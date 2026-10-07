import { describe, expect, test } from 'bun:test';
import { TopicSubscriptions, filterForTeams, payloadFor, topicOfMessage } from './topicSubscriptions.js';
import { isSubscribeTopic, isUnsubscribeTopic } from './types.js';
import type { MatchHistoryEntry, MatchHistoryState, PracticeRecordingState, SavedTeamsState } from './types.js';

function match(n: number, teams: number[]): MatchHistoryEntry {
  return {
    matchNumber: n,
    teams: teams.map((t, i) => ({ station: `slot${i + 1}`, teamNumber: t, alliance: i % 2 ? 'blue' : 'red' })),
  } as unknown as MatchHistoryEntry;
}

const history: MatchHistoryState = {
  type: 'matchHistoryState',
  matches: [match(1, [5940, 8048]), match(2, [6238, 1700]), match(3, [5940, 6238])],
};

const practice = {
  type: 'practiceRecordingState',
  optOut: [1700, 5940],
  buffering: true,
  activeRuns: [
    { station: 'slot1', teamNumber: 5940, startedAt: 1 },
    { station: 'slot2', teamNumber: 6238, startedAt: 2 },
  ],
  runs: [
    { id: 'practice-a', station: 'slot1', teamNumber: 5940, startedAt: 1, endedAt: 2, recordings: [] },
    { id: 'practice-b', station: 'slot2', teamNumber: 6238, startedAt: 3, endedAt: 4, recordings: [] },
  ],
} as unknown as PracticeRecordingState;

describe('topic messages', () => {
  test('the big states are topic messages; everything else is not', () => {
    expect(topicOfMessage(history)).toBe('matchHistory');
    expect(topicOfMessage(practice)).toBe('practiceRecording');
    expect(topicOfMessage({ type: 'usageState' })).toBe('usage');
    expect(topicOfMessage({ type: 'timelapseState' })).toBe('timelapse');
    expect(topicOfMessage({ type: 'matchState' })).toBeUndefined();
    expect(topicOfMessage(null)).toBeUndefined();
  });

  test('subscribe messages are validated', () => {
    expect(isSubscribeTopic({ type: 'subscribe', topic: 'matchHistory' })).toBe(true);
    expect(isSubscribeTopic({ type: 'subscribe', topic: 'matchHistory', teams: [5940] })).toBe(true);
    expect(isSubscribeTopic({ type: 'subscribe', topic: 'nope' })).toBe(false);
    expect(isSubscribeTopic({ type: 'subscribe', topic: 'toString' })).toBe(false);
    expect(isSubscribeTopic({ type: 'subscribe', topic: 'usage', teams: ['5940'] })).toBe(false);
    expect(isSubscribeTopic({ type: 'subscribe', topic: 'usage', teams: new Array(33).fill(1) })).toBe(false);
    expect(isUnsubscribeTopic({ type: 'unsubscribe', topic: 'timelapse' })).toBe(true);
    expect(isUnsubscribeTopic({ type: 'unsubscribe', topic: 'constructor' })).toBe(false);
  });
});

describe('filterForTeams', () => {
  test("a team's history holds only the matches it played", () => {
    const mine = filterForTeams('matchHistory', history, [5940]);
    expect(mine.matches.map(m => m.matchNumber)).toEqual([1, 3]);
    // The original is left alone: other subscribers get it unfiltered.
    expect(history.matches).toHaveLength(3);
  });

  test("a team's practice state holds only its own runs and opt-out", () => {
    const mine = filterForTeams('practiceRecording', practice, [5940]);
    expect(mine.runs.map(r => r.id)).toEqual(['practice-a']);
    expect(mine.activeRuns.map(r => r.teamNumber)).toEqual([5940]);
    expect(mine.optOut).toEqual([5940]);
    expect(mine.buffering).toBe(true);
  });

  test('no filter, or a topic that cannot be filtered, passes through', () => {
    expect(filterForTeams('matchHistory', history, null)).toBe(history);
    const usage = { type: 'usageState', sessions: [1, 2] };
    expect(filterForTeams('usage', usage, [5940])).toBe(usage);
  });
});

describe('payloadFor', () => {
  test('history goes out without the score timeline and period breakdown', () => {
    const full: MatchHistoryState = {
      type: 'matchHistoryState',
      matches: [
        { ...match(1, [5940]), scoreTimeline: [{ t: 1 }], periodBreakdown: { auto: { red: 1, blue: 0 } } },
      ] as unknown as MatchHistoryEntry[],
    };
    const sent = payloadFor('matchHistory', full, null);
    expect(sent.matches[0]).not.toHaveProperty('scoreTimeline');
    expect(sent.matches[0]).not.toHaveProperty('periodBreakdown');
    expect(sent.matches[0].matchNumber).toBe(1);
    // The store's own copy keeps them (the public summary page uses them).
    expect(full.matches[0].scoreTimeline).toHaveLength(1);
  });

  test("a team's saved robots are only that team's SSIDs", () => {
    const saved = {
      type: 'savedTeamsState',
      teams: [{ ssid: '5940' }, { ssid: '5940-b' }, { ssid: '59400' }, { ssid: '6238' }],
    } as unknown as SavedTeamsState;
    expect(payloadFor('savedTeams', saved, [5940]).teams.map(t => t.ssid)).toEqual(['5940', '5940-b']);
  });
});

describe('TopicSubscriptions.route', () => {
  test('a topic message goes only to its subscribers, each with its own slice', () => {
    const subs = new TopicSubscriptions<string>();
    subs.subscribe('match-page', 'matchHistory');
    subs.subscribe('team-5940', 'matchHistory', [5940]);
    subs.subscribe('team-6238', 'matchHistory', [6238]);
    subs.subscribe('usage-page', 'usage');

    const routed = new Map(subs.route(history));
    expect([...routed.keys()].sort()).toEqual(['match-page', 'team-5940', 'team-6238']);
    const numbers = (json: string) => (JSON.parse(json) as MatchHistoryState).matches.map(m => m.matchNumber);
    expect(numbers(routed.get('match-page')!)).toEqual([1, 2, 3]);
    expect(numbers(routed.get('team-5940')!)).toEqual([1, 3]);
    expect(numbers(routed.get('team-6238')!)).toEqual([2, 3]);
  });

  test('sockets with the same filter share one serialization', () => {
    const subs = new TopicSubscriptions<string>();
    subs.subscribe('a', 'matchHistory', [5940]);
    subs.subscribe('b', 'matchHistory', [5940, 5940]);
    const [[, first], [, second]] = subs.route(history);
    expect(second).toBe(first);
  });

  test('a message that is not a topic message is not routed here', () => {
    const subs = new TopicSubscriptions<string>();
    subs.subscribe('a', 'matchHistory');
    expect(subs.route({ type: 'matchState' })).toEqual([]);
  });

  test('unsubscribing, re-subscribing and closing', () => {
    const subs = new TopicSubscriptions<string>();
    subs.subscribe('a', 'matchHistory', [5940]);
    // A new subscribe replaces the filter: this page now wants everything.
    subs.subscribe('a', 'matchHistory');
    expect(subs.filterOf('a', 'matchHistory')).toBeNull();
    subs.unsubscribe('a', 'matchHistory');
    expect(subs.route(history)).toEqual([]);
    expect(subs.filterOf('a', 'matchHistory')).toBeUndefined();

    subs.subscribe('b', 'timelapse');
    subs.drop('b');
    expect(subs.route({ type: 'timelapseState' })).toEqual([]);
  });
});
