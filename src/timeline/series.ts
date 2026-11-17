/**
 * The three kinds of track a timeline can hold. Each keeps its data in the
 * shape the source produces it in — nothing is squeezed into a number so a
 * line chart can draw it.
 *
 * - {@link NumericSeries}: measurements. `linear` for a signal sampled fast
 *   enough to join the dots (battery voltage); `hold` for a register that
 *   keeps its value until the source says otherwise (the radio's ~1 Hz
 *   status).
 * - {@link StateSeries}: a boolean or enum that holds until it changes.
 * - {@link EventSeries}: moments and spans.
 *
 * All times are server epoch ms.
 */

// ── Numeric ─────────────────────────────────────────────────────────

export interface NumericOptions {
  /** `linear`: every sample is kept and neighbours are joined by a line.
   *  `hold`: a sample is kept only when the value changes, and drawn as a
   *  step that lasts until the next one. */
  mode: 'linear' | 'hold';
  /** How long the source may stay silent before the value counts as unknown.
   *  `linear`: neighbours further apart than this are not joined.
   *  `hold`: a value is held at most this long past its last report. */
  staleAfterMs: number;
}

export interface NumericSample {
  t: number;
  v: number;
  /** Lowest and highest value seen since the previous sample, when the
   *  source says; otherwise both equal `v`. */
  lo: number;
  hi: number;
}

/** What one pixel column of a numeric series covers. */
export interface NumericBucket {
  /** Column index, 0 at the left edge of the view. */
  x: number;
  first: number;
  last: number;
  min: number;
  max: number;
  /** Lowest `lo` and highest `hi` in the column (≤ min, ≥ max). */
  lo: number;
  hi: number;
}

/** A numeric series as it is sent to a page: times as the first one and
 *  then the gaps between them (ms), values to three decimals, `null` for a
 *  gap. `lo`/`hi` are left out when no reading has a spread. */
export interface NumericDump {
  seen: number;
  t: number[];
  v: (number | null)[];
  lo?: (number | null)[];
  hi?: (number | null)[];
}

/** A state series as it is sent to a page (times as in {@link NumericDump}). */
export interface StateDump<V> {
  seen: number;
  t: number[];
  v: (V | null)[];
}

const round3 = (v: number): number | null => (Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);

/** Times as the first one, then the gap to each next one. */
function toDeltas(times: ArrayLike<number>, from: number, to: number): number[] {
  const out: number[] = [];
  let previous = 0;
  for (let i = from; i < to; i++) {
    const t = Math.round(times[i]);
    out.push(i === from ? t : t - previous);
    previous = t;
  }
  return out;
}

const INITIAL_CAPACITY = 256;

export class NumericSeries {
  readonly mode: 'linear' | 'hold';
  readonly staleAfterMs: number;

  private times = new Float64Array(INITIAL_CAPACITY);
  private values = new Float32Array(INITIAL_CAPACITY);
  private lows = new Float32Array(INITIAL_CAPACITY);
  private highs = new Float32Array(INITIAL_CAPACITY);
  private head = 0;
  private tail = 0;
  /** When the source last reported, whether or not a sample was stored. */
  private seen = -Infinity;

  constructor(options: NumericOptions) {
    this.mode = options.mode;
    this.staleAfterMs = options.staleAfterMs;
  }

  get length(): number {
    return this.tail - this.head;
  }

  /** The time of the newest report (−∞ when there has been none). */
  get seenAt(): number {
    return this.seen;
  }

  timeAt(i: number): number {
    return this.times[this.head + i];
  }

  valueAt(i: number): number {
    return this.values[this.head + i];
  }

  lowAt(i: number): number {
    return this.lows[this.head + i];
  }

  highAt(i: number): number {
    return this.highs[this.head + i];
  }

  /**
   * A reading from the source. `lo` and `hi` are the lowest and highest
   * values since the previous reading, for sources that summarise several
   * raw samples into one. Readings older than the newest one are ignored (a
   * replayed history).
   */
  push(t: number, v: number, lo = v, hi = v): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    if (t <= this.seen) return;

