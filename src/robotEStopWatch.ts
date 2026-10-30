import type { RobotEStop, RobotEStopOrigin, RobotEStopsState, StationName } from './types.js';

/**
 * Robots that are e-stopped in the roboRIO itself, and who sent it.
 *
 * pFMS's own stops never reach the robot: it never sets the e-stop bit in a
 * control packet (src/matchEngine.ts), it disables and cuts traffic instead,
 * and clearing one really clears it. An e-stop that comes from a Driver
 * Station is different. The roboRIO latches it until it reboots, and nothing
 * pFMS or the DS can do will release it. A team sees a robot that simply
 * won't enable (team 114's TestBird, 2026-10-28,
 * plans/robot-estop-warnings.md).
 *
 * The robot's replies (UDP 1150) carry the latch as a status bit, so its
 * rising edge is the moment the robot was e-stopped. The DS's control packets
 * (UDP 1110) carry the request as a bit too, so the packets just before that
 * edge say who asked:
 *
 * - a laptop on the field's network whose packets reached this robot, which
 *   may be the one driving it or the one driving the team's other robot;
 * - nobody the field can see, so a DS reaching the robot some other way, such
 *   as tethered or on the robot's own Wi-Fi;
 * - unknown, if the robot was already latched when pFMS first heard it.
 */

/** How long before the robot's latch a sender's e-stop bit still explains it. */
const SENDER_WINDOW_MS = 2_000;
/** A laptop sending control packets this recently counts as talking to it. */
const TALKING_WINDOW_MS = 3_000;
/** A latched robot unheard from for this long is forgotten: it has left. */
const FORGET_AFTER_MS = 30 * 60_000;

export interface RobotEStopWatchEffects {
  /** The name of the robot on a station, for the log. */
  robotOn(station: StationName): string | undefined;
  /** The station whose robot this laptop drives. */
  stationDrivenBy(laptop: string, team: number): StationName | undefined;
  /** A laptop's name, when known. */
  hostnameOf(laptop: string): string | undefined;
  info(message: string): void;
  warn(message: string): void;
}

type Station = {
  team: number;
  /** Reply seen at all, so the first one can be told from a rising edge. */
  heard: boolean;
  latched: RobotEStop | null;
  lastReplyAt: number;
  enabledAt?: number;
  wasEnabled: boolean;
  /** Laptop → last control packet it got to this robot. */
  talking: Map<string, number>;
  /** Laptop → last e-stop bit it got to this robot. */
  eStopBits: Map<string, number>;
  /** An e-stop bit from a sender whose address is unknown. */
  anonymousBitAt?: number;
};

export class RobotEStopWatch {
  private stations = new Map<StationName, Station>();
  private version = 0;

  constructor(private readonly fx: RobotEStopWatchEffects) {}

  /**
   * A control packet that reached this station's robot. `laptop` is where it
   * came from, undefined if that isn't known. Only the forwarded copy counts:
   * what a team Stop's cut drops never reached the robot.
   */
  control(station: StationName, team: number, laptop: string | undefined, eStopBit: boolean, at: number): void {
    const s = this.station(station, team, at);
    if (laptop) s.talking.set(laptop, at);
    if (!eStopBit) return;
    if (!laptop) {
      s.anonymousBitAt = at;
      return;
    }
    const last = s.eStopBits.get(laptop);
    s.eStopBits.set(laptop, at);
    // One line per press: a DS repeats the bit in every packet.
    if (last === undefined || at - last > SENDER_WINDOW_MS) {
      this.fx.info(
        `DS ${this.nameOf(laptop)} sent an e-stop to ${this.label(station, team)}: ${this.relation(laptop, station, team)}`,
      );
    }
  }

  /** A status reply from this station's robot. */
  reply(station: StationName, team: number, flags: { eStop: boolean; enabled: boolean }, at: number): void {
    const s = this.station(station, team, at);
    const first = !s.heard;
    s.heard = true;
    s.lastReplyAt = at;
    if (flags.enabled && !s.wasEnabled) s.enabledAt = at;
    s.wasEnabled = flags.enabled;

    if (flags.eStop && !s.latched) {
      s.latched = this.latch(station, s, first, at);
      this.version++;
    } else if (!flags.eStop && s.latched) {
      const mins = Math.round((at - s.latched.since) / 60_000);
      this.fx.info(`Robot e-stop gone on ${this.label(station, team)} after ${mins}m: the robot rebooted`);
      s.latched = null;
      s.eStopBits.clear();
      s.anonymousBitAt = undefined;
      this.version++;
    }
  }

