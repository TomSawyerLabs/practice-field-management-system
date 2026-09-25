import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MatchEngine } from './matchEngine.js';
import { MatchHistoryStore } from './matchHistoryStore.js';
import { ScoringEngine } from './scoringEngine.js';
import {
  challengeScore,
  CHALLENGE_MAX_DURATION,
  CHALLENGE_MAX_PENALTY_SECONDS,
  CHALLENGE_MIN_DURATION,
  CHALLENGE_PENALTY_LAPS,
  CHALLENGE_PENALTY_SECONDS,
  type MatchConfig,
} from './types.js';

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

  test('penalty costs are settable, and carried with the config', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', challengePenaltyLaps: 3, challengePenaltySeconds: 10 }));
    const { config } = engine.getState();
    expect(config.challengePenaltyLaps).toBe(3);
    expect(config.challengePenaltySeconds).toBe(10);
  });

  test('a penalty may be made free, but not negative or absurd', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', challengePenaltyLaps: 0, challengePenaltySeconds: 0 }));
    expect(engine.getState().config.challengePenaltyLaps).toBe(0);
    expect(engine.getState().config.challengePenaltySeconds).toBe(0);

    engine.updateMatchConfig(request({ format: 'challenge', challengePenaltyLaps: -4, challengePenaltySeconds: 9999 }));
    expect(engine.getState().config.challengePenaltyLaps).toBe(0);
    expect(engine.getState().config.challengePenaltySeconds).toBe(CHALLENGE_MAX_PENALTY_SECONDS);
  });

  test('penalty costs default when a client says nothing', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge' }));
    const { config } = engine.getState();
    expect(config.challengePenaltyLaps).toBe(CHALLENGE_PENALTY_LAPS);
    expect(config.challengePenaltySeconds).toBe(CHALLENGE_PENALTY_SECONDS);
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
    engine.updateMatchConfig(
      request({ format: 'challenge', teleopDuration: 90, challengeTiming: 'stopwatch', challengePenaltySeconds: 2 }),
    );
    engine.cancelMatch();
    engine.createMatch();
    const { config } = engine.getState();
    expect(config.format).toBe('challenge');
    expect(config.teleopDuration).toBe(90);
    expect(config.challengeTiming).toBe('stopwatch');
    expect(config.challengePenaltySeconds).toBe(2);
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

  test('the cost of a penalty is whatever the run was set to', () => {
    expect(challengeScore({ laps: 7, penalties: 2 }, 'window', { penaltyLaps: 3 }).laps).toBe(1);
    expect(challengeScore({ laps: 1, penalties: 2, finishedAt: 30 }, 'stopwatch', { penaltySeconds: 10 }).seconds).toBe(
      50,
    );
  });

  test('a free penalty leaves the result alone', () => {
    expect(challengeScore({ laps: 7, penalties: 2 }, 'window', { penaltyLaps: 0 }).laps).toBe(7);
    expect(challengeScore({ laps: 1, penalties: 2, finishedAt: 30 }, 'stopwatch', { penaltySeconds: 0 }).seconds).toBe(
      30,
    );
  });

  test('a run recorded before costs were settable scores the way it did then', () => {
    expect(challengeScore({ laps: 7, penalties: 2 }, 'window', {}).laps).toBe(5);
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
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 10, challengePenaltyLaps: 2 }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    engine.setReady('slot1', true);
    engine.startMatch();

    await Bun.sleep(3400);
    engine.challengeAdjust('red', 4);
    engine.stopMatch();

    const entry = history.getState().matches.at(-1)!;
    expect(entry.challenge).toEqual({
      timing: 'window',
      // Recorded with the run, so a later change of heart can't re-score it
      penaltyLaps: 2,
      penaltySeconds: CHALLENGE_PENALTY_SECONDS,
      tally: { red: { laps: 4, penalties: 0 } },
    });
    // Blue never took the field, so it isn't on the board at all
    expect(entry.challenge!.tally.blue).toBeUndefined();

    // A miscount noticed after the buzzer still makes it into the record
    engine.challengeAdjust('red', 1);
    expect(history.getState().matches.at(-1)!.challenge!.tally.red!.laps).toBe(5);

    rmSync(file, { force: true });
  }, 10_000);
});

/** Robots on both alliances, all readied, started. Returns after the horn. */
async function startRace(config: Partial<MatchConfig>, stations: Record<string, 'red' | 'blue'>) {
  const engine = new MatchEngine(() => 5940);
  engine.createMatch();
  engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60, ...config }));
  for (const [station, alliance] of Object.entries(stations)) {
    engine.joinStationAlliance(station as 'slot1', alliance);
  }
  for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
  engine.setReadyRequested(true);
  for (const station of Object.keys(stations)) engine.setReady(station as 'slot1', true);
  engine.startMatch();
  await Bun.sleep(3400);
  expect(engine.getState().phase).toBe('teleop');
  return engine;
}

