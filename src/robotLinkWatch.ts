import { StationNameList, type StationName } from './types.js';

/**
 * Says, per drive session, whether the laptop's Driver Station actually
 * reaches its robot, and if not, which leg is broken.
 *
 * A legacy NI Driver Station on guest Wi-Fi talks to its robot through pFMS:
 * its control packets (UDP 1110) arrive from the laptop's own address and are
 * masqueraded onto the robot's VLAN; the roboRIO answers (UDP 1150) to the
 * gateway, and the drive session's DNAT forwards that to the laptop. The
 * passive capture sees every one of those hops, so a DS showing "No Robot
 * Communication" can be told apart as:
 *
 * - the DS sending nothing at all,
 * - the DS sending to an address no robot answers from,
 * - the robot answering, but its replies not being forwarded to the laptop.
 *
 * Only transitions are logged, so a healthy field logs one line per session.
 */

/** A control or reply packet the capture saw, with its addresses as captured. */
export type LinkHop = {
  station: StationName;
  /** 'control': DS→robot UDP 1110. 'reply': robot→DS UDP 1150. */
  kind: 'control' | 'reply';
  src: string;
  dst: string;
  at: number;
};

export type LinkState =
  | { ok: true }
  | { ok: false; problem: 'ds-silent' }
  | { ok: false; problem: 'robot-silent'; targets: string[] }
  | { ok: false; problem: 'not-delivered'; robot: string };

export interface RobotLinkWatchEffects {
  /** The laptop driving the robot on this station, if any. */
  laptopOn(station: StationName): string | undefined;
  /** Whether that laptop runs the legacy NI DS. The 2027 DS's robot replies
   *  to its source port, not 1150, so the capture can't see its replies. */
  isLegacyDs(dsIp: string): boolean;
  /** Whether the capture is running; without it silence means nothing. */
  capturing(): boolean;
  info(message: string): void;
  warn(message: string): void;
  now(): number;
}

/** How recent a hop must be to count as "flowing". The DS sends at 50 Hz. */
export const LINK_RECENT_MS = 3_000;
/** How long a new session gets to come up before a broken link is reported. */
export const LINK_GRACE_MS = 10_000;

type Watched = {
  dsIp: string;
  since: number;
  /** Robot addresses the laptop's control packets go to → last seen. */
  targets: Map<string, number>;
  /** Addresses the robot answered from → last seen. */
  robots: Map<string, number>;
  /** Last reply forwarded to the laptop. */
  delivered: number;
  /** The state last logged, as a comparable key, or null before any. */
  logged: string | null;
  /** When the link was logged down, for "back after N s". */
  downAt: number | null;
};

export class RobotLinkWatch {
  private watched = new Map<StationName, Watched>();

  constructor(private readonly fx: RobotLinkWatchEffects) {}

  /** Every captured control or reply packet. */
  hop(h: LinkHop): void {
    const w = this.current(h.station);
    if (!w) return;
    if (h.kind === 'control') {
      // Only the laptop's own copy: the forwarded copy is from the gateway.
      if (h.src === w.dsIp) w.targets.set(h.dst, h.at);
    } else {
      w.robots.set(h.src, h.at);
      if (h.dst === w.dsIp) w.delivered = h.at;
    }
  }

  /** Classify each session and log what changed. Call every few seconds. */
  check(): void {
    const now = this.fx.now();
    // Every station, not just ones with traffic: a DS that sends nothing is
    // the case most worth reporting.
    for (const station of StationNameList) this.current(station);
    if (!this.fx.capturing()) return;
    for (const [station, w] of this.watched) {
      if (!this.fx.isLegacyDs(w.dsIp)) continue;
      const state = this.stateOf(w, now);
      const key = JSON.stringify(state);
      if (key === w.logged) continue;
      if (state.ok) {
        const what = w.logged === null ? 'up' : 'back';
        const after = now - (w.downAt ?? w.since);
        w.downAt = null;
        w.logged = key;
        this.fx.info(
          `Robot link ${what} for ${w.dsIp} on ${station} after ${Math.round(after / 1000)}s: DS → ${this.recent(w.targets, now).join(', ')}`,
        );
        continue;
      }
      // Give a new session time to come up before calling it broken.
      if (w.logged === null && now - w.since < LINK_GRACE_MS) continue;
      w.downAt ??= now;
      w.logged = key;
      this.fx.warn(`Robot link down for ${w.dsIp} on ${station}: ${describe(state)}`);
    }
  }

  /** What the link looks like right now. */
  private stateOf(w: Watched, now: number): LinkState {
    if (now - w.delivered <= LINK_RECENT_MS) return { ok: true };
    const targets = this.recent(w.targets, now);
    if (targets.length === 0) return { ok: false, problem: 'ds-silent' };
    const robots = this.recent(w.robots, now);
    if (robots.length === 0) return { ok: false, problem: 'robot-silent', targets };
    return { ok: false, problem: 'not-delivered', robot: robots[0] };
  }

  private recent(seen: Map<string, number>, now: number): string[] {
    return [...seen]
      .filter(([, at]) => now - at <= LINK_RECENT_MS)
      .map(([ip]) => ip)
      .sort();
  }

  /** The watch for this station's current laptop, starting a fresh one when
   *  the laptop changed and dropping it when nobody drives. */
  private current(station: StationName): Watched | undefined {
    const dsIp = this.fx.laptopOn(station);
    const w = this.watched.get(station);
    if (!dsIp) {
      if (w) this.watched.delete(station);
      return undefined;
    }
    if (w?.dsIp === dsIp) return w;
    const fresh: Watched = {
      dsIp,
      since: this.fx.now(),
      targets: new Map(),
      robots: new Map(),
      delivered: -Infinity,
      logged: null,
      downAt: null,
    };
    this.watched.set(station, fresh);
    return fresh;
  }
}

function describe(state: LinkState): string {
  if (state.ok) return 'ok';
  switch (state.problem) {
    case 'ds-silent':
      return 'the DS sends the robot nothing (no control packets from the laptop)';
    case 'robot-silent':
      return `the DS sends to ${state.targets.join(', ')}, but no robot answers`;
    case 'not-delivered':
      return `the robot answers from ${state.robot}, but its replies aren't reaching the laptop`;
  }
}
