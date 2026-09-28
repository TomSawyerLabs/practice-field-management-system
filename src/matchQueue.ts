import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Alliance, LineEntry, MatchState, QueueEntry, QueueSettings, QueueShape, QueueState } from './types.js';
import { isQueueShape } from './types.js';

/**
 * The match queue: one ordered list of upcoming matches, fed by a pre-made
 * schedule and by the fill line teams join from their own page. The head of
 * the list is "next match". The match manager forms matches from the line
 * with whatever shape suits the moment (1v1 for demos, 2v2 early, 3v3 when
 * everything works), reorders, skips, and swaps no-shows for the next team
 * in line. Nothing here touches the radio or the engine directly; see
 * matchSetup.ts for "Set up next match".
 */

// The line starts closed: a team page only shows "Play next" once whoever
// runs /queue opens it, so a day with no queue manager gathers no line.
const DEFAULT_SETTINGS: QueueSettings = {
  lineOpen: false,
  shape: { red: 3, blue: 3 },
  noShowMinutes: null,
  allowShort: true,
};

type MatchEngineLike = {
  addStateListener(fn: (state: MatchState) => void): () => void;
  getState(): MatchState;
};

export type AddEntryInput = {
  red: number[];
  blue: number[];
  source?: QueueEntry['source'];
  scheduledAt?: number;
  notes?: string;
  /** Put it right after whatever is on deck / playing, ahead of the rest. */
  atFront?: boolean;
};

export class MatchQueue {
  private entries: QueueEntry[] = [];
  private line: LineEntry[] = [];
  private settings: QueueSettings = { ...DEFAULT_SETTINGS, shape: { ...DEFAULT_SETTINGS.shape } };
  private listeners: ((state: QueueState) => void)[] = [];
  private noShowTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  /** Is this team's robot on the field (or on its way), or joined? Injected. */
  private present: (team: number) => boolean = () => false;

  constructor(
    private readonly filePath = process.env.MATCH_QUEUE_FILE ?? 'match-queue.json',
    deps: { now?: () => number } = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.load();
  }

  /** Tell the queue how to know a team has shown up (robot on the field or
   *  joined the match), for the no-show clock. */
  setPresenceResolver(fn: (team: number) => boolean) {
    this.present = fn;
  }

  // ── State ────────────────────────────────────────────────────────

  getState(): QueueState {
    const noShows = this.noShows();
    return {
      type: 'queueState',
      entries: this.entries.map(e => ({ ...e, red: [...e.red], blue: [...e.blue] })),
      line: this.line.map(l => ({ ...l })),
      settings: { ...this.settings, shape: { ...this.settings.shape } },
      noShows: noShows.length ? noShows : undefined,
    };
  }

  getSettings(): QueueSettings {
    return { ...this.settings, shape: { ...this.settings.shape } };
  }

  addListener(fn: (state: QueueState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private changed(): void {
    this.persist();
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in match queue listener:', err);
      }
    }
  }

  // ── Entries ──────────────────────────────────────────────────────

  /** The match to set up next: on deck if one is, else the first queued. */
  next(): QueueEntry | undefined {
    return this.entries.find(e => e.status === 'onDeck') ?? this.entries.find(e => e.status === 'queued');
  }

  get(id: string): QueueEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  /** Where the fill line's next match goes: right after anything on deck,
   *  playing, or already played. */
  private frontIndex(): number {
    let i = 0;
    while (i < this.entries.length && this.entries[i].status !== 'queued') i++;
    return i;
  }

  add(input: AddEntryInput): QueueEntry {
    const entry: QueueEntry = {
      id: randomUUID().slice(0, 8),
      number: this.entries.reduce((max, e) => Math.max(max, e.number), 0) + 1,
      source: input.source ?? 'manual',
      scheduledAt: input.scheduledAt,
      red: [...input.red],
      blue: [...input.blue],
      status: 'queued',
      notes: input.notes,
    };
    // A team can't be in two upcoming matches' worth of line at once: joining
    // a match takes it out of the line.
    this.line = this.line.filter(l => !entry.red.includes(l.team) && !entry.blue.includes(l.team));
    if (input.atFront) this.entries.splice(this.frontIndex(), 0, entry);
    else this.entries.push(entry);
    this.changed();
    return entry;
  }

