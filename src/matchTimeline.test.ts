import { describe, expect, test } from 'bun:test';
import { MatchTimeline } from './matchTimeline.js';
import type { Alliance, MatchConfig, MatchPhase, MatchState } from './types.js';

const CONFIG: MatchConfig = { autoDuration: 20, teleopDuration: 140, endgameDuration: 30, pauseDuration: 3 };

function state(
  phase: MatchPhase,
  remainingTime: number,
  extra: Partial<Pick<MatchState, 'autoWinnerAlliance' | 'pausedFrom' | 'awaitingAutoWinner' | 'config'>> = {},
): MatchState {
  return {
    type: 'matchState',
    phase,
    remainingTime,
    totalMatchTime: 0,
    config: CONFIG,
    stationStates: {},
    connectedStations: {},
    readyRequested: false,
    staffStates: {
      headRef: { ready: false, ignored: false, connected: false },
      scorekeeper: { ready: false, ignored: false, connected: false },
      safety: { ready: false, ignored: false, connected: false },
    },
    ...extra,
  };
}

const T0 = 1_700_000_000_000;

describe('MatchTimeline.at', () => {
  test('interpolates remaining time from the nearest earlier sample', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 100), T0);
    expect(tl.at(T0 + 2500)?.remaining).toBeCloseTo(97.5, 6);
    expect(tl.at(T0 + 2500)?.phase).toBe('teleop');
  });

  test('returns null before the first sample', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 100), T0);
    expect(tl.at(T0 - 1)).toBeNull();
  });

  test('back-dates a timer-driven phase boundary to when the clock ran out', () => {
    const tl = new MatchTimeline();
    tl.record(state('auto', 0.1), T0);
    tl.record(state('autoPause', 3), T0 + 250);
    // The boundary really happened at T0 + 100 ms
    expect(tl.at(T0 + 50)?.phase).toBe('auto');
    expect(tl.at(T0 + 150)?.phase).toBe('autoPause');
    expect(tl.at(T0 + 150)?.phaseStartedAt).toBe(T0 + 100);
  });

  test('back-dates teleop→endgame to the endgame threshold', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 30.2), T0);
    tl.record(state('endgame', 29.95), T0 + 250);
    expect(tl.at(T0 + 210)?.phase).toBe('endgame');
    expect(tl.at(T0 + 190)?.phase).toBe('teleop');
  });

  test('does not back-date operator-driven transitions', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 100), T0);
    tl.record(state('paused', 99, { pausedFrom: 'teleop' }), T0 + 1000);
    expect(tl.at(T0 + 999)?.phase).toBe('teleop');
    expect(tl.at(T0 + 1000)?.phase).toBe('paused');
  });

  test('freezes remaining time while paused and keeps the pre-pause sub-period', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 140), T0);
    tl.record(state('paused', 135, { pausedFrom: 'teleop' }), T0 + 5000);
    const m = tl.at(T0 + 60_000);
    expect(m?.phase).toBe('paused');
    expect(m?.gamePhase).toBe('teleop');
    expect(m?.remaining).toBe(135);
    expect(m?.subPeriod).toBe('transition');
  });

  test('freezes autoPause while awaiting a manual winner', () => {
    const tl = new MatchTimeline();
    tl.record(state('autoPause', 3, { awaitingAutoWinner: true }), T0);
    expect(tl.at(T0 + 10_000)?.remaining).toBe(3);
  });

  test('clears history when a new countdown begins and collapses idle samples', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 100), T0);
    tl.record(state('postMatch', 0), T0 + 1000);
    tl.record(state('idle', 0), T0 + 2000);
    tl.record(state('idle', 0), T0 + 3000);
    tl.record(state('idle', 0), T0 + 4000);
    expect(tl.size).toBe(3); // teleop, postMatch, one idle
    tl.record(state('countdown', 3), T0 + 5000);
    expect(tl.size).toBe(1);
    expect(tl.at(T0 + 1500)).toBeNull();
  });
});

