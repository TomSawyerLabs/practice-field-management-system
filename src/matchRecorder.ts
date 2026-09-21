/**
 * MatchRecorder — a full video capture of every match, independent of the
 * score-review integration.
 *
 * Streams come from the admin panel (`recordingStreams` in SetupSettings):
 * anything ffmpeg can pull, typically the field's stitchd/MediaMTX RTSP
 * outputs. One ffmpeg per enabled stream starts as a pre-roll once the field
 * is startable (so the hold-to-start and countdown are captured) and stops a
 * few seconds after the match ends; a pre-roll whose match never starts is
 * discarded. Nothing is transcoded —
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { MatchEngine } from './matchEngine.js';
import type { MatchHistoryStore } from './matchHistoryStore.js';
import { METADATA_FILE, SCORES_CSV, TELEMETRY_CSV, type SessionMetadataCollector } from './sessionMetadata.js';
import type {
  MatchPhase,
  MatchRecording,
  MatchRecordingState,
  MatchRecordingStreamStatus,
  MatchState,
  RecordingInventoryEntry,
  RecordingInventoryFile,
  RecordingsInventory,
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
/** Metadata written beside the videos, listed to an admin when present. */
const SIDECAR_FILES = [METADATA_FILE, SCORES_CSV, TELEMETRY_CSV];
/** Phases in which robots have actually run — a session that never reaches
 *  one of these (hold released, countdown aborted) is discarded at the end. */
const PLAY_PHASES: ReadonlySet<MatchPhase> = new Set(['auto', 'autoPause', 'paused', 'teleop', 'endgame']);
/** Keep rolling this long after the match leaves its active phases, so the
 *  final buzzer and any post-match scoring action is on tape. */
const POST_ROLL_MS = 5000;
/** A pre-roll that was armed (everyone ready) but whose match never started
 *  is kept alive this long after the field stops being startable, then
 *  discarded — a re-ready within that window just keeps rolling. */
const PREROLL_ABANDON_MS = 20_000;
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
  /** Provisional (pre-roll) sessions have no match yet; `adopt` fills it in. */
  matchId: string | null;
  matchNumber?: number;
  dir: string;
  startedAt: number;
  teams: RecordingManifest['teams'];
  jobs: StreamJob[];
  stopping: boolean;
  stopTimer?: NodeJS.Timeout;
  /** Robots ran at some point — otherwise the files are discarded at the end. */
  sawPlay: boolean;
}

/** The field is one hold-to-start away from a match: check open, every
 *  joined team ready, every required staff role ready. This is when the
 *  pre-roll starts, so the hold, the countdown and the first seconds of
 *  auto are all on tape (ffmpeg needs a keyframe or two to get going). */
function isStartable(state: MatchState): boolean {
  if (state.phase !== 'created' || !state.readyRequested) return false;
  const joined = Object.values(state.stationStates).filter(s => s?.joined);
  if (joined.length === 0 || !joined.every(s => s?.ready)) return false;
  return Object.values(state.staffStates ?? {}).every(s => s.ignored || s.ready);
}

