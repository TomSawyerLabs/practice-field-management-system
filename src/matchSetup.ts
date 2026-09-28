import type { Alliance, QueueEntry, StationName } from './types.js';
import type { MatchQueue } from './matchQueue.js';

/**
 * "Set up next match": take the queue's next entry and make the field match
 * it. Wi-Fi first — every robot in the match goes on the pending list (a
 * robot already on the field is kept, everyone else's post-match release
 * stands) and the list is applied as one radio update — then the match is
 * created with each robot joined to its alliance. Each half is also
 * available on its own. Problems are collected, not thrown: a team with no
 * saved Wi-Fi still leaves the rest of the match set up.
 */

export type SetupMode = 'all' | 'wifi' | 'match';

export type StageOutcome = 'staged' | 'kept' | 'noCredentials';

export interface MatchSetupDeps {
  queue: MatchQueue;
  engine: {
    getPhase(): string;
    hasJoined(): boolean;
    createMatch(): void;
    joinStationAlliance(station: StationName, alliance: Alliance): void;
    isJoined(station: StationName): boolean;
  };
  radio: {
    /** Put every team's saved robot on the pending list in one batch (a
     *  robot already on the field is kept). 'noCredentials' for a team with
     *  nothing saved. */
    stageRobots(teams: number[]): Promise<Map<number, StageOutcome>>;
    /** Apply the pending list to the radio. Resolves once the commit is
     *  queued; the radio may still be reconfiguring. */
    apply(): Promise<void>;
    /** Where the team's robot is, or will be once the list is applied. */
    stationForTeam(team: number): StationName | null;
  };
}

export type SetupResult = { entry?: QueueEntry; problems: string[] };

export async function setupNextMatch(
  deps: MatchSetupDeps,
  id: string | undefined,
  mode: SetupMode,
): Promise<SetupResult> {
  const entry = id ? deps.queue.get(id) : deps.queue.next();
  const problems: string[] = [];
  if (!entry) return { problems: ['Nothing in the queue to set up'] };
  if (entry.status === 'playing' || entry.status === 'played') {
    return { entry, problems: [`Match ${entry.number} has already been played`] };
  }
  const teams: { team: number; alliance: Alliance }[] = [
    ...entry.red.map(team => ({ team, alliance: 'red' as const })),
    ...entry.blue.map(team => ({ team, alliance: 'blue' as const })),
  ];
  if (teams.length === 0) return { entry, problems: [`Match ${entry.number} has no teams`] };

  if (mode !== 'match') {
    const outcomes = await deps.radio.stageRobots(teams.map(t => t.team));
    for (const { team } of teams) {
      if (outcomes.get(team) === 'noCredentials') {
        problems.push(`Team ${team} has no saved Wi-Fi — they need to enable it from their page once`);
      }
    }
    await deps.radio.apply();
    deps.queue.markOnDeck(entry.id);
  }

  if (mode !== 'wifi') {
    const phase = deps.engine.getPhase();
    if (phase !== 'idle' && phase !== 'postMatch' && phase !== 'created') {
      problems.push('A match is running — the next one can be created when it ends');
      return { entry, problems };
    }
    if (phase === 'created' && deps.engine.hasJoined()) {
      problems.push('A match is already set up with robots joined — cancel it first');
      return { entry, problems };
    }
    if (phase !== 'created') deps.engine.createMatch();
    for (const { team, alliance } of teams) {
      const station = deps.radio.stationForTeam(team);
      if (!station) {
        problems.push(`Team ${team} has no robot on the field yet — it can join from its page when it does`);
        continue;
      }
      if (deps.engine.isJoined(station)) continue;
      deps.engine.joinStationAlliance(station, alliance);
    }
    deps.queue.markOnDeck(entry.id);
  }

  return { entry, problems };
}
