import { describe, expect, test } from 'bun:test';
import type { Alliance, MatchPhase } from '../types.js';
import { GENERIC, REBUILT_2026 } from './builtin.js';
import * as legacy from './legacyShiftState.fixture.js';
import {
  breakdownRows,
  decideAutoWinner,
  gameDataAt,
  gamePeriods,
  gameOf,
  inactiveGoalAt,
  periodIds,
  subPeriodAt,
  teleopBoundaries,
  validateGameDefinition,
} from './rules.js';
import type { GameDefinition } from './types.js';

const WINNERS: (Alliance | null)[] = ['red', 'blue', null];
const PHASES: MatchPhase[] = [
  'idle',
  'created',
  'countdown',
  'auto',
  'autoPause',
  'paused',
  'teleop',
  'endgame',
  'postMatch',
];

describe('REBUILT layer matches the pre-layer shift rules', () => {
  const { teleopDuration, endgameDuration } = REBUILT_2026.timing;

  test('sub-period and inactive goal agree at every quarter second of every phase', () => {
    let checked = 0;
    for (const phase of PHASES) {
      for (let remaining = teleopDuration + 1; remaining >= -1; remaining -= 0.25) {
        expect(subPeriodAt(REBUILT_2026, phase, remaining)).toBe(
          legacy.getMatchSubPeriod(phase, remaining, teleopDuration),
        );
        for (const winner of WINNERS) {
          expect(inactiveGoalAt(REBUILT_2026, phase, remaining, winner)).toBe(
            legacy.getAllianceShiftState(phase, remaining, teleopDuration, endgameDuration, winner),
          );
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  test('the scoreboard breakdown shows the same rows as before', () => {
    for (const alliance of ['red', 'blue'] as Alliance[]) {
      for (const winner of WINNERS) {
        const [s1, s2] = legacy.getAllianceScoringShifts(alliance, winner);
        expect(breakdownRows(REBUILT_2026, alliance, winner)).toEqual([
          { label: 'Auto', period: 'auto' },
          { label: 'Transition', period: 'transition' },
          { label: 'Period 1', period: s1 },
          { label: 'Period 2', period: s2 },
          { label: 'Endgame', period: 'endgame' },
        ]);
      }
    }
  });

  test('breakdown keys are the seven REBUILT periods the ball counter and history use', () => {
    expect(periodIds(REBUILT_2026)).toEqual(['auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame']);
  });

  test('game data is R/B once auto is decided, in the phases it always was', () => {
    for (const phase of PHASES) {
      const sent = phase === 'autoPause' || phase === 'teleop' || phase === 'endgame';
      expect(gameDataAt(REBUILT_2026, phase, 'red')).toBe(sent ? 'R' : null);
      expect(gameDataAt(REBUILT_2026, phase, 'blue')).toBe(sent ? 'B' : null);
      expect(gameDataAt(REBUILT_2026, phase, null)).toBeNull();
    }
  });

  test('the host timer pulses at the old boundaries', () => {
    // MatchControlPage used teleopDur - 10, -35, -60, -85, -110, then 0.
    expect(teleopBoundaries(REBUILT_2026)).toEqual([130, 105, 80, 55, 30, 0]);
  });

  test('a config with no game is a REBUILT match', () => {
    expect(gameOf({})).toBe(REBUILT_2026);
    expect(gameOf(null)).toBe(REBUILT_2026);
    expect(gameOf({ game: GENERIC })).toBe(GENERIC);
  });
});

describe('generic layer', () => {
  test('auto, teleop, endgame and nothing else', () => {
    expect(periodIds(GENERIC)).toEqual(['auto', 'teleop', 'endgame']);
    expect(gamePeriods(GENERIC).map(p => p.duration)).toEqual([15, 115, 20]);
  });

  test('both goals stay on for the whole match and no game data is sent', () => {
    for (const phase of PHASES) {
      for (let remaining = 136; remaining >= 0; remaining -= 0.5) {
        for (const winner of WINNERS) expect(inactiveGoalAt(GENERIC, phase, remaining, winner)).toBeNull();
      }
      expect(gameDataAt(GENERIC, phase, 'red')).toBeNull();
    }
  });

  test('sub-periods follow the clock', () => {
    expect(subPeriodAt(GENERIC, 'auto', 10)).toBe('auto');
    expect(subPeriodAt(GENERIC, 'teleop', 135)).toBe('teleop');
    expect(subPeriodAt(GENERIC, 'teleop', 20.5)).toBe('teleop');
    expect(subPeriodAt(GENERIC, 'teleop', 19.9)).toBe('endgame'); // a tick before the engine flips the phase
    expect(subPeriodAt(GENERIC, 'endgame', 5)).toBe('endgame');
    expect(subPeriodAt(GENERIC, 'postMatch', 3)).toBe('endgame');
    expect(subPeriodAt(GENERIC, 'idle', 0)).toBeNull();
  });

  test('breakdown is one row per period', () => {
    expect(breakdownRows(GENERIC, 'red', null)).toEqual([
      { label: 'Auto', period: 'auto' },
      { label: 'Teleop', period: 'teleop' },
      { label: 'Endgame', period: 'endgame' },
    ]);
  });
});

describe('custom games', () => {
  const KING_OF_THE_HILL: GameDefinition = {
    id: 'king-of-the-hill',
    name: 'King of the Hill',
    timing: { autoDuration: 0, pauseDuration: 0, teleopDuration: 90, endgameDuration: 0 },
    teleopPeriods: [
      { id: 'red-holds', label: 'Red holds', duration: 30, goalOff: 'blue', cue: 'warning' },
      { id: 'blue-holds', label: 'Blue holds', duration: 30, goalOff: 'red', cue: 'warning' },
    ],
    gameData: { kind: 'fixed', text: 'KOTH' },
  };

  test('fixed goal rules, a remainder period, no auto and no endgame', () => {
    expect(validateGameDefinition(KING_OF_THE_HILL)).toEqual({ ok: true, game: KING_OF_THE_HILL });
    expect(periodIds(KING_OF_THE_HILL)).toEqual(['red-holds', 'blue-holds', 'teleop']);
    expect(inactiveGoalAt(KING_OF_THE_HILL, 'teleop', 80, null)).toBe('blue');
    expect(inactiveGoalAt(KING_OF_THE_HILL, 'teleop', 40, null)).toBe('red');
    expect(inactiveGoalAt(KING_OF_THE_HILL, 'teleop', 10, null)).toBeNull();
    // With no endgame, the post-match count belongs to the last period.
    expect(subPeriodAt(KING_OF_THE_HILL, 'postMatch', 2)).toBe('teleop');
    expect(teleopBoundaries(KING_OF_THE_HILL)).toEqual([60, 30, 0]);
    expect(breakdownRows(KING_OF_THE_HILL, 'red', null).map(r => r.period)).toEqual(['red-holds', 'teleop']);
  });

  test('fixed game data goes out from the countdown to the buzzer', () => {
    expect(gameDataAt(KING_OF_THE_HILL, 'countdown', null)).toBe('KOTH');
    expect(gameDataAt(KING_OF_THE_HILL, 'paused', null)).toBe('KOTH');
    expect(gameDataAt(KING_OF_THE_HILL, 'postMatch', null)).toBeNull();
    expect(gameDataAt(KING_OF_THE_HILL, 'idle', null)).toBeNull();
  });
});

describe('decideAutoWinner', () => {
  test('higher score wins; a tie goes to the coin', () => {
    expect(decideAutoWinner({ red: 3, blue: 1 })).toBe('red');
    expect(decideAutoWinner({ red: 0, blue: 1 })).toBe('blue');
    expect(decideAutoWinner({ red: 2, blue: 2 }, () => 0.2)).toBe('red');
    expect(decideAutoWinner({ red: 2, blue: 2 }, () => 0.7)).toBe('blue');
  });
});

describe('validateGameDefinition', () => {
  test('the built-ins are valid', () => {
    expect(validateGameDefinition(REBUILT_2026).ok).toBe(true);
    expect(validateGameDefinition(GENERIC).ok).toBe(true);
  });

  const errorsOf = (v: unknown) => {
    const r = validateGameDefinition(v);
    return r.ok ? [] : r.errors;
  };

  test('says what is wrong in words an author can act on', () => {
    expect(errorsOf(null)).toEqual(['A game must be a JSON object.']);
    const errors = errorsOf({
      id: 'Bad Id',
      name: '',
      timing: { autoDuration: 15, pauseDuration: 0, teleopDuration: 60, endgameDuration: 10, overtime: 5 },
      teleopPeriod: [],
      teleopPeriods: [
        { id: 'auto', label: 'x', duration: 10 },
        { id: 'a', label: 'A', duration: 30, goalOff: 'autoWinner' },
        { id: 'a', label: 'A again', duration: 30, cue: 'airhorn' },
      ],
      gameData: { kind: 'autoWinner', red: 'TOO-LONG-TEXT', blue: 'B' },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'Unknown field "teleopPeriod".',
        '"id" must be 1-48 lowercase letters, digits or dashes, starting with a letter or digit.',
        '"name" must be a non-empty string of at most 60 characters.',
        'Unknown field "timing.overtime".',
        'teleopPeriods[0].id "auto" is reserved — pFMS adds auto, teleop and endgame itself.',
        'teleopPeriods[1].goalOff "autoWinner" needs the game to have an "autoWinner".',
        'teleopPeriods[2].id "a" is used twice.',
        'teleopPeriods[2].cue must be one of start, end, resume, warning, pause, getready.',
        '"teleopPeriods" add up to 70 s, but teleop before the endgame is only 50 s.',
        '"gameData.red" and "gameData.blue" must be 1-8 plain ASCII characters.',
        '"gameData" of kind "autoWinner" needs the game to have an "autoWinner".',
      ]),
    );
  });

  test('an author cannot claim plugin hooks', () => {
    const r = validateGameDefinition({ ...GENERIC, ruleHooks: ['inactiveGoal'] });
    expect(r.ok && r.game.ruleHooks).toBeUndefined();
  });
});
