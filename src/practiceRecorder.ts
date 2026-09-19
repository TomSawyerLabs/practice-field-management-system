/**
 * PracticeRecorder — "record while enabled".
 *
 * A team that ticks the box on its station page gets a clip of every time
 * its robot is enabled outside a match, from PRACTICE_PAD_SECONDS before the
 * enable to the same after the disable. The pre-roll is the reason this is
 * not a copy of MatchRecorder: footage from before the trigger only exists if
 * it was already being captured. So while any opted-in team is on the field
 * (its DS or robot is sending telemetry) one ffmpeg per stream pulls the
 * source continuously into 1 s MPEG-TS segments in a ring buffer
 * (`<recordings>/.practice-buffer/<stream>/seg-NNNNNN.ts`), and segments older
 * than ~15 s are thrown away. When a robot is enabled the segments stop being
 * thrown away; when the last one is disabled the segments spanning the window
 * are joined (`-c copy`) into `<recordings>/practice-<stamp>/<stream>.mp4`.
 *
 * Timing uses segment mtimes: a segment's mtime is when ffmpeg closed it, i.e.
 * the wall-clock end of its footage (minus the source's own latency, which
 * shifts everything equally). Segments split on keyframes, so the padding is
 * "at least 3 s", up to 3 s + one GOP.
 *
 * Runs are field-wide: overlapping enables of several opted-in robots make
 * one clip, filed under every team that was enabled during it. Matches are
 * the MatchRecorder's job — the buffer stops as soon as a match leaves the
 * idle/created phases and a run in progress is closed at that moment.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { inputArgs, probeDuration, runCommand, slugify, type RecordingManifest } from './matchRecorder.js';
import type { PracticeStore } from './practiceStore.js';
import type { SessionMetadataCollector } from './sessionMetadata.js';
import {
  PRACTICE_PAD_SECONDS,
  type MatchRecording,
  type MatchState,
  type PracticeRecordingState,
  type PracticeRunEntry,
  type RecordingStreamConfig,
  type StationName,
  type TelemetryUpdate,
} from './types.js';

const PAD_MS = PRACTICE_PAD_SECONDS * 1000;
const SEGMENT_SECONDS = 1;
/** Segments older than this are deleted while no run is being captured. */
const BUFFER_KEEP_MS = 15_000;
/** A disable followed by a re-enable within this window stays one clip. */
const MERGE_GRACE_MS = 2000;
/** Telemetry silence after which a station is treated as gone (and disabled). */
const PRESENCE_TIMEOUT_MS = 15_000;
/** Longest single clip; a robot enabled longer than this gets a second clip. */
const MAX_RUN_MS = 20 * 60 * 1000;
/** How long to wait for the segment covering the end of a run to be closed. */
const SEGMENT_SETTLE_MS = 4000;
const TICK_MS = 1000;
const RESPAWN_DELAY_MS = 1000;
const RESPAWN_BACKOFF_MS = 10_000;
const STOP_GRACE_MS = 5000;
const STDERR_KEEP_LINES = 8;
const BUFFER_DIRNAME = '.practice-buffer';
const RUNS_IN_STATE = 50;

export interface PracticeRecorderOptions {
  /** Recordings root, shared with the match recorder. */
  directory: string;
  ffmpegPath: string;
  ffprobePath: string;
  getStreams: () => RecordingStreamConfig[];
  store: PracticeStore;
  metadata: SessionMetadataCollector;
  getTeamForStation: (station: StationName) => number | undefined;
  /** ffmpeg works on this host (the match recorder checked at startup). */
  isAvailable: () => boolean;
  /** Input options placed before `-i` (tests use `-re -stream_loop -1` on a file). */
  inputPrefixArgs?: string[];
  now?: () => number;
}

interface BufferJob {
  config: RecordingStreamConfig;
  slug: string;
  dir: string;
  proc: ChildProcess | null;
  nextSegment: number;
  respawnTimer?: NodeJS.Timeout;
  failures: number;
  error?: string;
  stderr: string[];
}

interface Run {
  /** Window start: first enable minus the pad. */
  startedAt: number;
  /** Opted-in stations enabled at some point during the run → team. */
  participants: Map<StationName, number>;
  /** When the last enabled participant disabled; undefined while any is enabled. */
  lastDisableAt?: number;
  /** Set once the run is closed and waiting to be finalized. */
  endedAt?: number;
}

interface Segment {
  file: string;
  /** Wall-clock end of the footage (close time). */
  end: number;
  /** Wall-clock start: the previous segment's end (estimated for the first). */
  start: number;
}

