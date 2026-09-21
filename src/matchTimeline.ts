import { isChallengeConfig, type Alliance, type MatchConfig, type MatchPhase, type MatchState } from './types.js';
import { getAllianceShiftState, getMatchSubPeriod, type MatchSubPeriod } from './shiftState.js';

/**
 * After a goal turns off (shift change or operator pause), balls already in
 * flight still count for this long. Measured in wall-clock time — a ball in
 * the air doesn't care whether the match clock is running.
 */
export const GOAL_GRACE_SECONDS = 3;
const GOAL_GRACE_MS = GOAL_GRACE_SECONDS * 1000;

/** Phases before the match proper — nothing scored here belongs to the match. */
const PRE_MATCH_PHASES: ReadonlySet<MatchPhase> = new Set(['idle', 'created', 'countdown']);

/**
 * Phase changes the match engine makes on its own when the previous phase's
 * clock runs out. Their true instant is when `remaining` reached the
 * threshold, not when the next 250 ms tick noticed — so those boundaries are
 * back-dated. Every other transition (pause, resume, stop, e-stop, abandon,
 * clear) is operator-driven and happens at broadcast time.
 */
const TIMER_TRANSITIONS: ReadonlySet<string> = new Set([
  'countdown>auto',
  'countdown>teleop',
  'auto>autoPause',
  'auto>teleop',
  'autoPause>teleop',
  'teleop>endgame',
  'teleop>postMatch',
  'endgame>postMatch',
]);

interface TimelineSample {
  /** Server wall clock (ms since epoch) this sample describes. */
  at: number;
  phase: MatchPhase;
  /** The phase that matters for shift scoring — the pre-pause phase while paused. */
  gamePhase: MatchPhase;
  /** Seconds remaining in `phase` at `at`. */
  remaining: number;
  /** True when the match clock is not running (paused, or autoPause awaiting a winner). */
  frozen: boolean;
  autoWinner: Alliance | null;
  config: MatchConfig | null;
  /** Wall clock when the current run of `phase` began. */
  phaseStartedAt: number;
}

/** What the match looked like at one instant. */
export interface MatchMoment {
  at: number;
  phase: MatchPhase;
  gamePhase: MatchPhase;
  /** Seconds remaining in `phase`, interpolated from the nearest earlier sample. */
  remaining: number;
  autoWinner: Alliance | null;
  config: MatchConfig | null;
  subPeriod: MatchSubPeriod | null;
  /** Alliance whose goal is inactive by REBUILT shift rules at this instant (null = both active). */
  inactiveGoal: Alliance | null;
  /** Wall clock when the current run of `phase` began. */
  phaseStartedAt: number;
}

/**
 * Whether a score for an alliance at some instant counts.
 *
 * - `active`: the goal was on.
 * - `grace`: the goal had turned off less than GOAL_GRACE_SECONDS earlier —
 *   the ball was in flight when it did, so it counts.
 * - `inactive`: the goal had been off for longer than the grace — off-goal.
 * - `outsideMatch`: before the match started (idle/created/countdown).
 */
export type GoalVerdict = 'active' | 'grace' | 'inactive' | 'outsideMatch';

/**
 * A record of the match engine's state over wall-clock time, so a score
 * event that reports *when* the ball actually scored can be judged against
 * the phase, sub-period and goal-active state at that instant rather than at
 * the instant the report arrived.
 *
 * Fed one sample per matchState broadcast (the engine ticks 4×/s while a
 * match runs). Remaining time between samples is interpolated from the
 * nearest earlier one — the engine itself decrements by wall-clock deltas,
 * so this is faithful. The record survives the end of the match so events
 * that trickle in during the post-match count still resolve, and is cleared
 * when the next match's countdown begins.
 */
export class MatchTimeline {
  private samples: TimelineSample[] = [];

  /** Forget everything (called when a new match begins). */
  reset(): void {
    this.samples = [];
  }

  /** Number of samples held (for tests/diagnostics). */
  get size(): number {
    return this.samples.length;
  }

  /** Record a matchState broadcast. */
  record(state: MatchState, now: number = Date.now()): void {
    const prev = this.samples[this.samples.length - 1];
    const phase = state.phase;

    // A new match: the previous one's history is no longer needed.
    if (phase === 'countdown' && (!prev || PRE_MATCH_PHASES.has(prev.phase)) && prev?.phase !== 'countdown') {
      this.samples = [];
    }
    const last = this.samples[this.samples.length - 1];

