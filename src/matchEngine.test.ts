import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MatchEngine, RESTART_COOLDOWN_MS, SETUP_AUTO_CANCEL_MS, teamStopCut } from './matchEngine.js';
import { MatchHistoryStore } from './matchHistoryStore.js';
import { setBroadcast } from './appLogger.js';
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

type Station = Parameters<MatchEngine['setReady']>[0];

/** The station's Driver Station sends a status heartbeat (legacy 0x38: robot
 *  linked, disabled): the field can hear it, so the team may ready up. */
function dsAttached(engine: MatchEngine, station: Station) {
  engine.dsReportedStatus(station, false, false, false, 0x38, true);
}

/** The DS went quiet long enough for the FMS to consider it detached. */
function dsGoesQuiet(engine: MatchEngine, station: Station) {
  (engine as unknown as { lastDsHeartbeat: Map<string, number> }).lastDsHeartbeat.set(station, Date.now() - 6_000);
}

/** Run the 2 s readiness sweep now instead of waiting for its timer. */
function sweepReadiness(engine: MatchEngine) {
  (engine as unknown as { unreadyStationsWithoutDs(): boolean }).unreadyStationsWithoutDs();
}

/** The tests in a describe run the engine on a fake clock: timers and
 *  Date.now only move through elapse(), however busy the machine is. */
function useFakeClock() {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
}

const elapse = (ms: number) => jest.advanceTimersByTime(ms);

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
  useFakeClock();

  /** Get a single robot onto the field and start the run. */
  function startRun(timing: 'window' | 'stopwatch') {
    const engine = new MatchEngine(() => 5940);
    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 30, challengeTiming: timing }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.startMatch();
    return engine;
  }

  test('counts down, runs the window with no auto, and tallies laps', () => {
    const engine = startRun('window');
    expect(engine.getState().phase).toBe('countdown');

    elapse(3400);
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
  });

  test('finishing a stopwatch run stops the robot and ends the run', () => {
    const engine = startRun('stopwatch');
    elapse(3400);
    expect(engine.getState().phase).toBe('teleop');

    engine.challengeFinish('red');
    const finished = engine.getState();
    expect(finished.phase).toBe('postMatch');
    expect(finished.stationStates.slot1?.enabled).toBe(false);
    // The run proper started after the 3 s countdown
    expect(finished.challenge!.red.finishedAt).toBeGreaterThan(0);
    expect(finished.challenge!.red.finishedAt).toBeLessThan(2);
  });

  test('finish is refused when the run is timed by the window', () => {
    const engine = startRun('window');
    elapse(3400);
    engine.challengeFinish('red');
    expect(engine.getState().phase).toBe('teleop');
    expect(engine.getState().challenge!.red.finishedAt).toBeUndefined();
    engine.stopMatch();
  });
});

describe('a challenge run lands in match history', () => {
  useFakeClock();

  test('carries its timing and per-alliance tally, and follows post-buzzer corrections', () => {
    const file = join(tmpdir(), `pfms-history-${randomUUID()}.json`);
    const engine = new MatchEngine(() => 5940);
    const history = new MatchHistoryStore(file);
    history.attach(engine, new ScoringEngine());

    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 10, challengePenaltyLaps: 2 }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.startMatch();

    elapse(3400);
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
  });
});

describe('a match everyone walked away from', () => {
  useFakeClock();

  test('is still recorded, with every team that played', () => {
    const file = join(tmpdir(), `pfms-history-${randomUUID()}.json`);
    const engine = new MatchEngine(station => (station === 'slot1' ? 5940 : 254));
    const history = new MatchHistoryStore(file);
    history.attach(engine, new ScoringEngine());

    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60 }));
    engine.joinStationAlliance('slot1', 'red');
    engine.joinStationAlliance('slot2', 'blue');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    for (const station of ['slot1', 'slot2'] as const) {
      dsAttached(engine, station);
      engine.setReady(station, true);
    }
    engine.startMatch();
    elapse(3400);

    // One leaves, then the other — the last departure ends the match
    engine.leaveStation('slot1');
    engine.leaveStation('slot2');
    expect(engine.getState().phase).toBe('postMatch');

    const entry = history.getState().matches.at(-1)!;
    expect(entry.endReason).toBe('abandoned');
    expect(entry.teams.map(t => [t.station, t.teamNumber, t.alliance])).toEqual([
      ['slot1', 5940, 'red'],
      ['slot2', 254, 'blue'],
    ]);
    expect(Object.keys(entry.challenge!.tally).sort()).toEqual(['blue', 'red']);

    engine.clearMatch();
    rmSync(file, { force: true });
  });
});