/** Phases in which robots are under their own Driver Station's control. */
export function isPracticePhase(phase: MatchState['phase']): boolean {
  return phase === 'idle' || phase === 'created';
}

export class PracticeRecorder {
  private readonly opts: PracticeRecorderOptions;
  private readonly bufferRoot: string;
  private readonly now: () => number;
  private jobs: BufferJob[] | null = null;
  private run: Run | null = null;
  /** Runs closed and being finalized: their segments must survive pruning. */
  private finalizing = new Set<Run>();
  private stationSeen = new Map<StationName, number>();
  private stationEnabled = new Map<StationName, boolean>();
  private matchPhase: MatchState['phase'] = 'idle';
  private tickTimer: NodeJS.Timeout | null = null;
  private listeners: ((state: PracticeRecordingState) => void)[] = [];
  private stopping = false;

  constructor(opts: PracticeRecorderOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.bufferRoot = join(opts.directory, BUFFER_DIRNAME);
  }

  start(): void {
    // Whatever a previous process left in the buffer is stale.
    rmSync(this.bufferRoot, { recursive: true, force: true });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.opts.store.addListener(() => this.emit());
    console.log(`Practice recorder ready: ${this.opts.store.getOptIn().length} team(s) opted in`);
  }

  /** Stop the buffer and drop any run in progress (shutdown/tests). */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.run = null;
    await this.stopBuffer();
    try {
      rmSync(this.bufferRoot, { recursive: true, force: true });
    } catch {
      // Windows can still hold a just-closed segment open for a moment; the
      // next start() clears the directory anyway.
    }
  }

  addListener(fn: (state: PracticeRecordingState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  getState(): PracticeRecordingState {
    const runs = this.opts.store.getRuns();
    return {
      type: 'practiceRecordingState',
      optIn: this.opts.store.getOptIn(),
      buffering: this.jobs !== null,
      activeRun: this.run
        ? { startedAt: this.run.startedAt, teams: [...new Set(this.run.participants.values())] }
        : undefined,
      unavailableReason: this.unavailableReason(),
      runs: runs.slice(-RUNS_IN_STATE),
    };
  }

  /** A team's opt-in changed: an untick while its robot is enabled ends its
   *  part in the run; a tick while it is on the field starts buffering. */
  onOptInChanged(): void {
    this.tick();
  }

  /** Last telemetry from any station configured for this team (0 = never). */
  lastSeenForTeam(teamNumber: number): number {
    let last = 0;
    for (const [station, seen] of this.stationSeen) {
      if (this.opts.getTeamForStation(station) === teamNumber) last = Math.max(last, seen);
    }
    return last;
  }

  // ── inputs ─────────────────────────────────────────────────────────

  onTelemetry(update: TelemetryUpdate): void {
    const now = this.now();
    this.stationSeen.set(update.station, now);
    if (!update.dsStatus) return;
    const enabled = update.dsStatus.enabled;
    if (this.stationEnabled.get(update.station) === enabled) return;
    this.stationEnabled.set(update.station, enabled);
    if (enabled) this.handleEnable(update.station, now);
    else this.handleDisable(update.station, now);
  }

  onMatchState(state: MatchState): void {
    const was = this.matchPhase;
    this.matchPhase = state.phase;
    if (isPracticePhase(was) && !isPracticePhase(state.phase)) {
      // The match recorder takes over from here.
      if (this.run && this.run.endedAt === undefined) this.closeRun(this.run, this.now(), 'match starting');
      this.tick();
    }
  }

  // ── run lifecycle ──────────────────────────────────────────────────

  private handleEnable(station: StationName, now: number): void {
    const team = this.opts.getTeamForStation(station);
    if (team === undefined || !this.opts.store.isOptedIn(team)) return;
    if (!isPracticePhase(this.matchPhase)) return;
    if (!this.jobs) {
      // The robot was enabled before the buffer had a chance to start (first
      // telemetry and the enable arrived together). Start now; the pre-roll
      // will be whatever ffmpeg has caught by the time the run is cut.
      this.startBuffer();
      if (!this.jobs) return;
    }
    let run = this.run;
    if (run && run.endedAt !== undefined) run = null; // closed, being finalized
    if (!run) {
      run = { startedAt: now - PAD_MS, participants: new Map() };
      this.run = run;
      console.log(`Practice recording started: ${station} (team ${team}) enabled`);
    } else if (run.lastDisableAt !== undefined) {
      console.log(`Practice recording continues: ${station} (team ${team}) re-enabled`);
    }
    run.participants.set(station, team);
    run.lastDisableAt = undefined;
    this.emit();
  }

  private handleDisable(station: StationName, now: number): void {
    const run = this.run;
    if (!run || run.endedAt !== undefined || !run.participants.has(station)) return;
    const anyEnabled = [...run.participants.keys()].some(s => this.stationEnabled.get(s));
    if (!anyEnabled && run.lastDisableAt === undefined) run.lastDisableAt = now;
  }

  private closeRun(run: Run, endedAt: number, why: string): void {
    run.endedAt = endedAt;
    this.finalizing.add(run);
    if (this.run === run) this.run = null;
    console.log(
      `Practice recording closing (${why}): ${Math.round((endedAt - run.startedAt) / 1000)}s, teams ${[...new Set(run.participants.values())].join(', ')}`,
    );
    this.emit();
    // The segment holding the last padded second closes ~1 s after it; give
    // it a little more than that, plus time for late score reports.
    setTimeout(
      () => {
        void this.finalize(run).catch(err => {
          console.error('Practice recording finalize failed:', err);
          this.finalizing.delete(run);
        });
      },
      Math.max(0, endedAt - this.now()) + SEGMENT_SETTLE_MS,
    );
  }

  private tick(): void {
    if (this.stopping) return;
    const now = this.now();

    // A station that stopped talking is treated as disabled.
    for (const [station, enabled] of this.stationEnabled) {
      const seen = this.stationSeen.get(station) ?? 0;
      if (enabled && now - seen > PRESENCE_TIMEOUT_MS) {
        this.stationEnabled.set(station, false);
        this.handleDisable(station, seen);
      }
    }

    const run = this.run;
    if (run && run.endedAt === undefined) {
      // A participant whose team unticked the box no longer holds the run open.
      for (const [station, team] of run.participants) {
        if (!this.opts.store.isOptedIn(team) && this.stationEnabled.get(station)) {
          run.participants.delete(station);
        }
      }
      const anyEnabled = [...run.participants.keys()].some(s => this.stationEnabled.get(s));
      if (!anyEnabled && run.lastDisableAt === undefined) run.lastDisableAt = now;
      if (run.participants.size === 0) {
        this.run = null;
      } else if (run.lastDisableAt !== undefined && now >= run.lastDisableAt + PAD_MS + MERGE_GRACE_MS) {
        this.closeRun(run, run.lastDisableAt + PAD_MS, 'robot disabled');
      } else if (now - run.startedAt >= MAX_RUN_MS) {
        // Split a marathon enable so the clip stays manageable; the next
        // clip starts right where this one ends.
        const participants = new Map([...run.participants].filter(([s]) => this.stationEnabled.get(s)));
        this.closeRun(run, now, 'maximum clip length');
        if (participants.size > 0) this.run = { startedAt: now, participants };
      }
    }

    const shouldBuffer =
      this.unavailableReason() === undefined &&
      isPracticePhase(this.matchPhase) &&
      (this.run !== null || this.presentOptedInStations(now).length > 0);
    if (shouldBuffer && !this.jobs) this.startBuffer();
    else if (!shouldBuffer && this.jobs && this.run === null) void this.stopBuffer();

    this.pruneBuffer(now);
  }

  private presentOptedInStations(now: number): StationName[] {
    const out: StationName[] = [];
    for (const [station, seen] of this.stationSeen) {
      if (now - seen > PRESENCE_TIMEOUT_MS) continue;
      const team = this.opts.getTeamForStation(station);
      if (team !== undefined && this.opts.store.isOptedIn(team)) out.push(station);
    }
    return out;
  }

  private unavailableReason(): string | undefined {
    if (!this.opts.isAvailable()) return 'ffmpeg is not available on this host';
    if (this.opts.getStreams().filter(s => s.enabled).length === 0) return 'no recording streams are enabled';
    return undefined;
  }

  // ── ring buffer ────────────────────────────────────────────────────

  private startBuffer(): void {
    if (this.jobs) return;
    const streams = this.opts.getStreams().filter(s => s.enabled);
    if (streams.length === 0 || !this.opts.isAvailable()) return;
    const jobs: BufferJob[] = [];
    const seen = new Map<string, number>();
    for (const config of streams) {
      let slug = slugify(config.name);
      const n = (seen.get(slug) ?? 0) + 1;
      seen.set(slug, n);
      if (n > 1) slug = `${slug}-${n}`;
      const dir = join(this.bufferRoot, slug);
      rmSync(dir, { recursive: true, force: true });
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error(`Practice recorder: cannot create ${dir}: ${(err as Error).message}`);
        return;
      }
      jobs.push({ config, slug, dir, proc: null, nextSegment: 0, failures: 0, stderr: [] });
    }
    this.jobs = jobs;
    console.log(`Practice buffer started → ${jobs.map(j => j.config.name).join(', ')}`);
    for (const job of jobs) this.spawn(job);
    this.emit();
  }

  private spawn(job: BufferJob): void {
    if (this.jobs === null || !this.jobs.includes(job)) return;
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      ...(this.opts.inputPrefixArgs ?? []),
      ...inputArgs(job.config.url),
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-f',
      'segment',
      '-segment_time',
      String(SEGMENT_SECONDS),
      '-segment_format',
      'mpegts',
      '-segment_start_number',
      String(job.nextSegment),
      join(job.dir, 'seg-%06d.ts'),
    ];
    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    job.proc = proc;
    job.stderr = [];
    proc.stderr?.setEncoding('utf-8');
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        job.stderr.push(line.trim());
        if (job.stderr.length > STDERR_KEEP_LINES) job.stderr.shift();
      }
    });
    proc.on('error', err => {
      job.error = `ffmpeg failed to start: ${err.message}`;
      console.error(`Practice buffer ${job.config.name}: ${job.error}`);
    });
    proc.on('exit', (code, signal) => {
      if (job.proc !== proc) return;
      job.proc = null;
      if (this.jobs === null || !this.jobs.includes(job)) return;
      const why = job.stderr.at(-1) ?? `exit ${code ?? signal}`;
      job.error = why;
      // Numbering continues past whatever was written, so old and new segments never collide.
      job.nextSegment = this.maxSegmentNumber(job) + 1;
      const quick = this.now() - this.lastSegmentTime(job) < 5000;
      job.failures = quick ? 0 : job.failures + 1;
      const delay = job.failures >= 3 ? RESPAWN_BACKOFF_MS : RESPAWN_DELAY_MS;
      console.warn(`Practice buffer ${job.config.name} dropped (${why}); reconnecting in ${delay / 1000}s`);
      job.respawnTimer = setTimeout(() => {
        job.respawnTimer = undefined;
        this.spawn(job);
      }, delay);
    });
  }

  private async stopBuffer(): Promise<void> {
    const jobs = this.jobs;
    if (!jobs) return;
    this.jobs = null;
    console.log('Practice buffer stopped');
    this.emit();
    await Promise.all(
      jobs.map(job => {
        if (job.respawnTimer) clearTimeout(job.respawnTimer);
        const proc = job.proc;
        if (!proc) return Promise.resolve();
        return new Promise<void>(resolve => {
          const kill = setTimeout(() => proc.kill('SIGKILL'), STOP_GRACE_MS);
          proc.once('exit', () => {
            clearTimeout(kill);
            resolve();
          });
          try {
            proc.stdin?.write('q');
            proc.stdin?.end();
          } catch {
            proc.kill('SIGTERM');
          }
        });
      }),
    );
  }

  /** Delete segments nobody will need: older than the keep window, and not
   *  inside the window of a run in progress or being finalized. */
  private pruneBuffer(now: number): void {
    if (!existsSync(this.bufferRoot)) return;
    let protectFrom = Infinity;
    if (this.run) protectFrom = this.run.startedAt;
    for (const r of this.finalizing) protectFrom = Math.min(protectFrom, r.startedAt);
    const cutoff = Math.min(now - BUFFER_KEEP_MS, protectFrom);
    for (const seg of this.listSegments()) {
      if (seg.end < cutoff) rmSync(seg.file, { force: true });
    }
  }

  private listSegments(only?: string): Segment[] {
    const dirs = only
      ? [only]
      : existsSync(this.bufferRoot)
        ? readdirSync(this.bufferRoot).map(d => join(this.bufferRoot, d))
        : [];
    const out: Segment[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir).filter(n => /^seg-\d+\.ts$/.test(n));
      } catch {
        continue;
      }
      names.sort();
      let prevEnd: number | undefined;
      for (const name of names) {
        const file = join(dir, name);
        let end: number;
        try {
          end = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        // Across a respawn the previous segment's end is not this one's start.
        const contiguous = prevEnd !== undefined && end - prevEnd < SEGMENT_SECONDS * 1000 * 5;
        out.push({ file, end, start: contiguous ? prevEnd! : end - SEGMENT_SECONDS * 1000 * 2 });
        prevEnd = end;
      }
    }
    return out;
  }

  private maxSegmentNumber(job: BufferJob): number {
    let max = -1;
    try {
      for (const n of readdirSync(job.dir)) {
        const m = /^seg-(\d+)\.ts$/.exec(n);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch {
      // gone
    }
    return max;
  }

  private lastSegmentTime(job: BufferJob): number {
    const segs = this.listSegments(job.dir);
    return segs.length ? segs[segs.length - 1].end : 0;
  }

  // ── finalize ───────────────────────────────────────────────────────

  private async finalize(run: Run): Promise<void> {
    const endedAt = run.endedAt!;
    const jobs = this.jobs ?? [];
    const id = practiceRunId(run.startedAt);
    const dir = join(this.opts.directory, id);
    mkdirSync(dir, { recursive: true });
    const recordings: MatchRecording[] = [];
    const streams = this.opts.getStreams().filter(s => s.enabled);
    // The buffer may have stopped (match started) before finalize ran; the
    // segments are still on disk under their stream slugs.
    const sources = jobs.length
      ? jobs.map(j => ({ name: j.config.name, slug: j.slug, dir: j.dir }))
      : streams.map(s => ({ name: s.name, slug: slugify(s.name), dir: join(this.bufferRoot, slugify(s.name)) }));
    for (const src of sources) {
      const segs = this.listSegments(src.dir).filter(s => s.end > run.startedAt && s.start < endedAt);
      recordings.push(await this.joinSegments(src.name, src.slug, segs, dir, run.startedAt, endedAt));
    }
    const teams = [...run.participants].map(([station, teamNumber]) => ({ station, teamNumber }));
    const manifest: RecordingManifest = {
      matchId: id,
      startedAt: run.startedAt,
      endedAt,
      teams: teams.map(t => ({ ...t, alliance: null })),
      recordings,
    };
    try {
      writeFileSync(join(dir, 'recording.json'), JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.error(`Practice recorder: cannot write manifest in ${dir}: ${(err as Error).message}`);
    }
    const hasMetadata = this.opts.metadata.writeSidecars(dir, {
      kind: 'practice',
      id,
      startedAt: run.startedAt,
      endedAt,
      teams: manifest.teams,
    });
    this.finalizing.delete(run);
    if (recordings.every(r => r.status === 'failed')) {
      rmSync(dir, { recursive: true, force: true });
      console.warn(`Practice recording discarded: no video was captured (${recordings.map(r => r.error).join('; ')})`);
      this.emit();
      return;
    }
    const entry: PracticeRunEntry = { id, startedAt: run.startedAt, endedAt, teams, recordings, hasMetadata };
    this.opts.store.addRun(entry);
    const summary = recordings.map(r => `${r.name}: ${r.status} ${(r.bytes / 1e6).toFixed(0)} MB`).join(', ');
    console.log(`Practice recording saved: ${id} (${summary}) for team(s) ${teams.map(t => t.teamNumber).join(', ')}`);
    this.emit();
  }

  private async joinSegments(
    name: string,
    slug: string,
    segs: Segment[],
    dir: string,
    startedAt: number,
    endedAt: number,
  ): Promise<MatchRecording> {
    const base: MatchRecording = {
      name,
      file: `${slug}.mp4`,
      bytes: 0,
      startedAt,
      endedAt,
      status: 'failed',
    };
    if (segs.length === 0) return { ...base, error: 'No video was buffered for this window' };
    const out = join(dir, `${slug}.mp4`);
    const list = join(dir, `${slug}.segments.txt`);
    try {
      writeFileSync(
        list,
        segs.map(s => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n',
      );
      await runCommand(
        this.opts.ffmpegPath,
        ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out],
        180_000,
      );
    } catch (err) {
      return { ...base, error: `Could not join segments: ${(err as Error).message}` };
    } finally {
      rmSync(list, { force: true });
    }
    const bytes = statSync(out).size;
    const durationSeconds = await probeDuration(this.opts.ffprobePath, out);
    const windowSeconds = (endedAt - startedAt) / 1000;
    // Segment boundaries add up to a GOP on either side; anything shorter
    // than the window by more than that means the source dropped out.
    const hasGap = durationSeconds !== undefined && durationSeconds < windowSeconds - 3;
    return {
      ...base,
      bytes,
      durationSeconds,
      status: hasGap ? 'partial' : 'ok',
      error: hasGap ? `~${Math.round(windowSeconds - durationSeconds)}s missing (source dropped)` : undefined,
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in PracticeRecorder listener:', err);
      }
    }
  }
}

/** `practice-20260918-190430-3fa1`: sortable, readable, unique enough. */
export function practiceRunId(startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `practice-${stamp}-${randomBytes(2).toString('hex')}`;
}
