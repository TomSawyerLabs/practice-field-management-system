/**
 * Verify the on-link rule behind /api/auth/check
 * (`bun scripts/test-on-link-access.ts`).
 *
 * The bug it guards against: a device on the field network reaches pFMS over
 * IPv6 from the ISP-delegated prefix, fails the proxy's private-range test,
 * and is shown the public page. The backend must recognise it from the
 * prefixes on the host's own interfaces — and must not be fooled by a
 * stranger claiming such an address in X-Forwarded-For.
 *
 * Uses steamboat's real interface table (2026-09-11) as the fixture and a
 * real HTTP server on loopback for the handler.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import CIDRMatcher from 'cidr-matcher';
import { OnLinkChecker, isOnLink, onLinkPrefixes, type InterfaceTable } from '../src/onLink.js';
import { handleExternalAccessAuth } from '../src/externalAccessAuth.js';
import type { ExternalAccessStore } from '../src/externalAccessStore.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`,
  );
  if (!cond) failures++;
}

const v4 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo =>
  ({ address, netmask: '', family: 'IPv4', mac: '', internal, cidr }) as NetworkInterfaceInfo;
const v6 = (address: string, cidr: string, scopeid = 0, internal = false): NetworkInterfaceInfo =>
  ({ address, netmask: '', family: 'IPv6', mac: '', internal, cidr, scopeid }) as NetworkInterfaceInfo;

// steamboat, 2026-09-11 — `ip -o addr`
const STEAMBOAT: InterfaceTable = {
  lo: [v4('127.0.0.1', '127.0.0.1/8', true), v6('::1', '::1/128', 0, true)],
  eno1: [
    v4('10.0.100.5', '10.0.100.5/24'),
    v4('10.255.0.5', '10.255.0.5/20'),
    v6('2600:1700:459:8a1f::1a5', '2600:1700:459:8a1f::1a5/128'), // DHCPv6 lease: a host route, not a network
    v6('2600:1700:459:8a1f:1e69:7aff:fea2:713c', '2600:1700:459:8a1f:1e69:7aff:fea2:713c/64'),
    v6('fe80::1e69:7aff:fea2:713c', 'fe80::1e69:7aff:fea2:713c/64', 2),
  ],
  'eno1.3': [v4('10.55.0.5', '10.55.0.5/16')],
  'eno1.99': [v4('192.168.69.8', '192.168.69.8/24')],
  docker0: [v4('172.17.0.1', '172.17.0.1/16')],
};

// ── Prefix derivation ───────────────────────────────────────────────
const prefixes = onLinkPrefixes(STEAMBOAT);
const cidrs = prefixes.map(p => p.cidr).sort();
check('derives the delegated IPv6 /64 from the SLAAC address', cidrs.includes('2600:1700:459:8a1f::/64'), cidrs);
check('ignores the /128 DHCPv6 host route', !cidrs.some(c => c.endsWith('/128')), cidrs);
check('ignores loopback', !cidrs.some(c => c.startsWith('127.') || c === '::1/128'), cidrs);
check('derives the office LAN /20 with host bits cleared', cidrs.includes('10.255.0.0/20'), cidrs);
check(
  'keeps team VLAN and test-net prefixes',
  cidrs.includes('10.55.0.0/16') && cidrs.includes('192.168.69.0/24'),
  cidrs,
);
check('link-local counts', cidrs.includes('fe80::/64'), cidrs);

// ── Membership ──────────────────────────────────────────────────────
check("Cameron's laptop (LAN, IPv6) is on-link", isOnLink('2600:1700:459:8a1f:c8c4:564d:96e2:5a5b', prefixes));
check('sentinel (LAN, DHCPv6 address) is on-link', isOnLink('2600:1700:459:8a1f::3b3', prefixes));
check('another AT&T customer is not', !isOnLink('2600:1700:459:8a20::1', prefixes));
check('a Cloudflare edge address is not', !isOnLink('2606:4700:3037::6815:1ece', prefixes));
check('a Cloudflare IPv4 edge is not', !isOnLink('172.70.176.14', prefixes));
check('a LAN IPv4 client is on-link', isOnLink('10.255.15.240', prefixes));
check('an IPv4-mapped IPv6 form is handled', isOnLink('::ffff:10.255.1.2', prefixes));
check('a zone id is tolerated', isOnLink('fe80::1234%eno1', prefixes));
check('garbage is not on-link', !isOnLink('not-an-ip', prefixes) && !isOnLink('', prefixes));
check('no interfaces → nothing is on-link', !isOnLink('10.255.0.9', onLinkPrefixes({})));

// ── The checker re-reads the table only when stale ──────────────────
let reads = 0;
const checker = new OnLinkChecker(60_000, () => (reads++, STEAMBOAT));
checker.isOnLink('10.255.0.1');
checker.isOnLink('10.255.0.2');
check('interface table read once within the refresh window', reads === 1, { reads });

// ── The HTTP handler, behind a trusted proxy ────────────────────────
const store = { validateToken: (t: string) => t === 'good-token' } as unknown as ExternalAccessStore;
const trusted = new CIDRMatcher(['127.0.0.1/32', '::1/128']);
let trustProxy = true;
const server = createServer((req, res) => {
  if (
    !handleExternalAccessAuth(req, res, store, {
      trustedProxyMatcher: trustProxy ? trusted : new CIDRMatcher(['192.0.2.1/32']),
      onLink: checker,
    })
  ) {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const ask = (headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}/api/auth/check`, { headers }).then(r => ({
    status: r.status,
    access: r.headers.get('x-pfms-access'),
    cookie: r.headers.get('set-cookie'),
  }));

let r = await ask({ 'X-Forwarded-For': '2600:1700:459:8a1f:c8c4:564d:96e2:5a5b' });
check('LAN IPv6 client, no cookie → 200 on-link', r.status === 200 && r.access === 'on-link' && !r.cookie, r);

r = await ask({ 'X-Forwarded-For': '2606:4700:3037::6815:1ece' });
check('external client, no cookie → 401', r.status === 401, r);

r = await ask({ 'X-Forwarded-For': '203.0.113.7, 172.70.176.14' });
check('via Cloudflare: leftmost address is the client → 401', r.status === 401, r);

r = await ask({ 'X-Forwarded-For': '203.0.113.7', Cookie: 'pfms_access=good-token' });
check('external client with a valid cookie → 200 + refreshed cookie', r.status === 200 && !!r.cookie, r);

r = await ask({ 'X-Forwarded-For': '2600:1700:459:8a1f::1', Cookie: 'pfms_access=bad' });
check('bad cookie does not block an on-link client', r.status === 200 && r.access === 'on-link', r);

trustProxy = false;
r = await ask({ 'X-Forwarded-For': '2600:1700:459:8a1f:c8c4:564d:96e2:5a5b' });
check('X-Forwarded-For from an untrusted peer is ignored (loopback is not on-link) → 401', r.status === 401, r);
trustProxy = true;

server.close();
console.log(failures === 0 ? '\nAll on-link access checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
