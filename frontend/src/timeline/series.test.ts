import { describe, expect, test } from 'bun:test';
import { bucketize, EventSeries, NumericSeries, StateSeries, type NumericBucket } from './series';

const T = 1_700_000_000_000;

describe('NumericSeries (linear)', () => {
  const battery = () => new NumericSeries({ mode: 'linear', staleAfterMs: 1_500 });

  test('keeps every reading and the lowest seen between them', () => {
    const s = battery();
    s.push(T, 12.4);
    s.push(T + 250, 12.1, 9.8);
    expect(s.length).toBe(2);
    expect(s.sampleAt(T + 300)).toEqual({
      t: T + 250,
      v: expect.closeTo(12.1, 5),
      lo: expect.closeTo(9.8, 5),
      hi: expect.closeTo(12.1, 5),
    });
    expect(s.range(T, T + 1000)).toEqual({ min: expect.closeTo(9.8, 5), max: expect.closeTo(12.4, 5) });
  });

  test('a reading exactly at the asked time counts', () => {
    const s = battery();
    s.push(T, 12);
    s.push(T + 250, 11);
    expect(s.sampleAt(T + 250)?.v).toBe(11);
    expect(s.sampleAt(T - 1)).toBeNull();
  });

  test('a reading is not held past the silence that follows it', () => {
    const s = battery();
    s.push(T, 12);
    expect(s.sampleAt(T + 1_000)?.v).toBe(12);
    expect(s.sampleAt(T + 2_000)).toBeNull();
  });

  test('ignores a replayed (older) reading', () => {
    const s = battery();
    s.push(T + 500, 12);
    s.push(T, 11);
    s.push(T + 500, 10);
    expect(s.length).toBe(1);
    expect(s.latest()?.v).toBe(12);
  });

  test('grows past its first allocation and survives trimming', () => {
    const s = battery();
    for (let i = 0; i < 5_000; i++) s.push(T + i * 20, i);
    expect(s.length).toBe(5_000);
    s.trimBefore(T + 4_000 * 20);
    // One reading before the cut is kept, to say what the value was there.
    expect(s.length).toBe(1_001);
    expect(s.timeAt(0)).toBe(T + 3_999 * 20);
    for (let i = 5_000; i < 12_000; i++) s.push(T + i * 20, i);
    expect(s.latest()).toEqual({ t: T + 11_999 * 20, v: 11_999, lo: 11_999, hi: 11_999 });
    expect(s.valueAt(0)).toBe(3_999);
  });
});

describe('NumericSeries (hold)', () => {
  const register = () => new NumericSeries({ mode: 'hold', staleAfterMs: 20_000 });

  test('stores a change, not every poll', () => {
    const s = register();
    for (let i = 0; i < 10; i++) s.push(T + i * 100, -52);
    s.push(T + 1_000, -55);
    expect(s.length).toBe(2);
    expect(s.sampleAt(T + 900)?.v).toBe(-52);
    expect(s.sampleAt(T + 1_000)?.v).toBe(-55);
  });

  test('holds the newest value only while the source keeps reporting', () => {
    const s = register();
    s.push(T, -52);
    s.push(T + 15_000, -52);
    expect(s.sampleAt(T + 30_000)?.v).toBe(-52);
    expect(s.sampleAt(T + 36_000)).toBeNull();
  });

  test('a silence longer than a value can be held becomes a gap', () => {
    const s = register();
    s.push(T, -52);
    s.push(T + 60_000, -52);
    expect(s.sampleAt(T + 10_000)?.v).toBe(-52);
    expect(s.sampleAt(T + 30_000)).toBeNull();
    expect(s.sampleAt(T + 60_000)?.v).toBe(-52);
  });

  test('an explicit gap ends the value there', () => {
    const s = register();
    s.push(T, 100);
    s.gap(T + 1_000);
    s.gap(T + 1_100);
    expect(s.length).toBe(2);
    expect(s.sampleAt(T + 500)?.v).toBe(100);
    expect(s.sampleAt(T + 1_500)).toBeNull();
    s.push(T + 2_000, 100);
    expect(s.sampleAt(T + 2_500)?.v).toBe(100);
  });
});

