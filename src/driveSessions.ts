import { StationNameList, type StationName } from './types.js';
import { teamOfSsid } from './utils.js';

/**
 * Drive sessions: which Driver Station laptop drives which robot.
 *
 * A laptop drives a **robot**, not a slot. State here is keyed only by the
 * robot (its SSID, unique on the field) and by the laptop (its IP). The slot
 * a robot currently occupies is looked up from the radio config at the moment
 * something slot-shaped is needed — a kernel rule on the slot's bridge, the
 * match engine's per-station DS record, the broadcast to clients.
 *
 * So a slot changing hands needs no special case: the previous robot is no
 * longer on any slot, so its session ends; the new robot has no session, so
 * its team's laptop takes it with nothing in the way. (When this was keyed by
 * slot, the previous team's laptop kept the slot and the new team's only
 * laptop was refused as a "duplicate DS" — 2026-09-27, slots 1 and 4.) A
 * robot that moves to another slot keeps its session; its rules follow it.
 *
 * Kernel state (DNAT so the robot's UDP reaches the laptop, FORWARD drops for
 * a second laptop on the same robot, the laptop's route preference) is never
 * edited in place. One serialised `sync()` derives what should exist from the
 * sessions and the current radio config, and adds or removes the difference.
 */

/** A robot, named by its SSID. */
export type RobotId = string;

/** Robot UDP on `station`'s bridge, addressed to the team's gateway, is
 *  rewritten to the laptop. */
export type DnatRule = { station: StationName; team: number; dsIp: string };

/** A second laptop for the robot on `station` is kept off that robot's VLAN. */
export type BlockRule = { station: StationName; dsIp: string };

export interface DriveSessionEffects {
  /** The robot on a station right now (its SSID in the radio's active config). */
  robotOn(station: StationName): RobotId | null;
  addDnat(rule: DnatRule): Promise<void>;
  /** Delete `copies` copies of the rule (more than one only when a restart
   *  found duplicates in the kernel). */
  removeDnat(rule: DnatRule, copies: number): Promise<void>;
  addBlock(rule: BlockRule): Promise<void>;
  removeBlock(rule: BlockRule): Promise<void>;
  /** The station a laptop's route preference points at, or null. */
  routeOf(dsIp: string): StationName | null;
  setRoute(dsIp: string, station: StationName, team: number): Promise<void>;
  clearRoute(dsIp: string): Promise<void>;
  /** Tell the match engine which laptop is the DS for a station. Also its
   *  liveness feed, so it is called on every message from a driving laptop. */
  engineSetDs(station: StationName, dsIp: string): void;
  engineClearDs(station: StationName): void;
  /** Sessions or blocks changed (broadcast to clients). */
  changed(): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err: unknown): void;
  now(): number;
}

/** A laptop that has said nothing for this long no longer holds a robot.
 *  Liveness is activity-only, never "the TCP socket is open": team VLANs are
 *  masqueraded, and a laptop that vanishes without a FIN (laptop swap,
 *  unplugged cable) leaves an established socket behind for ~10 minutes —
 *  long enough to lock the replacement out (2854's laptop swap, 2026-07-12).
 *  A live DS always produces activity within seconds (UDP status at 2 Hz, or
 *  the ~6 s TCP reconnect cycle). */
export const DS_STALE_TIMEOUT_MS = 20_000;

/** Laptops idle this long, and not driving or blocked, are forgotten. */
const LAPTOP_FORGET_MS = 10 * 60_000;

type Laptop = { team: number | null; lastActivity: number };

export type StationSession = { dsIp: string; lastActivity: number; timeoutRemaining: number };

const dnatKey = (r: DnatRule) => `${r.station}|${r.team}|${r.dsIp}`;
const blockKey = (r: BlockRule) => `${r.station}|${r.dsIp}`;

export class DriveSessions {
  private readonly laptops = new Map<string, Laptop>();
  /** Robot → the laptop driving it. */
  private readonly sessions = new Map<RobotId, string>();
  /** Robot → further laptops for the same robot, held off its VLAN. */
  private readonly blocked = new Map<RobotId, Set<string>>();

