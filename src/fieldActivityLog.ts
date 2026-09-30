/**
 * FieldActivityLog — what was on the field, and when, for the timelapse
 * timeline.
 *
 * Three kinds of record, one JSON object per line in
 * `<dir>/<local day>.jsonl` (filed by the day the record starts):
 *
 *  - `robot`  — a station had a robot: its radio was linked to the field, or
 *    its Driver Station / robot sent telemetry in the last 15 s. Keyed by the
 *    team configured on the station at the time. Absences shorter than
 *    ROBOT_HOLD_MS (a link flap) do not split the span.
 *  - `enable` — the DS status's enabled bit, true to false. Enables inside a
 *    match are logged too: they are the same fact, and the timeline draws the
 *    match around them.
 *  - `match`  — copied from match history, so the timeline still has a match
 *    after history rolls it off (it keeps 250). Re-appended when its scores
 *    change during the post-match count; the last line for an id wins.
 *
 * Nothing else in pFMS keeps this: usage-data.json bridges link drops of up
 * to two hours, and practice runs only exist for teams that record.
 *
 * Spans are written when they close. The ones still open are checkpointed to
 * `open.json` with their last-seen time (every 10 s), so after a crash or a restart
 * (pFMS has no graceful shutdown) they are closed where the evidence ended
 * rather than lost or stretched over the downtime.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  FieldActivityMatch,
  FieldActivitySpan,
  MatchHistoryEntry,
  StationName,
  TelemetryUpdate,
} from './types.js';
import { StationNameList } from './types.js';

/** Telemetry this recent means a robot (or its DS) is here. */
const TELEMETRY_PRESENCE_MS = 15_000;
/** A robot missing for less than this keeps its span (link flaps). */
const ROBOT_HOLD_MS = 30_000;
/** Robot spans shorter than this are link glitches, not robots. */
const MIN_ROBOT_MS = 5_000;
const TICK_MS = 5_000;
/** How stale a recovered span's end can be after a crash. */
const CHECKPOINT_MS = 10_000;
const OPEN_FILE = 'open.json';
const META_FILE = 'meta.json';
const DAY_MS = 24 * 60 * 60 * 1000;

type Line =
  | { kind: 'robot' | 'enable'; team: number; station: StationName; start: number; end: number }
  | ({ kind: 'match' } & FieldActivityMatch);

interface OpenSpan {
  kind: 'robot' | 'enable';
  team: number;
  station: StationName;
  start: number;
  lastSeen: number;
}

export interface FieldActivityLogOptions {
  /** Where the day files live. Created on start. */
  directory: string;
  getTeamForStation: (station: StationName) => number | undefined;
  now?: () => number;
  /** Presence/checkpoint cadence; tests turn it off and call tick(). */
  tickMs?: number;
}

export class FieldActivityLog {
  private readonly opts: FieldActivityLogOptions;
  private readonly now: () => number;
  private readonly dir: string;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastCheckpoint = 0;
  private checkpointDirty = false;

  private readonly linked = new Map<StationName, boolean>();
  private readonly lastTelemetry = new Map<StationName, number>();
  private readonly robots = new Map<StationName, OpenSpan>();
  private readonly enables = new Map<StationName, OpenSpan>();
  /** What was last written for each match id, so an unchanged entry is not
   *  appended again on every history update. */
  private readonly loggedMatches = new Map<string, string>();
  private since: number | undefined;
  /** Parsed day files, keyed by name, reused while the file is unchanged. */
  private readonly cache = new Map<string, { size: number; mtimeMs: number; lines: Line[] }>();

  constructor(opts: FieldActivityLogOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.dir = opts.directory;
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.loadMeta();
    this.recoverOpen();
    this.loadLoggedMatches();
    const tickMs = this.opts.tickMs ?? TICK_MS;
    if (tickMs > 0) this.tickTimer = setInterval(() => this.tick(), tickMs);
  }