describe('a robot in the match with no Driver Station', () => {
  useFakeClock();

  test('is warned about once, and again if its DS drops a second time', () => {
    const warnings: string[] = [];
    setBroadcast(msg => {
      const m = msg as { type?: string; level?: string; message?: string };
      if (m.type === 'appLog' && m.level === 'warn' && m.message?.includes('no Driver Station')) {
        warnings.push(m.message);
      }
    });
    const engine = new MatchEngine(() => 5940);
    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60 }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    engine.setDSAddress('slot1', '10.59.40.5');
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.startMatch();
    elapse(3400);
    expect(warnings).toEqual([]);

    engine.clearDSAddress('slot1');
    elapse(600);
    expect(warnings).toEqual([
      "Team 5940 (slot1) has no Driver Station connected to the field, so its robot can't be enabled",
    ]);

    // Back, then gone again: a fresh warning
    engine.setDSAddress('slot1', '10.59.40.5');
    elapse(600);
    engine.clearDSAddress('slot1');
    elapse(600);
    expect(warnings.length).toBe(2);

    engine.stopMatch();
    engine.clearMatch();
    setBroadcast(() => {});
  });
});

describe('after the buzzer', () => {
  useFakeClock();

  test('a robot that connects to a station outside the match shows straight away', () => {
    const onRadio: Partial<Record<Station, number>> = { slot1: 5940 };
    const engine = new MatchEngine(station => onRadio[station] ?? null);
    engine.createMatch();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60 }));
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.startMatch();
    elapse(3400);

    // Mid-match, the roster is frozen
    onRadio.slot2 = 254;
    expect(engine.getState().stationStates.slot2!.teamNumber).toBeNull();

    engine.stopMatch();
    expect(engine.getState().phase).toBe('postMatch');
    expect(engine.getState().stationStates.slot2!.teamNumber).toBe(254);
    // The team that played keeps its number, whatever the radio says now
    onRadio.slot1 = 1678;
    expect(engine.getState().stationStates.slot1!.teamNumber).toBe(5940);

    engine.clearMatch();
  });
});

/** Robots on both alliances, all readied, started. Returns after the horn. */
function startRace(config: Partial<MatchConfig>, stations: Record<string, 'red' | 'blue'>) {
  const engine = new MatchEngine(() => 5940);
  engine.createMatch();
  engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60, ...config }));
  for (const [station, alliance] of Object.entries(stations)) {
    engine.joinStationAlliance(station as 'slot1', alliance);
  }
  for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
  engine.setReadyRequested(true);
  for (const station of Object.keys(stations)) {
    dsAttached(engine, station as 'slot1');
    engine.setReady(station as 'slot1', true);
  }
  engine.startMatch();
  elapse(3400);
  expect(engine.getState().phase).toBe('teleop');
  return engine;
}

describe('a stopwatch race holds a finished alliance down', () => {
  useFakeClock();

  test('through a pause and resume, and against the re-enable button', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red', slot2: 'blue' });
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
    elapse(3200);
    s = engine.getState();
    expect(s.phase).toBe('teleop');
    expect(s.stationStates.slot1?.enabled).toBe(false);
    expect(s.stationStates.slot2?.enabled).toBe(true);
    engine.stopMatch();
  });

  test('finish is refused for an alliance with nobody on the field', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red' });
    engine.challengeFinish('blue');
    expect(engine.getState().challenge!.blue.finishedAt).toBeUndefined();
    engine.stopMatch();
  });

  test('ends when the last robot still on the clock leaves', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red', slot2: 'blue' });
    engine.challengeFinish('red');
    engine.leaveStation('slot2');
    expect(engine.getState().phase).toBe('postMatch');
  });
});

