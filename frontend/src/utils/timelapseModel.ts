/**
 * The arithmetic behind /timelapse, kept out of the components so it can be
 * tested: where a wall-clock moment is in the film, which scrub tile shows
 * it, how a crowd of short spans collapses into something drawable at the
 * current zoom, and where the axis ticks go.
 */
import type { FieldActivityMatch, FieldActivitySpan, TimelapseScrub, TimelapseSegment } from '../../../src/types';

// ── segments ───────────────────────────────────────────────────────────

/** Index of the segment covering `t`, or -1 in a gap. Segments are sorted
 *  and do not overlap (the server trims them). */
export function segmentAt(segments: TimelapseSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Index of the first segment starting after `t`, or -1. */
export function nextSegmentAfter(segments: TimelapseSegment[], t: number): number {
  for (let i = 0; i < segments.length; i++) if (segments[i].start > t) return i;
  return -1;
}

/** Index of the last segment ending at or before `t`, or -1. */
export function previousSegmentBefore(segments: TimelapseSegment[], t: number): number {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].end <= t) return i;
  return -1;
}

/** Seconds into the segment's file for wall-clock `t`. */
export function wallToMedia(seg: TimelapseSegment, t: number): number {
  const f = (t - seg.start) / (seg.end - seg.start);
  return seg.mediaStart + Math.min(1, Math.max(0, f)) * (seg.mediaEnd - seg.mediaStart);
}

/** Wall-clock time of `media` seconds into the segment's file. */
export function mediaToWall(seg: TimelapseSegment, media: number): number {
  const f = (media - seg.mediaStart) / (seg.mediaEnd - seg.mediaStart || 1);
  return seg.start + Math.min(1, Math.max(0, f)) * (seg.end - seg.start);
}

/** Field seconds per second of film. */
export function segmentSpeed(seg: TimelapseSegment): number {
  return (seg.end - seg.start) / 1000 / Math.max(1e-6, seg.mediaEnd - seg.mediaStart);
}

/** Where in its scrub sheet the frame for wall-clock `t` is, in sheet pixels. */
export function scrubTile(seg: TimelapseSegment, t: number): { scrub: TimelapseScrub; sx: number; sy: number } | null {
  const scrub = seg.scrub;
  if (!scrub || scrub.count === 0) return null;
  const i = Math.min(scrub.count - 1, Math.max(0, Math.floor(wallToMedia(seg, t) / scrub.interval)));
  return {
    scrub,
    sx: (i % scrub.cols) * scrub.tileWidth,
    sy: Math.floor(i / scrub.cols) * scrub.tileHeight,
  };
}

/** The archival still to show in a gap at `t`: the latest one at or before
 *  `t` since the previous segment ended, else the first one before the next
 *  segment starts. */
export function stillForGap<F extends { at: number }>(
  frames: F[],
  segments: TimelapseSegment[],
  t: number,
): F | undefined {
  const prev = previousSegmentBefore(segments, t);
  const next = nextSegmentAfter(segments, t);
  const lo = prev >= 0 ? segments[prev].end : -Infinity;
  const hi = next >= 0 ? segments[next].start : Infinity;
  const inGap = frames.filter(f => f.at >= lo && f.at < hi);
  if (inGap.length === 0) return undefined;
  const before = inGap.filter(f => f.at <= t);
  return before.length > 0 ? before[before.length - 1] : inGap[0];
}

// ── decimation ─────────────────────────────────────────────────────────

/** Spans that sit too close together to tell apart at this zoom, drawn as
 *  one. `busyMs` is how much of the cluster the spans themselves cover —
 *  the density a cluster is shaded by. */
export interface Cluster<T> {
  start: number;
  end: number;
  count: number;
  busyMs: number;
  items: T[];
}

/**
 * Merge spans whose gap is under `minGapPx` at `msPerPx`, and any span
 * narrower than a pixel into its neighbour's cluster. A hundred enables in
 * five minutes on a day-wide view become one shaded bar saying "×100"; zoom
 * in and they separate again.
 */
export function clusterSpans<T extends { start: number; end: number }>(
  spans: T[],
  msPerPx: number,
  minGapPx = 3,
): Cluster<T>[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Cluster<T>[] = [];
  const gapMs = minGapPx * msPerPx;
  for (const s of sorted) {
    const cur = out[out.length - 1];
    if (cur && s.start - cur.end < gapMs) {
      cur.end = Math.max(cur.end, s.end);
      cur.count++;
      cur.busyMs += Math.max(0, s.end - s.start);
      cur.items.push(s);
    } else {
      out.push({ start: s.start, end: s.end, count: 1, busyMs: Math.max(0, s.end - s.start), items: [s] });
    }
  }
  return out;
}

