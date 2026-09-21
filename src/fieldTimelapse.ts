/**
 * FieldTimelapse — the field, over a season.
 *
 * Two capture modes sharing one store and one set of streams:
 *
 *  - **Archival frames.** At a few fixed local times a day, one full-resolution
 *    JPEG per enabled stream. ~3 MB each on the stitched field stream, so three
 *    a day is about 3.4 GB a year; they are kept as stills rather than video so
 *    a film can be re-rendered later at any size, including crops and pans.
 *    Optional pre/post HTTP actions run either side of the shutter, which is
 *    how the bay lights get driven to a known level and put back (see
 *    `TimelapseAction`). They never fire while the field is in use.
 *
 *  - **Fast timelapse while robots are here.** One long-running ffmpeg per
 *    stream, sampling the source and writing half-hour chunks. The default
 *    samples keyframes only (`-skip_frame nokey`): the field stream has a 2 s
 *    GOP, so that is 0.5 fps for ~20 % of a core, against ~85 % to decode all
 *    30 fps and throw 29 of them away. Frames are retimed to 30 fps playback
 *    (`setpts=N/30/TB`) *before* encoding — x264 budgets bits per second of
 *    output, so leaving a 1 fps timebase costs ~20× the bytes for identical
 *    frames. At 30 fps playback the cost is ~19 MB per hour of field time.
 *
 * Everything lives under `<recordings>/.timelapse/`. The leading dot matters:
 * `MatchRecorder.sweep()` skips dot-prefixed names, so a season of frames is
 * not deleted as if it were a stale match. This module runs its own sweep with
 * its own (separate) retention for frames and chunks.
 *
 * Matches are left alone — the match recorder owns the streams then, and that
 * footage already exists at full rate.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputArgs, runCommand, slugify } from './matchRecorder.js';
import {
  TIMELAPSE_DEFAULTS,
  type MatchState,
  type RecordingStreamConfig,
  type TimelapseAction,
  type TimelapseConfig,
  type TimelapseDayListing,
  type TimelapseFrameEntry,
  type TimelapseListing,
  type TimelapseRenderFile,
  type TimelapseRenderState,
  type TimelapseSource,
  type TimelapseSessionEntry,
  type TimelapseState,
} from './types.js';

/** Schedule and presence are checked on this cadence. */
const TICK_MS = 15_000;
/** Capture keeps running this long after the last packet from any robot, so a
 *  practice night is one piece rather than confetti. */
const PRESENCE_HOLD_MS = 5 * 60_000;
/** The encoder is rotated this often, so a crash costs one chunk. */
const CHUNK_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** A scheduled frame missed by more than this (restart, field busy) is given
 *  up on rather than taken at the wrong time of day. */
const SLOT_GRACE_MS = 15 * 60_000;
const FRAME_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 60 * 60_000;
/** Playback rate of every timelapse this module writes. */
const PLAYBACK_FPS = 30;
/** Width of the small copy written beside each archival frame. A gallery of
 *  12 MP originals would be 3 MB a tile; these are ~40 KB. */
const THUMB_WIDTH = 480;
const RESPAWN_DELAY_MS = 5000;
const STOP_GRACE_MS = 8000;
const STDERR_KEEP_LINES = 8;
const DIRNAME = '.timelapse';
const STATE_FILE = 'timelapse.json';
const FRAMES_IN_STATE = 30;
const SESSIONS_IN_STATE = 30;
const LOG_KEEP = 500;

/** Just enough of `fetch` for the pre/post actions, so a test can stand in
 *  for it without building a whole Response. */
export type TimelapseFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface FieldTimelapseOptions {
  /** Recordings root; the store is `<directory>/.timelapse`. */
  directory: string;
  ffmpegPath: string;
  getStreams: () => RecordingStreamConfig[];
  getConfig: () => TimelapseConfig | undefined;
  /** ffmpeg works on this host (the match recorder checked at startup). */
  isAvailable: () => boolean;
  /** True while a match is running or a robot is enabled — the lights must not
   *  move, whatever the schedule says. */
  isFieldBusy: () => boolean;
  /** Input options placed before `-i` (tests read a file instead of a camera). */
  inputPrefixArgs?: string[];
  now?: () => number;
  /** Schedule/presence cadence; tests turn it down so they don't wait 15 s. */
  tickMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: TimelapseFetch;
}

