/**
 * The game's rules as the browser sees them. A declarative game is
 * evaluated here, against the locally interpolated clock, so tints and
 * countdowns move smoothly between the server's 4 Hz updates. A rule a
 * plugin computes in code (`game.ruleHooks`) can't run here, so for those
 * the server's broadcast value is used as-is.
 */
import { isChallengeConfig, type Alliance, type MatchPhase, type MatchState } from '../../../src/types';
import { gameOf, inactiveGoalAt, subPeriodAt } from '../../../src/game/rules';

export * from '../../../src/game/rules';
export type { GameDefinition, GameCatalogEntry, GamePeriod } from '../../../src/game/types';

/**
 * Whose goal is off (null = both on), at `remaining` seconds left in
 * `phase`. Only teleop switches goals off. A challenge run has none.
 */
export function inactiveGoalNow(
  matchState: MatchState,
  remaining: number = matchState.remainingTime,
  phase: MatchPhase | undefined = matchState.phase,
): Alliance | null {
  if (isChallengeConfig(matchState.config)) return null;
  const game = gameOf(matchState.config);
  if (game.ruleHooks?.includes('inactiveGoal')) {
    return phase === 'teleop' && matchState.phase === 'teleop' ? (matchState.inactiveGoalAlliance ?? null) : null;
  }
  return inactiveGoalAt(game, phase, remaining, matchState.autoWinnerAlliance ?? null);
}

/** The sub-period at `remaining` seconds left in the current phase. */
export function subPeriodNow(matchState: MatchState, remaining: number = matchState.remainingTime): string | null {
  if (isChallengeConfig(matchState.config)) return null;
  const game = gameOf(matchState.config);
  if (game.ruleHooks?.includes('subPeriod')) return matchState.subPeriod ?? null;
  return subPeriodAt(game, matchState.phase, remaining);
}
