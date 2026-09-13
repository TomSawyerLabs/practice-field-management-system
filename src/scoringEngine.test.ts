import { describe, expect, test } from 'bun:test';
import { ScoringEngine, resolveOccurredAt } from './scoringEngine.js';
import type { MatchConfig, MatchPhase, MatchState, StationControlState } from './types.js';

const CONFIG: MatchConfig = { autoDuration: 20, teleopDuration: 140, endgameDuration: 30, pauseDuration: 3 };

function station(alliance: 'red' | 'blue'): StationControlState {
  return {
    teamNumber: alliance === 'red' ? 1234 : 5678,
    enabled: false,
    eStop: false,
    aStop: false,
    mode: 'teleOp',
    joined: true,
    ready: true,
    alliance,
    matchSlot: `${alliance}1`,
    disabledBy: null,
  };
}

function state(
  phase: MatchPhase,
  remainingTime: number,
  extra: Partial<Pick<MatchState, 'autoWinnerAlliance' | 'pausedFrom' | 'awaitingAutoWinner'>> = {},
): MatchState {
  return {
    type: 'matchState',
    phase,
    remainingTime,
    totalMatchTime: 0,
    config: CONFIG,
    stationStates: { slot1: station('red'), slot4: station('blue') },
    connectedStations: {},
    readyRequested: true,
    staffStates: {
      headRef: { ready: true, ignored: false, connected: false },
      scorekeeper: { ready: true, ignored: false, connected: false },
      safety: { ready: true, ignored: false, connected: false },
    },
    ...extra,
  };
}

// Well in the past so nothing here is inside the live free-play window.
const T0 = Date.now() - 3_600_000;
const s = (seconds: number) => T0 + seconds * 1000;

/** An engine that has seen: countdown at 0 s, auto 3–23 s, autoPause 23–26 s, teleop from 26 s (red won auto). */
function engineInTeleop(): ScoringEngine {
  const engine = new ScoringEngine();
  engine.setElements([{ id: 'goal', name: 'Goal', pointValue: 1 }]);
  engine.onMatchStateChange(state('idle', 0), s(-1));
  engine.onMatchStateChange(state('countdown', 3), s(0));
  engine.onMatchStateChange(state('auto', 20), s(3));
  engine.onMatchStateChange(state('auto', 0.1), s(22.9));
  engine.onMatchStateChange(state('autoPause', 3), s(23.1));
  engine.onMatchStateChange(state('autoPause', 0.1), s(25.9));
  engine.onMatchStateChange(state('teleop', 140, { autoWinnerAlliance: 'red' }), s(26.1));
  return engine;
}

const goal = (alliance: 'red' | 'blue', ageMs?: number) => ({ source: 'counter', alliance, element: 'goal', ageMs });

describe('resolveOccurredAt', () => {
  test('ageMs wins and needs no clock agreement', () => {
    expect(resolveOccurredAt({ ...goal('red', 1500), timestamp: 5 }, 10_000)).toEqual({
      occurredAt: 8500,
      timing: 'age',
    });
  });
  test('negative age is clamped to now', () => {
    expect(resolveOccurredAt(goal('red', -50), 10_000).occurredAt).toBe(10_000);
  });
  test('a plausible timestamp is used when ageMs is absent', () => {
    expect(resolveOccurredAt({ ...goal('red'), timestamp: 9000 }, 10_000)).toEqual({
      occurredAt: 9000,
      timing: 'timestamp',
    });
  });
  test('a timestamp from the future or a bogus clock falls back to receive time', () => {
    expect(resolveOccurredAt({ ...goal('red'), timestamp: 20_000 }, 10_000).timing).toBe('receive');
    expect(resolveOccurredAt({ ...goal('red'), timestamp: 10_000 - 2 * 3_600_000 }, 10_000).timing).toBe('receive');
  });
  test('no timing info means receive time', () => {
    expect(resolveOccurredAt(goal('red'), 10_000)).toEqual({ occurredAt: 10_000, timing: 'receive' });
  });
});