describe('StateSeries', () => {
  test('records changes and reports what each one replaced', () => {
    const s = new StateSeries<'disabled' | 'teleop'>({ staleAfterMs: 3_000 });
    expect(s.set(T, 'disabled')).toBeNull();
    expect(s.set(T + 250, 'disabled')).toBeUndefined();
    expect(s.set(T + 500, 'teleop')).toBe('disabled');
    expect(s.length).toBe(2);
    expect(s.valueAt(T + 400)).toBe('disabled');
    expect(s.valueAt(T + 500)).toBe('teleop');
    expect(s.valueAt(T - 1)).toBeNull();
  });

  test('false is a value, not "unknown"', () => {
    const s = new StateSeries<boolean>({ staleAfterMs: 3_000 });
    s.set(T, false);
    expect(s.set(T + 250, true)).toBe(false);
    expect(s.valueAt(T + 100)).toBe(false);
    expect(s.segments(T, T + 1_000, T + 1_000)).toEqual([
      { start: T, end: T + 250, value: false, open: false },
      { start: T + 250, end: T + 1_000, value: true, open: true },
    ]);
  });

  test('goes unknown when the source stops reporting', () => {
    const s = new StateSeries<'robot'>({ staleAfterMs: 3_000 });
    s.set(T, 'robot');
    s.set(T + 1_000, 'robot');
    expect(s.valueAt(T + 3_500)).toBe('robot');
    expect(s.valueAt(T + 5_000)).toBeNull();
    // Still unknown in hindsight once it comes back, and that is a change.
    expect(s.set(T + 10_000, 'robot')).toBeNull();
    expect(s.segments(T, T + 11_000, T + 11_000)).toEqual([
      { start: T, end: T + 4_000, value: 'robot', open: false },
      { start: T + 10_000, end: T + 11_000, value: 'robot', open: true },
    ]);
  });

  test('trimming keeps the value in force at the cut', () => {
    const s = new StateSeries<'a' | 'b'>({ staleAfterMs: 60_000 });
    s.set(T, 'a');
    s.set(T + 1_000, 'b');
    s.set(T + 2_000, 'a');
    s.trimBefore(T + 1_500);
    expect(s.length).toBe(2);
    expect(s.valueAt(T + 1_500)).toBe('b');
  });
});

describe('EventSeries', () => {
  test('a running span is updated in place, then closed', () => {
    const e = new EventSeries();
    e.upsert({ id: 'r', t: T, open: true, label: 'Field Wi-Fi update', tone: 'warning' });
    e.upsert({ id: 'x', t: T + 5_000, label: 'Enabled', tone: 'good' });
    e.upsert({ id: 'r', t: T, open: true, label: 'Field Wi-Fi update', tone: 'warning', detail: '2 stations change' });
    expect(e.length).toBe(2);
    // Running, it reaches "now" — so it is in view long after it started.
    expect(e.inRange(T + 30_000, T + 40_000, T + 40_000).map(x => x.id)).toEqual(['r']);
    e.close('r', T + 38_000);
    expect(e.get('r')).toMatchObject({ end: T + 38_000, open: false, detail: '2 stations change' });
    expect(e.inRange(T + 39_000, T + 40_000, T + 40_000)).toEqual([]);
  });

  test('stays in time order whatever order events arrive in', () => {
    const e = new EventSeries();
    e.upsert({ id: 'b', t: T + 2_000, label: 'b', tone: 'neutral' });
    e.upsert({ id: 'a', t: T + 1_000, label: 'a', tone: 'neutral' });
    e.upsert({ id: 'c', t: T + 3_000, label: 'c', tone: 'neutral' });
    expect(e.inRange(T, T + 5_000, T + 5_000).map(x => x.id)).toEqual(['a', 'b', 'c']);
    e.trimBefore(T + 1_500, T + 5_000);
    expect(e.get('a')).toBeUndefined();
    expect(e.length).toBe(2);
  });
});

describe('bucketize', () => {
  test('a column with many readings keeps its extremes', () => {
    const s = new NumericSeries({ mode: 'linear', staleAfterMs: 1_500 });
    // 50 Hz for 10 s, with one 20 ms sag.
    for (let i = 0; i < 500; i++) s.push(T + i * 20, i === 250 ? 7 : 12);
    const buckets: NumericBucket[] = [];
    bucketize(s, T, T + 10_000, 100, b => buckets.push({ ...b }));
    expect(buckets.length).toBe(100);
    expect(buckets.filter(b => b.min === 7).length).toBe(1);
    expect(buckets.every(b => b.max === 12)).toBe(true);
  });

  test('includes the readings just outside the view, and marks gaps', () => {
    const s = new NumericSeries({ mode: 'linear', staleAfterMs: 1_500 });
    s.push(T - 100, 1);
    s.push(T + 100, 2);
    s.gap(T + 200);
    s.push(T + 300, 3);
    s.push(T + 1_100, 4);
    s.push(T + 1_200, 5);
    const seen: [number, number][] = [];
    bucketize(s, T, T + 1_000, 10, (b, firstT) => seen.push([firstT - T, b.first]));
    expect(seen).toEqual([
      [-100, 1],
      [100, 2],
      [200, NaN],
      [300, 3],
      [1_100, 4],
    ]);
  });
});
