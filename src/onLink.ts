import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { normalizeIp } from './utils.js';

/**
 * "Is this client on one of my own networks?"
 *
 * The reverse proxy in front of pFMS serves the internal UI to private-range
 * sources and asks the backend about everyone else. That test cannot recognise
 * a device on the field network that arrives over IPv6: its address comes from
 * whatever global prefix the ISP delegated, which is not private and changes
 * without notice. So the backend answers the question from the only place the
 * prefixes are actually known — the host's own interfaces, read live from the
 * OS. No addresses in config, nothing to update when the ISP renumbers.
 *
 * A prefix counts when the host has a non-host-route address in it on a
 * non-loopback interface. That is every network pFMS is plugged into: the
 * office LAN (IPv4 and the delegated IPv6 /64), the team VLANs, link-local.
 * Docker bridges are included too; they are private anyway.
 */

export interface OnLinkPrefix {
  cidr: string;
  family: 'ipv4' | 'ipv6';
}

/** Interfaces as `os.networkInterfaces()` returns them; injectable for tests. */
export type InterfaceTable = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function onLinkPrefixes(interfaces: InterfaceTable = networkInterfaces()): OnLinkPrefix[] {
  const out = new Map<string, OnLinkPrefix>();
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.internal || !a.cidr) continue;
      const bits = Number(a.cidr.split('/')[1]);
      const v6 = a.family === 'IPv6';
      // A host route (/32, /128) is one address, not a network — the DHCPv6
      // lease on the office LAN is exactly that and must not count.
      if (bits >= (v6 ? 128 : 32)) continue;
      const cidr = `${networkOf(a.address, bits, v6)}/${bits}`;
      out.set(cidr, { cidr, family: v6 ? 'ipv6' : 'ipv4' });
    }
  }
  return [...out.values()];
}

/** True when `ip` falls inside any of the prefixes. */
export function isOnLink(ip: string, prefixes: OnLinkPrefix[]): boolean {
  const list = new BlockList();
  for (const p of prefixes) {
    const [addr, bits] = p.cidr.split('/');
    list.addSubnet(addr!, Number(bits), p.family);
  }
  return matches(list, ip);
}

function matches(list: BlockList, ip: string): boolean {
  const plain = normalizeIp(ip.trim());
  if (isIPv4(plain)) return list.check(plain, 'ipv4');
  // Strip a zone id (`fe80::1%eno1`); BlockList doesn't accept them.
  const noZone = plain.replace(/%.*$/, '');
  if (isIPv6(noZone)) return list.check(noZone, 'ipv6');
  return false;
}

/** Zero the host bits so equal networks dedupe to one string. */
function networkOf(address: string, bits: number, v6: boolean): string {
  const bytes = v6 ? ipv6Bytes(address) : address.split('.').map(Number);
  const masked = bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    return keep === 8 ? b : keep === 0 ? 0 : b & (0xff << (8 - keep)) & 0xff;
  });
  if (!v6) return masked.join('.');
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2) words.push(((masked[i]! << 8) | masked[i + 1]!).toString(16));
  return words.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
}

function ipv6Bytes(address: string): number[] {
  const [head, tail = ''] = address.replace(/%.*$/, '').split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const words = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return words.flatMap(w => {
    const n = parseInt(w || '0', 16);
    return [n >> 8, n & 0xff];
  });
}

/**
 * Re-reads the interface table at most every `refreshMs`, so the auth check
 * (one call per external page load) stays cheap and a prefix change is picked
 * up within a minute without a restart.
 */
export class OnLinkChecker {
  private prefixes: OnLinkPrefix[] = [];
  private readAt = 0;

  constructor(
    private readonly refreshMs = 60_000,
    private readonly read: () => InterfaceTable = networkInterfaces,
  ) {}

  current(): OnLinkPrefix[] {
    if (Date.now() - this.readAt >= this.refreshMs) {
      this.prefixes = onLinkPrefixes(this.read());
      this.readAt = Date.now();
    }
    return this.prefixes;
  }

  isOnLink(ip: string): boolean {
    return isOnLink(ip, this.current());
  }
}