function teamsOf(state: MatchState): RecordingManifest['teams'] {
  return Object.entries(state.stationStates)
    .filter(([, s]) => s?.joined)
    .map(([station, s]) => ({ station, teamNumber: s?.teamNumber ?? null, alliance: s?.alliance ?? null }));
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

export function inputArgs(url: string): string[] {
  // Give up on a stalled source instead of hanging forever, so the reconnect
  // logic can kick in. The RTSP demuxer takes `-timeout` (µs) and REJECTS the
  // generic `-rw_timeout` ("Option rw_timeout not found" — ffprobe tolerates
  // it, ffmpeg 7.1 does not; that cost the first recorded match on
  // 2026-09-13). HTTP/other inputs take the generic protocol option.
  const args = isRtsp(url) ? ['-rtsp_transport', 'tcp', '-timeout', '10000000'] : ['-rw_timeout', '10000000'];
  return [...args, '-i', url];
}

export class MatchRecorder {
  private readonly directory: string;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly getStreams: () => RecordingStreamConfig[];
  private readonly getRetentionDays: () => number | undefined;
  private historyStore: MatchHistoryStore | null = null;
  private metadata: SessionMetadataCollector | null = null;
  private session: Session | null = null;
  private sweepListeners: (() => void)[] = [];
  /** Status of the last run per stream name, shown while idle. */
  private lastStatus = new Map<string, MatchRecordingStreamStatus>();
  private listeners: ((state: MatchRecordingState) => void)[] = [];
  private available = false;
  private unavailableReason?: string;
  private statusTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private diskFreeBytes?: number;
  private usedBytes?: number;
  /** Thumbnail generations in flight, keyed by the image path. */
  private thumbJobs = new Map<string, Promise<string | undefined>>();
  /** Thumbnails that could not be made, so we stop trying. */
  private thumbFailed = new Set<string>();

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

  /** Called after every retention sweep, so other indexes of the recordings
   *  directory (practice runs) can drop entries whose files are gone. */
  addSweepListener(fn: () => void): () => void {
    this.sweepListeners.push(fn);
    return () => {
      const i = this.sweepListeners.indexOf(fn);
      if (i >= 0) this.sweepListeners.splice(i, 1);
    };
  }

  /** Score events and telemetry get written next to each match's video. */
  setMetadataCollector(collector: SessionMetadataCollector): void {
    this.metadata = collector;
  }

  /** Absolute recordings root (matches and practice runs share it). */
  get recordingsDirectory(): string {
    return this.directory;
  }

  get ffmpegPath(): string {
    return this.ffmpeg;
  }

  get ffprobePath(): string {
    return this.ffprobe;
  }

  /** ffmpeg was found and works on this host. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Days recordings are kept (configured, or the default). */
  effectiveRetentionDays(): number {
    return this.retentionDays();
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
      activeMatchId: this.session?.matchId ?? undefined,
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

  /**
   * A poster frame for one recorded file, generated the first time anyone
   * asks and cached beside the video as `<slug>.thumb.jpg`. Resolves to the
   * image's path, or undefined when there is nothing to grab a frame from.
   *
   * Generated on demand rather than at record time: the end of a match is
   * the busiest moment this class has, and doing it here also gives every
   * recording made before thumbnails existed one for free.
   */
  async thumbnail(matchId: string, file: string): Promise<string | undefined> {
    const dir = this.matchDirectory(matchId);
    if (!dir || !isRecordingFileName(file)) return undefined;
    const source = join(dir, file);
    const out = join(dir, `${file.replace(/\.mp4$/, '')}.thumb.jpg`);
    if (existsSync(out)) return out;
    // Remember what could not be thumbnailed (no ffmpeg on this host, a
    // zero-byte capture): a table full of <img>s would otherwise spawn a
    // doomed ffmpeg per row, on every refresh.
    if (this.thumbFailed.has(out) || !existsSync(source)) return undefined;
    const running = this.thumbJobs.get(out);
    if (running) return running;
    // One generation per file at a time: a table of twenty rows loads twenty
    // <img>s at once, and ffmpeg writing the same path from twenty processes
    // would be a race with a corrupt JPEG at the end of it.
    const job = this.makeThumbnail(source, out)
      .then(path => {
        if (!path) this.thumbFailed.add(out);
        return path;
      })
      .finally(() => this.thumbJobs.delete(out));
    this.thumbJobs.set(out, job);
    return job;
  }

  private async makeThumbnail(source: string, out: string): Promise<string | undefined> {
    // Writing into the directory bumps its mtime, which the retention sweep
    // falls back on for directories with no manifest — so looking at an
    // orphaned `pending-*` in the admin table would keep resetting its age
    // and stop it ever being swept. Put the timestamps back afterwards.
    const dir = dirname(out);
    let dirTimes: { atime: Date; mtime: Date } | undefined;
    try {
      const st = statSync(dir);
      dirTimes = { atime: st.atime, mtime: st.mtime };
    } catch {
      // Gone already; nothing to preserve and ffmpeg will say so.
    }
    try {
      return await this.renderThumbnail(source, out);
    } finally {
      if (dirTimes) {
        try {
          utimesSync(dir, dirTimes.atime, dirTimes.mtime);
        } catch {
          // Best effort — at worst the directory looks newer than it is.
        }
      }
    }
  }

  private async renderThumbnail(source: string, out: string): Promise<string | undefined> {
    // Not frame 0: a match recording opens on the pre-roll, so its first
    // frame is an empty field during the countdown. A quarter of the way in
    // (capped) is far more likely to show a robot.
    const duration = await this.probeDuration(source);
    const seek = duration && duration > 8 ? Math.min(duration * 0.25, 30) : 0;
    for (const at of seek > 0 ? [seek, 0] : [0]) {
      try {
        await this.run(
          this.ffmpeg,
          // -ss before -i is a keyframe seek: fast, and past the end it just
          // writes nothing rather than failing, hence the existsSync check.
          [
            '-v',
            'error',
            '-nostdin',
            '-y',
            '-ss',
            at.toFixed(2),
            '-i',
            source,
            '-frames:v',
            '1',
            '-vf',
            'scale=320:-2',
            '-q:v',
            '5',
            out,
          ],
          30_000,
        );
        if (existsSync(out)) return out;
      } catch (err) {
        console.warn(`Match recorder: no thumbnail for ${source}: ${(err as Error).message}`);
        return undefined;
      }
    }
    return undefined;
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
    const session = this.session;
    if (active && state.matchId) {
      if (session && !session.stopping) {
        if (session.matchId === null) {
          this.adopt(session, state);
        } else if (session.matchId !== state.matchId) {
          // A new match started before the previous one's post-roll ended.
          this.stopSession('next match started', 0);
        } else if (session.stopTimer) {
          // Back into an active phase (e.g. resumed) before the post-roll fired.
          clearTimeout(session.stopTimer);
          session.stopTimer = undefined;
        }
      }
      if (!this.session) this.startSession(state, state.matchId);
      if (this.session && PLAY_PHASES.has(state.phase)) this.session.sawPlay = true;
      return;
    }

    // Not in a match. Either wind down the current session, keep a pre-roll
    // alive while the field is still startable, or arm a new pre-roll.
    if (session && !session.stopping) {
      const provisional = session.matchId === null;
      if (provisional && isStartable(state)) {
        if (session.stopTimer) {
          clearTimeout(session.stopTimer);
          session.stopTimer = undefined;
        }
        return;
      }
      if (!session.stopTimer) {
        const reason = provisional
          ? 'match never started'
          : state.phase === 'postMatch'
            ? (state.endReason ?? 'ended')
            : state.phase;
        session.stopTimer = setTimeout(
          () => this.stopSession(reason, 0),
          provisional ? PREROLL_ABANDON_MS : POST_ROLL_MS,
        );
      }
      return;
    }
    if (!session && isStartable(state)) this.startSession(state, null);
  }

  /** A pre-roll session's match has started: move its files under the match
   *  id and record what we now know. ffmpeg keeps writing through the rename
   *  (open file descriptors follow the directory). */
  private adopt(session: Session, state: MatchState): void {
    const matchId = state.matchId!;
    const newDir = this.matchDirectory(matchId);
    if (!newDir) return;
    try {
      renameSync(session.dir, newDir);
    } catch (err) {
      console.error(`Match recorder: could not move pre-roll ${session.dir} → ${newDir}: ${(err as Error).message}`);
      return;
    }
    for (const job of session.jobs) job.parts = job.parts.map(p => newDir + p.slice(session.dir.length));
    session.dir = newDir;
    session.matchId = matchId;
    session.matchNumber = state.matchNumber;
    session.teams = teamsOf(state);
    this.writeManifest(session, []);
    console.log(`Match recording continues as match ${state.matchNumber ?? '?'} (${matchId})`);
    this.emit();
  }

  private startSession(state: MatchState, matchId: string | null): void {
    if (!this.available) return;
    const streams = this.getStreams().filter(s => s.enabled);
    if (streams.length === 0) return;
    const dir = matchId ? this.matchDirectory(matchId) : join(this.directory, `pending-${Date.now()}`);
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
    const session: Session = {
      matchId,
      matchNumber: matchId ? state.matchNumber : undefined,
      dir,
      startedAt: Date.now(),
      teams: teamsOf(state),
      sawPlay: false,
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
    if (matchId) this.writeManifest(session, []);
    console.log(
      matchId
        ? `Match recording started: match ${state.matchNumber ?? '?'} (${matchId}) → ${session.jobs.map(j => j.config.name).join(', ')}`
        : `Match recording pre-roll started (field is startable) → ${session.jobs.map(j => j.config.name).join(', ')}`,
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
    // The session directory can be renamed (pre-roll adopt) or, in a rapid
    // start/abort burst, briefly not exist yet; make sure it is there before
    // ffmpeg opens its output (2026-09-13: "Error opening output files").
    try {
      mkdirSync(dirname(part), { recursive: true });
    } catch {
      // best effort; ffmpeg will report if it still can't open the file
    }
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
    if (session.matchId === null || !session.sawPlay) {
      // Nothing worth keeping: the hold was released, the countdown aborted,
      // or the field stopped being startable before anyone pressed start.
      rmSync(session.dir, { recursive: true, force: true });
      if (this.session === session) this.session = null;
      console.log(`Match recording discarded (${session.matchId ? 'match never ran' : 'match never started'})`);
      this.emit();
      return;
    }
    const matchId = session.matchId;
    const endedAt = Date.now();
    const recordings: MatchRecording[] = [];
    for (const job of session.jobs) {
      recordings.push(await this.finalizeJob(session, job, endedAt));
    }
    this.writeManifest(session, recordings, endedAt);
    this.metadata?.writeSidecars(session.dir, {
      kind: 'match',
      id: matchId,
      matchNumber: session.matchNumber,
      startedAt: session.startedAt,
      endedAt,
      teams: session.teams,
    });
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
    const attached = this.historyStore?.setRecordings(matchId, recordings) ?? false;
    const summary = recordings.map(r => `${r.name}: ${r.status} ${(r.bytes / 1e6).toFixed(0)} MB`).join(', ');
    console.log(
      `Match recording finished for ${matchId} (${summary})${attached ? '' : ' — no history entry to attach to'}`,
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
    // A reconnect only means the video has a GAP if the captured footage is
    // meaningfully shorter than the match. A sub-second blip that was joined
    // back seamlessly (e.g. the pre-roll directory rename) leaves a complete
    // recording, so don't cry "source dropped" over it — compare the captured
    // duration to how long the session actually ran.
    const sessionSeconds = (endedAt - session.startedAt) / 1000;
    const covered = durationSeconds !== undefined && durationSeconds >= sessionSeconds - 3;
    const hasGap = job.reconnects > 0 && !covered;
    return {
      ...base,
      bytes,
      durationSeconds,
      status: hasGap ? 'partial' : 'ok',
      error: hasGap
        ? `Source dropped ${job.reconnects} time(s); ~${Math.max(0, Math.round(sessionSeconds - (durationSeconds ?? 0)))}s missing`
        : undefined,
    };
  }

  private probeDuration(file: string): Promise<number | undefined> {
    return probeDuration(this.ffprobe, file);
  }

  private writeManifest(session: Session, recordings: MatchRecording[], endedAt?: number): void {
    if (session.matchId === null) return;
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

  // ── inventory & eviction (admin) ───────────────────────────────────

  /** Scan the recordings root: one entry per directory, with its size and
   *  what the manifest says about it. Cheap enough for on-demand use (a
   *  stat per file); not broadcast. */
  inventory(): RecordingsInventory {
    const entries: RecordingInventoryEntry[] = [];
    if (existsSync(this.directory)) {
      for (const name of readdirSync(this.directory)) {
        if (name.startsWith('.')) continue;
        const dir = join(this.directory, name);
        let bytes = 0;
        const sizes = new Map<string, number>();
        try {
          if (!statSync(dir).isDirectory()) continue;
          for (const f of readdirSync(dir)) {
            const st = statSync(join(dir, f));
            if (!st.isFile()) continue;
            bytes += st.size;
            sizes.set(f, st.size);
          }
        } catch {
          continue;
        }
        const manifest = this.readManifest(name);
        const teams = [...new Set((manifest?.teams ?? []).map(t => t.teamNumber).filter((n): n is number => !!n))];
        entries.push({
          id: name,
          kind: name.startsWith('practice-') ? 'practice' : manifest ? 'match' : 'other',
          matchNumber: manifest?.matchNumber,
          startedAt: manifest?.startedAt,
          endedAt: manifest?.endedAt,
          teams,
          bytes,
          videos: (manifest?.recordings ?? []).filter(r => r.status !== 'failed').length,
          files: listFiles(manifest?.recordings, sizes),
          sidecars: SIDECAR_FILES.filter(f => sizes.has(f)),
        });
      }
    }
    entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return {
      type: 'recordingsInventory',
      entries,
      usedBytes: this.usedBytes,
      diskFreeBytes: this.diskFreeBytes,
      retentionDays: this.retentionDays(),
      directory: this.directory,
      scannedAt: Date.now(),
    };
  }

  /** Delete one recording directory. The active session and the practice
   *  buffer are refused. Returns false when nothing was deleted. */
  deleteRecording(id: string): boolean {
    const dir = this.matchDirectory(id);
    if (!dir || id.startsWith('.') || this.session?.dir === dir || !existsSync(dir)) return false;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Match recorder: could not delete ${dir}: ${(err as Error).message}`);
      return false;
    }
    console.log(`Recording deleted by admin: ${id}`);
    this.afterDelete();
    return true;
  }

  /** Delete every recording whose manifest says it started before `before`
   *  (directories without a manifest go by mtime). Returns the count. */
  deleteRecordingsBefore(before: number): number {
    let removed = 0;
    for (const e of this.inventory().entries) {
      const started = e.startedAt ?? this.mtimeOf(e.id);
      if (started === undefined || started >= before) continue;
      const dir = this.matchDirectory(e.id);
      if (!dir || this.session?.dir === dir) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.warn(`Match recorder: could not delete ${dir}: ${(err as Error).message}`);
      }
    }
    if (removed > 0) {
      console.log(`Recordings deleted by admin: ${removed} older than ${new Date(before).toISOString()}`);
      this.afterDelete();
    }
    return removed;
  }

  private mtimeOf(id: string): number | undefined {
    try {
      return statSync(join(this.directory, id)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Disk stats and the other indexes (practice runs, match history) catch up. */
  private afterDelete(): void {
    void this.refreshDiskStats().then(() => this.emit());
    for (const fn of this.sweepListeners) {
      try {
        fn();
      } catch (err) {
        console.error('Error in MatchRecorder sweep listener:', err);
      }
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
      // The practice recorder's ring buffer lives here too and manages itself.
      if (name.startsWith('.')) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
        const manifest = this.readManifest(name);
        const age = manifest?.endedAt ?? manifest?.startedAt ?? statSync(dir).mtimeMs;
        // A pre-roll left behind by a crash is junk after an hour.
        const stalePreroll = name.startsWith('pending-') && Date.now() - age > 60 * 60 * 1000;
        if (age < cutoff || stalePreroll) {
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
    for (const fn of this.sweepListeners) {
      try {
        fn();
      } catch (err) {
        console.error('Error in MatchRecorder sweep listener:', err);
      }
    }
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
        for (const f of readdirSync(dir)) {
          const st = statSync(join(dir, f));
          if (st.isFile()) total += st.size;
        }
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

  private run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return runCommand(cmd, args, timeoutMs);
  }
}

/** A plain MP4 name inside a recording directory — no traversal, no
 *  sidecars. The same shape the video route accepts, so anything listed can
 *  also be fetched. Raw parts (`<slug>.part0.mp4`) pass: a failed remux
 *  leaves those as the only playable files. */
export function isRecordingFileName(file: string): boolean {
  return /^[A-Za-z0-9._-]{1,120}\.mp4$/.test(file) && !file.includes('..');
}

/** The videos an admin can open for one recording directory. The manifest
 *  names them when there is one (and keeps the failed ones, so the page can
 *  say a stream captured nothing); otherwise fall back to the MP4s actually
 *  on disk, which is all an interrupted recording leaves behind. */
function listFiles(recordings: MatchRecording[] | undefined, sizes: Map<string, number>): RecordingInventoryFile[] {
  if (recordings?.length) {
    return recordings.map(r => ({
      name: r.name,
      file: r.file,
      // On-disk size wins: the manifest's was right when it was written.
      bytes: sizes.get(r.file) ?? r.bytes,
      durationSeconds: r.durationSeconds,
      status: r.status,
      error: r.error,
    }));
  }
  return [...sizes.keys()]
    .filter(isRecordingFileName)
    .sort()
    .map(file => ({ name: file.replace(/\.mp4$/, ''), file, bytes: sizes.get(file) ?? 0, status: 'ok' as const }));
}

/** Run a command to completion, resolving with stdout. Rejects on non-zero
 *  exit (with the tail of stderr) or when it outlives `timeoutMs`. */
export function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
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

/** Media duration in seconds via ffprobe, or undefined when unreadable. */
export async function probeDuration(ffprobe: string, file: string): Promise<number | undefined> {
  try {
    const out = await runCommand(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      15_000,
    );
    const n = Number.parseFloat(out.trim());
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined;
  } catch {
    return undefined;
  }
}