/** How many of the spans are going at each change point: a step function,
 *  as `[t, count]` pairs in time order. */
export function concurrency(spans: { start: number; end: number }[]): [number, number][] {
  const edges: [number, number][] = [];
  for (const s of spans) {
    edges.push([s.start, 1], [s.end, -1]);
  }
  // Ends before starts at the same instant, so back-to-back spans never
  // count double.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  let n = 0;
  for (const [t, d] of edges) {
    n += d;
    if (out.length > 0 && out[out.length - 1][0] === t) out[out.length - 1][1] = n;
    else out.push([t, n]);
  }
  return out;
}

// ── lanes ──────────────────────────────────────────────────────────────

/** One team's row: when its robot was here, and when it was enabled. */
export interface TeamLane {
  team: number;
  robots: FieldActivitySpan[];
  enables: FieldActivitySpan[];
  /** Total enabled time, for the label and sorting. */
  enabledMs: number;
}

/** A row per team seen in the range, in order of first appearance. */
export function teamLanes(robots: FieldActivitySpan[], enables: FieldActivitySpan[]): TeamLane[] {
  const byTeam = new Map<number, TeamLane>();
  const first = new Map<number, number>();
  const lane = (team: number) => {
    let l = byTeam.get(team);
    if (!l) {
      l = { team, robots: [], enables: [], enabledMs: 0 };
      byTeam.set(team, l);
    }
    return l;
  };
  for (const r of robots) {
    lane(r.team).robots.push(r);
    first.set(r.team, Math.min(first.get(r.team) ?? Infinity, r.start));
  }
  for (const e of enables) {
    const l = lane(e.team);
    l.enables.push(e);
    l.enabledMs += e.end - e.start;
    first.set(e.team, Math.min(first.get(e.team) ?? Infinity, e.start));
  }
  return [...byTeam.values()].sort((a, b) => (first.get(a.team) ?? 0) - (first.get(b.team) ?? 0) || a.team - b.team);
}

/** Moments worth jumping between with the previous/next-event keys:
 *  match starts and enable starts, sorted, de-duplicated to the second. */
export function eventTimes(matches: FieldActivityMatch[], enables: FieldActivitySpan[]): number[] {
  const set = new Set<number>();
  for (const m of matches) set.add(Math.round(m.start / 1000) * 1000);
  for (const e of enables) set.add(Math.round(e.start / 1000) * 1000);
  return [...set].sort((a, b) => a - b);
}

// ── axis ───────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const TICK_STEPS = [
  5_000,
  10_000,
  30_000,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  60 * MINUTE,
  2 * 60 * MINUTE,
  3 * 60 * MINUTE,
  6 * 60 * MINUTE,
];

/**
 * Axis ticks for [start, end] across `widthPx`, labelled at least
 * `minLabelPx` apart. Steps land on local clock boundaries (on the hour, on
 * the quarter hour), which is what a person reads a timeline by.
 */
export function axisTicks(
  start: number,
  end: number,
  widthPx: number,
  minLabelPx = 72,
): { major: number[]; minor: number[]; step: number } {
  const msPerPx = (end - start) / Math.max(1, widthPx);
  const step = TICK_STEPS.find(s => s / msPerPx >= minLabelPx) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const minorStep = TICK_STEPS.slice()
    .reverse()
    .find(s => s < step && step % s === 0 && s / msPerPx >= 8);
  const align = (t: number, s: number) => {
    // Align to local midnight so "every 3 h" means 03:00, 06:00, …
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return midnight + Math.ceil((t - midnight) / s) * s;
  };
  const major: number[] = [];
  for (let t = align(start, step); t <= end; t += step) major.push(t);
  const minor: number[] = [];
  if (minorStep) {
    for (let t = align(start, minorStep); t <= end; t += minorStep)
      if ((t - align(t, step)) % step !== 0) minor.push(t);
  }
  return { major, minor, step };
}

// ── formatting ─────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** `14:05` or `14:05:30`. */
export function clock(t: number, seconds = false): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
}

/** `2h 05m`, `4m 10s`, `12s`. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Practice day (`YYYY-MM-DD`) of a moment: days roll over at 04:00, the
 *  same as the practice links, so a session past midnight is one day. */
export function practiceDayOf(t: number): string {
  const d = new Date(t - 4 * 60 * MINUTE);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [04:00 on `day`, 04:00 the next day) in epoch ms. */
export function practiceDayRange(day: string): { start: number; end: number } {
  const [y, m, d] = day.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d, 4, 0, 0, 0).getTime(),
    end: new Date(y, m - 1, d + 1, 4, 0, 0, 0).getTime(),
  };
}

/** "Sat, Sep 27". */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
