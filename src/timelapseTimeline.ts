/**
 * The timelapse viewer's one logical timeline, assembled from what is on
 * disk. Pure functions — `FieldTimelapse` gathers the inputs, this decides
 * what the page is shown — so the rules are testable without ffmpeg.
 *
 * - Chunks become segments placed on the wall clock. Where two overlap (a
 *   match's own chunk starts at its pre-roll, while the live capture is still
 *   running) the earlier one keeps the overlap and the later one is trimmed,
 *   so any moment is covered by one segment at most.
 * - Matches come from match history, with the activity log's copies filling
 *   in for entries history has rolled off.
 * - Robots and enables come from the activity log. For time before the log
 *   existed they are backfilled from the coarser records pFMS already kept:
 *   radio-link sessions for robots, practice runs for enables.
 */
import { practiceDayEnd, practiceDayOf } from './practiceStore.js';
import {
  PRACTICE_PAD_SECONDS,
  type FieldActivityMatch,
  type FieldActivitySpan,
  type PracticeRunEntry,
  type TimelapseDaySummary,
  type TimelapseScrub,
  type TimelapseSegment,
  type UsageSession,
} from './types.js';

/** One chunk on disk, with its timing (measured, or estimated if the chunk
 *  has not been finalized yet). */
export interface ChunkInfo {
  /** `<day>/<name>.mp4` under the store's `active/`. */
  file: string;
  /** Stream name. */
  stream: string;
  source: 'live' | 'match';
  /** Wall-clock span the chunk's footage covers. */
  start: number;
  end: number;
  /** Length of the chunk's own playback. */
  mediaSeconds: number;
  capturing?: boolean;
  estimated?: boolean;
  scrub?: TimelapseScrub;
  proxy?: string;
  matchId?: string;
}

/** Place chunks on the wall clock, trimming overlaps (earlier wins). */
export function placeSegments(chunks: ChunkInfo[]): TimelapseSegment[] {
  const out: TimelapseSegment[] = [];
  let covered = -Infinity;
  const sorted = chunks
    .filter(c => c.end > c.start && c.mediaSeconds > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const c of sorted) {
    const start = Math.max(c.start, covered);
    if (start >= c.end) continue;
    const perMs = c.mediaSeconds / (c.end - c.start);
    out.push({
      file: c.file,
      source: c.source,
      start,
      end: c.end,
      mediaStart: round3((start - c.start) * perMs),
      mediaEnd: round3(c.mediaSeconds),
      ...(c.capturing ? { capturing: true } : {}),
      ...(c.estimated ? { estimated: true } : {}),
      ...(c.scrub ? { scrub: c.scrub } : {}),
      ...(c.proxy ? { proxy: c.proxy } : {}),
      ...(c.matchId ? { matchId: c.matchId } : {}),
    });
    covered = Math.max(covered, c.end);
  }
  return out;
}

/** History's version of a match wins (its scores are the live ones); the
 *  log supplies the matches history no longer holds. */
export function mergeMatches(logged: FieldActivityMatch[], history: FieldActivityMatch[]): FieldActivityMatch[] {
  const byId = new Map<string, FieldActivityMatch>();
  for (const m of logged) byId.set(m.id, m);
  for (const m of history) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.start - b.start);
}

/**
 * Robots and enables for [from, to]: the activity log from `since` on, and
 * before that the records pFMS kept anyway.
 *
 * Radio-link sessions bridge link drops of up to two hours, so a backfilled
 * robot lane is continuous where the real one had gaps. Practice runs only
 * exist for teams that recorded, and are padded 3 s either side (removed
 * here) and merge re-enables within 6 s — close enough to draw.
 */
export function backfillActivity(opts: {
  from: number;
  to: number;
  logged: { robots: FieldActivitySpan[]; enables: FieldActivitySpan[] };
  since: number | undefined;
  usage: UsageSession[];
  practiceRuns: PracticeRunEntry[];
}): { robots: FieldActivitySpan[]; enables: FieldActivitySpan[] } {
  const { from, to, logged } = opts;
  const since = opts.since ?? Infinity;
  if (from >= since) return logged;

  const clip = (span: FieldActivitySpan): FieldActivitySpan | null => {
    const end = Math.min(span.end, since);
    if (end <= span.start || end < from || span.start > to) return null;
    return { ...span, end };
  };
  const robots = opts.usage
    .map(u =>
      clip({ kind: 'robot', team: u.team, station: u.station, start: u.startedAt, end: u.endedAt ?? u.lastSeenAt }),
    )
    .filter((s): s is FieldActivitySpan => s !== null);
  const pad = PRACTICE_PAD_SECONDS * 1000;
  const enables = opts.practiceRuns
    .map(r =>
      clip({ kind: 'enable', team: r.teamNumber, station: r.station, start: r.startedAt + pad, end: r.endedAt - pad }),
    )
    .filter((s): s is FieldActivitySpan => s !== null);
  const byStart = (a: FieldActivitySpan, b: FieldActivitySpan) => a.start - b.start;
  return {
    robots: [...robots, ...logged.robots].sort(byStart),
    enables: [...enables, ...logged.enables].sort(byStart),
  };
}

/** Practice days (04:00–04:00) with footage, oldest first. A chunk that runs
 *  across 04:00 counts toward the day it started in. */
export function summarizeDays(segments: TimelapseSegment[], frames: { at: number }[]): TimelapseDaySummary[] {
  const days = new Map<string, TimelapseDaySummary>();
  const dayOf = (at: number): TimelapseDaySummary => {
    const day = practiceDayOf(at);
    let entry = days.get(day);
    if (!entry) {
      entry = { day, videoSeconds: 0, segments: 0, frames: 0, firstAt: at, lastAt: at };
      days.set(day, entry);
    }
    return entry;
  };
  for (const s of segments) {
    const d = dayOf(s.start);
    d.segments++;
    d.videoSeconds += Math.round((s.end - s.start) / 1000);
    d.firstAt = Math.min(d.firstAt, s.start);
    d.lastAt = Math.max(d.lastAt, Math.min(s.end, practiceDayEnd(d.day)));
  }
  for (const f of frames) {
    const d = dayOf(f.at);
    d.frames++;
    d.firstAt = Math.min(d.firstAt, f.at);
    d.lastAt = Math.max(d.lastAt, f.at);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