interface PersistedState {
  version: 1;
  frames: TimelapseFrameEntry[];
  sessions: TimelapseSessionEntry[];
}

/** One stream's encoder, while robots are on the field. */
interface ActiveJob {
  config: RecordingStreamConfig;
  slug: string;
  file: string;
  day: string;
  startedAt: number;
  proc: ChildProcess | null;
  respawnTimer?: NodeJS.Timeout;
  stderr: string[];
  error?: string;
}

export class FieldTimelapse {
  private readonly opts: FieldTimelapseOptions;
  private readonly now: () => number;
  private readonly fetchImpl: TimelapseFetch;
  readonly root: string;
  private readonly framesRoot: string;
  private readonly activeRoot: string;
  private readonly rendersRoot: string;

  private persisted: PersistedState = { version: 1, frames: [], sessions: [] };
  private jobs: ActiveJob[] | null = null;
  private lastTelemetryAt = 0;
  private matchPhase: MatchState['phase'] = 'idle';
  private tickTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private listeners: ((state: TimelapseState) => void)[] = [];
  private capturingFrame = false;
  private render?: TimelapseRenderState;
  private totals = { frameCount: 0, frameBytes: 0, sessionBytes: 0, renderBytes: 0 };
  private stopping = false;

  constructor(opts: FieldTimelapseOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.root = join(opts.directory, DIRNAME);
    this.framesRoot = join(this.root, 'frames');
    this.activeRoot = join(this.root, 'active');
    this.rendersRoot = join(this.root, 'renders');
  }