describe('MatchTimeline.classifyGoal', () => {
  /** A teleop that started at T0 with red as auto winner (red's goal off in shifts 1 & 3). */
  function teleopFromT0(): MatchTimeline {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 140, { autoWinnerAlliance: 'red' }), T0);
    return tl;
  }
  const s = (seconds: number) => T0 + seconds * 1000;

  test('both goals active during the transition', () => {
    const tl = teleopFromT0();
    expect(tl.classifyGoal('red', s(5))).toBe('active');
    expect(tl.classifyGoal('blue', s(5))).toBe('active');
  });

  test('shift 1: winner goal grace then inactive, loser goal active', () => {
    const tl = teleopFromT0();
    expect(tl.classifyGoal('red', s(11))).toBe('grace');
    expect(tl.classifyGoal('red', s(12.9))).toBe('grace');
    expect(tl.classifyGoal('red', s(13.5))).toBe('inactive');
    expect(tl.classifyGoal('red', s(30))).toBe('inactive');
    expect(tl.classifyGoal('blue', s(30))).toBe('active');
  });

  test('shift 2: roles swap', () => {
    const tl = teleopFromT0();
    expect(tl.classifyGoal('blue', s(36))).toBe('grace');
    expect(tl.classifyGoal('blue', s(40))).toBe('inactive');
    expect(tl.classifyGoal('red', s(40))).toBe('active');
  });

  test('endgame: both active', () => {
    const tl = teleopFromT0();
    expect(tl.classifyGoal('red', s(120))).toBe('active');
    expect(tl.classifyGoal('blue', s(120))).toBe('active');
  });

  test('an operator pause is an off period with the same grace', () => {
    const tl = teleopFromT0();
    tl.record(state('paused', 135, { pausedFrom: 'teleop', autoWinnerAlliance: 'red' }), s(5));
    expect(tl.classifyGoal('red', s(6))).toBe('grace');
    expect(tl.classifyGoal('blue', s(7.9))).toBe('grace');
    expect(tl.classifyGoal('red', s(9))).toBe('inactive');
    expect(tl.classifyGoal('blue', s(60))).toBe('inactive');
    // Resume: goals come straight back on (no grace needed)
    tl.record(state('teleop', 135, { autoWinnerAlliance: 'red' }), s(90));
    expect(tl.classifyGoal('red', s(90.5))).toBe('active');
  });

  test('grace does not restart when a pause follows a shift change', () => {
    const tl = teleopFromT0();
    // Red's goal went off at 10 s; pause at 12 s. A ball at 14 s has been
    // "off" continuously for 4 s → inactive, even though the pause is fresh.
    tl.record(state('paused', 128, { pausedFrom: 'teleop', autoWinnerAlliance: 'red' }), s(12));
    expect(tl.classifyGoal('red', s(14))).toBe('inactive');
    // Blue's goal was on until the pause → grace at 14 s
    expect(tl.classifyGoal('blue', s(14))).toBe('grace');
  });

  test('scores before the countdown ends are outside the match', () => {
    const tl = new MatchTimeline();
    tl.record(state('countdown', 3), T0);
    tl.record(state('auto', 19.9), T0 + 3100); // back-dated to T0 + 3000
    expect(tl.classifyGoal('red', T0 + 1000)).toBe('outsideMatch');
    expect(tl.classifyGoal('red', T0 + 2999)).toBe('outsideMatch');
    expect(tl.classifyGoal('red', T0 + 3050)).toBe('active');
  });

  test('null when the record does not cover the instant', () => {
    const tl = new MatchTimeline();
    expect(tl.classifyGoal('red', T0)).toBeNull();
  });

  test('auto winner is applied from the sample in force at the instant', () => {
    const tl = new MatchTimeline();
    tl.record(state('teleop', 140, { autoWinnerAlliance: 'blue' }), T0);
    const inactive: Alliance | null | undefined = tl.at(s(20))?.inactiveGoal;
    expect(inactive).toBe('blue');
  });
});
