/**
 * Persistent state for practice recording ("record while enabled"):
 * which teams turned it off, the runs that were recorded, and the per-team
 * per-day capability tokens behind `/practice/<token>`.
 *
 * Every team records by default; a team that unticks the box on its station
 * page is remembered here. Version 1 of the file kept the opposite list
 * (teams that had ticked it) — everyone is in now, so that list is ignored.
 *
 * Kept apart from match history: matches are a field-wide event log, while
 * practice runs are filed per team and referenced by day links.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mintShareToken } from './matchEngine.js';
import type { PracticeDayToken, PracticeRunEntry } from './types.js';

const DEFAULT_FILE = 'practice-recordings.json';
const MAX_RUNS = 500;
/** Days start at 04:00 local, so a session that runs past midnight stays together. */
const DAY_ROLLOVER_HOUR = 4;

interface Persisted {
  version: 2;
  /** Teams that turned recording off. */
  optOut: number[];
  runs: PracticeRunEntry[];
  days: PracticeDayToken[];
}

/** Local practice day (`YYYY-MM-DD`) a timestamp belongs to. */
export function practiceDayOf(ts: number): string {
  const d = new Date(ts - DAY_ROLLOVER_HOUR * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** When a practice day ends (the next 04:00 local), epoch ms. */
export function practiceDayEnd(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + 1, DAY_ROLLOVER_HOUR, 0, 0, 0).getTime();
}

/** "Fri, Sep 18" for a practice day. */
export function practiceDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export class PracticeStore {
  private optOut = new Set<number>();
  private runs: PracticeRunEntry[] = [];
  private days: PracticeDayToken[] = [];
  private readonly filePath: string;
  private listeners: (() => void)[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.PRACTICE_RECORDINGS_FILE ?? DEFAULT_FILE;
    this.load();
  }

  // ── opt-out ────────────────────────────────────────────────────────

  /** Every team records unless it turned recording off. */
  isOptedIn(teamNumber: number): boolean {
    return !this.optOut.has(teamNumber);
  }

  getOptOut(): number[] {
    return [...this.optOut].sort((a, b) => a - b);
  }

  setOptIn(teamNumber: number, enabled: boolean): void {
    if (enabled !== this.optOut.has(teamNumber)) return;
    if (enabled) this.optOut.delete(teamNumber);
    else this.optOut.add(teamNumber);
    this.persist();
    this.notify();
  }

  // ── runs ───────────────────────────────────────────────────────────

  addRun(run: PracticeRunEntry): void {
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
    // A day link exists from the first recording on, so the station page
    // can show it right away and the notifier knows there is something to send.
    this.getOrCreateDayToken(run.teamNumber, practiceDayOf(run.startedAt));
    this.persist();
    this.notify();
  }

  getRuns(): PracticeRunEntry[] {
    return this.runs;
  }

  /** Runs a team took part in on a practice day, oldest first. */
  runsFor(teamNumber: number, day: string): PracticeRunEntry[] {
    return this.runs.filter(r => practiceDayOf(r.startedAt) === day && r.teamNumber === teamNumber);
  }

  /** Drop runs whose directory the retention sweep has deleted. */
  pruneMissing(exists: (id: string) => boolean): void {
    const before = this.runs.length;
    this.runs = this.runs.filter(r => exists(r.id));
    if (this.runs.length !== before) {
      this.persist();
      this.notify();
    }
  }

  // ── day tokens ─────────────────────────────────────────────────────

  findDay(teamNumber: number, day: string): PracticeDayToken | undefined {
    return this.days.find(d => d.teamNumber === teamNumber && d.day === day);
  }

  findByToken(token: string): PracticeDayToken | undefined {
    return this.days.find(d => d.token === token);
  }

  getOrCreateDayToken(teamNumber: number, day: string): PracticeDayToken {
    let entry = this.findDay(teamNumber, day);
    if (!entry) {
      entry = { token: mintShareToken(), teamNumber, day, createdAt: Date.now() };
      this.days.push(entry);
      this.persist();
    }
    return entry;
  }

  getDays(): PracticeDayToken[] {
    return this.days;
  }

  markSlackPosted(token: string, at = Date.now()): void {
    const entry = this.findByToken(token);
    if (!entry) return;
    entry.slackPostedAt = at;
    this.persist();
  }

  // ── listeners / persistence ────────────────────────────────────────

  addListener(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('Error in PracticeStore listener:', err);
      }
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<Persisted>;
      this.optOut = new Set((parsed.optOut ?? []).filter(n => Number.isInteger(n) && n > 0));
      this.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
      this.days = Array.isArray(parsed.days) ? parsed.days : [];
      console.log(
        `Loaded practice recording state from ${this.filePath}: ${this.optOut.size} team(s) opted out, ${this.runs.length} run(s)`,
      );
    } catch (err) {
      console.warn(`Failed to load practice recording state from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    const data: Persisted = { version: 2, optOut: this.getOptOut(), runs: this.runs, days: this.days };
    try {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save practice recording state to ${this.filePath}:`, (err as Error).message);
    }
  }
}