  start(): void {
    this.load();
    this.sweep();
    this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    const config = this.config();
    if (config.enabled) {
      console.log(
        `Field timelapse ready: frames at ${config.dailyTimes.join(', ')}` +
          (config.captureWhileRobotsPresent ? `, fast timelapse while robots are here (${config.activeMode})` : ''),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.tickTimer = this.sweepTimer = null;
    await this.stopActive('shutdown');
  }

  addListener(fn: (state: TimelapseState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  // ── inputs ─────────────────────────────────────────────────────────

  /** Any packet from any station means robots are here. */
  onTelemetry(): void {
    this.lastTelemetryAt = this.now();
  }

  onMatchState(state: MatchState): void {
    this.matchPhase = state.phase;
    if (!this.isIdlePhase() && this.jobs) void this.stopActive('match starting');
  }

  /** Settings changed: apply them without waiting for the next tick. */
  onConfigChanged(): void {
    this.tick();
    this.emit();
  }

  // ── state ──────────────────────────────────────────────────────────

  getState(): TimelapseState {
    const config = this.config();
    return {
      type: 'timelapseState',
      enabled: config.enabled,
      unavailableReason: this.unavailableReason(),
      capturing: this.jobs !== null,
      robotsPresent: this.robotsPresent(),
      nextDailyAt: this.nextSlotAt(),
      lastFrame: this.persisted.frames.at(-1),
      recentFrames: this.persisted.frames.slice(-FRAMES_IN_STATE).reverse(),
      recentSessions: this.persisted.sessions.slice(-SESSIONS_IN_STATE).reverse(),
      ...this.totals,
      directory: this.root,
      render: this.render,
      renders: this.listRenders(),
    };
  }

  private config(): TimelapseConfig {
    return this.opts.getConfig() ?? TIMELAPSE_DEFAULTS;
  }

  private streams(): RecordingStreamConfig[] {
    return this.opts.getStreams().filter(s => s.enabled);
  }

  private unavailableReason(): string | undefined {
    if (!this.opts.isAvailable()) return 'ffmpeg is not available on this host';
    if (this.streams().length === 0) return 'no recording streams are enabled';
    return undefined;
  }

  private robotsPresent(): boolean {
    return this.now() - this.lastTelemetryAt < PRESENCE_HOLD_MS;
  }

  private isIdlePhase(): boolean {
    return this.matchPhase === 'idle' || this.matchPhase === 'created';
  }

  // ── scheduling ─────────────────────────────────────────────────────

  private tick(): void {
    if (this.stopping) return;
    const config = this.config();
    const blocked = !config.enabled || this.unavailableReason() !== undefined;

    if (!blocked) {
      const due = this.dueSlot(config);
      if (due && !this.capturingFrame) {
        void this.captureFrame(due, true).catch(err => console.error('Timelapse frame failed:', err));
      }
    }

    const wantActive =
      !blocked && config.captureWhileRobotsPresent && this.robotsPresent() && this.isIdlePhase() && !this.stopping;
    if (wantActive && !this.jobs) this.startActive();
    else if (!wantActive && this.jobs) void this.stopActive(this.robotsPresent() ? 'match starting' : 'field quiet');
    else if (this.jobs) this.rotateIfDue();
  }

  /** The scheduled time that should have fired by now and has not, if any. */
  private dueSlot(config: TimelapseConfig): string | undefined {
    const now = this.now();
    const day = localDay(now);
    for (const slot of config.dailyTimes) {
      const at = slotTime(now, slot);
      if (now < at || now - at > SLOT_GRACE_MS) continue;
      if (this.persisted.frames.some(f => f.day === day && f.slot === slot)) continue;
      return slot;
    }
    return undefined;
  }

  /** When the next archival frame is due, for the admin panel. */
  private nextSlotAt(): number | undefined {
    const config = this.config();
    if (!config.enabled || config.dailyTimes.length === 0) return undefined;
    const now = this.now();
    const day = localDay(now);
    let best: number | undefined;
    for (const slot of config.dailyTimes) {
      const today = slotTime(now, slot);
      const taken = this.persisted.frames.some(f => f.day === day && f.slot === slot);
      const at = today > now && !taken ? today : today + 24 * 60 * 60 * 1000;
      if (best === undefined || at < best) best = at;
    }
    return best;
  }

  // ── archival frames ────────────────────────────────────────────────

  /**
   * Take one full-resolution frame per enabled stream.
   *
   * The light actions are skipped — not the frame — whenever anyone is here:
   * the lights are already on in that case, and a frame lit differently is
   * worth more than a hole in the film.
   */
  async captureFrame(slot: string, withActions: boolean): Promise<TimelapseFrameEntry> {
    const config = this.config();
    const now = this.now();
    const day = localDay(now);
    const entry: TimelapseFrameEntry = { day, slot, at: now, files: [], lights: 'none' };
    this.capturingFrame = true;
    try {
      const pre = config.preActions ?? [];
      const post = config.postActions ?? [];
      const hasActions = pre.length + post.length > 0;
      // Only ever touch the lights in an empty shop. When anyone is here they
      // have already turned the lights on, so there is nothing to gain and a
      // flicker to lose.
      const occupied = this.opts.isFieldBusy() || this.robotsPresent();
      if (withActions && hasActions && occupied) entry.lights = 'skipped-field-in-use';

      if (!withActions || !hasActions || occupied) {
        await this.shoot(entry, day, slot);
      } else {
        try {
          for (const action of pre) await this.runAction(action);
          entry.lights = 'ran';
          if (config.settleSeconds > 0) await sleep(config.settleSeconds * 1000);
        } catch (err) {
          // A light that would not come on must not cost us the frame.
          entry.lights = 'failed';
          entry.lightsError = (err as Error).message;
        }
        try {
          await this.shoot(entry, day, slot);
        } finally {
          // Whatever happened above, put the lights back.
          for (const action of post) {
            try {
              await this.runAction(action);
            } catch (err) {
              entry.lights = 'failed';
              entry.lightsError = `restore failed: ${(err as Error).message}`;
              console.error(`Timelapse: could not restore the lights: ${(err as Error).message}`);
            }
          }
        }
      }
    } finally {
      this.capturingFrame = false;
    }

    if (entry.files.length === 0 && !entry.error) entry.error = 'no frame was captured';
    this.persisted.frames.push(entry);
    if (this.persisted.frames.length > LOG_KEEP)
      this.persisted.frames.splice(0, this.persisted.frames.length - LOG_KEEP);
    this.persist();
    this.refreshTotals();
    const size = entry.files.reduce((n, f) => n + f.bytes, 0);
    if (entry.error) console.warn(`Timelapse frame ${day} ${slot} failed: ${entry.error}`);
    else console.log(`Timelapse frame ${day} ${slot}: ${entry.files.length} stream(s), ${(size / 1e6).toFixed(1)} MB`);
    this.emit();
    return entry;
  }

  /** One JPEG per enabled stream, taken one after another so the lights stay
   *  up for the shortest time and the decoder spike stays small. */
  private async shoot(entry: TimelapseFrameEntry, day: string, slot: string): Promise<void> {
    const dir = join(this.framesRoot, day);
    mkdirSync(dir, { recursive: true });
    const stamp = slot === 'manual' ? hhmmss(this.now()) : slot.replace(':', '');
    const errors: string[] = [];
    for (const stream of this.streams()) {
      const slug = slugify(stream.name);
      const name = `${stamp}-${slug}.jpg`;
      const thumbName = `${stamp}-${slug}.thumb.jpg`;
      const out = join(dir, name);
      const thumb = join(dir, thumbName);
      try {
        // Two outputs, one connection: the archival frame at full size and a
        // gallery-sized copy of the very same frame.
        await runCommand(
          this.opts.ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            ...(this.opts.inputPrefixArgs ?? []),
            ...inputArgs(stream.url),
            '-frames:v',
            '1',
            '-q:v',
            '2',
            '-y',
            out,
            '-frames:v',
            '1',
            '-vf',
            // Quoted min(…) so a source narrower than this is copied rather
            // than blown up; the quotes keep the comma out of the filtergraph.
            `scale='min(${THUMB_WIDTH},iw)':-2`,
            '-q:v',
            '6',
            '-y',
            thumb,
          ],
          FRAME_TIMEOUT_MS,
        );
        entry.files.push({
          stream: stream.name,
          file: `${day}/${name}`,
          thumb: existsSync(thumb) ? `${day}/${thumbName}` : undefined,
          bytes: statSync(out).size,
        });
      } catch (err) {
        errors.push(`${stream.name}: ${errText(err)}`);
        rmSync(out, { force: true });
        rmSync(thumb, { force: true });
      }
    }
    if (errors.length > 0) entry.error = errors.join('; ');
  }

  /** Fire one configured HTTP action. Failures are reported, never thrown at
   *  the scheduler — a light that would not turn on must not cost the frame. */
  private async runAction(action: TimelapseAction): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        ...(action.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(action.headers ?? {}),
      };
      const res = await this.fetchImpl(action.url, {
        method: action.method,
        headers,
        body: action.body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(action.url).host}`);
    } catch (err) {
      throw new Error((err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── fast timelapse while robots are here ───────────────────────────

  private startActive(): void {
    if (this.jobs) return;
    const streams = this.streams();
    if (streams.length === 0) return;
    const jobs: ActiveJob[] = [];
    for (const config of streams) {
      const job = this.newJob(config);
      if (job) jobs.push(job);
    }
    if (jobs.length === 0) return;
    this.jobs = jobs;
    console.log(`Field timelapse started (${this.config().activeMode}): ${jobs.map(j => j.config.name).join(', ')}`);
    for (const job of jobs) this.spawn(job);
    this.emit();
  }

  private newJob(config: RecordingStreamConfig): ActiveJob | null {
    const now = this.now();
    const day = localDay(now);
    const dir = join(this.activeRoot, day);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`Field timelapse: cannot create ${dir}: ${(err as Error).message}`);
      return null;
    }
    const slug = slugify(config.name);
    return {
      config,
      slug,
      day,
      file: join(dir, `${slug}-${hhmmss(now)}.mp4`),
      startedAt: now,
      proc: null,
      stderr: [],
    };
  }

  private spawn(job: ActiveJob): void {
    if (this.jobs === null || !this.jobs.includes(job)) return;
    const config = this.config();
    const sample = config.activeMode === 'everySecond' ? 'fps=1,' : '';
    const proc = spawn(
      this.opts.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-nostats',
        // Decoder option: only keyframes are decoded at all, which is where
        // nearly all of the CPU saving comes from.
        ...(config.activeMode === 'keyframes' ? ['-skip_frame', 'nokey'] : []),
        ...(this.opts.inputPrefixArgs ?? []),
        ...inputArgs(job.config.url),
        '-vf',
        `${sample}scale=${config.activeWidth}:-2,setpts=N/${PLAYBACK_FPS}/TB`,
        '-r',
        String(PLAYBACK_FPS),
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(config.activeCrf),
        // One output keyframe per second of playback. With fragmented MP4 the
        // file is flushed at each one, so a chunk lost to a kill costs a
        // second of film (~a minute of field time) rather than the lot.
        '-g',
        String(PLAYBACK_FPS),
        '-pix_fmt',
        'yuv420p',
        // Fragmented MP4: a chunk stays playable even if the process is killed
        // rather than asked to quit, which a plain moov-at-the-end file is not.
        // (`default_base_moof`, not `default_base_is_moof` — ffmpeg rejects the
        // latter outright and writes a zero-byte file.)
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof',
        '-y',
        job.file,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
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
      console.error(`Field timelapse ${job.config.name}: ${job.error}`);
    });
    proc.on('exit', (code, signal) => {
      if (job.proc !== proc) return;
      job.proc = null;
      if (this.jobs === null || !this.jobs.includes(job)) return;
      // An exit we did not ask for: the source dropped. Close this chunk and
      // start another rather than losing the rest of the session.
      job.error = job.stderr.at(-1) ?? `exit ${code ?? signal}`;
      console.warn(`Field timelapse ${job.config.name} dropped (${job.error}); reconnecting`);
      this.closeChunk(job);
      job.respawnTimer = setTimeout(() => {
        job.respawnTimer = undefined;
        const fresh = this.newJob(job.config);
        if (!fresh || this.jobs === null) return;
        Object.assign(job, { file: fresh.file, day: fresh.day, startedAt: this.now(), stderr: [] });
        this.spawn(job);
      }, RESPAWN_DELAY_MS);
    });
  }

  /** Rotate any encoder that has been running for a full chunk. */
  private rotateIfDue(): void {
    const now = this.now();
    for (const job of this.jobs ?? []) {
      if (job.proc && now - job.startedAt >= CHUNK_MS) {
        void this.rotate(job);
      }
    }
  }

  private async rotate(job: ActiveJob): Promise<void> {
    const proc = job.proc;
    if (!proc) return;
    job.proc = null;
    await quit(proc);
    this.closeChunk(job);
    if (this.jobs === null || !this.jobs.includes(job)) return;
    const fresh = this.newJob(job.config);
    if (!fresh) return;
    Object.assign(job, { file: fresh.file, day: fresh.day, startedAt: this.now(), stderr: [] });
    this.spawn(job);
    this.emit();
  }

  private async stopActive(why: string): Promise<void> {
    const jobs = this.jobs;
    if (!jobs) return;
    this.jobs = null;
    await Promise.all(
      jobs.map(async job => {
        if (job.respawnTimer) clearTimeout(job.respawnTimer);
        const proc = job.proc;
        job.proc = null;
        if (proc) await quit(proc);
        this.closeChunk(job);
      }),
    );
    console.log(`Field timelapse stopped (${why})`);
    this.refreshTotals();
    this.emit();
  }

  /** Record a finished chunk, or delete it if nothing landed in it. */
  private closeChunk(job: ActiveJob): void {
    let bytes = 0;
    try {
      bytes = statSync(job.file).size;
    } catch {
      return;
    }
    // An mp4 with only headers is not worth keeping or showing.
    if (bytes < 2048) {
      rmSync(job.file, { force: true });
      return;
    }
    const endedAt = this.now();
    const entry: TimelapseSessionEntry = {
      day: job.day,
      startedAt: job.startedAt,
      endedAt,
      stream: job.config.name,
      file: `${job.day}/${job.file.split(/[\\/]/).pop()}`,
      bytes,
      coveredSeconds: Math.round((endedAt - job.startedAt) / 1000),
    };
    this.persisted.sessions.push(entry);
    if (this.persisted.sessions.length > LOG_KEEP)
      this.persisted.sessions.splice(0, this.persisted.sessions.length - LOG_KEEP);
    this.persist();
  }

  // ── rendering ──────────────────────────────────────────────────────

  /**
   * Build one downloadable film for a date range, from either source:
   *
   *  - `frames`: the archival stills, encoded at the chosen rate. This is the
   *    season film — a year of three-a-day at 12 fps is about 90 seconds.
   *  - `practice`: the chunks captured while robots were here, joined in
   *    order. They were already encoded at capture time, so this is a stream
   *    copy when their settings match, and a re-encode only when they do not
   *    (someone changed the width or crf partway through the range).
   *
   * One at a time: a season of 12 MP JPEGs is minutes of decoding, and two at
   * once would fight the recorders for CPU.
   */
  async renderFilm(opts: {
    source: TimelapseSource;
    from?: string;
    to?: string;
    fps: number;
    height: number;
    stream?: string;
  }): Promise<void> {
    if (this.render?.status === 'running') throw new Error('a film is already being built');
    const streamName = opts.stream ?? this.streams()[0]?.name;
    if (!streamName) throw new Error('no streams are configured');
    const slug = slugify(streamName);
    const parts = opts.source === 'frames' ? this.framesIn(slug, opts) : this.chunksIn(slug, opts);
    if (parts.length === 0) throw new Error('nothing in that range to build from');
    if (opts.source === 'frames' && parts.length < 2) throw new Error('only one frame in that range — nothing to play');

    const started = this.now();
    this.render = { status: 'running', source: opts.source, startedAt: started, frames: parts.length };
    this.emit();
    mkdirSync(this.rendersRoot, { recursive: true });
    const name = `${opts.source === 'frames' ? 'timelapse' : 'practice'}-${localDay(started)}-${hhmmss(started)}.mp4`;
    const out = join(this.rendersRoot, name);
    const list = join(this.rendersRoot, `.${name}.txt`);
    try {
      writeFileSync(list, parts.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      if (opts.source === 'practice') {
        try {
          await this.concat(list, out, ['-c', 'copy']);
        } catch {
          // Mismatched chunks (settings changed mid-range): re-encode instead.
          await this.concat(list, out, [
            '-vf',
            `scale=-2:${opts.height}`,
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '22',
            '-pix_fmt',
            'yuv420p',
          ]);
        }
      } else {
        await this.concat(list, out, [
          '-vf',
          `scale=-2:${opts.height},setpts=N/${opts.fps}/TB`,
          '-r',
          String(opts.fps),
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
        ]);
      }
      const bytes = statSync(out).size;
      this.render = {
        status: 'done',
        source: opts.source,
        file: name,
        bytes,
        frames: parts.length,
        startedAt: started,
        finishedAt: this.now(),
      };
      console.log(`Timelapse film built: ${name} (${parts.length} parts, ${(bytes / 1e6).toFixed(0)} MB)`);
    } catch (err) {
      rmSync(out, { force: true });
      this.render = {
        status: 'failed',
        source: opts.source,
        frames: parts.length,
        startedAt: started,
        finishedAt: this.now(),
        error: errText(err),
      };
      console.error(`Timelapse film failed: ${errText(err)}`);
    } finally {
      rmSync(list, { force: true });
      this.refreshTotals();
      this.emit();
    }
  }

  private concat(list: string, out: string, encodeArgs: string[]): Promise<string> {
    return runCommand(
      this.opts.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        ...encodeArgs,
        '-movflags',
        '+faststart',
        '-y',
        out,
      ],
      RENDER_TIMEOUT_MS,
    );
  }

  /** Archival frames for one stream in a day range, oldest first. Thumbnails
   *  are skipped — they end `.thumb.jpg`, not `-<slug>.jpg`. */
  private framesIn(slug: string, range: { from?: string; to?: string }): string[] {
    const out: string[] = [];
    for (const day of this.daysIn(this.framesRoot, range)) {
      const dir = join(this.framesRoot, day);
      for (const name of readdirSync(dir).sort()) {
        if (name.endsWith(`-${slug}.jpg`)) out.push(join(dir, name));
      }
    }
    return out;
  }

  /** Robots-present chunks for one stream in a day range, oldest first. */
  private chunksIn(slug: string, range: { from?: string; to?: string }): string[] {
    const out: string[] = [];
    for (const day of this.daysIn(this.activeRoot, range)) {
      const dir = join(this.activeRoot, day);
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith(`${slug}-`) && name.endsWith('.mp4')) out.push(join(dir, name));
      }
    }
    return out;
  }

  private daysIn(root: string, range: { from?: string; to?: string }): string[] {
    return this.days(root).filter(d => (!range.from || d >= range.from) && (!range.to || d <= range.to));
  }

  /** Films built so far, newest first. */
  listRenders(): TimelapseRenderFile[] {
    if (!existsSync(this.rendersRoot)) return [];
    const out: TimelapseRenderFile[] = [];
    for (const file of readdirSync(this.rendersRoot)) {
      if (!file.endsWith('.mp4')) continue;
      try {
        const st = statSync(join(this.rendersRoot, file));
        out.push({ file, bytes: st.size, at: st.mtimeMs });
      } catch {
        // deleted underneath us
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Delete one built film. Returns false if the name is not one of ours. */
  deleteRender(file: string): boolean {
    const full = this.filePath('render', file);
    if (!full) return false;
    rmSync(full, { force: true });
    console.log(`Timelapse film deleted by admin: ${file}`);
    if (this.render?.file === file) this.render = undefined;
    this.refreshTotals();
    this.emit();
    return true;
  }

  /**
   * Everything on disk for a range of days, read from the filesystem rather
   * than the log so it stays right across restarts and manual tidying.
   */
  listing(range: { from?: string; to?: string } = {}): TimelapseListing {
    const byDay = new Map<string, TimelapseDayListing>();
    const dayOf = (day: string): TimelapseDayListing => {
      let entry = byDay.get(day);
      if (!entry) {
        entry = { day, frames: [], practice: [] };
        byDay.set(day, entry);
      }
      return entry;
    };

    for (const day of this.daysIn(this.framesRoot, range)) {
      const dir = join(this.framesRoot, day);
      const names = readdirSync(dir).sort();
      const thumbs = new Set(names.filter(n => n.endsWith('.thumb.jpg')));
      for (const name of names) {
        if (!name.endsWith('.jpg') || name.endsWith('.thumb.jpg')) continue;
        const m = /^(\d{4,6})-(.+)\.jpg$/.exec(name);
        if (!m) continue;
        const thumbName = `${m[1]}-${m[2]}.thumb.jpg`;
        try {
          const st = statSync(join(dir, name));
          dayOf(day).frames.push({
            // A four-digit stamp is a scheduled slot; six means "capture now".
            slot: m[1].length === 4 ? `${m[1].slice(0, 2)}:${m[1].slice(2)}` : 'manual',
            at: st.mtimeMs,
            stream: m[2],
            file: `${day}/${name}`,
            thumb: thumbs.has(thumbName) ? `${day}/${thumbName}` : undefined,
            bytes: st.size,
          });
        } catch {
          // deleted underneath us
        }
      }
    }

    for (const day of this.daysIn(this.activeRoot, range)) {
      const dir = join(this.activeRoot, day);
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.mp4')) continue;
        const m = /^(.+)-(\d{6})\.mp4$/.exec(name);
        try {
          const st = statSync(join(dir, name));
          dayOf(day).practice.push({
            file: `${day}/${name}`,
            stream: m?.[1] ?? name,
            at: st.mtimeMs,
            bytes: st.size,
          });
        } catch {
          // deleted underneath us
        }
      }
    }

    return {
      type: 'timelapseListing',
      days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
      scannedAt: this.now(),
    };
  }

  // ── files on disk ──────────────────────────────────────────────────

  /** Absolute path of a stored file, or undefined if the name is not one of
   *  ours. Paths from clients never reach the filesystem unchecked. */
  filePath(kind: 'frame' | 'active' | 'render', path: string): string | undefined {
    if (kind === 'render') {
      if (!/^[A-Za-z0-9._-]{1,120}\.mp4$/.test(path) || path.includes('..')) return undefined;
      const full = join(this.rendersRoot, path);
      return existsSync(full) ? full : undefined;
    }
    const m = /^(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9._-]{1,120})$/.exec(path);
    if (!m || path.includes('..')) return undefined;
    const [, day, name] = m;
    if (kind === 'frame' && !name.endsWith('.jpg')) return undefined;
    if (kind === 'active' && !name.endsWith('.mp4')) return undefined;
    const full = join(kind === 'frame' ? this.framesRoot : this.activeRoot, day, name);
    return existsSync(full) ? full : undefined;
  }

  /** Days that have archival frames, oldest first. */
  private days(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort();
  }

  /** Delete what is past its retention. Frames and chunks have separate
   *  windows — the point of the feature is that the frames outlive
   *  everything else on the disk. */
  sweep(): void {
    const config = this.config();
    const now = this.now();
    let removed = 0;
    if (config.frameRetentionDays > 0) {
      const cutoff = localDay(now - config.frameRetentionDays * 24 * 60 * 60 * 1000);
      for (const day of this.days(this.framesRoot)) {
        if (day >= cutoff) continue;
        rmSync(join(this.framesRoot, day), { recursive: true, force: true });
        removed++;
      }
    }
    const activeCutoff = localDay(now - config.activeRetentionDays * 24 * 60 * 60 * 1000);
    for (const day of this.days(this.activeRoot)) {
      if (day >= activeCutoff) continue;
      // Never delete the day an encoder is still writing into.
      if ((this.jobs ?? []).some(j => j.day === day)) continue;
      rmSync(join(this.activeRoot, day), { recursive: true, force: true });
      removed++;
    }
    if (removed > 0) console.log(`Field timelapse: swept ${removed} day(s) past retention`);
    this.prunePersisted();
    this.refreshTotals();
    this.emit();
  }

  /** Drop log entries whose files are gone, so the admin list matches disk. */
  private prunePersisted(): void {
    const before = this.persisted.frames.length + this.persisted.sessions.length;
    this.persisted.frames = this.persisted.frames.filter(f => f.files.some(x => this.filePath('frame', x.file)));
    this.persisted.sessions = this.persisted.sessions.filter(s => this.filePath('active', s.file));
    if (before !== this.persisted.frames.length + this.persisted.sessions.length) this.persist();
  }

  private refreshTotals(): void {
    const scan = (root: string, nested: boolean): { count: number; bytes: number } => {
      let count = 0;
      let bytes = 0;
      const dirs = nested ? this.days(root).map(d => join(root, d)) : existsSync(root) ? [root] : [];
      for (const dir of dirs) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          try {
            const st = statSync(join(dir, name));
            if (!st.isFile() || name.startsWith('.')) continue;
            count++;
            bytes += st.size;
          } catch {
            // deleted underneath us
          }
        }
      }
      return { count, bytes };
    };
    const frames = scan(this.framesRoot, true);
    this.totals = {
      frameCount: frames.count,
      frameBytes: frames.bytes,
      sessionBytes: scan(this.activeRoot, true).bytes,
      renderBytes: scan(this.rendersRoot, false).bytes,
    };
  }

  // ── persistence ────────────────────────────────────────────────────

  private load(): void {
    mkdirSync(this.root, { recursive: true });
    const file = join(this.root, STATE_FILE);
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
      if (Array.isArray(parsed.frames)) this.persisted.frames = parsed.frames;
      if (Array.isArray(parsed.sessions)) this.persisted.sessions = parsed.sessions;
    } catch (err) {
      console.warn(`Field timelapse: could not read ${file}: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(join(this.root, STATE_FILE), JSON.stringify(this.persisted, null, 2));
    } catch (err) {
      console.error(`Field timelapse: could not write state: ${(err as Error).message}`);
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in FieldTimelapse listener:', err);
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const errText = (err: unknown) => (err as Error).message ?? String(err);

/** Local calendar day, `YYYY-MM-DD` — the same day a human at the shop means. */
export function localDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hhmmss(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Epoch ms of "HH:MM" on the local day of `now`. Built from local calendar
 *  fields so it lands on the right wall-clock time across a DST change. */
export function slotTime(now: number, slot: string): number {
  const [h, m] = slot.split(':').map(Number);
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
}

/** Ask ffmpeg to finish the file it is writing, and wait for it to do so. */
function quit(proc: ChildProcess): Promise<void> {
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
}
