/**
 * What became of each `.local` lookup the mDNS reflector saw: forwarded to a
 * robot, answered, delivered, unanswered or dropped (and why).
 *
 * Kept so the next "our app can't find our cameras" leaves evidence: the
 * reflector's counters live in memory, and a deploy wipes them (2854,
 * 2026-11-15). The log is a small JSON-lines file with one rotated copy, so it
 * survives a restart and never grows past about twice `maxBytes`. The newest
 * events are also kept in memory for the Network page.
 *
 * Lookups repeat (a laptop re-asks every second, and the site router's mDNS
 * proxy asks for everything), so an event that repeats within `repeatWindowMs`
 * is counted instead of written, and the next one written carries the count.
 *
 * Nothing here may throw into the reflector: a file that can't be written is
 * logged once and the in-memory copy carries on.
 */
import { appendFile, readFileSync, renameSync, statSync } from 'node:fs';
import type { MdnsLookupEvent } from './types.js';

export interface MdnsLookupLogOptions {
  /** The log file; its rotated copy is `<file>.1`. Null keeps memory only. */
  file: string | null;
  /** Rotate once the file passes this size. */
  maxBytes?: number;
  /** How many events the Network page can see. */
  keepInMemory?: number;
  /** A repeat of the same event inside this window is counted, not written. */
  repeatWindowMs?: number;
  /** How often buffered lines are written. */
  flushMs?: number;
}

const DEFAULTS = {
  maxBytes: 2 * 1024 * 1024,
  keepInMemory: 500,
  repeatWindowMs: 30_000,
  flushMs: 2_000,
};

/** Events that are "the same" for the repeat count: same kind, same parties, same names. */
export function repeatKey(event: MdnsLookupEvent): string {
  switch (event.kind) {
    case 'forwarded':
      return `f|${event.requester}|${event.station}|${event.questions.map(q => `${q.name}/${q.type}`).join(',')}`;
    case 'dropped':
      return `d|${event.requester}|${event.reason}|${event.questions.map(q => `${q.name}/${q.type}`).join(',')}`;
    case 'answered':
      return `a|${event.station}|${event.from}|${event.to.join(',')}|${event.records.map(r => r.name).join(',')}`;
    case 'unanswered':
      return `u|${event.requester}|${event.station}|${event.name}`;
    case 'send failed':
      return `s|${event.to}|${event.error}`;
  }
}

export class MdnsLookupLog {
  private readonly opts: Required<Omit<MdnsLookupLogOptions, 'file'>> & { file: string | null };
  private recent: MdnsLookupEvent[] = [];
  private buffer: string[] = [];
  /** Per repeat key: when it was last written, and repeats since. */
  private lastWritten = new Map<string, { at: number; repeats: number }>();
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  private writeErrorLogged = false;

  constructor(options: MdnsLookupLogOptions) {
    this.opts = { ...DEFAULTS, ...options };
    this.recent = this.readTail();
  }

  start(): void {
    if (this.timer || !this.opts.file) return;
    this.timer = setInterval(() => this.flush(), this.opts.flushMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  record(event: MdnsLookupEvent): void {
    const key = repeatKey(event);
    const last = this.lastWritten.get(key);
    if (last && event.t - last.at < this.opts.repeatWindowMs) {
      last.repeats++;
      return;
    }
    const written: MdnsLookupEvent = last?.repeats ? { ...event, repeatsBefore: last.repeats } : event;
    this.lastWritten.set(key, { at: event.t, repeats: 0 });
    this.recent.push(written);
    if (this.recent.length > this.opts.keepInMemory) this.recent.splice(0, this.recent.length - this.opts.keepInMemory);
    if (this.opts.file) this.buffer.push(JSON.stringify(written) + '\n');
    if (this.lastWritten.size > 5_000) this.forgetOldKeys(event.t);
  }

  /** Newest last, at most `limit`. */
  getRecent(limit = this.opts.keepInMemory): MdnsLookupEvent[] {
    return this.recent.slice(-limit);
  }

  private forgetOldKeys(now: number): void {
    for (const [key, entry] of this.lastWritten) {
      if (now - entry.at >= this.opts.repeatWindowMs) this.lastWritten.delete(key);
    }
  }

  /** Writes what's buffered; rotates first when the file is full. */
  flush(): void {
    const file = this.opts.file;
    if (!file || this.writing || this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    try {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > this.opts.maxBytes) renameSync(file, `${file}.1`);
    } catch (err) {
      this.writeFailed(err);
    }
    this.writing = true;
    appendFile(file, chunk, err => {
      this.writing = false;
      if (err) this.writeFailed(err);
    });
  }

  private writeFailed(err: unknown): void {
    if (this.writeErrorLogged) return;
    this.writeErrorLogged = true;
    console.error(`mDNS lookup log: can't write ${this.opts.file}, keeping lookups in memory only:`, err);
  }

  /** The newest events from the file and its rotated copy, so a restart keeps them. */
  private readTail(): MdnsLookupEvent[] {
    const file = this.opts.file;
    if (!file) return [];
    const events: MdnsLookupEvent[] = [];
    for (const path of [`${file}.1`, file]) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as MdnsLookupEvent);
        } catch {
          // a line cut short by a crash
        }
      }
    }
    return events.slice(-this.opts.keepInMemory);
  }
}