describe('a relay with staff hand-offs', () => {
  useFakeClock();

  test('runs one robot per alliance at a time and stops the clock on the last', () => {
    const engine = startRace(
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
    elapse(3200);
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
  });
});

describe('a relay with driver-station hand-offs', () => {
  useFakeClock();

  test('the runner disabling itself sends the next robot', () => {
    const engine = startRace({ challengeTiming: 'relay', relayHandoff: 'ds' }, { slot1: 'red', slot2: 'red' });
    // The station console's own Disable counts
    engine.stationDisable('slot1', 'self');
    let s = engine.getState();
    expect(s.stationStates.slot2?.enabled).toBe(true);
    expect(s.challenge!.red.splits).toHaveLength(1);

    // A DS-reported disable counts too, once the post-enable grace has passed
    elapse(2100);
    engine.dsReportedStatus('slot2', false, false, false, 0x00, true);
    s = engine.getState();
    expect(s.challenge!.red.finishedAt).toBeDefined();
    expect(s.phase).toBe('postMatch');
  });

  test('a disable from a robot that is not running is just a disable', () => {
    const engine = startRace({ challengeTiming: 'relay', relayHandoff: 'ds' }, { slot1: 'red', slot2: 'red' });
    engine.stationDisable('slot2', 'self');
    expect(engine.getState().challenge!.red.splits ?? []).toHaveLength(0);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(true);
    engine.stopMatch();
  });
});

describe('a driver station that drops off the field mid-match', () => {
  useFakeClock();

  test('comes back enabled when its last word was a disable', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red', slot2: 'blue' });
    elapse(2100);
    engine.dsReportedStatus('slot1', false, false, false, 0x78, true);
    let s = engine.getState();
    expect(s.stationStates.slot1?.enabled).toBe(false);
    expect(s.stationStates.slot1?.disabledBy).toBe('ds');

    dsGoesQuiet(engine, 'slot1');
    engine.dsReportedStatus('slot1', false, false, false, 0x38, true);
    s = engine.getState();
    expect(s.stationStates.slot1?.enabled).toBe(true);
    expect(s.stationStates.slot1?.disabledBy).toBeNull();
    // Its first "still disabled" reports after the enable are the grace window, not a new disable
    engine.dsReportedStatus('slot1', false, false, false, 0x38, true);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(true);
    engine.stopMatch();
  });

  test('a disable from a DS that keeps talking is the driver, and stays', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red' });
    elapse(2100);
    engine.dsReportedStatus('slot1', false, false, false, 0x38, true);
    engine.dsReportedStatus('slot1', false, false, false, 0x38, true);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);
    expect(engine.getState().stationStates.slot1?.disabledBy).toBe('ds');
    engine.stopMatch();
  });

  test('an admin Disable right behind an admin Enable is a double click and is ignored', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red' });
    engine.stationDisable('slot1', 'admin');
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);
    engine.undisable('slot1', true);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(true);
    engine.stationDisable('slot1', 'admin');
    expect(engine.getState().stationStates.slot1?.enabled).toBe(true);
    // Repeated after the debounce it is a decision
    elapse(1600);
    engine.stationDisable('slot1', 'admin');
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);
    expect(engine.getState().stationStates.slot1?.disabledBy).toBe('admin');
    engine.stopMatch();
  });

  test('a staff disable survives the DS coming back', () => {
    const engine = startRace({ challengeTiming: 'stopwatch' }, { slot1: 'red' });
    engine.stationDisable('slot1', 'admin');
    dsGoesQuiet(engine, 'slot1');
    engine.dsReportedStatus('slot1', false, false, false, 0x38, true);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);
    expect(engine.getState().stationStates.slot1?.disabledBy).toBe('admin');
    engine.stopMatch();
  });
});

