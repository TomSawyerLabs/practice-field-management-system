import type { StationName, TelemetryUpdate } from './types.js';
import type { UdpMessage, LogDataMessage, DSMessage } from './fmsServer.js';

type FmsEvent = { address: string; port: number; data: DSMessage | UdpMessage };

function isUdpMessage(data: DSMessage | UdpMessage): data is UdpMessage {
  return 'BatteryVoltage' in data && 'tags' in data;
}

function isDsMessage(data: DSMessage | UdpMessage): data is DSMessage {
  return 'type' in data;
}

/** A DS sends its UDP status ~50 times a second. One that has gone quiet
 *  this long (unplugged, laptop closed) is not vouching for an enabled
 *  robot any more — without this, its last "enabled" report would defer
 *  every radio commit until some other DS event cleared it. */
export const ENABLED_REPORT_STALE_MS = 5_000;

/** After a start, how long the first radio commit waits to hear from every
 *  robot before going ahead. A robot with a Driver Station is heard within
 *  moments; one that's silent this long has nothing driving it. */
export const ENABLED_STATE_WAIT_MS = 15_000;

export class TelemetryManager {
  private loggedFirst = false;
  /** Track team number per TCP source address (learned from type 0x18 TeamNumberMessage) */
  private tcpTeamByAddress = new Map<string, number>();
  /** Cached team→station mappings, refreshed at most once per second */
  private cachedMappings: Record<number, StationName> = {};
  private cachedMappingsAt = 0;
  /** Per-station enabled state from DS UDP telemetry, and when it was reported */
  private enabledStations = new Map<StationName, { enabled: boolean; at: number }>();
  /** The same, from any source: for the first commit after a start. */
  private robotStatus = new Map<StationName, { enabled: boolean; at: number }>();
  private firstCommitSettled = false;
  private readonly startedAt: number;