  /** What sync() has put in the kernel, and what it told the engine and the
   *  route manager — so it can take exactly that away again. */
  private readonly installedDnat = new Map<string, { rule: DnatRule; copies: number }>();
  private readonly installedBlocks = new Map<string, BlockRule>();
  private readonly routed = new Set<string>();
  private readonly engineShown = new Map<StationName, string>();

  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  constructor(private readonly fx: DriveSessionEffects) {}

  // ── Inputs ─────────────────────────────────────────────────────────

  /**
   * A message from a Driver Station laptop. `team` is the team number when
   * the message carries one (handshakes, UDP status); telemetry-only
   * messages only prove the laptop is alive and are ignored for laptops we
   * have never heard a team number from (robot-network devices).
   */
  heard(dsIp: string, team?: number): void {
    const laptop = this.laptops.get(dsIp);
    if (!laptop && team === undefined) return;
    const now = this.fx.now();
    if (laptop) {
      laptop.lastActivity = now;
      if (team !== undefined) laptop.team = team;
    } else {
      this.laptops.set(dsIp, { team: team ?? null, lastActivity: now });
    }

    const driving = this.robotDrivenBy(dsIp);
    if (driving !== undefined) {
      if (team === undefined || teamOfSsid(driving) === team) {
        const station = this.stationOf(driving);
        if (station) this.fx.engineSetDs(station, dsIp); // liveness
        return;
      }
      // The DS on this laptop was switched to another team.
      this.endSession(driving, `laptop now says team ${team}`);
    }
    if (team === undefined) return;

    const robots = this.robotsOfTeam(team);
    // Two robots of one team: the laptop picks one with the Drive button.
    if (robots.length === 1) this.claim(robots[0], dsIp);
  }

  /** The Drive button: this laptop drives the robot on `station` (or, with
   *  null, stops driving). */
  drive(dsIp: string, station: StationName | null): void {
    const now = this.fx.now();
    const laptop = this.laptops.get(dsIp);
    if (laptop) laptop.lastActivity = now;
    else this.laptops.set(dsIp, { team: null, lastActivity: now });

    if (station === null) {
      const driving = this.robotDrivenBy(dsIp);
      if (driving !== undefined) this.endSession(driving, 'stopped from the Drive button');
      return;
    }
    const robot = this.fx.robotOn(station);
    if (!robot) return;
    this.claim(robot, dsIp);
  }

  /** The radio's active config changed: robots arrived, left, or moved. */
  configChanged(): void {
    for (const robot of [...this.sessions.keys()]) {
      if (!this.stationOf(robot)) this.endSession(robot, 'robot is no longer on the field');
    }
    for (const robot of [...this.blocked.keys()]) {
      if (!this.stationOf(robot)) this.blocked.delete(robot);
    }
    // A robot that just arrived may belong to a laptop that is already
    // talking to us — don't make it wait for its next handshake.
    for (const station of StationNameList) {
      const robot = this.fx.robotOn(station);
      if (!robot || this.sessions.has(robot)) continue;
      const team = teamOfSsid(robot);
      if (team === null || this.robotsOfTeam(team).length !== 1) continue;
      const waiting = [...this.laptops]
        .filter(([ip, l]) => l.team === team && !this.isStale(ip) && this.robotDrivenBy(ip) === undefined)
        .sort(([, a], [, b]) => b.lastActivity - a.lastActivity);
      if (waiting.length > 0) this.claim(robot, waiting[0][0]);
    }
    this.touch();
  }

  /** A laptop's TCP connection closed. Sessions survive it (the DS flaps
   *  every ~6 s out of a match); a block on it is lifted. */
  disconnected(dsIp: string): void {
    let changed = false;
    for (const ips of this.blocked.values()) changed = ips.delete(dsIp) || changed;
    this.pruneEmptyBlocks();
    if (changed) this.touch();
  }

