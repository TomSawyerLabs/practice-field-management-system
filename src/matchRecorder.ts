/**
 * MatchRecorder — a full video capture of every match, independent of the
 * score-review integration.
 *
 * Streams come from the admin panel (`recordingStreams` in SetupSettings):
 * anything ffmpeg can pull, typically the field's stitchd/MediaMTX RTSP
 * outputs. One ffmpeg per enabled stream starts when a match enters its
 * countdown and stops a few seconds after it ends. Nothing is transcoded —
 * `-c copy` remuxes the stream into MP4, so the only cost is disk.
 *
 * Robustness:
 *  - Capture goes to fragmented MP4 (`.partN.mp4`), which stays playable if
 *    ffmpeg or pFMS dies mid-match.
 *  - If the source drops, ffmpeg is restarted into the next part; at the end
 *    all parts are joined (concat demuxer, still `-c copy`) and remuxed with
 *    `+faststart` into `<slug>.mp4` for instant playback/scrubbing.
 *  - Every match directory carries a `recording.json`, so the files are
 *    self-describing even if match-history.json is cleared.
 *  - A retention sweep deletes match directories older than the configured
 *    number of days (default 30) at startup and daily.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MatchEngine } from './matchEngine.js';
import type { MatchHistoryStore } from './matchHistoryStore.js';
import type {
  MatchPhase,
  MatchRecording,
  MatchRecordingState,
  MatchRecordingStreamStatus,
  MatchState,
  RecordingStreamConfig,
  RecordingStreamTestResult,
} from './types.js';

const ACTIVE_PHASES: ReadonlySet<MatchPhase> = new Set([
  'countdown',
  'auto',
  'autoPause',
  'paused',
  'teleop',
  'endgame',
]);
/** Keep rolling this long after the match leaves its active phases, so the
 *  final buzzer and any post-match scoring action is on tape. */
const POST_ROLL_MS = 3000;
/** How long a `q` gets to finish the file before SIGKILL. */
const STOP_GRACE_MS = 10_000;
const RECONNECT_DELAY_MS = 1000;
const MAX_PARTS = 30;
const STATUS_INTERVAL_MS = 2000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const STDERR_KEEP_LINES = 12;

export const DEFAULT_RECORDINGS_DIR = 'recordings';

export interface MatchRecorderOptions {
  /** Where match directories go. Relative paths resolve against the cwd. */
  directory?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  getStreams: () => RecordingStreamConfig[];
  getRetentionDays: () => number | undefined;
}

/** Sidecar written into each match directory. */
export interface RecordingManifest {
  matchId: string;
  matchNumber?: number;
  startedAt: number;
  endedAt?: number;
  teams: { station: string; teamNumber: number | null; alliance: string | null }[];
  recordings: MatchRecording[];
}

interface StreamJob {
  config: RecordingStreamConfig;
  slug: string;
  proc: ChildProcess | null;
  parts: string[];
  reconnects: number;
  startedAt: number;
  error?: string;
  stderr: string[];
  respawnTimer?: NodeJS.Timeout;
}

interface Session {
  matchId: string;
  matchNumber?: number;
  dir: string;
  startedAt: number;
  teams: RecordingManifest['teams'];
  jobs: StreamJob[];
  stopping: boolean;
  stopTimer?: NodeJS.Timeout;
}

/** "All Field cam" → "all-field-cam" */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'stream'
  );
}

function isRtsp(url: string): boolean {
  return /^rtsps?:/i.test(url);
}

function inputArgs(url: string): string[] {
  // -rw_timeout is a generic protocol option (µs): give up on a stalled
  // source instead of hanging forever, so the reconnect logic can kick in.
  const args = ['-rw_timeout', '10000000'];
  if (isRtsp(url)) args.unshift('-rtsp_transport', 'tcp');
  return [...args, '-i', url];
}

