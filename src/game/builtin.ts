/**
 * Games compiled into pFMS. Both are plain definitions — REBUILT's hub
 * shifts fit the declarative vocabulary, so the browser evaluates them
 * locally just like the server does.
 */
import type { GameDefinition } from './types.js';

/**
 * FRC 2026 REBUILT, on official timing.
 *
 * Teleop opens with a 10 s Transition where both hubs are active. The auto
 * loser scores first: their hub is active (the winner's is off) in Shifts 1
 * and 3; the winner scores in Shifts 2 and 4. The last 30 s are the endgame,
 * both hubs on. Game data tells the robots who won auto: `R` or `B`.
 */
export const REBUILT_2026: GameDefinition = {
  id: 'rebuilt-2026',
  name: 'REBUILT',
  season: 2026,
  description: 'FRC 2026: hub shifts decided by the auto winner.',
  timing: { autoDuration: 20, pauseDuration: 3, teleopDuration: 140, endgameDuration: 30 },
  autoWinner: { default: 'scores' },
  teleopPeriods: [
    { id: 'transition', label: 'Transition', short: 'TS', duration: 10 },
    { id: 'shift1', label: 'Shift 1', short: 'S1', duration: 25, goalOff: 'autoWinner' },
    { id: 'shift2', label: 'Shift 2', short: 'S2', duration: 25, goalOff: 'autoLoser' },
    { id: 'shift3', label: 'Shift 3', short: 'S3', duration: 25, goalOff: 'autoWinner' },
    { id: 'shift4', label: 'Shift 4', short: 'S4', duration: 25, goalOff: 'autoLoser' },
  ],
  gameData: { kind: 'autoWinner', red: 'R', blue: 'B' },
};

/**
 * A plain FRC-style match: auto, a short pause, teleop with an endgame, no
 * shifts, no auto winner and no game data. Points come from the scoring
 * elements alone. The base for most custom games.
 */
export const GENERIC: GameDefinition = {
  id: 'generic',
  name: 'Generic match',
  description: 'Auto, teleop and endgame. No game-specific rules: points come from the scoring elements alone.',
  timing: { autoDuration: 15, pauseDuration: 3, teleopDuration: 135, endgameDuration: 20 },
};

export const BUILTIN_GAMES: readonly GameDefinition[] = [REBUILT_2026, GENERIC];

/** What a field runs when nobody has picked a game — and what every match
 *  recorded before game layers existed was. */
export const DEFAULT_GAME = REBUILT_2026;
