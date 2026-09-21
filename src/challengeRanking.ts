/**
 * Ranking for the speed challenge leaderboard.
 *
 * The leaderboard is a view over match history rather than a store of its
 * own: every challenge run leaves a history entry carrying its tally, so
 * ranking is a matter of reading them back. One row per set of teams, showing
 * their best attempt.
 *
 * Window runs rank by laps, penalties already deducted. Stopwatch runs rank
 * by time, penalties already added, and a run that never finished is a DNF
 * and sorts last. The two are never mixed — they aren't comparable.
 */
import {
  challengeScore,
  type Alliance,
  type ChallengeTally,
  type ChallengeTiming,
  type MatchHistoryEntry,
} from './types.js';

export interface ChallengeAttempt {
  /** Team numbers that ran together, ascending. */
  teams: number[];
  /** Identity of the team-set, for grouping attempts. */
  key: string;
  laps: number;
  /** Finishing time with penalties, or null for a window run or a DNF. */
  seconds: number | null;
  /** When the best attempt ended. */
  at: number;
  /** How many times this team-set has run. */
  attempts: number;
}

/** Whichever attempt is the better result. Ties go to whoever did it first. */
export function betterAttempt(a: ChallengeAttempt, b: ChallengeAttempt, timing: ChallengeTiming): ChallengeAttempt {
  if (timing === 'stopwatch') {
    // A finished run always beats a DNF, however many laps the DNF managed.
    if (a.seconds === null) return b.seconds === null ? (a.at <= b.at ? a : b) : b;
    if (b.seconds === null) return a;
    if (a.seconds !== b.seconds) return a.seconds < b.seconds ? a : b;
    return a.at <= b.at ? a : b;
  }
  if (a.laps !== b.laps) return a.laps > b.laps ? a : b;
  return a.at <= b.at ? a : b;
}

/** Best attempt per team-set, ranked, for one timing style. */
export function leaderboardRows(matches: MatchHistoryEntry[], timing: ChallengeTiming): ChallengeAttempt[] {
  const byTeams = new Map<string, ChallengeAttempt>();

  for (const match of matches) {
    if (match.challenge?.timing !== timing) continue;
    for (const [alliance, tally] of Object.entries(match.challenge.tally) as [Alliance, ChallengeTally][]) {
      const teams = match.teams
        .filter(t => t.alliance === alliance)
        .map(t => t.teamNumber)
        .sort((a, b) => a - b);
      if (teams.length === 0) continue;

      const key = teams.join('+');
      const { laps, seconds } = challengeScore(tally, timing);
      const attempt: ChallengeAttempt = { teams, key, laps, seconds, at: match.endedAt, attempts: 1 };

      const best = byTeams.get(key);
      if (!best) {
        byTeams.set(key, attempt);
        continue;
      }
      // The run count follows the team-set; the rest of the row follows
      // whichever attempt was better.
      const attempts = best.attempts + 1;
      const winner = betterAttempt(best, attempt, timing);
      byTeams.set(key, { ...winner, attempts });
    }
  }

  return [...byTeams.values()].sort((a, b) => (betterAttempt(a, b, timing) === a ? -1 : 1));
}