  /** Every few seconds: end sessions whose laptop went quiet, lift blocks on
   *  quiet laptops, forget long-gone laptops, and re-sync the kernel. */
  sweep(): void {
    const now = this.fx.now();
    let changed = false;
    for (const [robot, ip] of [...this.sessions]) {
      if (this.isStale(ip)) {
        this.endSession(robot, `no activity for ${DS_STALE_TIMEOUT_MS / 1000}s`, { quiet: true });
        changed = true;
      }
    }
    for (const ips of this.blocked.values()) {
      for (const ip of [...ips]) {
        if (this.isStale(ip)) {
          ips.delete(ip);
          changed = true;
        }
      }
    }
    this.pruneEmptyBlocks();
    for (const [ip, laptop] of [...this.laptops]) {
      if (now - laptop.lastActivity < LAPTOP_FORGET_MS) continue;
      if (this.robotDrivenBy(ip) !== undefined || this.isBlocked(ip)) continue;
      this.laptops.delete(ip);
    }
    if (changed) this.touch();
    else void this.sync();
  }

  /**
   * After a graceful restart the kernel still holds the rules the previous
   * process installed. Adopt them: each DNAT rule becomes a session again if
   * the robot now on that slot is of the rule's team (so robots stay
   * connected across a reload), and anything left over is removed by sync().
   * A laptop that never speaks again is swept after DS_STALE_TIMEOUT_MS.
   */
  restore(dnat: DnatRule[], blocks: BlockRule[]): void {
    const now = this.fx.now();
    for (const rule of dnat) {
      const key = dnatKey(rule);
      const existing = this.installedDnat.get(key);
      this.installedDnat.set(key, { rule, copies: (existing?.copies ?? 0) + 1 });
      const robot = this.fx.robotOn(rule.station);
      if (!robot || teamOfSsid(robot) !== rule.team || this.sessions.has(robot)) continue;
      this.laptops.set(rule.dsIp, { team: rule.team, lastActivity: now });
      this.sessions.set(robot, rule.dsIp);
      this.fx.info(`Restored drive session: ${rule.dsIp} → ${robot} on ${rule.station}`);
    }
    for (const rule of blocks) this.installedBlocks.set(blockKey(rule), rule);
    this.touch();
  }

  // ── Views (slot-shaped, derived now) ───────────────────────────────

  /** The laptop driving whatever robot is on `station`. */
  laptopOn(station: StationName): string | undefined {
    const robot = this.fx.robotOn(station);
    return robot ? this.sessions.get(robot) : undefined;
  }

  /** Whether `dsIp` is a duplicate on `station`: another laptop is actively
   *  driving that robot, so this one will be held off it (the same test as
   *  claiming a robot). A duplicate must not be handed a station by the FMS
   *  handshake either — it would lock that laptop under field control. */
  isDuplicateOn(station: StationName, dsIp: string): boolean {
    const holder = this.laptopOn(station);
    return holder !== undefined && holder !== dsIp && !this.isStale(holder);
  }

  /** The station of the robot this laptop drives, if it is of `team`. Used
   *  to tell apart two robots of one team. */
  stationDrivenBy(dsIp: string, team: number): StationName | undefined {
    const robot = this.robotDrivenBy(dsIp);
    if (robot === undefined || teamOfSsid(robot) !== team) return undefined;
    return this.stationOf(robot) ?? undefined;
  }

  sessionsByStation(): Partial<Record<StationName, StationSession>> {
    const now = this.fx.now();
    const out: Partial<Record<StationName, StationSession>> = {};
    for (const [robot, dsIp] of this.sessions) {
      const station = this.stationOf(robot);
      if (!station) continue;
      const lastActivity = this.laptops.get(dsIp)?.lastActivity ?? now;
      const timeoutRemaining = Math.round(Math.max(0, (DS_STALE_TIMEOUT_MS - (now - lastActivity)) / 1000));
      out[station] = { dsIp, lastActivity, timeoutRemaining };
    }
    return out;
  }