export class MatchRecorder {
  private readonly directory: string;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly getStreams: () => RecordingStreamConfig[];
  private readonly getRetentionDays: () => number | undefined;
  private historyStore: MatchHistoryStore | null = null;
  private session: Session | null = null;
  /** Status of the last run per stream name, shown while idle. */
  private lastStatus = new Map<string, MatchRecordingStreamStatus>();
  private listeners: ((state: MatchRecordingState) => void)[] = [];
  private available = false;
  private unavailableReason?: string;
  private statusTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private diskFreeBytes?: number;
  private usedBytes?: number;

  constructor(opts: MatchRecorderOptions) {
    this.directory = resolve(opts.directory ?? process.env.MATCH_RECORDINGS_DIR ?? DEFAULT_RECORDINGS_DIR);
    this.ffmpeg = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.ffprobe = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
    this.getStreams = opts.getStreams;
    this.getRetentionDays = opts.getRetentionDays;
  }

  /** Verify ffmpeg, run the first retention sweep, and start listening to matches. */
  async start(matchEngine: MatchEngine, historyStore: MatchHistoryStore): Promise<void> {
    this.historyStore = historyStore;
    try {
      await this.run(this.ffmpeg, ['-version'], 5000);
      this.available = true;
    } catch (err) {
      this.available = false;
      this.unavailableReason = `${this.ffmpeg} not usable: ${(err as Error).message}`;
      console.warn(`Match recording disabled — ${this.unavailableReason}`);
    }

    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    void this.refreshDiskStats();

    matchEngine.addStateListener(state => this.onMatchState(state));
    console.log(
      `Match recorder ${this.available ? 'ready' : 'unavailable'}: ${this.getStreams().filter(s => s.enabled).length} stream(s) enabled, files under ${this.directory}`,
    );
  }

