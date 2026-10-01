import { describe, expect, test } from 'bun:test';
import type { TimelapseSegment } from '../../../src/types';
import {
  axisTicks,
  clusterSpans,
  concurrency,
  mediaToWall,
  practiceDayOf,
  practiceDayRange,
  scrubTile,
  segmentAt,
  stillForGap,
  teamLanes,
  wallToMedia,
} from './timelapseModel';

const T0 = new Date(2026, 8, 27, 12, 0, 0).getTime();
const min = (n: number) => T0 + n * 60_000;

const seg = (start: number, end: number, extra: Partial<TimelapseSegment> = {}): TimelapseSegment => ({
  file: `x-${start}`,
  source: 'live',
  start,
  end,
  mediaStart: 0,
  mediaEnd: (end - start) / 60_000,
  ...extra,
});

describe('segments', () => {
  const segs = [seg(min(0), min(30)), seg(min(40), min(50)), seg(min(50), min(60))];

  test('finding the segment under a moment, and the gaps between', () => {
    expect(segmentAt(segs, min(0))).toBe(0);
    expect(segmentAt(segs, min(29.99))).toBe(0);
    expect(segmentAt(segs, min(35))).toBe(-1);
    expect(segmentAt(segs, min(50))).toBe(2);
    expect(segmentAt(segs, min(60))).toBe(-1);
  });

  test('wall and film time map both ways, including a trimmed start', () => {
    const trimmed = seg(min(21), min(24), { mediaStart: 1, mediaEnd: 4 });
    expect(wallToMedia(trimmed, min(22))).toBeCloseTo(2, 6);
    expect(mediaToWall(trimmed, 3.5)).toBeCloseTo(min(23.5), 0);
    // Clamped at the ends.
    expect(wallToMedia(trimmed, min(30))).toBe(4);
  });

  test('the scrub tile under a moment', () => {
    // A tile every 1/3 s of film = 20 s of field time at 60×.
    const s = seg(min(0), min(30), {
      scrub: { file: 'x.scrub.jpg', cols: 10, count: 90, tileWidth: 160, tileHeight: 143, interval: 1 / 3 },
    });
    expect(scrubTile(s, min(0))).toMatchObject({ sx: 0, sy: 0 });
    // 3 min 40 s in = tile 11: second row, second column.
    expect(scrubTile(s, min(3) + 40_000)).toMatchObject({ sx: 160, sy: 143 });
    expect(scrubTile(s, min(30))).toMatchObject({ sx: 9 * 160, sy: 8 * 143 });
    expect(scrubTile(seg(min(0), min(1)), min(0))).toBeNull();
  });

  test('a gap shows the archival still taken in it', () => {
    const frames = [{ at: min(-60) }, { at: min(33) }, { at: min(37) }];
    expect(stillForGap(frames, segs, min(36))).toEqual({ at: min(33) });
    expect(stillForGap(frames, segs, min(38))).toEqual({ at: min(37) });
    // Before the first still in the gap: the gap's first still.
    expect(stillForGap(frames, segs, min(31))).toEqual({ at: min(33) });
    // A still from before the previous segment belongs to another gap.
    expect(stillForGap([{ at: min(-60) }], segs, min(36))).toBeUndefined();
  });
});

describe('clusterSpans', () => {
  // 100 enables of 2 s, every 5 s.
  const enables = Array.from({ length: 100 }, (_, i) => ({ start: min(0) + i * 5000, end: min(0) + i * 5000 + 2000 }));

  test('at a day-wide zoom a burst of enables is one cluster, with its density', () => {
    // 1 px = 1 min.
    const clusters = clusterSpans(enables, 60_000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(100);
    expect(clusters[0].busyMs).toBe(200_000);
    expect(clusters[0].end - clusters[0].start).toBe(99 * 5000 + 2000);
  });

  test('zoomed in, they separate again', () => {
    // 1 px = 0.5 s: 3 s gaps are 6 px.
    expect(clusterSpans(enables, 500)).toHaveLength(100);
  });

  test('robot presence lanes: back-to-back spans are not double counted', () => {
    expect(
      concurrency([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 5, end: 15 },
      ]),
    ).toEqual([
      [0, 1],
      [5, 2],
      [10, 2],
      [15, 1],
      [20, 0],
    ]);
  });
});

describe('teamLanes', () => {
  test('one lane per team in order of arrival, with its enabled time', () => {
    const lanes = teamLanes(
      [
        { kind: 'robot', team: 971, station: 'slot2', start: min(10), end: min(50) },
        { kind: 'robot', team: 5940, station: 'slot1', start: min(0), end: min(60) },
      ],
      [
        { kind: 'enable', team: 5940, station: 'slot1', start: min(1), end: min(2) },
        { kind: 'enable', team: 5940, station: 'slot1', start: min(3), end: min(5) },
      ],
    );
    expect(lanes.map(l => [l.team, l.enables.length, l.enabledMs])).toEqual([
      [5940, 2, 3 * 60_000],
      [971, 0, 0],
    ]);
  });
});

describe('axis and days', () => {
  test('a day-wide axis ticks on the hour, a zoomed one on round minutes', () => {
    const day = practiceDayRange('2026-09-27');
    const wide = axisTicks(day.start, day.end, 1200);
    expect(wide.step).toBeGreaterThanOrEqual(60 * 60_000);
    expect(new Date(wide.major[0]).getMinutes()).toBe(0);
    // 20 minutes across 1500 px: a minute is 75 px, enough for a label.
    const zoomed = axisTicks(min(0) + 17_000, min(20), 1500);
    expect(zoomed.step).toBe(60_000);
    expect(zoomed.major[0]).toBe(min(1));
  });

  test('a practice day runs 04:00 to 04:00', () => {
    expect(practiceDayOf(new Date(2026, 8, 28, 1, 30).getTime())).toBe('2026-09-27');
    expect(practiceDayOf(new Date(2026, 8, 28, 4, 0).getTime())).toBe('2026-09-28');
    const r = practiceDayRange('2026-09-27');
    expect(r.end - r.start).toBe(24 * 60 * 60_000);
  });
});
