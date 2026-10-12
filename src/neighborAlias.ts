/**
 * The IPv4 address of a device pFMS sees over IPv6.
 *
 * A laptop on a network with IPv6 reaches the pFMS pages over IPv6, but
 * everything pFMS does with a client's address is IPv4: route preference
 * (`ip rule from <laptop> to 10.TE.AM.0/24` — its packets to a robot leave
 * from its IPv4 address), drive sessions, DS matching, "this is you" rows.
 * A device that just connected is on-link, so the kernel neighbour table
 * has its MAC; the IPv4 entry with the same MAC is the same device.
 */
import { execFile } from 'node:child_process';
import { isIPv4, isIPv6 } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Neighbour states that say the entry is a real, recently seen device. */
const LIVE_STATES = new Set(['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'PERMANENT', 'NOARP']);

/**
 * From `ip neigh show` output, the IPv4 address sharing a MAC with `ipv6`.
 * Prefers an entry on the same interface, then a REACHABLE one. Undefined
 * when the IPv6 address isn't in the table or no IPv4 entry shares its MAC.
 */
export function pickIpv4Neighbor(neighOutput: string, ipv6: string): string | undefined {
  const target = ipv6.split('%')[0].toLowerCase();
  type Entry = { ip: string; dev?: string; mac?: string; state?: string };
  const entries: Entry[] = [];
  for (const line of neighOutput.split('\n')) {
    const words = line.trim().split(/\s+/);
    if (words.length < 2) continue;
    const at = (key: string) => {
      const i = words.indexOf(key);
      return i >= 0 ? words[i + 1] : undefined;
    };
    entries.push({ ip: words[0].toLowerCase(), dev: at('dev'), mac: at('lladdr')?.toLowerCase(), state: words.at(-1) });
  }
  const self = entries.find(e => e.ip === target && e.mac);
  if (!self) return undefined;
  const candidates = entries.filter(e => isIPv4(e.ip) && e.mac === self.mac && (!e.state || LIVE_STATES.has(e.state)));
  const rank = (e: Entry) => (e.dev === self.dev ? 2 : 0) + (e.state === 'REACHABLE' ? 1 : 0);
  return candidates.sort((a, b) => rank(b) - rank(a))[0]?.ip;
}

/** The IPv4 address of an on-link IPv6 client, from the kernel neighbour
 *  table. Undefined off Linux, for IPv4 input, or when there is none. */
export async function ipv4OfNeighbor(ip: string): Promise<string | undefined> {
  if (!isIPv6(ip.split('%')[0]) || process.platform !== 'linux') return undefined;
  try {
    const { stdout } = await execFileAsync('ip', ['neigh', 'show']);
    return pickIpv4Neighbor(stdout, ip);
  } catch {
    return undefined;
  }
}