  update(id: string, patch: { red?: number[]; blue?: number[]; scheduledAt?: number | null; notes?: string }): boolean {
    const entry = this.get(id);
    if (!entry || entry.status === 'played') return false;
    if (patch.red) entry.red = [...patch.red].slice(0, 3);
    if (patch.blue) entry.blue = [...patch.blue].slice(0, 3);
    if (patch.scheduledAt === null) delete entry.scheduledAt;
    else if (patch.scheduledAt !== undefined) entry.scheduledAt = patch.scheduledAt;
    if (patch.notes !== undefined) entry.notes = patch.notes || undefined;
    this.changed();
    return true;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id || e.status === 'playing');
    if (this.entries.length === before) return false;
    this.changed();
    return true;
  }

  /** New order for the not-yet-played entries. Ids not listed keep their
   *  relative order after the listed ones; played entries stay where they
   *  are, at the top. */
  reorder(ids: string[]): void {
    const fixed = this.entries.filter(e => e.status === 'played' || e.status === 'playing');
    const movable = this.entries.filter(e => e.status !== 'played' && e.status !== 'playing');
    const byId = new Map(movable.map(e => [e.id, e]));
    const ordered: QueueEntry[] = [];
    for (const id of ids) {
      const e = byId.get(id);
      if (e) {
        ordered.push(e);
        byId.delete(id);
      }
    }
    this.entries = [...fixed, ...ordered, ...byId.values()];
    this.changed();
  }

  skip(id: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.status === 'playing' || entry.status === 'played') return false;
    entry.status = 'skipped';
    delete entry.onDeckAt;
    this.armNoShowClock();
    this.changed();
    return true;
  }

  /** Put a skipped (or on-deck) entry back in the queue. */
  requeue(id: string): boolean {
    const entry = this.get(id);
    if (!entry || (entry.status !== 'skipped' && entry.status !== 'onDeck')) return false;
    entry.status = 'queued';
    delete entry.onDeckAt;
    this.armNoShowClock();
    this.changed();
    return true;
  }

  markOnDeck(id: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.status === 'playing' || entry.status === 'played') return false;
    // Only one match is on deck at a time.
    for (const e of this.entries) {
      if (e.status === 'onDeck' && e.id !== id) {
        e.status = 'queued';
        delete e.onDeckAt;
      }
    }
    if (entry.status !== 'onDeck') {
      entry.status = 'onDeck';
      entry.onDeckAt = this.now();
    }
    this.armNoShowClock();
    this.changed();
    return true;
  }

  private markPlaying(matchId: string | undefined): void {
    const entry = this.entries.find(e => e.status === 'onDeck');
    if (!entry) return;
    entry.status = 'playing';
    entry.matchId = matchId;
    delete entry.onDeckAt;
    this.armNoShowClock();
    this.changed();
  }

  private markPlayed(): void {
    const entry = this.entries.find(e => e.status === 'playing');
    if (!entry) return;
    entry.status = 'played';
    this.changed();
  }

  /** Drop played (and skipped) entries; with `played` false, drop everything
   *  that is not playing. Settings and the line stay. */
  clear(playedOnly = false): void {
    this.entries = this.entries.filter(e =>
      playedOnly ? e.status !== 'played' && e.status !== 'skipped' : e.status === 'playing',
    );
    this.changed();
  }

  // ── The line ─────────────────────────────────────────────────────

  joinLine(team: number, alliance?: Alliance): 'joined' | 'already' | 'closed' | 'queued' {
    if (!this.settings.lineOpen) return 'closed';
    if (
      this.entries.some(e => (e.status === 'queued' || e.status === 'onDeck') && e.red.concat(e.blue).includes(team))
    ) {
      return 'queued'; // already in an upcoming match
    }
    const existing = this.line.find(l => l.team === team);
    if (existing) {
      if (existing.alliance !== alliance) {
        existing.alliance = alliance;
        this.changed();
      }
      return 'already';
    }
    this.line.push({ team, joinedAt: this.now(), alliance });
    this.changed();
    return 'joined';
  }

  leaveLine(team: number): boolean {
    const before = this.line.length;
    this.line = this.line.filter(l => l.team !== team);
    if (this.line.length === before) return false;
    this.changed();
    return true;
  }

  moveInLine(team: number, index: number): boolean {
    const from = this.line.findIndex(l => l.team === team);
    if (from < 0) return false;
    const [entry] = this.line.splice(from, 1);
    this.line.splice(Math.min(index, this.line.length), 0, entry);
    this.changed();
    return true;
  }

  /** Team's position in the line, 1-based, or null. */
  linePosition(team: number): number | null {
    const i = this.line.findIndex(l => l.team === team);
    return i < 0 ? null : i + 1;
  }

  /**
   * Form the next match from the front of the line. Teams with an alliance
   * preference get it while there is room; the rest fill whichever side has
   * more room (red first when equal). With fewer teams than the shape asks
   * for, the match is formed short if allowed, else nothing happens.
   */
  formFromLine(shape: QueueShape = this.settings.shape, allowShort = this.settings.allowShort): QueueEntry | null {
    if (!isQueueShape(shape)) return null;
    const wanted = shape.red + shape.blue;
    const red: number[] = [];
    const blue: number[] = [];
    const taken: number[] = [];
    const room = (a: Alliance) => (a === 'red' ? shape.red - red.length : shape.blue - blue.length);
    const place = (l: LineEntry, a: Alliance) => {
      (a === 'red' ? red : blue).push(l.team);
      taken.push(l.team);
    };
    // First pass: preferences.
    for (const l of this.line) {
      if (taken.length >= wanted) break;
      if (l.alliance && room(l.alliance) > 0) place(l, l.alliance);
    }
    // Second pass: everyone else, in line order, into the side with more room.
    for (const l of this.line) {
      if (taken.length >= wanted) break;
      if (taken.includes(l.team)) continue;
      const side: Alliance = room('red') >= room('blue') ? 'red' : 'blue';
      if (room(side) > 0) place(l, side);
    }
    if (taken.length === 0) return null;
    if (taken.length < wanted && !allowShort) return null;
    return this.add({ red, blue, source: 'line', atFront: true });
  }

  /**
   * A team in an upcoming match is not coming (or not yet): swap in the next
   * team from the line. The replaced team goes to the back of the line if it
   * came from the line, otherwise it is just dropped from the match.
   */
  replaceTeam(id: string, team: number): { replaced: boolean; withTeam?: number } {
    const entry = this.get(id);
    if (!entry || entry.status === 'playing' || entry.status === 'played') return { replaced: false };
    const side: Alliance | null = entry.red.includes(team) ? 'red' : entry.blue.includes(team) ? 'blue' : null;
    if (!side) return { replaced: false };
    const list = side === 'red' ? entry.red : entry.blue;
    const next = this.line.find(l => !entry.red.includes(l.team) && !entry.blue.includes(l.team));
    if (next) {
      list[list.indexOf(team)] = next.team;
      this.line = this.line.filter(l => l.team !== next.team);
    } else {
      list.splice(list.indexOf(team), 1);
    }
    if (entry.source === 'line') this.line.push({ team, joinedAt: this.now() });
    this.changed();
    return { replaced: true, withTeam: next?.team };
  }

  // ── Settings ─────────────────────────────────────────────────────

  updateSettings(patch: Partial<QueueSettings>): void {
    if (patch.lineOpen !== undefined) this.settings.lineOpen = patch.lineOpen;
    if (patch.shape && isQueueShape(patch.shape)) this.settings.shape = { ...patch.shape };
    if (patch.noShowMinutes !== undefined) this.settings.noShowMinutes = patch.noShowMinutes;
    if (patch.allowShort !== undefined) this.settings.allowShort = patch.allowShort;
    this.armNoShowClock();
    this.changed();
  }

  // ── No-shows ─────────────────────────────────────────────────────

  /** Teams of the on-deck match that have not shown once its clock ran out. */
  noShows(): number[] {
    const minutes = this.settings.noShowMinutes;
    const entry = this.entries.find(e => e.status === 'onDeck');
    if (!minutes || !entry?.onDeckAt) return [];
    if (this.now() - entry.onDeckAt < minutes * 60_000) return [];
    return entry.red.concat(entry.blue).filter(team => !this.present(team));
  }

  /** Broadcast once when the on-deck clock runs out, so pages don't poll. */
  private armNoShowClock(): void {
    if (this.noShowTimer) {
      clearTimeout(this.noShowTimer);
      this.noShowTimer = null;
    }
    const minutes = this.settings.noShowMinutes;
    const entry = this.entries.find(e => e.status === 'onDeck');
    if (!minutes || !entry?.onDeckAt) return;
    const due = entry.onDeckAt + minutes * 60_000 - this.now();
    if (due <= 0) return;
    this.noShowTimer = setTimeout(() => {
      this.noShowTimer = null;
      this.changed();
    }, due);
    this.noShowTimer.unref?.();
  }

  // ── Following the match ──────────────────────────────────────────

  /** Follow the engine: the on-deck match becomes "playing" when it starts
   *  and "played" when it ends. */
  attach(engine: MatchEngineLike): () => void {
    let lastPhase = engine.getState().phase;
    const active = (p: MatchState['phase']) => p !== 'idle' && p !== 'created' && p !== 'postMatch';
    return engine.addStateListener(state => {
      const phase = state.phase;
      if (phase === lastPhase) return;
      const was = lastPhase;
      lastPhase = phase;
      if (was === 'created' && active(phase)) this.markPlaying(state.matchId);
      else if (phase === 'postMatch' && active(was)) this.markPlayed();
    });
  }

  // ── Persistence ──────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(raw.entries)) this.entries = raw.entries.filter(isEntry);
      if (Array.isArray(raw.line)) this.line = raw.line.filter(isLineEntry);
      if (raw.settings && typeof raw.settings === 'object') this.updateSettingsQuietly(raw.settings);
      // A match that was playing when we went down has either ended or been
      // abandoned; either way it is not coming back as "playing".
      for (const e of this.entries) if (e.status === 'playing') e.status = 'played';
      this.armNoShowClock();
    } catch (err) {
      console.error('Failed to load the match queue:', err);
    }
  }

  private updateSettingsQuietly(s: Partial<QueueSettings>): void {
    if (typeof s.lineOpen === 'boolean') this.settings.lineOpen = s.lineOpen;
    if (isQueueShape(s.shape)) this.settings.shape = { ...s.shape };
    if (s.noShowMinutes === null || (typeof s.noShowMinutes === 'number' && s.noShowMinutes > 0)) {
      this.settings.noShowMinutes = s.noShowMinutes;
    }
    if (typeof s.allowShort === 'boolean') this.settings.allowShort = s.allowShort;
  }

  private persist(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify({ entries: this.entries, line: this.line, settings: this.settings }, null, 2),
      );
    } catch (err) {
      console.error('Failed to save the match queue:', err);
    }
  }
}

const STATUSES: QueueEntry['status'][] = ['queued', 'onDeck', 'playing', 'played', 'skipped'];

function isEntry(v: unknown): v is QueueEntry {
  if (typeof v !== 'object' || !v) return false;
  const e = v as QueueEntry;
  const teams = (t: unknown) => Array.isArray(t) && t.every(n => typeof n === 'number');
  return (
    typeof e.id === 'string' &&
    typeof e.number === 'number' &&
    (e.source === 'schedule' || e.source === 'line' || e.source === 'manual') &&
    teams(e.red) &&
    teams(e.blue) &&
    STATUSES.includes(e.status)
  );
}

function isLineEntry(v: unknown): v is LineEntry {
  if (typeof v !== 'object' || !v) return false;
  const l = v as LineEntry;
  return typeof l.team === 'number' && typeof l.joinedAt === 'number';
}
