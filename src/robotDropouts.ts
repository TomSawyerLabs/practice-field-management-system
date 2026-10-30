import type { RobotDropout, RobotDropoutsState, StationDropouts, StationName } from './types.js';

/**
 * Short robot connection dropouts, and whether a brownout caused them.
 *
 * A Driver Station sends its robot a control packet (UDP 1110) every 20 ms,
 * and the roboRIO answers each with a status packet (UDP 1150) carrying the
 * battery voltage and a brownout bit. When the DS routes through pFMS both
 * cross the capture, so a gap in either says which end went quiet:
 *
 * - **robot**: the DS kept sending, and the robot answered none of it.
 * - **laptop**: the DS itself sent nothing (laptop Wi-Fi, or the DS stalled).
 *
 * A second without answers drops NetworkTables and dashboards, and the robot
 * disables, but it is far too short for the multi-second link checks
 * (src/robotLinkWatch.ts) or a telemetry chart sampled four times a second
 * to show. Team 114 lost about a second at a time on 2026-10-29, each time
 * with the battery sagging to 6.6 V (plans/team-114-nt-drops-2026-10-29.md).
 *
 * A dropout is blamed on a brownout when a reply shortly before or after it
 * has the brownout bit or a low battery: the replies stop during the
 * dropout, so the evidence is on either side. Each dropout is therefore
 * finalized a few seconds after it ends.
 *
 * Every packet is captured twice (arriving, and forwarded on); consecutive
 * copies share a sequence number and count once.
 */

/** Silence shorter than this is ordinary jitter. */
export const DROPOUT_MIN_MS = 500;
/** Silence longer than this is a reboot, battery swap or laptop leaving —
 *  reported elsewhere, not a dropout. */
export const DROPOUT_MAX_MS = 10_000;
/** Share of the DS's 50 Hz control packets that must keep arriving through
 *  a robot dropout for it to count as the robot's silence, not the DS's. */
const DS_KEPT_SENDING = 0.5;
const DS_PERIOD_MS = 20;
/** Battery below this counts as a brownout even without the bit (the
 *  roboRIO's own brownout threshold is 6.8 V). */
export const BROWNOUT_VOLTS = 7.0;
/** How far before and after a dropout a brownout still explains it. */
const CAUSE_BEFORE_MS = 2_000;
const CAUSE_AFTER_MS = 3_000;
/** Brownout samples closer together than this are one episode. */
const BROWNOUT_EPISODE_GAP_MS = 1_000;
/** A station quiet this long starts a fresh visit. */
const VISIT_IDLE_MS = 30 * 60_000;
/** Dropouts kept per station. */
const MAX_DROPOUTS = 50;
/** Battery history is kept as per-bucket minimums. */
const BUCKET_MS = 100;
const HISTORY_MS = 30_000;

type PowerBucket = { at: number; minV?: number; brownout: boolean };

type Station = {
  team: number;
  since: number;
  lastPacketAt: number;
  lastControlSeq?: number;
  lastControlAt?: number;
  lastForwardedSeq?: number;
  lastReplySeq?: number;
  lastReplyAt?: number;
  /** Distinct control packets forwarded to the robot since the last reply. */
  controlsSinceReply: number;
  buckets: PowerBucket[];
  pending: RobotDropout[];
  dropouts: RobotDropout[];
  brownouts: StationDropouts['brownouts'];
  lastBrownoutAt?: number;
};

export interface ReplySample {
  brownout: boolean;
  batteryVoltage?: number;
}

export class RobotDropoutTracker {
  private stations = new Map<StationName, Station>();
  /** Bumped on every change, so the broadcaster can skip unchanged snapshots. */
  private version = 0;

  constructor(private readonly onDropout?: (station: StationName, team: number, dropout: RobotDropout) => void) {}

  /**
   * A DS→robot control packet, by its sequence number. `forwarded` is the
   * copy pFMS sent on towards the robot (its source is on the robot's
   * subnet); the other is the copy arriving from the laptop. A DS wired onto
   * the robot's own network has only the one copy, which is both.
   *
   * The laptop's silence is judged by arriving copies, the robot's by
   * forwarded ones: while a team Stop's cut drops a robot's control
   * traffic the laptop is still sending, but nothing reaches the robot to
   * answer.
   */
  control(
    station: StationName,
    team: number,
    seq: number,
    at: number,
    copy: { arriving: boolean; forwarded: boolean },
  ): void {
    const s = this.station(station, team, at);
    if (copy.arriving && seq !== s.lastControlSeq) {
      s.lastControlSeq = seq;
      const gap = s.lastControlAt === undefined ? 0 : at - s.lastControlAt;
      if (gap >= DROPOUT_MIN_MS && gap <= DROPOUT_MAX_MS) {
        s.pending.push({ kind: 'laptop', cause: 'unknown', startedAt: s.lastControlAt!, endedAt: at, durationMs: gap });
      }
      s.lastControlAt = at;
    }
    if (copy.forwarded && seq !== s.lastForwardedSeq) {
      s.lastForwardedSeq = seq;
      s.controlsSinceReply++;
    }
  }

