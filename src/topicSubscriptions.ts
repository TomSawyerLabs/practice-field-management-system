/**
 * Which websocket wants which of the big states.
 *
 * Match history, practice runs, usage and the timelapse status used to go to
 * every page on connect and on every change — ~180 kB per page, most of it
 * match history, which grows with every match. Only the pages that show
 * them subscribe now (see TOPIC_MESSAGE_TYPES), and a team page asks for
 * its own team's entries only.
 *
 * Generic over the socket type so it can be tested without a server.
 */
import {
  TEAM_FILTERED_TOPICS,
  TOPIC_MESSAGE_TYPES,
  type MatchHistoryEntry,
  type MatchHistoryState,
  type PracticeRecordingState,
  type SavedTeamsState,
  type Topic,
} from './types.js';

/** null = every entry; otherwise only these teams' entries. */
type TeamFilter = readonly number[] | null;

const TOPIC_BY_TYPE = new Map<string, Topic>(
  Object.entries(TOPIC_MESSAGE_TYPES).map(([topic, type]) => [type, topic as Topic]),
);

/** The topic a message belongs to, if it is one that only goes to subscribers. */
export function topicOfMessage(msg: unknown): Topic | undefined {
  const type = (msg as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? TOPIC_BY_TYPE.get(type) : undefined;
}

/**
 * A history entry as pages get it over the socket: without the score
 * timeline and per-period breakdown, ~70% of an entry's size. Only the
 * public match summary page shows those, and it fetches them over HTTP
 * (/api/public/match/<token>).
 */
function entryForSocket(e: MatchHistoryEntry): MatchHistoryEntry {
  if (e.scoreTimeline === undefined && e.periodBreakdown === undefined) return e;
  const { scoreTimeline: _timeline, periodBreakdown: _breakdown, ...rest } = e;
  return rest;
}

/** What a subscriber with this filter is sent for a topic's state. */
export function payloadFor<T>(topic: Topic, msg: T, teams: TeamFilter): T {
  const filtered = filterForTeams(topic, msg, teams);
  if (topic !== 'matchHistory') return filtered;
  const h = filtered as unknown as MatchHistoryState;
  return { ...h, matches: h.matches.map(entryForSocket) } as T;
}

/** The SSID's team number: `5940` and `5940-b` are both team 5940. */
function ssidTeam(ssid: string): number {
  return Number.parseInt(ssid.split('-', 2)[0], 10);
}

/** The part of a topic's state a subscriber with this filter gets. */
export function filterForTeams<T>(topic: Topic, msg: T, teams: TeamFilter): T {
  if (teams === null || !TEAM_FILTERED_TOPICS.includes(topic)) return msg;
  const has = (team: number | null | undefined) => team != null && teams.includes(team);
  if (topic === 'matchHistory') {
    const m = msg as unknown as MatchHistoryState;
    return { ...m, matches: m.matches.filter(e => e.teams.some(t => has(t.teamNumber))) } as T;
  }
  if (topic === 'practiceRecording') {
    const p = msg as unknown as PracticeRecordingState;
    return {
      ...p,
      optOut: p.optOut.filter(has),
      activeRuns: p.activeRuns.filter(r => has(r.teamNumber)),
      runs: p.runs.filter(r => has(r.teamNumber)),
    } as T;
  }
  if (topic === 'savedTeams') {
    const s = msg as unknown as SavedTeamsState;
    return { ...s, teams: s.teams.filter(t => has(ssidTeam(t.ssid))) } as T;
  }
  return msg;
}

export class TopicSubscriptions<S> {
  private readonly bySocket = new Map<S, Map<Topic, TeamFilter>>();

  /** Start or replace a socket's subscription to a topic. */
  subscribe(socket: S, topic: Topic, teams?: readonly number[]): void {
    let topics = this.bySocket.get(socket);
    if (!topics) {
      topics = new Map();
      this.bySocket.set(socket, topics);
    }
    // Sorted and de-duplicated, so equal filters share one serialization.
    topics.set(topic, teams === undefined ? null : [...new Set(teams)].sort((a, b) => a - b));
  }

  unsubscribe(socket: S, topic: Topic): void {
    this.bySocket.get(socket)?.delete(topic);
  }

  /** Forget a closed socket. */
  drop(socket: S): void {
    this.bySocket.delete(socket);
  }

  /** The filter a socket subscribed with, or undefined when it has not. */
  filterOf(socket: S, topic: Topic): TeamFilter | undefined {
    return this.bySocket.get(socket)?.get(topic);
  }

  /**
   * Every subscriber of `msg`'s topic with the JSON it should get. Each
   * distinct filter is applied and serialized once, however many sockets
   * share it. Empty for a message that is not a topic message.
   */
  route(msg: unknown): [S, string][] {
    const topic = topicOfMessage(msg);
    if (!topic) return [];
    const byFilter = new Map<string, string>();
    const out: [S, string][] = [];
    for (const [socket, topics] of this.bySocket) {
      const teams = topics.get(topic);
      if (teams === undefined) continue;
      const key = teams === null ? '*' : teams.join(',');
      let data = byFilter.get(key);
      if (data === undefined) {
        data = JSON.stringify(payloadFor(topic, msg, teams));
        byFilter.set(key, data);
      }
      out.push([socket, data]);
    }
    return out;
  }
}