    if (this.mode === 'hold') {
      // The source went quiet for longer than a value can be held: say so,
      // rather than drawing the old value across the silence.
      if (this.length > 0 && t - this.seen > this.staleAfterMs) this.gap(this.seen + this.staleAfterMs);
      const lastValue = this.length > 0 ? this.values[this.tail - 1] : NaN;
      if (lastValue !== v) this.append(t, v, v, v);
    } else {
      this.append(t, v, Math.min(v, Number.isFinite(lo) ? lo : v), Math.max(v, Number.isFinite(hi) ? hi : v));
    }
    this.seen = t;
  }

  /** The source says there is no reading from `t` on (robot gone, link down). */
  gap(t: number): void {
    if (this.length === 0) return;
    if (Number.isNaN(this.values[this.tail - 1])) return;
    if (t <= this.times[this.tail - 1]) t = this.times[this.tail - 1] + 1;
    this.append(t, NaN, NaN, NaN);
    if (t > this.seen) this.seen = t;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.seen = -Infinity;
  }

  /** Everything in the series, small enough to send to a page. */
  dump(): NumericDump {
    const v: (number | null)[] = [];
    const lo: (number | null)[] = [];
    const hi: (number | null)[] = [];
    let spread = false;
    for (let i = this.head; i < this.tail; i++) {
      v.push(round3(this.values[i]));
      lo.push(round3(this.lows[i]));
      hi.push(round3(this.highs[i]));
      if (lo[lo.length - 1] !== v[v.length - 1] || hi[hi.length - 1] !== v[v.length - 1]) spread = true;
    }
    const t = toDeltas(this.times, this.head, this.tail);
    return spread ? { seen: this.seen, t, v, lo, hi } : { seen: this.seen, t, v };
  }

  /** Replace what is here with a dump. */
  load(d: NumericDump): void {
    this.clear();
    let t = 0;
    for (let i = 0; i < d.t.length; i++) {
      t = i === 0 ? d.t[0] : t + d.t[i];
      const v = d.v[i] ?? NaN;
      this.append(t, v, d.lo?.[i] ?? v, d.hi?.[i] ?? v);
    }
    this.seen = Number.isFinite(d.seen) ? d.seen : d.t.length > 0 ? t : -Infinity;
  }

  /** Forget everything before `t`, keeping the one sample that says what the
   *  value was at `t`. */
  trimBefore(t: number): void {
    const keepFrom = Math.max(0, this.lowerBound(t) - 1);
    this.head += keepFrom;
  }

  /** Index of the first sample at or after `t` (`length` when there is none). */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[this.head + mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The reading in force at `t`: the newest sample at or before it, unless
   * that one is a gap or too old to still stand.
   */
  sampleAt(t: number): NumericSample | null {
    let i = this.lowerBound(t);
    if (i === this.length || this.timeAt(i) > t) i--;
    if (i < 0) return null;
    const v = this.valueAt(i);
    if (Number.isNaN(v)) return null;
    const st = this.timeAt(i);
    if (this.mode === 'hold') {
      // Held until the next sample; the newest holds while the source reports.
      if (i === this.length - 1 && t > this.seen + this.staleAfterMs) return null;
    } else if (t - st > this.staleAfterMs) {
      return null;
    }
    return { t: st, v, lo: this.lowAt(i), hi: this.highAt(i) };
  }

  /** The newest real reading, however old. */
  latest(): NumericSample | null {
    for (let i = this.length - 1; i >= 0; i--) {
      const v = this.valueAt(i);
      if (!Number.isNaN(v)) return { t: this.timeAt(i), v, lo: this.lowAt(i), hi: this.highAt(i) };
    }
    return null;
  }

  /** Lowest and highest value (lows and highs included) between two times. */
  range(t0: number, t1: number): { min: number; max: number } | null {
    let min = Infinity;
    let max = -Infinity;
    // One sample before t0 still shows on screen (the line or step into view).
    const from = Math.max(0, this.lowerBound(t0) - 1);
    for (let i = from; i < this.length; i++) {
      if (this.timeAt(i) > t1) break;
      const v = this.valueAt(i);
      if (Number.isNaN(v)) continue;
      const lo = this.lowAt(i);
      const hi = this.highAt(i);
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    return min <= max ? { min, max } : null;
  }

  private append(t: number, v: number, lo: number, hi: number): void {
    if (this.tail === this.times.length) this.makeRoom();
    this.times[this.tail] = t;
    this.values[this.tail] = v;
    this.lows[this.tail] = lo;
    this.highs[this.tail] = hi;
    this.tail++;
  }

  /** Slide the live samples to the front, or grow when they fill the arrays. */
  private makeRoom(): void {
    const n = this.length;
    if (this.head >= this.times.length / 2) {
      this.times.copyWithin(0, this.head, this.tail);
      this.values.copyWithin(0, this.head, this.tail);
      this.lows.copyWithin(0, this.head, this.tail);
      this.highs.copyWithin(0, this.head, this.tail);
    } else {
      const capacity = this.times.length * 2;
      const times = new Float64Array(capacity);
      const values = new Float32Array(capacity);
      const lows = new Float32Array(capacity);
      const highs = new Float32Array(capacity);
      times.set(this.times.subarray(this.head, this.tail));
      values.set(this.values.subarray(this.head, this.tail));
      lows.set(this.lows.subarray(this.head, this.tail));
      highs.set(this.highs.subarray(this.head, this.tail));
      this.times = times;
      this.values = values;
      this.lows = lows;
      this.highs = highs;
    }
    this.head = 0;
    this.tail = n;
  }
}

// ── State ───────────────────────────────────────────────────────────

export interface StateSegment<V> {
  start: number;
  end: number;
  value: V;
  /** Still in force at `now` (the end is "so far", not a change). */
  open: boolean;
}

/**
 * A value that holds until it changes: a boolean, or one of a few names.
 * Stored as change points. `null` means unknown — said outright by the
 * source, or because it stopped reporting for longer than `staleAfterMs`.
 */
export class StateSeries<V extends string | boolean> {
  readonly staleAfterMs: number;

  private times: number[] = [];
  private values: (V | null)[] = [];
  private seen = -Infinity;

  constructor(options: { staleAfterMs: number }) {
    this.staleAfterMs = options.staleAfterMs;
  }

  get length(): number {
    return this.times.length;
  }

  get seenAt(): number {
    return this.seen;
  }

  /**
   * The source reports the value at `t`. Returns the value it replaced when
   * this is a change (`undefined` when it is not), so callers can raise an
   * event on a transition without keeping their own copy.
   */
  set(t: number, value: V | null): V | null | undefined {
    if (!Number.isFinite(t) || t <= this.seen) return undefined;
    const n = this.times.length;
    let previous = n > 0 ? this.values[n - 1] : null;

    // Silent for too long: the old value stopped being known back then.
    if (previous !== null && t - this.seen > this.staleAfterMs) {
      this.times.push(this.seen + this.staleAfterMs);
      this.values.push(null);
      previous = null;
    }
    this.seen = t;
    if (previous === value) return undefined;
    this.times.push(t);
    this.values.push(value);
    return previous;
  }

  clear(): void {
    this.times = [];
    this.values = [];
    this.seen = -Infinity;
  }

  dump(): StateDump<V> {
    return { seen: this.seen, t: toDeltas(this.times, 0, this.times.length), v: [...this.values] };
  }

  /** Replace what is here with a dump. */
  load(d: StateDump<V>): void {
    this.times = [];
    this.values = [...d.v];
    let t = 0;
    for (let i = 0; i < d.t.length; i++) {
      t = i === 0 ? d.t[0] : t + d.t[i];
      this.times.push(t);
    }
    this.seen = Number.isFinite(d.seen) ? d.seen : d.t.length > 0 ? t : -Infinity;
  }

  /** The value in force at `t`, or null when unknown. */
  valueAt(t: number): V | null {
    const i = this.indexAt(t);
    if (i < 0) return null;
    if (i === this.times.length - 1 && t > this.seen + this.staleAfterMs) return null;
    return this.values[i];
  }

  /** The known stretches between two times, oldest first. Unknown stretches
   *  are left out. `now` bounds the stretch that is still in force. */
  segments(t0: number, t1: number, now: number): StateSegment<V>[] {
    const out: StateSegment<V>[] = [];
    const n = this.times.length;
    for (let i = Math.max(0, this.indexAt(t0)); i < n; i++) {
      const start = this.times[i];
      if (start > t1) break;
      const value = this.values[i];
      if (value === null) continue;
      const isLast = i === n - 1;
      const holdsUntil = this.seen + this.staleAfterMs;
      const end = isLast ? Math.min(now, holdsUntil) : this.times[i + 1];
      if (end <= t0 || end <= start) continue;
      out.push({ start, end, value, open: isLast && now <= holdsUntil });
    }
    return out;
  }

  trimBefore(t: number): void {
    const keepFrom = this.indexAt(t);
    if (keepFrom > 0) {
      this.times.splice(0, keepFrom);
      this.values.splice(0, keepFrom);
    }
  }

  /** Index of the change point in force at `t` (−1 before the first). */
  private indexAt(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
}

// ── Events ──────────────────────────────────────────────────────────

/** How loudly an event speaks. Drawn with the status colour of the same name. */
export type EventTone = 'neutral' | 'good' | 'warning' | 'serious' | 'critical';

export interface TimelineEvent {
  /** Stable across re-sends, so a span that is still running can be updated. */
  id: string;
  t: number;
  /** Set for a span; a moment has none. */
  end?: number;
  /** A span that is still running: drawn up to "now". */
  open?: boolean;
  /** Short enough for a flag on the chart ("Enabled", "Teleop"). */
  label: string;
  /** One line more, shown at the crosshair. */
  detail?: string;
  tone: EventTone;
  /** Draw a line through every lane, not just a flag. */
  rule?: boolean;
  /** Belongs to one lane (by id): drawn there, with no flag of its own. */
  lane?: string;
}

export class EventSeries {
  private items: TimelineEvent[] = [];
  private byId = new Map<string, TimelineEvent>();

  get length(): number {
    return this.items.length;
  }

  /** Add an event, or replace the one with the same id. */
  upsert(event: TimelineEvent): void {
    const existing = this.byId.get(event.id);
    if (existing) {
      const moved = existing.t !== event.t;
      Object.assign(
        existing,
        { end: undefined, open: undefined, detail: undefined, rule: undefined, lane: undefined },
        event,
      );
      if (moved) this.items.sort((a, b) => a.t - b.t);
      return;
    }
    const stored = { ...event };
    this.byId.set(stored.id, stored);
    // Almost always the newest; walk back from the end for the rest.
    let i = this.items.length;
    while (i > 0 && this.items[i - 1].t > stored.t) i--;
    this.items.splice(i, 0, stored);
  }

  get(id: string): TimelineEvent | undefined {
    return this.byId.get(id);
  }

  /** Close a running span. */
  close(id: string, end: number): void {
    const e = this.byId.get(id);
    if (!e || !e.open) return;
    e.end = Math.max(end, e.t);
    e.open = false;
  }

  remove(id: string): void {
    const e = this.byId.get(id);
    if (!e) return;
    this.byId.delete(id);
    this.items.splice(this.items.indexOf(e), 1);
  }

  clear(): void {
    this.items = [];
    this.byId.clear();
  }

  /** Every event, oldest first, as plain objects. */
  dump(): TimelineEvent[] {
    return this.items.map(e => ({ ...e }));
  }

  /** Replace what is here with a dump. */
  load(events: readonly TimelineEvent[]): void {
    this.clear();
    for (const e of events) this.upsert(e);
  }

  /** Events that touch the time range, oldest first. */
  inRange(t0: number, t1: number, now: number): TimelineEvent[] {
    return this.items.filter(e => e.t <= t1 && endOf(e, now) >= t0);
  }

  trimBefore(t: number, now: number): void {
    const kept = this.items.filter(e => endOf(e, now) >= t);
    if (kept.length === this.items.length) return;
    for (const e of this.items) if (endOf(e, now) < t) this.byId.delete(e.id);
    this.items = kept;
  }
}

/** Where an event ends on the time axis: its own time for a moment. */
export function endOf(e: TimelineEvent, now: number): number {
  if (e.open) return Math.max(now, e.t);
  return e.end ?? e.t;
}

// ── Decimation ──────────────────────────────────────────────────────

/**
 * Summarise the samples between two times into one bucket per pixel column,
 * so a series with far more samples than pixels still draws every dip. Also
 * returns the neighbours just outside the view, which the line enters from.
 * Gaps (NaN) are skipped; callers break the line where the time between two
 * buckets' samples is too long.
 */
export function bucketize(
  series: NumericSeries,
  t0: number,
  t1: number,
  columns: number,
  each: (bucket: NumericBucket, firstT: number, lastT: number) => void,
): void {
  if (columns <= 0 || t1 <= t0) return;
  const perColumn = (t1 - t0) / columns;
  const from = Math.max(0, series.lowerBound(t0) - 1);
  let current: NumericBucket | null = null;
  let firstT = 0;
  let lastT = 0;

  for (let i = from; i < series.length; i++) {
    const t = series.timeAt(i);
    const v = series.valueAt(i);
    const x = Math.floor((t - t0) / perColumn);
    if (Number.isNaN(v)) {
      if (current) each(current, firstT, lastT);
      current = null;
      // A gap is its own bucket, so the caller knows the line stops here.
      each({ x, first: NaN, last: NaN, min: NaN, max: NaN, lo: NaN, hi: NaN }, t, t);
      if (t > t1) break;
      continue;
    }
    const lo = series.lowAt(i);
    const hi = series.highAt(i);
    if (current && current.x === x) {
      current.last = v;
      if (v < current.min) current.min = v;
      if (v > current.max) current.max = v;
      if (lo < current.lo) current.lo = lo;
      if (hi > current.hi) current.hi = hi;
      lastT = t;
    } else {
      if (current) each(current, firstT, lastT);
      current = { x, first: v, last: v, min: v, max: v, lo, hi };
      firstT = t;
      lastT = t;
    }
    // One sample past the right edge is enough to draw the line out of view.
    if (t > t1) break;
  }
  if (current) each(current, firstT, lastT);
}