  /** Forget latched robots that left. Call every few seconds. */
  tick(now: number): void {
    for (const [name, s] of this.stations) {
      if (s.latched && now - s.lastReplyAt > FORGET_AFTER_MS) {
        this.stations.delete(name);
        this.version++;
      }
    }
  }

  getVersion(): number {
    return this.version;
  }

  snapshot(): RobotEStopsState {
    const stations: RobotEStopsState['stations'] = {};
    for (const [name, s] of this.stations) if (s.latched) stations[name] = { ...s.latched };
    return { type: 'robotEStops', stations };
  }

  private station(name: StationName, team: number, at: number): Station {
    let s = this.stations.get(name);
    if (!s || s.team !== team) {
      if (s?.latched) this.version++;
      s = {
        team,
        heard: false,
        latched: null,
        lastReplyAt: at,
        wasEnabled: false,
        talking: new Map(),
        eStopBits: new Map(),
      };
      this.stations.set(name, s);
    }
    return s;
  }

  private latch(station: StationName, s: Station, first: boolean, at: number): RobotEStop {
    const others = [...s.talking].filter(([, seen]) => at - seen <= TALKING_WINDOW_MS).map(([laptop]) => laptop);
    const origin = this.origin(station, s, first, at);
    const label = this.label(station, s.team);
    const afterEnable =
      s.enabledAt !== undefined && at - s.enabledAt < 60_000
        ? `, ${Math.round(at - s.enabledAt)} ms after it enabled`
        : '';
    const talking = others.length ? `; laptops sending to it: ${others.map(l => this.nameOf(l)).join(', ')}` : '';
    this.fx.warn(
      `Robot e-stopped on ${label}${afterEnable}: ${describeOrigin(origin)}${talking}. It stays e-stopped until it reboots`,
    );
    return { team: s.team, since: at, origin };
  }

  private origin(station: StationName, s: Station, first: boolean, at: number): RobotEStopOrigin {
    if (first) return { kind: 'already' };
    // Latest sender, if several: the bit it sent is what the robot just took.
    const senders = [...s.eStopBits]
      .filter(([, sent]) => at - sent <= SENDER_WINDOW_MS)
      .sort(([, a], [, b]) => b - a)
      .map(([laptop]) => laptop);
    const laptop = senders[0];
    if (laptop) {
      const drives = this.fx.stationDrivenBy(laptop, s.team);
      return {
        kind: 'ds',
        laptop,
        hostname: this.fx.hostnameOf(laptop),
        drives,
        drivesRobot: drives ? this.fx.robotOn(drives) : undefined,
        drivesThis: drives === station,
      };
    }
    if (s.anonymousBitAt !== undefined && at - s.anonymousBitAt <= SENDER_WINDOW_MS) return { kind: 'ds-unknown' };
    return { kind: 'unseen' };
  }

  private nameOf(laptop: string): string {
    const host = this.fx.hostnameOf(laptop);
    return host ? `${laptop} (${host})` : laptop;
  }

  private label(station: StationName, team: number): string {
    return `${station} (${this.fx.robotOn(station) ?? team})`;
  }

  private relation(laptop: string, station: StationName, team: number): string {
    const drives = this.fx.stationDrivenBy(laptop, team);
    if (drives === station) return 'the laptop driving it';
    if (drives) return `that laptop drives ${this.label(drives, team)}, not this robot`;
    return 'that laptop has no drive session';
  }
}

function describeOrigin(o: RobotEStopOrigin): string {
  switch (o.kind) {
    case 'ds': {
      const who = o.hostname ? `${o.laptop} (${o.hostname})` : o.laptop;
      if (o.drivesThis) return `sent by DS ${who}, the laptop driving it`;
      if (o.drives) return `sent by DS ${who}, which drives ${o.drives} (${o.drivesRobot ?? '?'}), not this robot`;
      return `sent by DS ${who}, which has no drive session`;
    }
    case 'ds-unknown':
      return 'sent through the field by a laptop it could not identify';
    case 'unseen':
      return 'no DS on the field network sent it, so one is reaching the robot another way (tethered, or on its own Wi-Fi)';
    case 'already':
      return 'it was already e-stopped when pFMS first heard it, so the sender is unknown';
  }
}
