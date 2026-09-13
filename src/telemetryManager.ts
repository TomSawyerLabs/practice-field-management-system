import type { StationName, TelemetryUpdate } from './types.js';
import type { UdpMessage, LogDataMessage, DSMessage } from './fmsServer.js';

type FmsEvent = { address: string; port: number; data: DSMessage | UdpMessage };

function isUdpMessage(data: DSMessage | UdpMessage): data is UdpMessage {
  return 'BatteryVoltage' in data && 'tags' in data;
}

function isDsMessage(data: DSMessage | UdpMessage): data is DSMessage {
  return 'type' in data;
}

export class TelemetryManager {
  private loggedFirst = false;
  /** Track team number per TCP source address (learned from type 0x18 TeamNumberMessage) */
  private tcpTeamByAddress = new Map<string, number>();
  /** Cached team→station mappings, refreshed at most once per second */
  private cachedMappings: Record<number, StationName> = {};
  private cachedMappingsAt = 0;
  /** Track per-station enabled state from DS UDP telemetry */
  private enabledStations = new Map<StationName, boolean>();

  constructor(
    private readonly getTeamMappings: () => Record<number, StationName>,
    private readonly onUpdate: (update: TelemetryUpdate) => void,
    /** Resolve the correct station when a team is duplicated across stations.
     *  Called with (teamNumber, dsSourceAddress) — returns the station if resolvable. */
    private readonly resolveByAddress?: (teamNumber: number, address: string) => StationName | undefined,
  ) {}

  /** Returns true if any station's DS is reporting enabled. */
  anyRobotEnabled(): boolean {
    for (const enabled of this.enabledStations.values()) {
      if (enabled) return true;
    }
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
    this.enabledStations.set(station, msg.status.enabled);

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