describe('ScoringEngine attribution at the moment the ball scored', () => {
  test('a lagging auto ball reported during the pause still counts for auto', () => {
    const engine = new ScoringEngine();
    engine.setElements([{ id: 'goal', name: 'Goal', pointValue: 1 }]);
    engine.onMatchStateChange(state('idle', 0), s(-1));
    engine.onMatchStateChange(state('countdown', 3), s(0));
    engine.onMatchStateChange(state('auto', 20), s(3));
    engine.onMatchStateChange(state('auto', 0.1), s(22.9));
    engine.onMatchStateChange(state('autoPause', 3), s(23.1));

    const e = engine.submitEvent(goal('red', 2000), s(24));
    expect(e).not.toBe('unknown_element');
    if (e === 'unknown_element') return;
    expect(e.occurredAt).toBe(s(22));
    expect(e.timing).toBe('age');
    expect(e.matchPhase).toBe('auto');
    expect(e.matchSubPeriod).toBe('auto');
    expect(engine.getState().periodBreakdown?.auto.red).toBe(1);
    expect(engine.getState().phaseBreakdown?.auto.red.total).toBe(1);
  });

  test('an untimed report just after a phase change keeps the old phase-grace behaviour', () => {
    const engine = new ScoringEngine();
    engine.setElements([{ id: 'goal', name: 'Goal', pointValue: 1 }]);
    engine.onMatchStateChange(state('idle', 0), s(-1));
    engine.onMatchStateChange(state('countdown', 3), s(0));
    engine.onMatchStateChange(state('auto', 20), s(3));
    engine.onMatchStateChange(state('auto', 0.1), s(22.9));
    engine.onMatchStateChange(state('autoPause', 3), s(23.1));

    const e = engine.submitEvent(goal('red'), s(24));
    if (e === 'unknown_element') throw new Error('unexpected');
    expect(e.timing).toBe('receive');
    expect(e.matchPhase).toBe('auto');
  });

  test('shift boundary: the reported age decides on-goal, grace, or off-goal', () => {
    const engine = engineInTeleop();
    // Transition 26.1–36.1 s, then shift 1: red's goal off from 36.1 s.
    const onGoal = engine.submitEvent(goal('red', 4600), s(40)); // scored 35.4 s
    const inGrace = engine.submitEvent(goal('red', 1500), s(40)); // scored 38.5 s (2.4 s after off)
    const offGoal = engine.submitEvent(goal('red', 500), s(40)); // scored 39.5 s (3.4 s after off)
    const blue = engine.submitEvent(goal('blue', 500), s(40));
    for (const e of [onGoal, inGrace, offGoal, blue]) if (e === 'unknown_element') throw new Error('unexpected');
    expect((onGoal as { goalInactive?: boolean }).goalInactive).toBeUndefined();
    expect((onGoal as { matchSubPeriod?: string }).matchSubPeriod).toBe('transition');
    expect((inGrace as { goalInactive?: boolean }).goalInactive).toBeUndefined();
    expect((inGrace as { matchSubPeriod?: string }).matchSubPeriod).toBe('shift1');
    expect((offGoal as { goalInactive?: boolean }).goalInactive).toBe(true);

    const st = engine.getState();
    expect(st.red.total).toBe(2);
    expect(st.inactiveScores?.red.total).toBe(1);
    expect(st.blue.total).toBe(1);
    expect(st.periodBreakdown?.transition.red).toBe(1);
    expect(st.periodBreakdown?.shift1.red).toBe(1);
    expect(st.periodBreakdown?.shift1.blue).toBe(1);
  });

  test('a ball that scored before the countdown ended is not part of the match', () => {
    const engine = engineInTeleop();
    const e = engine.submitEvent(goal('red', 29_000), s(30)); // scored 1 s: countdown
    if (e === 'unknown_element') throw new Error('unexpected');
    expect(e.outsideMatch).toBe(true);
    const st = engine.getState();
    expect(st.red.total).toBe(0);
    expect(st.inactiveScores?.red.total).toBe(0);
  });

  test('a ball older than the whole record is outside the match too', () => {
    const engine = engineInTeleop();
    const e = engine.submitEvent(goal('red', 60_000), s(30)); // scored 30 s before countdown
    if (e === 'unknown_element') throw new Error('unexpected');
    expect(e.outsideMatch).toBe(true);
  });

  test('an operator pause turns goals off after the grace', () => {
    const engine = engineInTeleop();
    engine.onMatchStateChange(state('paused', 135, { pausedFrom: 'teleop', autoWinnerAlliance: 'red' }), s(31));
    const inFlight = engine.submitEvent(goal('blue', 1000), s(33)); // scored 32 s
    const late = engine.submitEvent(goal('blue', 1000), s(40)); // scored 39 s
    for (const e of [inFlight, late]) if (e === 'unknown_element') throw new Error('unexpected');
    expect((inFlight as { goalInactive?: boolean }).goalInactive).toBeUndefined();
    expect((late as { goalInactive?: boolean }).goalInactive).toBe(true);
    expect((late as { matchSubPeriod?: string }).matchSubPeriod).toBe('transition');
    expect(engine.getState().blue.total).toBe(1);
  });

  test('a back-dated phase boundary re-judges balls already reported', () => {
    const engine = engineInTeleop();
    engine.onMatchStateChange(state('endgame', 30), s(136.1));
    engine.onMatchStateChange(state('endgame', 0.1), s(166));
    // Reported before the engine's next tick announced postMatch
    const e = engine.submitEvent(goal('red', 0), s(166.15));
    if (e === 'unknown_element') throw new Error('unexpected');
    expect(e.matchPhase).toBe('endgame');
    engine.onMatchStateChange(state('postMatch', 10), s(166.25)); // boundary back-dated to 166.1
    expect(e.matchPhase).toBe('postMatch');
    expect(e.matchSubPeriod).toBe('endgame');
    expect(engine.getState().phaseBreakdown?.postMatch.red.total).toBe(1);
    expect(engine.getState().red.total).toBe(1);
  });

  test('deduplication compares when the balls scored, not when they were reported', () => {
    const engine = engineInTeleop();
    engine.setElements([{ id: 'goal', name: 'Goal', pointValue: 1, deduplicationWindowMs: 1000 }]);
    const first = engine.submitEvent(goal('red', 0), s(30));
    const sameBall = engine.submitEvent(goal('red', 1400), s(31.5)); // scored 30.1 s
    const nextBall = engine.submitEvent(goal('red', 0), s(31.5));
    for (const e of [first, sameBall, nextBall]) if (e === 'unknown_element') throw new Error('unexpected');
    expect((first as { deduplicated: boolean }).deduplicated).toBe(false);
    expect((sameBall as { deduplicated: boolean }).deduplicated).toBe(true);
    expect((nextBall as { deduplicated: boolean }).deduplicated).toBe(false);
    expect(engine.getState().red.total).toBe(2);
  });

  test('source status reports the lag of the last report', () => {
    const engine = engineInTeleop();
    engine.submitEvent(goal('red', 1234), s(30));
    const src = engine.getState().sources.counter;
    expect(src.lastLagMs).toBe(1234);
    expect(src.lastTiming).toBe('age');
  });

  test('the score timeline is built from when balls scored', () => {
    const engine = engineInTeleop();
    engine.submitEvent(goal('red', 5000), s(35)); // 30 s
    engine.submitEvent(goal('blue', 0), s(35)); // 35 s
    engine.submitEvent(goal('red', 100), s(35.2)); // 35.1 s
    expect(engine.getMatchScoreTimeline(s(3))).toEqual([
      { t: 0, red: 0, blue: 0 },
      { t: 27, red: 1, blue: 0 },
      { t: 32, red: 2, blue: 1 },
    ]);
  });
});

describe('ScoringEngine free play', () => {
  test('the sliding window is judged by when the ball scored', () => {
    const engine = new ScoringEngine();
    engine.setElements([{ id: 'goal', name: 'Goal', pointValue: 1 }]);
    const now = Date.now();
    engine.submitEvent(goal('red', 45_000), now); // older than the 30 s window
    engine.submitEvent(goal('blue', 1000), now);
    const st = engine.getState();
    expect(st.slidingWindow?.red.total).toBe(0);
    expect(st.slidingWindow?.blue.total).toBe(1);
  });
});
