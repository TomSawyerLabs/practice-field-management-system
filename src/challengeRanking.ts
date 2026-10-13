/**
 * Ranking for the speed challenge leaderboard.
 *
 * The leaderboard is a view over match history rather than a store of its
 * own: every challenge run leaves a history entry carrying its tally, so
 * ranking is a matter of reading them back. One row per set of teams, showing
 * their best attempt.
 *
 * Window runs rank by laps, penalties already deducted. Stopwatch and relay
 * runs rank by time, penalties already added, and a run that never finished
 * is a DNF and sorts last. The three are never mixed — they aren't
 * comparable.
 */
import {
  challengeScore,
  isCountUpTiming,
  type Alliance,
  type ChallengeAttempt,
  type ChallengeLeaderboardTables,
  type ChallengeTally,
  type ChallengeTiming,
  type MatchHistoryEntry,
} from './types.js';

export type { ChallengeAttempt };

const TIMINGS: ChallengeTiming[] = ['window', 'stopwatch', 'relay'];

/** Whichever attempt is the better result. Ties go to whoever did it first. */
export function betterAttempt(a: ChallengeAttempt, b: ChallengeAttempt, timing: ChallengeTiming): ChallengeAttempt {
  if (isCountUpTiming(timing)) {
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
      const { laps, seconds } = challengeScore(tally, timing, match.challenge);
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

/** Local midnight at the start of the day `now` falls in — where a "today"
 *  leaderboard starts. The field's own clock decides what today is. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Whether history holds any challenge run at all, whatever the scope. */
export function hasChallengeRuns(matches: MatchHistoryEntry[]): boolean {
  return matches.some(match => match.challenge);
}

/** Every timing style's ranked rows, leaving out styles nobody has run.
 *  `since` drops runs that ended before it (a "today" leaderboard). */
export function challengeLeaderboard(matches: MatchHistoryEntry[], since = 0): ChallengeLeaderboardTables {
  const inScope = since > 0 ? matches.filter(match => match.endedAt >= since) : matches;
  const tables: ChallengeLeaderboardTables = {};
  for (const timing of TIMINGS) {
    const rows = leaderboardRows(inScope, timing);
    if (rows.length > 0) tables[timing] = rows;
  }
  return tables;
}
