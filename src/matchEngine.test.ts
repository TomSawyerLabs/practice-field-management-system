import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MatchEngine } from './matchEngine.js';
import { MatchHistoryStore } from './matchHistoryStore.js';
import { ScoringEngine } from './scoringEngine.js';
import { challengeScore, CHALLENGE_MAX_DURATION, CHALLENGE_MIN_DURATION, type MatchConfig } from './types.js';

/** A client asking for a config. Durations are only honoured for a challenge. */
function request(over: Partial<MatchConfig>): MatchConfig {
  return { autoDuration: 20, teleopDuration: 140, endgameDuration: 30, pauseDuration: 3, ...over };
}

function created(): MatchEngine {
  const engine = new MatchEngine();
  engine.createMatch();
  return engine;
}

describe('official match timing stays locked', () => {
  test('durations sent by a client are ignored', () => {
    const engine = created();
    engine.updateMatchConfig(request({ autoDuration: 5, teleopDuration: 42, endgameDuration: 1, pauseDuration: 0 }));
    const { config } = engine.getState();
    expect(config.autoDuration).toBe(20);
    expect(config.teleopDuration).toBe(140);
    expect(config.endgameDuration).toBe(30);
    expect(config.pauseDuration).toBe(3);
    expect(config.format ?? 'official').toBe('official');
  });

  test('skipAuto and autoWinner still come through', () => {
    const engine = created();
    engine.updateMatchConfig(request({ skipAuto: true, autoWinner: 'blue' }));
    const { config } = engine.getState();
    expect(config.skipAuto).toBe(true);
    expect(config.autoWinner).toBe('blue');
  });
});

describe('challenge format', () => {
  test('unlocks the window and zeroes everything else', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 45 }));
    const { config } = engine.getState();
    expect(config.format).toBe('challenge');
    expect(config.teleopDuration).toBe(45);
    expect(config.autoDuration).toBe(0);
    expect(config.pauseDuration).toBe(0);
    expect(config.endgameDuration).toBe(0);
    expect(config.skipAuto).toBe(true);
    expect(config.challengeTiming).toBe('window');
  });

  test('clamps a window that would strand the field', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 100_000 }));
    expect(engine.getState().config.teleopDuration).toBe(CHALLENGE_MAX_DURATION);

    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 0 }));
    expect(engine.getState().config.teleopDuration).toBe(CHALLENGE_MIN_DURATION);
  });

  test('stopwatch timing is carried', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', challengeTiming: 'stopwatch' }));
    expect(engine.getState().config.challengeTiming).toBe('stopwatch');
  });

  test('reports no sub-period and no inactive goal', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60 }));
    const state = engine.getState();
    expect(state.subPeriod).toBeNull();
    expect(state.inactiveGoalAlliance).toBeNull();
  });

  test('the format carries over to the next run, the rest resets', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 90, challengeTiming: 'stopwatch' }));
    engine.cancelMatch();
    engine.createMatch();
    const { config } = engine.getState();
    expect(config.format).toBe('challenge');
    expect(config.teleopDuration).toBe(90);
    expect(config.challengeTiming).toBe('stopwatch');
  });

  test('switching back to official restores official timing', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 90 }));
    engine.updateMatchConfig(request({ format: 'official' }));
    const { config } = engine.getState();
    expect(config.format ?? 'official').toBe('official');
    expect(config.teleopDuration).toBe(140);
    expect(config.autoDuration).toBe(20);
  });

  test('a created match starts official until a host asks otherwise', () => {
    const engine = created();
    expect(engine.getState().config.teleopDuration).toBe(140);
  });
});

describe('challengeScore', () => {
  test('window runs are worth their laps, less a lap per penalty', () => {
    expect(challengeScore({ laps: 7, penalties: 0 }, 'window')).toEqual({ laps: 7, seconds: null });
    expect(challengeScore({ laps: 7, penalties: 2 }, 'window')).toEqual({ laps: 5, seconds: null });
  });

  test('enough penalties push a run below zero, so it ranks behind a clean one', () => {
    expect(challengeScore({ laps: 1, penalties: 4 }, 'window').laps).toBe(-3);
  });

  test('stopwatch runs add five seconds per penalty', () => {
    expect(challengeScore({ laps: 1, penalties: 2, finishedAt: 30 }, 'stopwatch').seconds).toBe(40);
  });

  test('a stopwatch run that never finished has no time', () => {
    expect(challengeScore({ laps: 1, penalties: 0 }, 'stopwatch').seconds).toBeNull();
  });
});