describe('a set-up match nobody joins', () => {
  /** Fire the abandoned-setup timer now instead of waiting ten minutes. */
  function expire(engine: MatchEngine) {
    (engine as unknown as { cancelAbandonedSetup(): void }).cancelAbandonedSetup();
  }

  test('says when it will cancel itself, and does', () => {
    const engine = created();
    let cancelled = 0;
    engine.setSetupCancelledHook(() => cancelled++);
    expect(engine.getState().setupExpiresAt).toBeGreaterThan(Date.now() + SETUP_AUTO_CANCEL_MS - 1000);

    expire(engine);
    expect(engine.getState().phase).toBe('idle');
    expect(engine.getState().setupExpiresAt).toBeUndefined();
    expect(cancelled).toBe(1);
  });

  test('a team joining stops the clock, and the last one leaving restarts it', () => {
    const engine = created();
    engine.joinStationAlliance('slot1', 'red');
    expect(engine.getState().setupExpiresAt).toBeUndefined();
    expire(engine); // a timer that fires anyway changes nothing
    expect(engine.getState().phase).toBe('created');

    engine.leaveStation('slot1');
    expect(engine.getState().setupExpiresAt).toBeDefined();
  });

  test('staff cancelling it by hand lets held joins through too, once', () => {
    const engine = created();
    let cancelled = 0;
    engine.setSetupCancelledHook(() => cancelled++);
    engine.cancelMatch();
    expect(engine.getState().setupExpiresAt).toBeUndefined();
    expect(cancelled).toBe(1);
    expire(engine); // a stale clock firing afterwards does nothing more
    expect(cancelled).toBe(1);
  });

  test('staff can cancel it with teams joined, and held joins still go through', () => {
    const engine = created();
    let cancelled = 0;
    engine.setSetupCancelledHook(() => cancelled++);
    engine.joinStationAlliance('slot1', 'red');
    engine.cancelMatch();
    expect(engine.getState().phase).toBe('idle');
    expect(cancelled).toBe(1);
  });

  test('a team page can clear it early, which lets held joins through like the clock does', () => {
    const engine = created();
    let cancelled = 0;
    engine.setSetupCancelledHook(() => cancelled++);
    expect(engine.clearEmptySetup("team 6036's page")).toBe(true);
    expect(engine.getState().phase).toBe('idle');
    expect(engine.getState().setupExpiresAt).toBeUndefined();
    expect(cancelled).toBe(1);
  });

  test('a team page cannot clear it once anyone has joined, or when no match is set up', () => {
    const engine = created();
    let cancelled = 0;
    engine.setSetupCancelledHook(() => cancelled++);
    engine.joinStationAlliance('slot1', 'red');
    expect(engine.clearEmptySetup("team 6036's page")).toBe(false);
    expect(engine.getState().phase).toBe('created');
    expect(cancelled).toBe(0);

    engine.cancelMatch(); // staff
    expect(engine.clearEmptySetup("team 6036's page")).toBe(false);
    expect(cancelled).toBe(1);
  });
});