  constructor(
    private readonly getTeamMappings: () => Record<number, StationName>,
    private readonly onUpdate: (update: TelemetryUpdate) => void,
    /** Resolve the correct station when a team is duplicated across stations.
     *  Called with (teamNumber, dsSourceAddress) — returns the station if resolvable. */
    private readonly resolveByAddress?: (teamNumber: number, address: string) => StationName | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Returns true if any station's DS is reporting enabled, recently. */
  anyRobotEnabled(): boolean {
    const now = this.now();
    for (const { enabled, at } of this.enabledStations.values()) {
      if (enabled && now - at <= ENABLED_REPORT_STALE_MS) return true;
    }
    return false;
  }

  /** A robot's own status, from its replies to its Driver Station: the only
   *  word on a robot whose DS isn't assigned a station, which sends the field
   *  no status at all. */
  noteRobotStatus(station: StationName, enabled: boolean): void {
    this.robotStatus.set(station, { enabled, at: this.now() });
  }

  /**
   * Whether a radio commit should wait because a robot is, or may be, enabled.
   * `stations` are those with a robot on them.
   *
   * Before the first report after a start nobody has said anything, which is
   * not the same as nobody being enabled, and a commit drops every robot's
   * Wi-Fi for ~30 s. So the first commit waits to hear from each robot, for
   * ENABLED_STATE_WAIT_MS, and for any it hears is enabled, however it heard.
   * After that, as before, only a DS reporting to the field holds a commit.
   */
  robotsMayBeEnabled(stations: StationName[]): boolean {
    if (this.anyRobotEnabled()) return true;
    if (this.firstCommitSettled) return false;
    const now = this.now();
    const waiting = now - this.startedAt < ENABLED_STATE_WAIT_MS;
    const enabled = [...this.robotStatus.values()].some(r => r.enabled && now - r.at <= ENABLED_REPORT_STALE_MS);
    if (enabled || (waiting && stations.some(s => !this.robotStatus.has(s)))) return true;
    // Too early to say, with no robot to go on: one may yet turn up on a bridge.
    if (!waiting || stations.length > 0) this.firstCommitSettled = true;
    return false;
  }

  processFmsEvent(event: FmsEvent): void {
    const { address, data } = event;

    if (isUdpMessage(data)) {
      this.processUdp(data, address);
      return;
    }

    if (!isDsMessage(data)) return;

    // Team-number handshake (0x18 legacy DS, 0x1e 2027 DS) — learn team for
    // this TCP address. Evict any stale entry for this team (DS reconnected
    // from a new IP).
    if (data.type === 0x18 || data.type === 0x1e) {
      for (const [addr, team] of this.tcpTeamByAddress) {
        if (team === data.teamNumber && addr !== address) {
          this.tcpTeamByAddress.delete(addr);
        }
      }
      this.tcpTeamByAddress.set(address, data.teamNumber);
      return;
    }

    // TCP LogDataMessage (0x16) — needs team from tcpTeamByAddress
    if (data.type === 0x16) {
      const team = this.tcpTeamByAddress.get(address);
      if (!team) return;
      this.processLogData(data, team, address);
    }
  }

  private processUdp(msg: UdpMessage, sourceAddress: string): void {
    const station = this.resolveStationForAddress(msg.teamNumber, sourceAddress);
    if (!station) return;

    this.logFirst(msg.teamNumber, station);
    this.enabledStations.set(station, { enabled: msg.status.enabled, at: this.now() });
    this.noteRobotStatus(station, msg.status.enabled);

    let dsCpuPercent: number | undefined;
    for (const tag of msg.tags) {
      if ('cpuPercent' in tag) {
        dsCpuPercent = (tag as { cpuPercent: number }).cpuPercent;
        break;
      }
    }

    const update: TelemetryUpdate = {
      type: 'telemetry',
      station,
      timestamp: Date.now(),
      batteryVoltage: msg.BatteryVoltage,
      dsCpuPercent,
      dsStatus: {
        eStop: msg.status.EStop,
        aStop: msg.status.AStop,
        robotComms: msg.status.robotComms,
        radioPing: msg.status.radioPing,
        rioPing: msg.status.rioPing,
        enabled: msg.status.enabled,
        mode: msg.status.mode,
      },
    };

    this.onUpdate(update);
  }

  private processLogData(msg: LogDataMessage, teamNumber: number, sourceAddress: string): void {
    const station = this.resolveStationForAddress(teamNumber, sourceAddress);
    if (!station) return;

    this.logFirst(teamNumber, station);

    const update: TelemetryUpdate = {
      type: 'telemetry',
      station,
      timestamp: Date.now(),
      batteryVoltage: msg.voltage,
      rttMs: msg.roundTripTime,
      lostPackets: msg.lostPackets,
      canUtil: msg.CAN,
      brownout: msg.status.brownout,
    };

    this.onUpdate(update);
  }

  /**
   * Resolve team → station, using address-based disambiguation for duplicate teams.
   * Falls back to the simple team→station mapping when address resolution isn't available
   * or doesn't find a match.
   */
  private resolveStationForAddress(teamNumber: number, sourceAddress: string): StationName | undefined {
    // Try address-based resolution first (handles duplicate teams)
    if (this.resolveByAddress) {
      const resolved = this.resolveByAddress(teamNumber, sourceAddress);
      if (resolved) return resolved;
    }
    // Fall back to simple team→station mapping
    return this.resolveStation(teamNumber);
  }

  private resolveStation(teamNumber: number): StationName | undefined {
    const now = Date.now();
    if (now - this.cachedMappingsAt > 1000) {
      this.cachedMappings = this.getTeamMappings();
      this.cachedMappingsAt = now;
    }
    return this.cachedMappings[teamNumber];
  }

  private logFirst(teamNumber: number, station: StationName): void {
    if (this.loggedFirst) return;
    this.loggedFirst = true;
    console.log(`First telemetry received: team ${teamNumber} -> ${station}`);
  }
}
