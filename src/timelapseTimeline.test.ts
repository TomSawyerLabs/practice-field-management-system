import { describe, expect, test } from 'bun:test';
import { backfillActivity, mergeMatches, placeSegments, summarizeDays, type ChunkInfo } from './timelapseTimeline.js';
import type { FieldActivityMatch, FieldActivitySpan } from './types.js';

const T0 = new Date(2026, 8, 27, 12, 0, 0).getTime();
const min = (n: number) => T0 + n * 60_000;

const chunk = (file: string, start: number, end: number, extra: Partial<ChunkInfo> = {}): ChunkInfo => ({
  file,
  stream: 'All field',
  source: 'live',
  start,
  end,
  // 60× — a minute of field time is a second of film.
  mediaSeconds: (end - start) / 60_000,
  ...extra,
});

describe('placeSegments', () => {
  test('non-overlapping chunks keep their whole span, in time order', () => {
    const segs = placeSegments([chunk('b', min(40), min(50)), chunk('a', min(0), min(30))]);
    expect(segs.map(s => [s.file, s.start, s.end, s.mediaStart, s.mediaEnd])).toEqual([
      ['a', min(0), min(30), 0, 30],
      ['b', min(40), min(50), 0, 10],
    ]);
  });

  test('an overlap goes to the earlier chunk; the later one starts where it ends, seeked in', () => {
    // Live capture runs until the countdown at 21:00; the match's own chunk
    // starts at its pre-roll a minute earlier.
    const segs = placeSegments([
      chunk('live', min(0), min(21)),
      chunk('match', min(20), min(24), { source: 'match', matchId: 'm1' }),
    ]);
    expect(segs[1]).toMatchObject({ file: 'match', start: min(21), end: min(24), mediaStart: 1, mediaEnd: 4 });
    expect(segs[1].matchId).toBe('m1');
  });

  test('a chunk wholly inside an earlier one is dropped', () => {
    const segs = placeSegments([chunk('outer', min(0), min(30)), chunk('inner', min(5), min(10))]);
    expect(segs.map(s => s.file)).toEqual(['outer']);
  });

  test('unplayable chunks (no length) are left out', () => {
    expect(placeSegments([chunk('x', min(0), min(10), { mediaSeconds: 0 })])).toEqual([]);
  });
});

describe('mergeMatches', () => {
  const m = (id: string, start: number, red?: number): FieldActivityMatch => ({
    id,
    matchNumber: 1,
    start,
    end: start + 150_000,
    teams: [],
    red,
  });

  test("history's copy wins, the log fills in what history has rolled off", () => {
    const merged = mergeMatches([m('old', min(0), 3), m('a', min(10), 1)], [m('a', min(10), 7)]);
    expect(merged.map(x => [x.id, x.red])).toEqual([
      ['old', 3],
      ['a', 7],
    ]);
  });
});

describe('backfillActivity', () => {
  const logged: { robots: FieldActivitySpan[]; enables: FieldActivitySpan[] } = {
    robots: [{ kind: 'robot', team: 5940, station: 'slot1', start: min(70), end: min(80) }],
    enables: [],
  };

  test('after the log began, only the log is used', () => {
    const out = backfillActivity({
      from: min(60),
      to: min(120),
      logged,
      since: min(60),
      usage: [{ team: 1, station: 'slot2', startedAt: min(0), lastSeenAt: min(100), endedAt: min(100) }],
      practiceRuns: [],
    });
    expect(out).toBe(logged);
  });

  test('before it, usage sessions and practice runs stand in, cut off where the log starts', () => {
    const out = backfillActivity({
      from: min(0),
      to: min(120),
      logged,
      since: min(60),
      usage: [{ team: 6036, station: 'slot2', startedAt: min(10), lastSeenAt: min(90), endedAt: min(90) }],
      practiceRuns: [
        {
          id: 'practice-1',
          station: 'slot2',
          teamNumber: 6036,
          // Padded 3 s either side of the enable.
          startedAt: min(20) - 3000,
          endedAt: min(21) + 3000,
          recordings: [],
        },
      ],
    });
    expect(out.robots.map(r => [r.team, r.start, r.end])).toEqual([
      [6036, min(10), min(60)],
      [5940, min(70), min(80)],
    ]);
    expect(out.enables.map(e => [e.team, e.start, e.end])).toEqual([[6036, min(20), min(21)]]);
  });
});

describe('summarizeDays', () => {
  test('a session past midnight belongs to the practice day it started on (04:00 rollover)', () => {
    const lateNight = new Date(2026, 8, 27, 23, 30).getTime();
    const afterMidnight = new Date(2026, 8, 28, 0, 30).getTime();
    const nextMorning = new Date(2026, 8, 28, 9, 0).getTime();
    const days = summarizeDays(placeSegments([chunk('a', lateNight, afterMidnight)]), [{ at: nextMorning }]);
    expect(days.map(d => [d.day, d.segments, d.videoSeconds, d.frames])).toEqual([
      ['2026-09-27', 1, 3600, 0],
      ['2026-09-28', 0, 0, 1],
    ]);
  });
});