describe('the challenge tally', () => {
  test('is refused when the field is not running a challenge', () => {
    const engine = created();
    engine.challengeAdjust('red', 1);
    expect(engine.getState().challenge).toBeUndefined();
  });

  test('is refused before the run starts, so stray taps do not count', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 30 }));
    engine.challengeAdjust('red', 5);
    expect(engine.getState().challenge?.red.laps).toBe(0);
  });
});

describe('a challenge run end to end', () => {
  /** Get a single robot onto the field and start the run. */
  function startRun(timing: 'window' | 'stopwatch') {
    const engine = new MatchEngine(() => 5940);
    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 30, challengeTiming: timing }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    engine.setReady('slot1', true);
    engine.startMatch();
    return engine;
  }

  test('counts down, runs the window with no auto, and tallies laps', async () => {
    const engine = startRun('window');
    expect(engine.getState().phase).toBe('countdown');

    await Bun.sleep(3400);
    const running = engine.getState();
    // Straight to the run — a challenge has no autonomous period
    expect(running.phase).toBe('teleop');
    expect(running.stationStates.slot1?.enabled).toBe(true);
    expect(running.stationStates.slot1?.mode).toBe('teleOp');
    expect(running.subPeriod).toBeNull();

    engine.challengeAdjust('red', 1);
    engine.challengeAdjust('red', 1);
    engine.challengeAdjust('red', 0, 1);
    const tally = engine.getState().challenge!.red;
    expect(tally.laps).toBe(2);
    expect(tally.penalties).toBe(1);

    // Corrections work, and nothing goes negative
    engine.challengeAdjust('red', -5, -5);
    expect(engine.getState().challenge!.red).toMatchObject({ laps: 0, penalties: 0 });
    engine.stopMatch();
  }, 10_000);

  test('finishing a stopwatch run stops the robot and ends the run', async () => {
    const engine = startRun('stopwatch');
    await Bun.sleep(3400);
    expect(engine.getState().phase).toBe('teleop');

    engine.challengeFinish('red');
    const finished = engine.getState();
    expect(finished.phase).toBe('postMatch');
    expect(finished.stationStates.slot1?.enabled).toBe(false);
    // The run proper started after the 3 s countdown
    expect(finished.challenge!.red.finishedAt).toBeGreaterThan(0);
    expect(finished.challenge!.red.finishedAt).toBeLessThan(2);
  }, 10_000);

  test('finish is refused when the run is timed by the window', async () => {
    const engine = startRun('window');
    await Bun.sleep(3400);
    engine.challengeFinish('red');
    expect(engine.getState().phase).toBe('teleop');
    expect(engine.getState().challenge!.red.finishedAt).toBeUndefined();
    engine.stopMatch();
  }, 10_000);
});

describe('a challenge run lands in match history', () => {
  test('carries its timing and per-alliance tally, and follows post-buzzer corrections', async () => {
    const file = join(tmpdir(), `pfms-history-${randomUUID()}.json`);
    const engine = new MatchEngine(() => 5940);
    const history = new MatchHistoryStore(file);
    history.attach(engine, new ScoringEngine());

    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 10 }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    engine.setReady('slot1', true);
    engine.startMatch();

    await Bun.sleep(3400);
    engine.challengeAdjust('red', 4);
    engine.stopMatch();

    const entry = history.getState().matches.at(-1)!;
    expect(entry.challenge).toEqual({ timing: 'window', tally: { red: { laps: 4, penalties: 0 } } });
    // Blue never took the field, so it isn't on the board at all
    expect(entry.challenge!.tally.blue).toBeUndefined();

    // A miscount noticed after the buzzer still makes it into the record
    engine.challengeAdjust('red', 1);
    expect(history.getState().matches.at(-1)!.challenge!.tally.red!.laps).toBe(5);

    rmSync(file, { force: true });
  }, 10_000);
});
