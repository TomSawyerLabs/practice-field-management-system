import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { StationName, SubnetScanResults, StationSubnetScan, DiscoveredHost } from './types.js';
import { StationNameList } from './types.js';

const execFile = promisify(execFileCb);

type TeamLookup = (station: StationName) => number | null;

interface HostState {
  firstSeen: number;
  lastSeen: number;
  alive: boolean;
  /** Start of the current consecutive-alive streak (reset when host goes down) */
  onlineSince: number;
  /** How this host was discovered */
  source: 'fping' | 'conntrack';
}

export class SubnetScanner {
  private state = new Map<StationName, Map<string, HostState>>();
  private lastScanTime = new Map<StationName, number>();
  private interval: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly getTeamForStation: TeamLookup,
    private readonly onScanComplete?: (results: SubnetScanResults) => void,
    private readonly dryRun = false,
  ) {}

  start(intervalMs = 10_000): void {
    this.stop();
    this.runScan();
    this.interval = setInterval(() => this.runScan(), intervalMs);
    console.log(`SubnetScanner started (interval: ${intervalMs}ms, dry-run: ${this.dryRun})`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  clearStation(station: StationName): void {
    this.state.delete(station);
    this.lastScanTime.delete(station);
  }

  clearAll(): void {
    this.state.clear();
    this.lastScanTime.clear();
  }

  getResults(): SubnetScanResults {
    const stations: Partial<Record<StationName, StationSubnetScan>> = {};

    for (const station of StationNameList) {
      const team = this.getTeamForStation(station);
      if (team === null) continue;

      const hostMap = this.state.get(station);
      if (!hostMap || hostMap.size === 0) continue;

      const subnet = SubnetScanner.teamSubnet(team);
      const hosts: DiscoveredHost[] = [];

      for (const [ip, state] of hostMap) {
        hosts.push({
          ip,
          alive: state.alive,
          firstSeen: state.firstSeen,
          lastSeen: state.lastSeen,
          onlineSince: state.onlineSince,
          source: state.source,
        });
      }

      // Sort: team subnet hosts first (by last octet), then guest hosts (by full IP)
      hosts.sort((a, b) => {
        const aIsGuest = a.source === 'conntrack';
        const bIsGuest = b.source === 'conntrack';
        if (aIsGuest !== bIsGuest) return aIsGuest ? 1 : -1;
        if (aIsGuest) return a.ip.localeCompare(b.ip, undefined, { numeric: true });
        const aOctet = parseInt(a.ip.split('.')[3]);
        const bOctet = parseInt(b.ip.split('.')[3]);
        return aOctet - bOctet;
      });

      stations[station] = {
        team,
        subnet,
        hosts,
        lastScanTime: this.lastScanTime.get(station) ?? 0,
      };
    }

    return { type: 'subnetScan', stations };
  }

  private async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;

    try {
      const promises: Promise<void>[] = [];
      for (const station of StationNameList) {
        const team = this.getTeamForStation(station);
        if (team === null) continue;
        promises.push(this.scanStation(station, team));
      }
      await Promise.all(promises);
      await this.scanConntrack();
      this.onScanComplete?.(this.getResults());
    } catch (err) {
      console.error('SubnetScanner error:', err);
    } finally {
      this.scanning = false;
    }
  }

  private async scanStation(station: StationName, team: number): Promise<void> {
    const subnet = SubnetScanner.teamSubnet(team);
    const rangeStart = `${subnet}.1`;
    const rangeEnd = `${subnet}.253`;
    const now = Date.now();

    if (this.dryRun) {
      console.log(`[dry-run] Would fping ${rangeStart} - ${rangeEnd} for ${station}`);
      this.lastScanTime.set(station, now);
      return;
    }

    const aliveIps = await this.runFping(station, rangeStart, rangeEnd);
    if (aliveIps === null) return; // fping failed entirely

    if (!this.state.has(station)) {
      this.state.set(station, new Map());
    }
    const hostMap = this.state.get(station)!;

    // Mark all fping-sourced hosts as down (conntrack hosts handled separately)
    for (const host of hostMap.values()) {
      if (host.source === 'fping') host.alive = false;
    }

    // Update alive hosts
    for (const ip of aliveIps) {
      const existing = hostMap.get(ip);
      if (existing) {
        // Reset onlineSince when transitioning from down → up
        if (!existing.alive) existing.onlineSince = now;
        existing.alive = true;
        existing.lastSeen = now;
      } else {
        hostMap.set(ip, { firstSeen: now, lastSeen: now, alive: true, onlineSince: now, source: 'fping' });
      }
    }

    this.lastScanTime.set(station, now);
  }

  private async runFping(station: StationName, rangeStart: string, rangeEnd: string): Promise<Set<string> | null> {
    try {
      const { stdout } = await execFile('fping', ['-a', '-r', '0', '-t', '200', '-q', '-g', rangeStart, rangeEnd], {
        timeout: 15_000,
      });
      return SubnetScanner.parseAliveIps(stdout);
    } catch (err: unknown) {
      // fping exits 1 when some hosts are unreachable (the common case).
      // Node's execFile rejects on non-zero exit, but stdout still has alive hosts.
      if (err && typeof err === 'object' && 'code' in err) {
        const e = err as { code: number | string; stdout?: string };
        if (e.code === 1 && typeof e.stdout === 'string') {
          return SubnetScanner.parseAliveIps(e.stdout);
        }
        if (e.code === 'ENOENT') {
          console.error('fping not found. Install with: sudo apt install fping');
          this.stop();
          return null;
        }
      }
      console.error(`SubnetScanner: fping failed for ${station}:`, err);
      return null;
    }
  }

  /**
   * Scan the kernel conntrack table for flows involving configured team subnets.
   * Any non-team IP (guest network) seen communicating with a team subnet is
   * added to that station's host map as a conntrack-sourced host.
   */
  private async scanConntrack(): Promise<void> {
    if (this.dryRun) return;

    // Build reverse lookup: subnet prefix → station
    const subnetToStation = new Map<string, StationName>();
    for (const station of StationNameList) {
      const team = this.getTeamForStation(station);
      if (team === null) continue;
      subnetToStation.set(SubnetScanner.teamSubnet(team), station);
    }
    if (subnetToStation.size === 0) return;

    // Our FMS IP — filter it out of guest host lists
    const selfIp = '10.0.100.5';

    let stdout: string;
    try {
      ({ stdout } = await execFile('conntrack', ['-L'], { timeout: 5_000 }));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string | number }).code === 'ENOENT') {
        return; // conntrack not installed — skip silently (already warned by DNAT flush)
      }
      // conntrack -L exits 0 on success; any other error is unexpected
      return;
    }

    const now = Date.now();

    // Track which conntrack-sourced hosts are still active this scan
    const activeGuests = new Map<StationName, Set<string>>();

    for (const line of stdout.split('\n')) {
      // Extract src and dst from the FIRST tuple only (before [UNREPLIED]/[ASSURED] or second src=)
      // Format: "proto protonum ttl src=A dst=B sport=X dport=Y [flags] src=C dst=D ..."
      const srcMatch = line.match(/src=(\S+)/);
      const dstMatch = line.match(/dst=(\S+)/);
      if (!srcMatch || !dstMatch) continue;
      const src = srcMatch[1];
      const dst = dstMatch[1];

      // Skip broadcast/multicast
      if (dst === '255.255.255.255' || dst.startsWith('224.')) continue;

      // Check if src or dst falls in a team subnet
      const srcPrefix = src.split('.').slice(0, 3).join('.');
      const dstPrefix = dst.split('.').slice(0, 3).join('.');
      const srcStation = subnetToStation.get(srcPrefix);
      const dstStation = subnetToStation.get(dstPrefix);

      // We want exactly one side in a team subnet, the other a private (guest) IP.
      // Filter out internet IPs — robots can make outbound connections that show up
      // in conntrack, but we only care about local guest network hosts.
      if (srcStation && !dstStation && SubnetScanner.isPrivateIp(dst)) {
        // src is in team subnet → dst is the guest (skip our own IPs)
        if (dst === selfIp) continue;
        if (!activeGuests.has(srcStation)) activeGuests.set(srcStation, new Set());
        activeGuests.get(srcStation)!.add(dst);
      } else if (dstStation && !srcStation && SubnetScanner.isPrivateIp(src)) {
        // dst is in team subnet → src is the guest (skip our own IPs)
        if (src === selfIp) continue;
        if (!activeGuests.has(dstStation)) activeGuests.set(dstStation, new Set());
        activeGuests.get(dstStation)!.add(src);
      }
    }

    // Update host maps with conntrack results
    for (const station of StationNameList) {
      const hostMap = this.state.get(station);
      if (!hostMap) continue;

      // Mark all conntrack-sourced hosts as down, and prune stale ones.
      // Conntrack entries expire from the kernel naturally (UDP ~30s, TCP varies),
      // so hosts not seen for 60s are removed from the map entirely.
      for (const [ip, host] of hostMap) {
        if (host.source !== 'conntrack') continue;
        if (now - host.lastSeen > 60_000) {
          hostMap.delete(ip);
        } else {
          host.alive = false;
        }
      }

      // Update active guest hosts
      const guests = activeGuests.get(station);
      if (!guests) continue;
      for (const ip of guests) {
        const existing = hostMap.get(ip);
        if (existing) {
          if (!existing.alive) existing.onlineSince = now;
          existing.alive = true;
          existing.lastSeen = now;
        } else {
          hostMap.set(ip, { firstSeen: now, lastSeen: now, alive: true, onlineSince: now, source: 'conntrack' });
        }
      }
    }
  }

  private static parseAliveIps(stdout: string): Set<string> {
    return new Set(
      stdout
        .trim()
        .split('\n')
        .filter(line => line.trim()),
    );
  }

  /** Check if an IP is in RFC 1918 private address space. */
  private static isPrivateIp(ip: string): boolean {
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1]);
      return second >= 16 && second <= 31;
    }
    return false;
  }

  static teamSubnet(team: number): string {
    const high = Math.floor(team / 100);
    const low = team % 100;
    return `10.${high}.${low}`;
  }
}