  blockedByStation(): Partial<Record<StationName, string[]>> {
    const out: Partial<Record<StationName, string[]>> = {};
    for (const [robot, ips] of this.blocked) {
      const station = this.stationOf(robot);
      if (station && ips.size > 0) out[station] = [...ips];
    }
    return out;
  }

  // ── Kernel / engine / route sync ───────────────────────────────────

  /** Bring the kernel rules and route preferences in line with the sessions.
   *  Serialised: a call while one is running makes it run once more. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const wantDnat = new Map<string, DnatRule>();
    const wantBlocks = new Map<string, BlockRule>();
    const wantRoutes = new Map<string, { station: StationName; team: number }>();
    for (const [robot, dsIp] of this.sessions) {
      const station = this.stationOf(robot);
      const team = teamOfSsid(robot);
      if (!station || team === null) continue;
      const rule = { station, team, dsIp };
      wantDnat.set(dnatKey(rule), rule);
      wantRoutes.set(dsIp, { station, team });
    }
    for (const [robot, ips] of this.blocked) {
      const station = this.stationOf(robot);
      if (!station) continue;
      for (const dsIp of ips) wantBlocks.set(blockKey({ station, dsIp }), { station, dsIp });
    }

    // Take away first, so a rule for the slot's previous robot is gone
    // before the next robot's rule goes in.
    // A failed removal stays recorded, so the next sync tries again.
    for (const [key, { rule, copies }] of [...this.installedDnat]) {
      if (wantDnat.has(key)) continue;
      if (!(await this.attempt(() => this.fx.removeDnat(rule, copies), `remove DNAT ${rule.station} → ${rule.dsIp}`)))
        continue;
      this.installedDnat.delete(key);
      this.fx.info(`DNAT rule removed: ${rule.station} → ${rule.dsIp}${copies > 1 ? ` (${copies} copies)` : ''}`);
    }
    for (const [key, rule] of [...this.installedBlocks]) {
      if (wantBlocks.has(key)) continue;
      if (!(await this.attempt(() => this.fx.removeBlock(rule), `unblock ${rule.dsIp} on ${rule.station}`))) continue;
      this.installedBlocks.delete(key);
      this.fx.info(`Unblocked duplicate DS ${rule.dsIp} for ${rule.station}`);
    }
    for (const dsIp of [...this.routed]) {
      if (wantRoutes.has(dsIp)) continue;
      if (await this.attempt(() => this.fx.clearRoute(dsIp), `clear route preference for ${dsIp}`)) {
        this.routed.delete(dsIp);
      }
    }

    for (const [key, rule] of wantDnat) {
      if (this.installedDnat.has(key)) continue;
      if (await this.attempt(() => this.fx.addDnat(rule), `add DNAT ${rule.station} → ${rule.dsIp}`)) {
        this.installedDnat.set(key, { rule, copies: 1 });
        this.fx.info(`DNAT rule added: ${rule.station} (team ${rule.team}) → ${rule.dsIp}`);
      }
    }
    for (const [key, rule] of wantBlocks) {
      if (this.installedBlocks.has(key)) continue;
      if (await this.attempt(() => this.fx.addBlock(rule), `block ${rule.dsIp} on ${rule.station}`)) {
        this.installedBlocks.set(key, rule);
      }
    }
    for (const [dsIp, { station, team }] of wantRoutes) {
      // Re-checked every sync: the route manager drops a preference on its
      // own when a slot's team changes, possibly after we re-pointed it.
      if (this.fx.routeOf(dsIp) === station) {
        this.routed.add(dsIp);
        continue;
      }
      if (await this.attempt(() => this.fx.setRoute(dsIp, station, team), `route ${dsIp} → ${station}`)) {
        this.routed.add(dsIp);
      }
    }
  }

  private async attempt(op: () => Promise<void>, what: string): Promise<boolean> {
    try {
      await op();
      return true;
    } catch (err) {
      this.fx.error(`Drive session sync: failed to ${what}`, err);
      return false;
    }
  }

  /** Keep the match engine's per-station DS record in step with the
   *  sessions: a station shows the laptop driving the robot now on it. */
  private syncEngine(): void {
    const want = new Map<StationName, string>();
    for (const [robot, dsIp] of this.sessions) {
      const station = this.stationOf(robot);
      if (station) want.set(station, dsIp);
    }
    for (const station of [...this.engineShown.keys()]) {
      if (want.has(station)) continue;
      this.engineShown.delete(station);
      this.fx.engineClearDs(station);
    }
    for (const [station, dsIp] of want) {
      if (this.engineShown.get(station) === dsIp) continue;
      this.engineShown.set(station, dsIp);
      this.fx.engineSetDs(station, dsIp);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  /** Give `robot` to `dsIp`, unless another laptop is actively driving it —
   *  then `dsIp` is the duplicate and is held off the robot's VLAN. */
  private claim(robot: RobotId, dsIp: string): boolean {
    const holder = this.sessions.get(robot);
    if (holder === dsIp) return true;
    if (holder !== undefined && !this.isStale(holder)) {
      const ips = this.blocked.get(robot) ?? new Set<string>();
      if (!ips.has(dsIp)) {
        ips.add(dsIp);
        this.blocked.set(robot, ips);
        this.fx.warn(
          `Blocked duplicate DS ${dsIp} for ${robot} on ${this.stationOf(robot) ?? '?'} (driven by ${holder})`,
        );
        this.touch();
      }
      return false;
    }
    if (holder !== undefined) this.fx.info(`DS takeover: ${dsIp} replacing stale DS ${holder} on ${robot}`);
    // A laptop drives one robot at a time.
    const previous = this.robotDrivenBy(dsIp);
    if (previous !== undefined) this.endSession(previous, `laptop switched to ${robot}`, { quiet: true });
    this.sessions.set(robot, dsIp);
    this.blocked.get(robot)?.delete(dsIp);
    this.pruneEmptyBlocks();
    this.fx.info(`Drive started: ${dsIp} → ${robot} on ${this.stationOf(robot) ?? '?'}`);
    this.touch();
    return true;
  }

  private endSession(robot: RobotId, why: string, { quiet = false } = {}): void {
    const dsIp = this.sessions.get(robot);
    if (dsIp === undefined) return;
    this.sessions.delete(robot);
    this.fx.info(`Drive session ended: ${dsIp} → ${robot} (${why})`);
    // Nobody is driving it now, so nobody is a duplicate of anybody.
    this.blocked.delete(robot);
    if (!quiet) this.touch();
  }

  /** Something changed: update the engine now, the kernel in the background,
   *  and tell clients. */
  private touch(): void {
    this.syncEngine();
    void this.sync();
    this.fx.changed();
  }

  private stationOf(robot: RobotId): StationName | null {
    for (const station of StationNameList) if (this.fx.robotOn(station) === robot) return station;
    return null;
  }

  private robotsOfTeam(team: number): RobotId[] {
    const out: RobotId[] = [];
    for (const station of StationNameList) {
      const robot = this.fx.robotOn(station);
      if (robot && teamOfSsid(robot) === team) out.push(robot);
    }
    return out;
  }

  private robotDrivenBy(dsIp: string): RobotId | undefined {
    for (const [robot, ip] of this.sessions) if (ip === dsIp) return robot;
    return undefined;
  }

  private isBlocked(dsIp: string): boolean {
    for (const ips of this.blocked.values()) if (ips.has(dsIp)) return true;
    return false;
  }

  private isStale(dsIp: string): boolean {
    const laptop = this.laptops.get(dsIp);
    return !laptop || this.fx.now() - laptop.lastActivity > DS_STALE_TIMEOUT_MS;
  }

  private pruneEmptyBlocks(): void {
    for (const [robot, ips] of [...this.blocked]) if (ips.size === 0) this.blocked.delete(robot);
  }
}
