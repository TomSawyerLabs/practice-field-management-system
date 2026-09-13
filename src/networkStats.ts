import { readFile } from 'node:fs/promises';
import type { NetworkBackend } from './node-ip/index.js';
import type { NetworkStats, StationName, StationNetworkStats, NeighborTableStats } from './types.js';
import { StationNameList } from './types.js';

/**
 * Query iptables FORWARD counters and map them to per-station rx/tx stats.
 *
 * Comment conventions from networkManager:
 *   - `<prefix>fwd-<station>`    → inInterface = VLAN iface → packets FROM robot
 *   - `<prefix>fwd-in-<station>` → outInterface = VLAN iface → packets TO robot
 */
/** Once per 5 minutes at most, so a full table doesn't also flood the journal. */
const NEIGHBOR_WARN_INTERVAL_MS = 5 * 60_000;
let lastNeighborWarn = 0;
let overflowsSeen = 0;

/**
 * Occupancy of the kernel's IPv4 neighbor table from /proc/net/arp, against
 * the gc_thresh3 ceiling. Linux-only; undefined elsewhere (or in dry-run).
 */
async function readNeighborTable(): Promise<NeighborTableStats | undefined> {
  let arp: string;
  let limitRaw: string;
  try {
    [arp, limitRaw] = await Promise.all([
      readFile('/proc/net/arp', 'utf-8'),
      readFile('/proc/sys/net/ipv4/neigh/default/gc_thresh3', 'utf-8'),
    ]);
  } catch {
    return undefined;
  }
  const byInterface: Record<string, number> = {};
  let entries = 0;
  for (const line of arp.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    entries++;
    const dev = cols[5];
    byInterface[dev] = (byInterface[dev] ?? 0) + 1;
  }
  const limit = Number.parseInt(limitRaw.trim(), 10) || 0;
  const sorted = Object.fromEntries(Object.entries(byInterface).sort((a, b) => b[1] - a[1]));
  if (limit > 0 && entries >= limit * 0.8) {
    if (entries >= limit) overflowsSeen++;
    const now = Date.now();
    if (now - lastNeighborWarn > NEIGHBOR_WARN_INTERVAL_MS) {
      lastNeighborWarn = now;
      const top = Object.entries(sorted)
        .slice(0, 4)
        .map(([d, n]) => `${d}=${n}`)
        .join(', ');
      console.warn(
        `Neighbor (ARP) table at ${entries}/${limit} — above ${limit} the kernel drops packets to hosts without an entry. Top: ${top}. Raise net.ipv4.neigh.default.gc_thresh3 (pFMS sets 8192 at startup).`,
      );
    }
  }
  return { entries, limit, byInterface: sorted, overflows: overflowsSeen };
}

export async function buildNetworkStats(net: NetworkBackend, commentPrefix: string): Promise<NetworkStats> {
  const [counters, neighborTable] = await Promise.all([net.getForwardCounters(commentPrefix), readNeighborTable()]);

  const stations: Partial<Record<StationName, StationNetworkStats>> = {};

  for (const station of StationNameList) {
    const fwdOut = counters.find(c => c.comment === `${commentPrefix}fwd-${station}`);
    const fwdIn = counters.find(c => c.comment === `${commentPrefix}fwd-in-${station}`);

    if (!fwdOut && !fwdIn) continue;

    stations[station] = {
      rxPackets: fwdOut?.packets ?? 0,
      rxBytes: fwdOut?.bytes ?? 0,
      txPackets: fwdIn?.packets ?? 0,
      txBytes: fwdIn?.bytes ?? 0,
    };
  }

  return { type: 'networkStats', stations, neighborTable };
}