  addListener(fn: (state: MatchRecordingState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  getState(): MatchRecordingState {
    const configured = this.getStreams();
    const streams: MatchRecordingStreamStatus[] = configured.map(cfg => {
      const job = this.session?.jobs.find(j => j.config.name === cfg.name);
      if (job) {
        return {
          name: cfg.name,
          url: cfg.url,
          enabled: cfg.enabled,
          status: this.session?.stopping ? 'finalizing' : job.proc ? 'recording' : 'error',
          bytes: this.partBytes(job),
          error: job.error,
          reconnects: job.reconnects,
        };
      }
      const last = this.lastStatus.get(cfg.name);
      return {
        name: cfg.name,
        url: cfg.url,
        enabled: cfg.enabled,
        status: 'idle',
        bytes: last?.bytes,
        error: last?.error,
      };
    });
    return {
      type: 'matchRecordingState',
      available: this.available,
      unavailableReason: this.unavailableReason,
      activeMatchId: this.session?.matchId,
      streams,
      retentionDays: this.retentionDays(),
      diskFreeBytes: this.diskFreeBytes,
      usedBytes: this.usedBytes,
      directory: this.directory,
    };
  }

  /** Absolute directory for a match's files, or null if the id is malformed. */
  matchDirectory(matchId: string): string | null {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(matchId)) return null;
    return join(this.directory, matchId);
  }

  /** The sidecar manifest for a recorded match, if present. */
  readManifest(matchId: string): RecordingManifest | null {
    const dir = this.matchDirectory(matchId);
    if (!dir) return null;
    try {
      return JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf-8')) as RecordingManifest;
    } catch {
      return null;
    }
  }

  /** ffprobe a candidate URL so the admin can confirm it before saving. */
  async testStream(url: string): Promise<RecordingStreamTestResult> {
    const t0 = Date.now();
    try {
      const out = await this.run(
        this.ffprobe,
        [
          '-v',
          'error',
          ...inputArgs(url),
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name,width,height,r_frame_rate',
          '-of',
          'json',
        ],
        15_000,
      );
      const parsed = JSON.parse(out) as {
        streams?: { codec_name?: string; width?: number; height?: number; r_frame_rate?: string }[];
      };
      const v = parsed.streams?.[0];
      if (!v)
        return {
          type: 'recordingStreamTestResult',
          url,
          ok: false,
          error: 'No video stream found',
          ms: Date.now() - t0,
        };
      const [num, den] = (v.r_frame_rate ?? '0/1').split('/').map(Number);
      return {
        type: 'recordingStreamTestResult',
        url,
        ok: true,
        codec: v.codec_name,
        width: v.width,
        height: v.height,
        fps: den ? Math.round((num / den) * 100) / 100 : undefined,
        ms: Date.now() - t0,
      };
    } catch (err) {
      return { type: 'recordingStreamTestResult', url, ok: false, error: (err as Error).message, ms: Date.now() - t0 };
    }
  }

  // ── match lifecycle ────────────────────────────────────────────────

  private onMatchState(state: MatchState): void {
    const active = ACTIVE_PHASES.has(state.phase);
    if (active && state.matchId) {
      if (this.session && this.session.matchId !== state.matchId) {
        // A new match started before the previous one's post-roll ended.
        this.stopSession('next match started', 0);
      }
      if (!this.session) this.startSession(state);
      return;
    }
    if (!active && this.session && !this.session.stopping && !this.session.stopTimer) {
      const reason = state.phase === 'postMatch' ? (state.endReason ?? 'ended') : state.phase;
      this.session.stopTimer = setTimeout(() => this.stopSession(reason, 0), POST_ROLL_MS);
    }
  }

  private startSession(state: MatchState): void {
    if (!this.available) return;
    const streams = this.getStreams().filter(s => s.enabled);
    if (streams.length === 0) return;
    const matchId = state.matchId!;
    const dir = this.matchDirectory(matchId);
    if (!dir) {
      console.warn(`Match recorder: refusing odd match id ${JSON.stringify(matchId)}`);
      return;
    }
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`Match recorder: cannot create ${dir}: ${(err as Error).message}`);
      return;
    }
    const teams = Object.entries(state.stationStates)
      .filter(([, s]) => s?.joined)
      .map(([station, s]) => ({ station, teamNumber: s?.teamNumber ?? null, alliance: s?.alliance ?? null }));
    const session: Session = {
      matchId,
      matchNumber: state.matchNumber,
      dir,
      startedAt: Date.now(),
      teams,
      jobs: streams.map(config => ({
        config,
        slug: slugify(config.name),
        proc: null,
        parts: [],
        reconnects: 0,
        startedAt: Date.now(),
        stderr: [],
      })),
      stopping: false,
    };
    // Two streams with the same slug would clobber each other's files.
    const seen = new Map<string, number>();
    for (const job of session.jobs) {
      const n = (seen.get(job.slug) ?? 0) + 1;
      seen.set(job.slug, n);
      if (n > 1) job.slug = `${job.slug}-${n}`;
    }
    this.session = session;
    this.writeManifest(session, []);
    console.log(
      `Match recording started: match ${state.matchNumber ?? '?'} (${matchId}) → ${session.jobs.map(j => j.config.name).join(', ')}`,
    );
    for (const job of session.jobs) this.spawnPart(session, job);
    this.statusTimer = setInterval(() => this.emit(), STATUS_INTERVAL_MS);
    this.emit();
  }

  private spawnPart(session: Session, job: StreamJob): void {
    if (session.stopping) return;
    if (job.parts.length >= MAX_PARTS) {
      job.error = `Source dropped ${job.parts.length} times; giving up for this match`;
      console.warn(`Match recording ${job.config.name}: ${job.error}`);
      return;
    }
    const part = join(session.dir, `${job.slug}.part${job.parts.length + 1}.mp4`);
    job.parts.push(part);
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      ...inputArgs(job.config.url),
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-f',
      'mp4',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      '-y',
      part,
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
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
      console.error(`Match recording ${job.config.name}: ${job.error}`);
    });
    proc.on('exit', (code, signal) => {
      if (job.proc !== proc) return;
      job.proc = null;
      if (session.stopping) return;
      // Died mid-match: remember why, then pick up again in a new part.
      const why = job.stderr.at(-1) ?? `exit ${code ?? signal}`;
      job.error = why;
      job.reconnects++;
      console.warn(`Match recording ${job.config.name} dropped (${why}); reconnecting`);
      job.respawnTimer = setTimeout(() => {
        job.respawnTimer = undefined;
        if (this.session === session && !session.stopping) this.spawnPart(session, job);
      }, RECONNECT_DELAY_MS);
      this.emit();
    });
  }

  private stopSession(reason: string, extraDelayMs: number): void {
    const session = this.session;
    if (!session || session.stopping) return;
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = undefined;
    }
    session.stopping = true;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    console.log(`Match recording stopping (${reason}): ${session.matchId}`);
    this.emit();
    setTimeout(() => {
      void this.finishSession(session).catch(err => {
        console.error(`Match recording finalize failed for ${session.matchId}:`, err);
      });
    }, extraDelayMs);
  }

  private async finishSession(session: Session): Promise<void> {
    await Promise.all(session.jobs.map(job => this.stopJob(job)));
    const endedAt = Date.now();
    const recordings: MatchRecording[] = [];
    for (const job of session.jobs) {
      recordings.push(await this.finalizeJob(session, job, endedAt));
    }
    this.writeManifest(session, recordings, endedAt);
    for (const rec of recordings) {
      this.lastStatus.set(rec.name, {
        name: rec.name,
        url: '',
        enabled: true,
        status: 'idle',
        bytes: rec.bytes,
        error: rec.status === 'failed' ? rec.error : undefined,
      });
    }
    if (this.session === session) this.session = null;
    const attached = this.historyStore?.setRecordings(session.matchId, recordings) ?? false;
    const summary = recordings.map(r => `${r.name}: ${r.status} ${(r.bytes / 1e6).toFixed(0)} MB`).join(', ');
    console.log(
      `Match recording finished for ${session.matchId} (${summary})${attached ? '' : ' — no history entry to attach to'}`,
    );
    void this.refreshDiskStats();
    this.emit();
  }

  private stopJob(job: StreamJob): Promise<void> {
    if (job.respawnTimer) {
      clearTimeout(job.respawnTimer);
      job.respawnTimer = undefined;
    }
    const proc = job.proc;
    if (!proc) return Promise.resolve();
    return new Promise(resolve => {
      const kill = setTimeout(() => {
        console.warn(`Match recording ${job.config.name}: ffmpeg ignored 'q', killing`);
        proc.kill('SIGKILL');
      }, STOP_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(kill);
        job.proc = null;
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

  /** Join the parts into one faststart MP4. Never throws — a failure keeps
   *  the raw parts and reports what happened. */
  private async finalizeJob(session: Session, job: StreamJob, endedAt: number): Promise<MatchRecording> {
    const parts = job.parts.filter(p => {
      try {
        return statSync(p).size > 0;
      } catch {
        return false;
      }
    });
    const base: MatchRecording = {
      name: job.config.name,
      file: `${job.slug}.mp4`,
      bytes: 0,
      startedAt: job.startedAt,
      endedAt,
      status: 'failed',
    };
    if (parts.length === 0) {
      return { ...base, error: job.error ?? 'No video was received from the source' };
    }
    const out = join(session.dir, `${job.slug}.mp4`);
    try {
      if (parts.length === 1) {
        await this.run(
          this.ffmpeg,
          ['-v', 'error', '-y', '-i', parts[0], '-c', 'copy', '-movflags', '+faststart', out],
          120_000,
        );
      } else {
        const list = join(session.dir, `${job.slug}.parts.txt`);
        writeFileSync(list, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
        await this.run(
          this.ffmpeg,
          ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out],
          180_000,
        );
        rmSync(list, { force: true });
      }
      for (const p of parts) rmSync(p, { force: true });
      for (const p of job.parts) rmSync(p, { force: true });
    } catch (err) {
      // Leave the fragmented capture in place and point at it — it still plays.
      const fallback = parts[0];
      console.error(
        `Match recording ${job.config.name}: remux failed (${(err as Error).message}); keeping ${fallback}`,
      );
      const size = statSync(fallback).size;
      return {
        ...base,
        file: fallback.slice(session.dir.length + 1),
        bytes: size,
        status: 'partial',
        error: `Could not join/remux: ${(err as Error).message}`,
      };
    }
    const bytes = statSync(out).size;
    const durationSeconds = await this.probeDuration(out);
    return {
      ...base,
      bytes,
      durationSeconds,
      status: job.reconnects > 0 ? 'partial' : 'ok',
      error: job.reconnects > 0 ? `Source dropped ${job.reconnects} time(s); parts joined` : undefined,
    };
  }

  private async probeDuration(file: string): Promise<number | undefined> {
    try {
      const out = await this.run(
        this.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
        15_000,
      );
      const n = Number.parseFloat(out.trim());
      return Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined;
    } catch {
      return undefined;
    }
  }

  private writeManifest(session: Session, recordings: MatchRecording[], endedAt?: number): void {
    const manifest: RecordingManifest = {
      matchId: session.matchId,
      matchNumber: session.matchNumber,
      startedAt: session.startedAt,
      endedAt,
      teams: session.teams,
      recordings,
    };
    try {
      writeFileSync(join(session.dir, 'recording.json'), JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.error(`Match recorder: cannot write manifest in ${session.dir}: ${(err as Error).message}`);
    }
  }

  // ── housekeeping ───────────────────────────────────────────────────

  private retentionDays(): number {
    const d = this.getRetentionDays();
    return d && d > 0 ? d : DEFAULT_RETENTION_DAYS;
  }

  /** Delete match directories older than the retention window. */
  sweep(): void {
    if (!existsSync(this.directory)) return;
    const cutoff = Date.now() - this.retentionDays() * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of readdirSync(this.directory)) {
      const dir = join(this.directory, name);
      if (this.session?.dir === dir) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
        const manifest = this.readManifest(name);
        const age = manifest?.endedAt ?? manifest?.startedAt ?? statSync(dir).mtimeMs;
        if (age < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch (err) {
        console.warn(`Match recorder sweep: ${dir}: ${(err as Error).message}`);
      }
    }
    if (removed > 0)
      console.log(`Match recorder: removed ${removed} recording(s) older than ${this.retentionDays()} days`);
    void this.refreshDiskStats();
  }

  private async refreshDiskStats(): Promise<void> {
    try {
      mkdirSync(this.directory, { recursive: true });
      const s = await statfs(this.directory);
      this.diskFreeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      this.diskFreeBytes = undefined;
    }
    try {
      let total = 0;
      for (const name of readdirSync(this.directory)) {
        const dir = join(this.directory, name);
        if (!statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) total += statSync(join(dir, f)).size;
      }
      this.usedBytes = total;
    } catch {
      this.usedBytes = undefined;
    }
  }

  private partBytes(job: StreamJob): number {
    let total = 0;
    for (const p of job.parts) {
      try {
        total += statSync(p).size;
      } catch {
        // part not written yet
      }
    }
    return total;
  }

  private emit(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in MatchRecorder listener:', err);
      }
    }
  }

  /** Run a command to completion, resolving with stdout. Rejects on non-zero
   *  exit (with the tail of stderr) or when it outlives `timeoutMs`. */
  private run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout?.on('data', d => (out += d));
      proc.stderr?.on('data', d => (err += d));
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      proc.on('error', e => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(err.trim().split('\n').slice(-3).join(' | ') || `exit code ${code}`));
      });
    });
  }
}