  /** A robot→DS status packet answering control packet `seq`. */
  reply(station: StationName, team: number, seq: number, at: number, sample: ReplySample): void {
    const s = this.station(station, team, at);
    if (seq === s.lastReplySeq) return;
    s.lastReplySeq = seq;
    this.notePower(s, at, sample);

    const gap = s.lastReplyAt === undefined ? 0 : at - s.lastReplyAt;
    // The control packet this reply answers is among those counted.
    const unanswered = Math.max(0, s.controlsSinceReply - 1);
    if (gap >= DROPOUT_MIN_MS && gap <= DROPOUT_MAX_MS && unanswered >= (gap / DS_PERIOD_MS) * DS_KEPT_SENDING) {
      s.pending.push({
        kind: 'robot',
        cause: 'unknown',
        startedAt: s.lastReplyAt!,
        endedAt: at,
        durationMs: gap,
        unanswered,
      });
    }
    s.lastReplyAt = at;
    s.controlsSinceReply = 0;
  }

  /** Finalize dropouts whose look-ahead has passed. Call every second or so. */
  tick(now: number): void {
    for (const [name, s] of this.stations) {
      const ready = s.pending.filter(d => now - d.endedAt >= CAUSE_AFTER_MS);
      if (ready.length === 0) continue;
      s.pending = s.pending.filter(d => now - d.endedAt < CAUSE_AFTER_MS);
      for (const d of ready) {
        this.explain(s, d);
        s.dropouts.push(d);
        this.onDropout?.(name, s.team, d);
      }
      s.dropouts.sort((a, b) => a.startedAt - b.startedAt);
      if (s.dropouts.length > MAX_DROPOUTS) s.dropouts.splice(0, s.dropouts.length - MAX_DROPOUTS);
      this.version++;
    }
  }

  /** Change counter; a new value means `snapshot()` changed. */
  getVersion(): number {
    return this.version;
  }

  snapshot(): RobotDropoutsState {
    const stations: RobotDropoutsState['stations'] = {};
    for (const [name, s] of this.stations) {
      if (s.dropouts.length === 0 && s.brownouts.count === 0) continue;
      stations[name] = { team: s.team, since: s.since, dropouts: [...s.dropouts], brownouts: { ...s.brownouts } };
    }
    return { type: 'robotDropouts', stations };
  }

  private station(name: StationName, team: number, at: number): Station {
    let s = this.stations.get(name);
    if (!s || s.team !== team || at - s.lastPacketAt > VISIT_IDLE_MS) {
      const hadHistory = Boolean(s && (s.dropouts.length > 0 || s.brownouts.count > 0));
      s = {
        team,
        since: at,
        lastPacketAt: at,
        controlsSinceReply: 0,
        buckets: [],
        pending: [],
        dropouts: [],
        brownouts: { count: 0 },
      };
      this.stations.set(name, s);
      if (hadHistory) this.version++;
    }
    s.lastPacketAt = at;
    return s;
  }

  private notePower(s: Station, at: number, { brownout, batteryVoltage }: ReplySample): void {
    const low = brownout || (batteryVoltage !== undefined && batteryVoltage < BROWNOUT_VOLTS);
    if (low) {
      if (s.lastBrownoutAt === undefined || at - s.lastBrownoutAt > BROWNOUT_EPISODE_GAP_MS) {
        s.brownouts.count++;
        this.version++;
      }
      s.lastBrownoutAt = at;
      s.brownouts.lastAt = at;
      if (
        batteryVoltage !== undefined &&
        (s.brownouts.minVoltage === undefined || batteryVoltage < s.brownouts.minVoltage)
      ) {
        s.brownouts.minVoltage = batteryVoltage;
        this.version++;
      }
    }

    const bucketAt = at - (at % BUCKET_MS);
    let last = s.buckets.at(-1);
    if (!last || last.at !== bucketAt) {
      last = { at: bucketAt, brownout: false };
      s.buckets.push(last);
      const cutoff = at - HISTORY_MS;
      while (s.buckets.length > 0 && s.buckets[0].at < cutoff) s.buckets.shift();
    }
    if (low) last.brownout = true;
    if (batteryVoltage !== undefined && (last.minV === undefined || batteryVoltage < last.minV))
      last.minV = batteryVoltage;
  }

  /** Fill in a dropout's cause and lowest nearby battery from the replies
   *  around it. Only the robot's own silence is blamed on its power: a DS
   *  that stopped sending did so whatever the battery was doing. */
  private explain(s: Station, d: RobotDropout): void {
    const from = d.startedAt - CAUSE_BEFORE_MS;
    const to = d.endedAt + CAUSE_AFTER_MS;
    for (const b of s.buckets) {
      if (b.at + BUCKET_MS <= from || b.at > to) continue;
      if (b.brownout && d.kind === 'robot') d.cause = 'brownout';
      if (b.minV !== undefined && (d.minBatteryVoltage === undefined || b.minV < d.minBatteryVoltage)) {
        d.minBatteryVoltage = b.minV;
      }
    }
  }
}

/** One journal line for a finalized dropout. */
export function describeDropout(station: StationName, team: number, d: RobotDropout): string {
  const secs = `${(d.durationMs / 1000).toFixed(1)}s`;
  const battery = d.minBatteryVoltage !== undefined ? `, battery down to ${d.minBatteryVoltage.toFixed(1)} V` : '';
  if (d.kind === 'laptop') {
    return `Dropout on ${station} (${team}): the Driver Station sent its robot nothing for ${secs} (laptop side)${battery}`;
  }
  const cause = d.cause === 'brownout' ? ' — brownout' : '';
  return `Dropout on ${station} (${team}): the robot answered none of ${d.unanswered ?? '?'} control packets for ${secs}${cause}${battery}`;
}