describe('a stopwatch race holds a finished alliance down', () => {
  test('through a pause and resume, and against the re-enable button', async () => {
    const engine = await startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red', slot2: 'blue' });
    engine.challengeFinish('red');
    let s = engine.getState();
    expect(s.stationStates.slot1?.enabled).toBe(false);
    expect(s.stationStates.slot2?.enabled).toBe(true);
    expect(s.phase).toBe('teleop');
    expect(s.runElapsed).toBeGreaterThanOrEqual(0);
    expect(s.challenge!.red.finishedAt).toBeLessThan(1);

    // Neither the team nor the admin console can put a finished robot back
    engine.undisable('slot1', false);
    engine.undisable('slot1', true);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);

    engine.pauseMatch();
    engine.resumeMatch();
    await Bun.sleep(3200);
    s = engine.getState();
    expect(s.phase).toBe('teleop');
    expect(s.stationStates.slot1?.enabled).toBe(false);
    expect(s.stationStates.slot2?.enabled).toBe(true);
    engine.stopMatch();
  }, 15_000);

  test('finish is refused for an alliance with nobody on the field', async () => {
    const engine = await startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red' });
    engine.challengeFinish('blue');
    expect(engine.getState().challenge!.blue.finishedAt).toBeUndefined();
    engine.stopMatch();
  }, 10_000);

  test('ends when the last robot still on the clock leaves', async () => {
    const engine = await startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red', slot2: 'blue' });
    engine.challengeFinish('red');
    engine.leaveStation('slot2');
    expect(engine.getState().phase).toBe('postMatch');
  }, 10_000);
});

describe('a relay with staff hand-offs', () => {
  test('runs one robot per alliance at a time and stops the clock on the last', async () => {
    const engine = await startRace(
      { challengeTiming: 'relay', relayHandoff: 'staff' },
      { slot1: 'red', slot2: 'red', slot3: 'blue' },
    );
    let s = engine.getState();
    expect(s.config.relayHandoff).toBe('staff');
    expect(s.stationStates.slot1?.enabled).toBe(true);
    expect(s.stationStates.slot2?.enabled).toBe(false);
    expect(s.stationStates.slot2?.disabledBy).toBe('relay');
    expect(s.stationStates.slot3?.enabled).toBe(true);

    // Not slot2's turn — the re-enable button does nothing
    engine.undisable('slot2', false);
    expect(engine.getState().stationStates.slot2?.enabled).toBe(false);

    // Finish is not how a relay ends
    engine.challengeFinish('red');
    expect(engine.getState().challenge!.red.finishedAt).toBeUndefined();

    engine.relayAdvance('red');
    s = engine.getState();
    expect(s.stationStates.slot1?.enabled).toBe(false);
    expect(s.stationStates.slot1?.disabledBy).toBe('relay');
    expect(s.stationStates.slot2?.enabled).toBe(true);
    expect(s.challenge!.red.splits).toHaveLength(1);
    expect(s.challenge!.red.finishedAt).toBeUndefined();

    // Pausing and resuming brings back only the current runners
    engine.pauseMatch();
    engine.resumeMatch();
    await Bun.sleep(3200);
    s = engine.getState();
    expect(s.stationStates.slot1?.enabled).toBe(false);
    expect(s.stationStates.slot2?.enabled).toBe(true);
    expect(s.stationStates.slot3?.enabled).toBe(true);

    engine.relayAdvance('red');
    s = engine.getState();
    expect(s.challenge!.red.splits).toHaveLength(2);
    expect(s.challenge!.red.finishedAt).toBe(s.challenge!.red.splits![1]);
    expect(s.stationStates.slot2?.enabled).toBe(false);
    expect(s.phase).toBe('teleop'); // blue is still out

    engine.relayAdvance('red'); // nothing left to advance
    expect(engine.getState().challenge!.red.splits).toHaveLength(2);

    engine.relayAdvance('blue');
    s = engine.getState();
    expect(s.challenge!.blue.finishedAt).toBeDefined();
    expect(s.phase).toBe('postMatch');
  }, 15_000);
});

describe('a relay with driver-station hand-offs', () => {
  test('the runner disabling itself sends the next robot', async () => {
    const engine = await startRace({ challengeTiming: 'relay', relayHandoff: 'ds' }, { slot1: 'red', slot2: 'red' });
    // The station console's own Disable counts
    engine.stationDisable('slot1', 'self');
    let s = engine.getState();
    expect(s.stationStates.slot2?.enabled).toBe(true);
    expect(s.challenge!.red.splits).toHaveLength(1);

    // A DS-reported disable counts too, once the post-enable grace has passed
    await Bun.sleep(2100);
    engine.dsReportedStatus('slot2', false, false, false, 0x00, true);
    s = engine.getState();
    expect(s.challenge!.red.finishedAt).toBeDefined();
    expect(s.phase).toBe('postMatch');
  }, 15_000);

  test('a disable from a robot that is not running is just a disable', async () => {
    const engine = await startRace({ challengeTiming: 'relay', relayHandoff: 'ds' }, { slot1: 'red', slot2: 'red' });
    engine.stationDisable('slot2', 'self');
    expect(engine.getState().challenge!.red.splits ?? []).toHaveLength(0);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(true);
    engine.stopMatch();
  }, 10_000);
});

describe('a manual relay', () => {
  test('enables everyone and ends on Finish', async () => {
    const engine = await startRace(
      { challengeTiming: 'relay', relayHandoff: 'manual' },
      { slot1: 'red', slot2: 'red', slot3: 'blue' },
    );
    const s = engine.getState();
    expect(s.stationStates.slot1?.enabled).toBe(true);
    expect(s.stationStates.slot2?.enabled).toBe(true);
    engine.relayAdvance('red'); // no FMS hand-offs in a manual relay
    expect(engine.getState().challenge!.red.splits).toBeUndefined();
    engine.challengeFinish('red');
    engine.challengeFinish('blue');
    expect(engine.getState().phase).toBe('postMatch');
  }, 10_000);
});
