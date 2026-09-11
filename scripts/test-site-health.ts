/**
 * Verify the LAN-access check behind /health/site
 * (`bun scripts/test-site-health.ts`).
 *
 * The failure it exists to catch: the LAN name resolves to an address where the
 * reverse proxy serves the public-only page, so devices that pick that address
 * are shut out — pfms.tsl in August 2026, when an AAAA record appeared and
 * every IPv6 client looked external. Serves real HTTP on 127.0.0.1 and ::1 and
 * injects the resolver, so it runs anywhere without touching the network.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SiteHealthChecker, pageKind, type ResolvedAddress } from '../src/siteHealth.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`,
  );
  if (!cond) failures++;
}

const INTERNAL_PAGE = readFileSync('frontend/index.html', 'utf8');
const PUBLIC_PAGE = readFileSync('frontend/src/public.html', 'utf8');

// ── The markers the check relies on are really in the shipped pages ──
check('frontend/index.html is marked internal', pageKind(INTERNAL_PAGE) === 'internal');
check('frontend/src/public.html is marked public', pageKind(PUBLIC_PAGE) === 'public');
check('a page without a marker is unknown', pageKind('<html><body>hi</body></html>') === 'unknown');

// The public page runs its own copy of this test in the browser to decide
// whether to reload. Pull it out and hold it to the same pages, so the two can
// never drift (a broken copy made the page reload into its own reload cap).
const pageRegex = /var PUBLIC_PAGE = \/(.+)\/i;/.exec(PUBLIC_PAGE)?.[1];
check('public.html defines its PUBLIC_PAGE test', pageRegex !== undefined);
check('public.html contains no control characters', !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(PUBLIC_PAGE));
if (pageRegex) {
  const inBrowser = new RegExp(pageRegex, 'i');
  check("the page's own test recognises the public page", inBrowser.test(PUBLIC_PAGE));
  check("the page's own test does not mistake the internal UI for it", !inBrowser.test(INTERNAL_PAGE));
}

// ── Two servers on one port, one per address family ─────────────────
type Mode = 'internal' | 'public' | 'notFound' | 'hang';
const mode: Record<4 | 6, Mode> = { 4: 'internal', 6: 'public' };
let hits = 0;

function serve(family: 4 | 6, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      hits++;
      const m = mode[family];
      if (m === 'hang') return;
      if (m === 'notFound') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not here');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(m === 'internal' ? INTERNAL_PAGE : PUBLIC_PAGE);
    });
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

let v4: Server | undefined;
let v6: Server | undefined;
for (let attempt = 0; attempt < 5 && !v6; attempt++) {
  v4 = await serve(4, '127.0.0.1', 0);
  const port = (v4.address() as AddressInfo).port;
  try {
    v6 = await serve(6, '::1', port);
  } catch {
    v4.close();
    v4 = undefined;
  }
}
if (!v4 || !v6) {
  console.error('Could not bind the same port on 127.0.0.1 and ::1');
  process.exit(1);
}
const PORT = (v4.address() as AddressInfo).port;
const LAN_URL = `http://field.test:${PORT}/`;

const BOTH: ResolvedAddress[] = [
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 },
];
const checker = (addresses: ResolvedAddress[] | Error, lanUrl: string | undefined = LAN_URL) =>
  new SiteHealthChecker(lanUrl, {
    cacheMs: 0,
    timeoutMs: 300,
    resolve: async () => {
      if (addresses instanceof Error) throw addresses;
      return addresses;
    },
  });
const outcome = (r: Awaited<ReturnType<SiteHealthChecker['check']>>, family: 4 | 6) =>
  r.lan?.probes.find(p => p.family === family)?.outcome;

// ── The August 2026 failure: IPv6 gets the public page ──────────────
mode[4] = 'internal';
mode[6] = 'public';
let r = await checker(BOTH).check();
check('IPv6 serving the public page fails the check', r.ok === false, r);
check('...and says which family is shut out', /IPv6 serves the public-only page/.test(r.lan?.summary ?? ''), r.lan);

mode[6] = 'internal';
r = await checker(BOTH).check();
check('both families serving the internal UI passes', r.ok === true, r);

mode[4] = 'public';
r = await checker([{ address: '127.0.0.1', family: 4 }]).check();
check('the only address serving the public page fails', r.ok === false, r);

mode[4] = 'notFound';
r = await checker([{ address: '127.0.0.1', family: 4 }]).check();
check(
  'a response that is not a pFMS page fails',
  r.ok === false && outcome(r, 4) === 'unexpected' && r.lan?.probes[0]?.status === 404,
  r,
);

mode[4] = 'internal';
mode[6] = 'hang';
r = await checker(BOTH).check();
check('a timeout is tolerated while another address works', r.ok === true && outcome(r, 6) === 'timeout', r);

r = await checker([{ address: '::1', family: 6 }]).check();
check('a timeout with nothing else working fails', r.ok === false, r);

// ── IPv4-only proxy: IPv6 refuses, browsers fall back ───────────────
await new Promise<void>(resolve => v6!.close(() => resolve()));
v6.closeAllConnections?.();
r = await checker(BOTH).check();
check('IPv6 refusing connections is fine (the IPv4-only proxy)', r.ok === true && outcome(r, 6) === 'refused', r);

r = await checker([{ address: '::1', family: 6 }]).check();
check('refusing everywhere fails', r.ok === false, r);

// ── Configuration edges ─────────────────────────────────────────────
const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND field.test'), { code: 'ENOTFOUND' });
r = await checker(notFound).check();
check('an unresolvable name fails', r.ok === false && /can't resolve field\.test/.test(r.lan?.summary ?? ''), r);

// Not via checker(): its default parameter would swap undefined for LAN_URL.
r = await new SiteHealthChecker(undefined, { cacheMs: 0 }).check();
check('LAN_URL unset: passes on liveness alone', r.ok === true && r.lan === undefined, r);

r = await checker([], 'not a url').check();
check('an invalid LAN_URL fails loudly', r.ok === false && /not a valid URL/.test(r.lan?.summary ?? ''), r);

// ── The endpoint is public: results are cached and shared ───────────
const cachedChecker = new SiteHealthChecker(LAN_URL, {
  cacheMs: 60_000,
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
});
hits = 0;
await Promise.all([cachedChecker.check(), cachedChecker.check(), cachedChecker.check()]);
await cachedChecker.check();
check('concurrent and repeat checks within the cache window probe once', hits === 1, { hits });

v4.close();
v4.closeAllConnections?.();
console.log(failures === 0 ? '\nAll site-health checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