describe('a manual relay', () => {
  useFakeClock();

  test('enables everyone and ends on Finish', () => {
    const engine = startRace(
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
  });
});

describe('the roster names the robot that joined, not the slot radio', () => {
  /** Radio active config (what is on the Wi-Fi) and the projected view (held
   *  requests win), both editable mid-test. */
  function field() {
    const onRadio: Partial<Record<string, number | null>> = { slot3: 111 };
    const projected: Partial<Record<string, number | null>> = { slot3: 111 };
    const engine = new MatchEngine(
      s => onRadio[s] ?? null,
      s => projected[s] ?? null,
    );
    engine.createMatch();
    return { engine, onRadio, projected };
  }

  test('a team joining while its Wi-Fi request is held shows under its own number', () => {
    const { engine, projected } = field();
    // 111 releases and 222 asks for the slot; both requests are held by the match.
    projected.slot3 = 222;
    engine.joinStationAlliance('slot3', 'blue');
    expect(engine.getState().stationStates.slot3?.teamNumber).toBe(222);
  });

  test('an unjoined station still shows whoever is on the radio', () => {
    const { engine, projected } = field();
    projected.slot3 = 222;
    expect(engine.getState().stationStates.slot3?.teamNumber).toBe(111);
  });

  test('leaving goes back to the radio team', () => {
    const { engine, projected } = field();
    projected.slot3 = 222;
    engine.joinStationAlliance('slot3', 'red');
    engine.leaveStation('slot3');
    expect(engine.getState().stationStates.slot3?.teamNumber).toBe(111);
  });

  test('the match snapshot keeps the joined robot', async () => {
    const { engine, projected } = field();
    projected.slot3 = 222;
    engine.joinStationAlliance('slot3', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot3');
    engine.setReady('slot3', true);
    engine.startMatch();
    expect(engine.getState().phase).toBe('countdown');
    expect(engine.getState().stationStates.slot3?.teamNumber).toBe(222);
    engine.stopMatch();
  });

  test('a joined station whose robot changes during setup leaves the match', () => {
    const { engine, projected } = field();
    engine.joinStationAlliance('slot3', 'red');
    engine.reconcileJoinedTeams(); // nothing changed
    expect(engine.getState().stationStates.slot3?.joined).toBe(true);

    projected.slot3 = null; // 111 released its Wi-Fi (held)
    engine.reconcileJoinedTeams();
    const s = engine.getState().stationStates.slot3!;
    expect(s.joined).toBe(false);
    expect(s.alliance).toBeNull();
    expect(s.teamNumber).toBe(111); // still on the radio until the release applies
  });

  test('the same team changing its SSID suffix stays joined', () => {
    const { engine, projected } = field();
    engine.joinStationAlliance('slot3', 'red');
    projected.slot3 = 111; // "111" → "111-beta": same team
    engine.reconcileJoinedTeams();
    expect(engine.getState().stationStates.slot3?.joined).toBe(true);
  });

  test('a running match is not touched by a Wi-Fi request', async () => {
    const { engine, projected } = field();
    engine.joinStationAlliance('slot3', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot3');
    engine.setReady('slot3', true);
    engine.startMatch();
    projected.slot3 = 333;
    engine.reconcileJoinedTeams();
    const s = engine.getState().stationStates.slot3!;
    expect(s.joined).toBe(true);
    expect(s.teamNumber).toBe(111);
    engine.stopMatch();
  });
});

describe('ready needs a Driver Station the field can hear', () => {
  /** One team joined, staff not required, ready check open, DS silent so far. */
  function setup() {
    const engine = new MatchEngine(() => 4159);
    engine.createMatch();
    engine.joinStationAlliance('slot4', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    return engine;
  }

  test('refused while the DS has never heartbeated, accepted once it does', () => {
    const engine = setup();
    expect(engine.getState().stationStates.slot4?.dsAttached).toBe(false);
    engine.setReady('slot4', true);
    expect(engine.getState().stationStates.slot4?.ready).toBe(false);
    engine.startMatch();
    expect(engine.getState().phase).toBe('created');

    dsAttached(engine, 'slot4');
    expect(engine.getState().stationStates.slot4?.dsAttached).toBe(true);
    engine.setReady('slot4', true);
    expect(engine.getState().stationStates.slot4?.ready).toBe(true);
  });

  test('a ready team whose DS goes quiet during setup is un-readied', () => {
    const engine = setup();
    dsAttached(engine, 'slot4');
    engine.setReady('slot4', true);
    sweepReadiness(engine);
    expect(engine.getState().stationStates.slot4?.ready).toBe(true); // still heartbeating

    dsGoesQuiet(engine, 'slot4');
    sweepReadiness(engine);
    expect(engine.getState().stationStates.slot4?.ready).toBe(false);
    engine.startMatch();
    expect(engine.getState().phase).toBe('created');
  });

  test('un-ready is always allowed, DS or not', () => {
    const engine = setup();
    dsAttached(engine, 'slot4');
    engine.setReady('slot4', true);
    dsGoesQuiet(engine, 'slot4');
    engine.setReady('slot4', false);
    expect(engine.getState().stationStates.slot4?.ready).toBe(false);
  });

  test('staff "Ready anyway" readies a silent station and the sweep leaves it alone', () => {
    const engine = setup();
    engine.setReady('slot4', true, { force: true });
    expect(engine.getState().stationStates.slot4?.ready).toBe(true);
    sweepReadiness(engine);
    expect(engine.getState().stationStates.slot4?.ready).toBe(true);
    engine.startMatch();
    expect(engine.getState().phase).toBe('countdown');
    engine.stopMatch();
  });

  test('the override is forgotten once the station is no longer ready', () => {
    const engine = setup();
    engine.setReady('slot4', true, { force: true });
    engine.setReady('slot4', false);
    sweepReadiness(engine); // drops the stale override
    // An ordinary ready now needs the DS again…
    engine.setReady('slot4', true);
    expect(engine.getState().stationStates.slot4?.ready).toBe(false);
    // …and a forced-then-attached station behaves like any other once its DS drops
    dsAttached(engine, 'slot4');
    engine.setReady('slot4', true, { force: true });
    dsGoesQuiet(engine, 'slot4');
    sweepReadiness(engine);
    expect(engine.getState().stationStates.slot4?.ready).toBe(false);
  });
});

describe('a cancelled countdown cools down before the next start', () => {
  /** One team joined and ready, staff not required, counting down. */
  function countingDown() {
    const engine = new MatchEngine(() => 1234);
    engine.createMatch();
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.startMatch();
    expect(engine.getState().phase).toBe('countdown');
    return engine;
  }

  afterEach(() => setSystemTime());

  test('a start straight after the match page cancels is refused until the cooldown runs out', () => {
    const now = Date.now();
    setSystemTime(new Date(now));
    const engine = countingDown();
    engine.abortCountdown();

    const state = engine.getState();
    expect(state.phase).toBe('created');
    expect(state.restartCooldown).toEqual({ until: now + RESTART_COOLDOWN_MS, cancelledBy: null });
    expect(state.stationStates.slot1?.ready).toBe(true); // still ready: only the cooldown stands in the way

    setSystemTime(new Date(now + RESTART_COOLDOWN_MS - 1));
    engine.startMatch();
    expect(engine.getState().phase).toBe('created');

    setSystemTime(new Date(now + RESTART_COOLDOWN_MS));
    expect(engine.getState().restartCooldown).toBeUndefined();
    engine.startMatch();
    expect(engine.getState().phase).toBe('countdown');
    engine.stopMatch();
  });

  test('a team backing out of the countdown is named as the canceller', () => {
    const engine = countingDown();
    engine.setReady('slot1', false);
    const state = engine.getState();
    expect(state.phase).toBe('created');
    expect(state.restartCooldown?.cancelledBy).toBe('slot1');
  });
});

describe('a team Stop out of a match', () => {
  test('latches until the team lets the robot drive again', () => {
    const engine = new MatchEngine(() => 8);
    engine.teamStop('slot1', true);
    expect(engine.getState().stationStates.slot1?.teamStopped).toBe(true);
    engine.teamStop('slot1', false);
    expect(engine.getState().stationStates.slot1?.teamStopped).toBe(false);
  });

  test('is ignored for a station in a match, and joining clears it', () => {
    const engine = new MatchEngine(() => 8);
    engine.teamStop('slot1', true);
    engine.createMatch();
    engine.joinStationAlliance('slot1', 'red');
    expect(engine.getState().stationStates.slot1?.teamStopped).toBe(false);
    engine.teamStop('slot1', true);
    expect(engine.getState().stationStates.slot1?.teamStopped).toBe(false);
  });

  test('is the only stop that cuts a Driver Station off its robot', () => {
    const engine = new MatchEngine(() => 8);
    const cut = (station: 'slot1' | 'slot2') => teamStopCut(engine.getState().stationStates[station]);
    engine.teamStop('slot1', true);
    expect(cut('slot1')).toBe(true);
    expect(cut('slot2')).toBe(false);
    engine.teamStop('slot1', false);
    expect(cut('slot1')).toBe(false);

    engine.stationEStop('slot1', 'staff');
    expect(cut('slot1')).toBe(false);
    engine.clearEStop('slot1');
    engine.fieldEStop();
    expect(cut('slot1')).toBe(false);
    expect(cut('slot2')).toBe(false);
  });

  test('e-stop is visible cheaply to the hold resolvers', () => {
    const engine = new MatchEngine(() => 8);
    expect(engine.isEStopped('slot1')).toBe(false);
    engine.fieldEStop();
    expect(engine.isEStopped('slot1')).toBe(true);
    engine.clearEStop();
    expect(engine.isEStopped('slot1')).toBe(false);
  });
});

describe('two robots of one team', () => {
  test('each station records the robot that joined, not just the team', () => {
    const robots: Record<string, string> = { slot1: '1967-Elsa', slot2: '1967-Lupe' };
    const robotOn = (s: string) => robots[s] ?? null;
    const engine = new MatchEngine(s => (robots[s] ? 1967 : null), undefined, robotOn);
    engine.createMatch();
    engine.joinStationAlliance('slot1', 'blue');
    engine.joinStationAlliance('slot2', 'red');
    const { stationStates } = engine.getState();
    expect(stationStates.slot1?.robot).toBe('1967-Elsa');
    expect(stationStates.slot2?.robot).toBe('1967-Lupe');
    expect(stationStates.slot2?.teamNumber).toBe(1967);
  });
});

/** slot1 (red) joins, readies and starts: the match is in its countdown. */
function startedWithSlot1(): MatchEngine {
  const engine = new MatchEngine(() => 1967);
  engine.createMatch();
  engine.joinStationAlliance('slot1', 'red');
  for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
  engine.setReadyRequested(true);
  dsAttached(engine, 'slot1');
  engine.setReady('slot1', true);
  engine.startMatch();
  expect(engine.getState().phase).toBe('countdown');
  return engine;
}

describe('Cancel Match', () => {
  test('ends the match for the robots in it and leaves everyone else alone', () => {
    const engine = startedWithSlot1();
    engine.stopMatch();
    const state = engine.getState();
    expect(state.phase).toBe('postMatch');
    expect(state.endReason).toBe('stopped');
    expect(state.stationStates.slot1?.enabled).toBe(false);
    // Nobody is e-stopped and there is no field latch: a free-driving robot
    // on slot4 never had FMS control, and still doesn't.
    expect(state.fieldEStop).toBeUndefined();
    for (const s of ['slot1', 'slot4'] as const) expect(engine.isEStopped(s)).toBe(false);
    expect(state.stationStates.slot4?.joined).toBe(false);
  });

  test('works from a paused match too', () => {
    const engine = startedWithSlot1();
    (engine as unknown as { phase: string }).phase = 'teleop';
    engine.pauseMatch();
    expect(engine.getState().phase).toBe('paused');
    engine.stopMatch();
    expect(engine.getState().phase).toBe('postMatch');
    expect(engine.getState().endReason).toBe('stopped');
  });
});

describe('the field E-Stop', () => {
  test('ends a running match and stops every station, joined or not', () => {
    const engine = startedWithSlot1();
    engine.fieldEStop();
    const state = engine.getState();
    expect(state.phase).toBe('postMatch');
    expect(state.endReason).toBe('estop');
    expect(state.fieldEStop?.since).toBeGreaterThan(0);
    expect(state.stationStates.slot1?.eStop).toBe(true);
    expect(state.stationStates.slot4?.eStop).toBe(true);
    // Field-wide, not any one robot's own e-stop
    expect(state.stationStates.slot4?.eStopBy).toBeUndefined();
  });

  test('is a latch: clearing or creating a match leaves it on, and no match can start', () => {
    const engine = startedWithSlot1();
    engine.fieldEStop();
    engine.clearMatch();
    expect(engine.getState().phase).toBe('idle');
    expect(engine.isEStopped('slot4')).toBe(true);
    engine.createMatch();
    expect(engine.getState().fieldEStop).toBeDefined();
    engine.joinStationAlliance('slot1', 'red');
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.startMatch();
    expect(engine.getState().phase).toBe('created');

    engine.clearFieldEStop();
    expect(engine.getState().fieldEStop).toBeUndefined();
    expect(engine.isEStopped('slot4')).toBe(false);
    engine.setReady('slot1', true);
    engine.startMatch();
    expect(engine.getState().phase).toBe('countdown');
    engine.stopMatch();
  });

  test('pressed during setup keeps the set-up match', () => {
    const engine = new MatchEngine(() => 1967);
    engine.createMatch();
    engine.joinStationAlliance('slot1', 'blue');
    engine.fieldEStop();
    expect(engine.getState().phase).toBe('created');
    expect(engine.getState().stationStates.slot1?.joined).toBe(true);
  });

  test("clearing one robot's e-stop leaves the field latch; clearing all releases both", () => {
    const engine = new MatchEngine(() => 1967);
    engine.stationEStop('slot2', 'team');
    engine.fieldEStop();
    engine.clearEStop('slot2');
    expect(engine.isEStopped('slot2')).toBe(true);
    expect(engine.getState().stationStates.slot2?.eStopBy).toBeUndefined();
    engine.stationEStop('slot2', 'staff');
    engine.clearEStop();
    expect(engine.getState().fieldEStop).toBeUndefined();
    expect(engine.isEStopped('slot2')).toBe(false);
  });
});

describe("one robot's e-stop", () => {
  test('records who latched it, and touches no other robot', () => {
    const engine = new MatchEngine(() => 1967);
    engine.stationEStop('slot1', 'team');
    engine.stationEStop('slot1', 'staff');
    engine.dsReportedStatus('slot3', false, true, false, 0xb8, true);
    const state = engine.getState();
    expect(state.stationStates.slot1?.eStopBy).toBe('team'); // the first source sticks
    expect(state.stationStates.slot3?.eStopBy).toBe('ds');
    expect(state.stationStates.slot2?.eStop).toBe(false);
    expect(state.fieldEStop).toBeUndefined();
  });

  test("clearing the match clears the robots' own e-stops", () => {
    const engine = startedWithSlot1();
    engine.stationEStop('slot1', 'staff');
    engine.stopMatch();
    engine.clearMatch();
    expect(engine.isEStopped('slot1')).toBe(false);
    expect(engine.getState().stationStates.slot1?.eStopBy).toBeUndefined();
  });
});

describe('coming out of an e-stop starts disabled', () => {
  afterEach(() => setSystemTime());

  /** slot1 is driving in teleop. */
  function driving(): MatchEngine {
    const engine = startedWithSlot1();
    (engine as unknown as { phase: string }).phase = 'teleop';
    engine.undisable('slot1', true);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(true);
    return engine;
  }
  const enableEveryone = (engine: MatchEngine) =>
    (engine as unknown as { enableParticipating(mode: string): void }).enableParticipating('teleOp');

  test('in a match: phase changes leave it disabled until the team presses Enable', () => {
    const engine = driving();
    engine.stationEStop('slot1', 'team');
    engine.clearEStop('slot1');
    let slot1 = engine.getState().stationStates.slot1!;
    expect(slot1.enabled).toBe(false);
    expect(slot1.disabledBy).toBe('estop');

    // The next teleop/resume enable passes it by
    enableEveryone(engine);
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);

    // The team's Re-enable is the click that brings it back
    engine.undisable('slot1', false);
    slot1 = engine.getState().stationStates.slot1!;
    expect(slot1.enabled).toBe(true);
    expect(slot1.disabledBy).toBeNull();
    engine.stopMatch();
  });

  test('the field E-Stop clearing mid-setup or after a match leaves robots disabled too', () => {
    const engine = driving();
    engine.fieldEStop();
    expect(engine.getState().phase).toBe('postMatch');
    engine.clearFieldEStop();
    expect(engine.getState().stationStates.slot1?.enabled).toBe(false);
  });

  test('a robot e-stopped in setup stays e-stopped when the match starts', () => {
    const engine = new MatchEngine(() => 1967);
    engine.createMatch();
    engine.joinStationAlliance('slot1', 'red');
    for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
    engine.setReadyRequested(true);
    dsAttached(engine, 'slot1');
    engine.setReady('slot1', true);
    engine.stationEStop('slot1', 'team');
    engine.startMatch();
    expect(engine.isEStopped('slot1')).toBe(true);
    engine.stopMatch();
  });
});

describe('the ball counter contract', () => {
  // balls-counter (src/ball_counter/match.py) reads these from /ws/scores to
  // start and stop its recordings. docs/scoring.md.
  test('the match state keeps the fields it reads', () => {
    const state = created().getState();
    for (const field of ['phase', 'matchId', 'subPeriod', 'inactiveGoalAlliance']) {
      expect(field in state).toBe(true);
    }
  });
});