  /** Close everything that is open, as of now. */
  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    const now = this.now();
    for (const span of [...this.robots.values()]) this.close(this.robots, span, Math.min(now, span.lastSeen + 1));
    for (const span of [...this.enables.values()]) this.close(this.enables, span, now);
    this.checkpoint(true);
  }

  /** When logging began (epoch ms). Before this the timeline falls back on
   *  coarser records. */
  loggedSince(): number | undefined {
    return this.since;
  }

  // ── inputs ─────────────────────────────────────────────────────────

  onTelemetry(update: TelemetryUpdate): void {
    const now = this.now();
    this.lastTelemetry.set(update.station, now);
    this.present(update.station, now);
    if (!update.dsStatus) return;
    const open = this.enables.get(update.station);
    if (update.dsStatus.enabled) {
      if (open) {
        open.lastSeen = now;
        return;
      }
      const team = this.opts.getTeamForStation(update.station);
      if (team === undefined) return;
      this.enables.set(update.station, { kind: 'enable', team, station: update.station, start: now, lastSeen: now });
      this.checkpointDirty = true;
    } else if (open) {
      this.close(this.enables, open, now);
    }
  }

  /** The radio reported whether a station's robot is associated. */
  onLinkState(station: StationName, linked: boolean): void {
    this.linked.set(station, linked);
    if (linked) this.present(station, this.now());
  }

  /** Stations may have changed team: a span belongs to one team. */
  onConfigChanged(): void {
    const now = this.now();
    for (const map of [this.robots, this.enables]) {
      for (const span of [...map.values()]) {
        if (this.opts.getTeamForStation(span.station) !== span.team) this.close(map, span, now);
      }
    }
    for (const station of StationNameList) if (this.linked.get(station)) this.present(station, now);
  }

  /** Match history changed. */
  onMatchHistory(entries: MatchHistoryEntry[]): void {
    for (const entry of entries) {
      const match = matchFromHistory(entry);
      const text = JSON.stringify({ kind: 'match', ...match });
      if (this.loggedMatches.get(match.id) === text) continue;
      this.loggedMatches.set(match.id, text);
      this.append(match.start, text);
    }
  }

  /** Presence timeouts and the open-span checkpoint. Public for tests. */
  tick(): void {
    const now = this.now();
    for (const station of StationNameList) {
      const heard = this.lastTelemetry.get(station) ?? 0;
      const robot = this.robots.get(station);
      // Seen as of now while linked; as of its last packet otherwise.
      if (this.linked.get(station) === true) this.present(station, now);
      else if (now - heard < TELEMETRY_PRESENCE_MS) this.present(station, heard);
      else if (robot && now - robot.lastSeen >= ROBOT_HOLD_MS) this.close(this.robots, robot, robot.lastSeen);

      // A DS that went silent while enabled: the enable ended when it did.
      const enable = this.enables.get(station);
      if (enable && now - heard >= TELEMETRY_PRESENCE_MS)
        this.close(this.enables, enable, Math.max(enable.start, heard));
    }
    this.checkpoint(false);
  }

  // ── queries ────────────────────────────────────────────────────────

  /** Robot and enable spans overlapping [from, to], open ones included
   *  (ending now). */
  spans(from: number, to: number): { robots: FieldActivitySpan[]; enables: FieldActivitySpan[] } {
    const robots: FieldActivitySpan[] = [];
    const enables: FieldActivitySpan[] = [];
    for (const line of this.linesIn(from, to)) {
      if (line.kind === 'match') continue;
      if (line.end < from || line.start > to) continue;
      (line.kind === 'robot' ? robots : enables).push({ ...line });
    }
    const now = this.now();
    for (const [map, out] of [
      [this.robots, robots],
      [this.enables, enables],
    ] as const) {
      for (const s of map.values()) {
        if (s.start > to || now < from) continue;
        out.push({ kind: s.kind, team: s.team, station: s.station, start: s.start, end: now, open: true });
      }
    }
    const byStart = (a: FieldActivitySpan, b: FieldActivitySpan) => a.start - b.start;
    return { robots: robots.sort(byStart), enables: enables.sort(byStart) };
  }

  /** Logged matches overlapping [from, to]; the last line for an id wins. */
  matches(from: number, to: number): FieldActivityMatch[] {
    const byId = new Map<string, FieldActivityMatch>();
    for (const line of this.linesIn(from, to)) {
      if (line.kind !== 'match' || line.end < from || line.start > to) continue;
      const { kind: _kind, ...match } = line;
      byId.set(match.id, match);
    }
    return [...byId.values()].sort((a, b) => a.start - b.start);
  }

  /** Delete day files before `beforeDay` (`YYYY-MM-DD`). */
  sweep(beforeDay: string): number {
    let removed = 0;
    for (const name of this.dayFiles()) {
      if (name.slice(0, 10) >= beforeDay) continue;
      rmSync(join(this.dir, name), { force: true });
      this.cache.delete(name);
      removed++;
    }
    return removed;
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Evidence of a robot on `station` as of `seenAt`. */
  private present(station: StationName, seenAt: number): void {
    const team = this.opts.getTeamForStation(station);
    const open = this.robots.get(station);
    if (open && open.team === team) {
      open.lastSeen = Math.max(open.lastSeen, seenAt);
      return;
    }
    if (open) this.close(this.robots, open, seenAt);
    if (team === undefined) return;
    this.robots.set(station, { kind: 'robot', team, station, start: seenAt, lastSeen: seenAt });
    this.checkpointDirty = true;
  }

  private close(map: Map<StationName, OpenSpan>, span: OpenSpan, end: number): void {
    if (map.get(span.station) === span) map.delete(span.station);
    this.checkpointDirty = true;
    this.write(span, end);
  }

  private write(span: OpenSpan, end: number): void {
    if (end < span.start) end = span.start;
    if (span.kind === 'robot' && end - span.start < MIN_ROBOT_MS) return;
    const line: Line = { kind: span.kind, team: span.team, station: span.station, start: span.start, end };
    this.append(span.start, JSON.stringify(line));
  }

  private append(at: number, text: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${localDay(at)}.jsonl`), text + '\n');
    } catch (err) {
      console.error(`Field activity log: could not write: ${(err as Error).message}`);
    }
  }

  private checkpoint(force: boolean): void {
    const now = this.now();
    // Opening or closing a span is written at the next tick; a span that is
    // only still going is refreshed every CHECKPOINT_MS.
    if (!force && !this.checkpointDirty && now - this.lastCheckpoint < CHECKPOINT_MS) return;
    this.lastCheckpoint = now;
    this.checkpointDirty = false;
    const open = [...this.robots.values(), ...this.enables.values()];
    const file = join(this.dir, OPEN_FILE);
    try {
      if (open.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      writeFileSync(`${file}.tmp`, JSON.stringify(open));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error(`Field activity log: could not checkpoint: ${(err as Error).message}`);
    }
  }

  /** Spans the previous process had open end where their evidence ended. */
  private recoverOpen(): void {
    const file = join(this.dir, OPEN_FILE);
    if (!existsSync(file)) return;
    try {
      const open = JSON.parse(readFileSync(file, 'utf8')) as OpenSpan[];
      for (const span of Array.isArray(open) ? open : []) {
        if (typeof span?.start !== 'number' || typeof span.lastSeen !== 'number') continue;
        this.write(span, span.lastSeen);
      }
      if (open.length > 0) console.log(`Field activity log: closed ${open.length} span(s) left open by the last run`);
    } catch (err) {
      console.warn(`Field activity log: could not read ${file}: ${(err as Error).message}`);
    }
    rmSync(file, { force: true });
  }

  private loadMeta(): void {
    const file = join(this.dir, META_FILE);
    try {
      if (existsSync(file)) {
        const meta = JSON.parse(readFileSync(file, 'utf8')) as { since?: unknown };
        if (typeof meta.since === 'number') this.since = meta.since;
      }
    } catch {
      // Rewritten below.
    }
    if (this.since === undefined) {
      this.since = this.now();
      try {
        writeFileSync(file, JSON.stringify({ since: this.since }));
      } catch (err) {
        console.error(`Field activity log: could not write ${file}: ${(err as Error).message}`);
      }
    }
  }

  /** Matches already on disk, so a restart does not append them all again. */
  private loadLoggedMatches(): void {
    for (const name of this.dayFiles()) {
      for (const line of this.readDay(name)) {
        if (line.kind === 'match') this.loggedMatches.set(line.id, JSON.stringify(line));
      }
    }
  }

  private dayFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort();
  }

  /** Every line in files that can hold a record overlapping [from, to]: a
   *  record is filed by its start, so the day before `from` is read too. */
  private linesIn(from: number, to: number): Line[] {
    const first = localDay(from - DAY_MS);
    const last = localDay(to);
    const out: Line[] = [];
    for (const name of this.dayFiles()) {
      const day = name.slice(0, 10);
      if (day < first || day > last) continue;
      out.push(...this.readDay(name));
    }
    return out;
  }

  private readDay(name: string): Line[] {
    const file = join(this.dir, name);
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(file);
    } catch {
      return [];
    }
    const cached = this.cache.get(name);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.lines;
    const lines: Line[] = [];
    for (const text of readFileSync(file, 'utf8').split('\n')) {
      if (!text.trim()) continue;
      try {
        const line = JSON.parse(text) as Line;
        if (typeof line.start === 'number' && typeof line.end === 'number') lines.push(line);
      } catch {
        // A torn last line from a crash mid-append; the rest of the file is fine.
      }
    }
    this.cache.set(name, { size: st.size, mtimeMs: st.mtimeMs, lines });
    return lines;
  }
}

/** A match history entry as the timeline draws it. */
export function matchFromHistory(entry: MatchHistoryEntry): FieldActivityMatch {
  return {
    id: entry.matchId ?? `t${entry.startedAt}`,
    matchNumber: entry.matchNumber,
    start: entry.startedAt,
    end: entry.endedAt,
    teams: entry.teams.map(t => ({ team: t.teamNumber, alliance: t.alliance ?? null })),
    red: entry.redScore,
    blue: entry.blueScore,
    ...(entry.challenge ? { challenge: true } : {}),
  };
}

/** Local calendar day, `YYYY-MM-DD`. */
function localDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