    const frozen =
      phase === 'paused' ||
      (phase === 'autoPause' && !!state.awaitingAutoWinner) ||
      phase === 'idle' ||
      phase === 'created';

    let at = now;
    let phaseStartedAt = now;
    if (last && last.phase === phase) {
      phaseStartedAt = last.phaseStartedAt;
      if (last.frozen && frozen && last.autoWinner === (state.autoWinnerAlliance ?? null)) {
        // Nothing is moving — collapse repeated samples so an idle field
        // doesn't accumulate one per heartbeat.
        this.samples.pop();
        at = last.at;
      }
    } else if (last && !last.frozen && TIMER_TRANSITIONS.has(`${last.phase}>${phase}`)) {
      // Timer-driven boundary: it really happened when the previous phase's
      // clock hit its threshold, which is up to one tick before we heard.
      const threshold = last.phase === 'teleop' && phase === 'endgame' ? (last.config?.endgameDuration ?? 0) : 0;
      const expected = last.at + Math.max(0, last.remaining - threshold) * 1000;
      if (expected < now) {
        at = Math.max(last.at, expected);
        phaseStartedAt = at;
      }
    }
    if (last && at < last.at) at = last.at;

    const gamePhase: MatchPhase = phase === 'paused' ? (state.pausedFrom ?? last?.gamePhase ?? 'teleop') : phase;

    this.samples.push({
      at,
      phase,
      gamePhase,
      remaining: Math.max(0, state.remainingTime),
      frozen,
      autoWinner: state.autoWinnerAlliance ?? null,
      config: state.config ?? null,
      phaseStartedAt,
    });
  }

  /** The match state at wall-clock instant `t`, or null if the record doesn't reach back that far. */
  at(t: number): MatchMoment | null {
    const s = this.sampleAtOrBefore(t);
    if (!s) return null;
    const remaining = s.frozen ? s.remaining : Math.max(0, s.remaining - (t - s.at) / 1000);
    const teleop = s.config?.teleopDuration ?? 0;
    const endgame = s.config?.endgameDuration ?? 0;
    const shifts = !!s.config && !isChallengeConfig(s.config);
    return {
      at: t,
      phase: s.phase,
      gamePhase: s.gamePhase,
      remaining,
      autoWinner: s.autoWinner,
      config: s.config,
      // A challenge run has no shifts. Deriving them anyway would read the
      // window as a 140 s teleop, invent a shift, and switch a goal off —
      // silently refusing balls scored during a field event.
      subPeriod: shifts ? getMatchSubPeriod(s.gamePhase, remaining, teleop) : null,
      inactiveGoal: shifts ? getAllianceShiftState(s.gamePhase, remaining, teleop, endgame, s.autoWinner) : null,
      phaseStartedAt: s.phaseStartedAt,
    };
  }

  /** The most recent recorded instant, or undefined when empty. */
  get latestAt(): number | undefined {
    return this.samples[this.samples.length - 1]?.at;
  }

  /**
   * Whether an alliance's goal counts a score at instant `t`. Null when the
   * record doesn't cover `t` (caller should fall back to "now").
   */
  classifyGoal(alliance: Alliance, t: number): GoalVerdict | null {
    const m = this.at(t);
    if (!m) return null;
    if (PRE_MATCH_PHASES.has(m.phase)) return 'outsideMatch';
    if (!isGoalOff(alliance, m)) return 'active';
    // The goal is off. Was it also off GOAL_GRACE_SECONDS ago? If not, it
    // turned off within the grace window and the ball was already in flight.
    const before = this.at(t - GOAL_GRACE_MS);
    if (before && !PRE_MATCH_PHASES.has(before.phase) && isGoalOff(alliance, before)) return 'inactive';
    return 'grace';
  }

  private sampleAtOrBefore(t: number): TimelineSample | undefined {
    const s = this.samples;
    let lo = 0;
    let hi = s.length - 1;
    if (hi < 0 || s[0].at > t) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].at <= t) lo = mid;
      else hi = mid - 1;
    }
    return s[lo];
  }
}

/** A goal is "off" while the match is paused or its shift makes it inactive. */
function isGoalOff(alliance: Alliance, m: MatchMoment): boolean {
  return m.phase === 'paused' || m.inactiveGoal === alliance;
}
