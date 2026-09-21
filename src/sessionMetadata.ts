/**
 * What was happening on the field while a video ran.
 *
 * Both recorders (matches and practice runs) know only a time window. This
 * collector keeps a rolling record of the last half hour of goal-sensor score
 * events and robot telemetry, and cuts the slice for a window into the
 * recording's directory as sidecars:
 *
 *   metadata.json   everything, machine-readable (RecordingMetadata)
 *   scores.csv      one row per ball the sensors reported
 *   telemetry.csv   one row per telemetry sample (battery, RTT, DS status …)
 *
 * Score events are kept by reference: the scoring engine re-judges an event
 * when the match timeline learns something new, and the sidecar is written
 * seconds after the window closes, so it sees the final verdict.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProcessedScoreEvent,
  RecordingActivity,
  RecordingMetadata,
  StationName,
  TelemetrySample,
  TelemetryUpdate,
} from './types.js';

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const PRUNE_EVERY = 500;

export const METADATA_FILE = 'metadata.json';
export const SCORES_CSV = 'scores.csv';
export const TELEMETRY_CSV = 'telemetry.csv';

export interface SessionMetadataOptions {
  getTeamForStation: (station: StationName) => number | undefined;
  /** How far back to remember, ms. A recording longer than this loses its start. */
  windowMs?: number;
  now?: () => number;
}

export class SessionMetadataCollector {
  private telemetry: TelemetrySample[] = [];
  private events: ProcessedScoreEvent[] = [];
  private sinceLastPrune = 0;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly getTeamForStation: (station: StationName) => number | undefined;

  constructor(opts: SessionMetadataOptions) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    this.getTeamForStation = opts.getTeamForStation;
  }

  onTelemetry(update: TelemetryUpdate): void {
    const sample: TelemetrySample = { t: update.timestamp, station: update.station };
    const team = this.getTeamForStation(update.station);
    if (team !== undefined) sample.teamNumber = team;
    if (update.batteryVoltage !== undefined) sample.batteryVoltage = update.batteryVoltage;
    if (update.batteryVoltageMin !== undefined) sample.batteryVoltageMin = update.batteryVoltageMin;
    if (update.rttMs !== undefined) sample.rttMs = update.rttMs;
    if (update.lostPackets !== undefined) sample.lostPackets = update.lostPackets;
    if (update.canUtil !== undefined) sample.canUtil = update.canUtil;
    if (update.dsCpuPercent !== undefined) sample.dsCpuPercent = update.dsCpuPercent;
    if (update.brownout !== undefined) sample.brownout = update.brownout;
    if (update.dsStatus) {
      sample.enabled = update.dsStatus.enabled;
      sample.mode = update.dsStatus.mode;
      sample.eStop = update.dsStatus.eStop;
      sample.aStop = update.dsStatus.aStop;
      sample.robotComms = update.dsStatus.robotComms;
    }
    this.telemetry.push(sample);
    this.maybePrune();
  }

  onScoreEvent(event: ProcessedScoreEvent): void {
    this.events.push(event);
    this.maybePrune();
  }

  /** Everything that happened between `startedAt` and `endedAt` (epoch ms). */
  slice(startedAt: number, endedAt: number): { scoreEvents: ProcessedScoreEvent[]; telemetry: TelemetrySample[] } {
    return {
      scoreEvents: this.events.filter(e => e.occurredAt >= startedAt && e.occurredAt <= endedAt),
      telemetry: this.telemetry.filter(s => s.t >= startedAt && s.t <= endedAt),
    };
  }

  /** Write the three sidecars for a window into `dir`. Returns false (and
   *  logs) when the directory can't be written; never throws. */
  writeSidecars(dir: string, meta: Omit<RecordingMetadata, 'version' | 'scoreEvents' | 'telemetry'>): boolean {
    const { scoreEvents, telemetry } = this.slice(meta.startedAt, meta.endedAt);
    const full: RecordingMetadata = { version: 1, ...meta, scoreEvents, telemetry };
    try {
      writeFileSync(join(dir, METADATA_FILE), JSON.stringify(full, null, 2));
      writeFileSync(join(dir, SCORES_CSV), scoresCsv(full));
      writeFileSync(join(dir, TELEMETRY_CSV), telemetryCsv(full));
      return true;
    } catch (err) {
      console.error(`Recording metadata: cannot write sidecars in ${dir}: ${(err as Error).message}`);
      return false;
    }
  }

  private maybePrune(): void {
    if (++this.sinceLastPrune < PRUNE_EVERY) return;
    this.sinceLastPrune = 0;
    const cutoff = this.now() - this.windowMs;
    this.telemetry = this.telemetry.filter(s => s.t >= cutoff);
    this.events = this.events.filter(e => e.occurredAt >= cutoff);
  }
}

/** Read a recording's `metadata.json`, or null when it has none. */
export function readMetadata(dir: string): RecordingMetadata | null {
  const file = join(dir, METADATA_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RecordingMetadata;
  } catch {
    return null;
  }
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** ISO timestamp plus seconds-into-the-recording, so a row can be found in the video. */
function timeCols(t: number, startedAt: number): [string, number] {
  return [new Date(t).toISOString(), Math.round((t - startedAt) / 100) / 10];
}

export function scoresCsv(meta: RecordingMetadata): string {
  return csv(
    [
      'time',
      'video_s',
      'alliance',
      'element',
      'count',
      'points',
      'awarded_to',
      'counted',
      'reason',
      'match_phase',
      'sub_period',
      'source',
      'lag_ms',
      'timing',
    ],
    meta.scoreEvents.map(e => {
      const reason = e.deduplicated
        ? 'deduplicated'
        : e.phaseRestricted
          ? 'phaseRestricted'
          : e.outsideMatch
            ? 'outsideMatch'
            : e.goalInactive
              ? 'goalInactive'
              : '';
      return [
        ...timeCols(e.occurredAt, meta.startedAt),
        e.alliance,
        e.element,
        e.count,
        e.count * e.pointValue,
        e.awardedTo,
        reason === '' ? 'yes' : 'no',
        reason,
        e.matchPhase,
        e.matchSubPeriod,
        e.source,
        e.lagMs,
        e.timing,
      ];
    }),
  );
}

export function telemetryCsv(meta: RecordingMetadata): string {
  return csv(
    [
      'time',
      'video_s',
      'station',
      'team',
      'battery_v',
      'battery_min_v',
      'rtt_ms',
      'lost_packets',
      'can_util_pct',
      'ds_cpu_pct',
      'brownout',
      'enabled',
      'mode',
      'estop',
      'astop',
      'robot_comms',
    ],
    meta.telemetry.map(s => [
      ...timeCols(s.t, meta.startedAt),
      s.station,
      s.teamNumber,
      s.batteryVoltage,
      s.batteryVoltageMin,
      s.rttMs,
      s.lostPackets,
      s.canUtil,
      s.dsCpuPercent,
      s.brownout,
      s.enabled,
      s.mode,
      s.eStop,
      s.aStop,
      s.robotComms,
    ]),
  );
}

/** Balls that counted per alliance, and one team's battery range, for a
 *  quick summary line without shipping the whole file to the page. */
export function summarizeMetadata(
  meta: RecordingMetadata,
  teamNumber?: number,
): { scored: { red: number; blue: number }; battery?: { min: number; max: number } } {
  const scored = { red: 0, blue: 0 };
  for (const e of meta.scoreEvents) {
    if (e.deduplicated || e.phaseRestricted || e.outsideMatch || e.goalInactive) continue;
    scored[e.awardedTo] += e.count;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const s of meta.telemetry) {
    if (teamNumber !== undefined && s.teamNumber !== teamNumber) continue;
    const lo = s.batteryVoltageMin ?? s.batteryVoltage;
    if (lo !== undefined) min = Math.min(min, lo);
    if (s.batteryVoltage !== undefined) max = Math.max(max, s.batteryVoltage);
  }
  return {
    scored,
    battery: Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined,
  };
}

/** Bin sizes we are willing to use, smallest first. */
const BIN_LADDER = [0.5, 1, 2, 5, 10, 15, 30, 60];
/** Enough resolution to see a burst, few enough to ship with the listing. */
const MAX_BINS = 120;
/** Enabled spans closer together than this are one span — telemetry is
 *  coalesced per station, so a single frame can blink the enabled bit. */
const SPAN_MERGE_SECONDS = 0.25;

/** A ball counted: the same test the score totals use. */
function counted(e: ProcessedScoreEvent): boolean {
  return !e.deduplicated && !e.phaseRestricted && !e.outsideMatch && !e.goalInactive;
}

/**
 * Where the action is inside a recording: balls per slice of video and the
 * spans in which `teamNumber`'s robot was enabled. Times are seconds from
 * the start of the video, so they line up with a player's scrub bar.
 */
export function activityFor(meta: RecordingMetadata, teamNumber?: number): RecordingActivity {
  const duration = Math.max(0, (meta.endedAt - meta.startedAt) / 1000);
  const binSeconds = BIN_LADDER.find(b => duration / b <= MAX_BINS) ?? BIN_LADDER[BIN_LADDER.length - 1];
  const bins = Math.max(1, Math.ceil(duration / binSeconds));
  const red = new Array<number>(bins).fill(0);
  const blue = new Array<number>(bins).fill(0);
  for (const e of meta.scoreEvents) {
    if (!counted(e)) continue;
    const t = (e.occurredAt - meta.startedAt) / 1000;
    if (t < 0 || t > duration) continue;
    const i = Math.min(bins - 1, Math.floor(t / binSeconds));
    (e.awardedTo === 'red' ? red : blue)[i] += e.count;
  }

  const samples = meta.telemetry
    .filter(s => s.enabled !== undefined && (teamNumber === undefined || s.teamNumber === teamNumber))
    .sort((a, b) => a.t - b.t);
  const enabled: { from: number; to: number }[] = [];
  const close = (from: number, to: number) => {
    const last = enabled[enabled.length - 1];
    if (last && from - last.to <= SPAN_MERGE_SECONDS) last.to = Math.max(last.to, to);
    else enabled.push({ from, to });
  };
  let openedAt: number | undefined;
  for (const s of samples) {
    const t = Math.min(duration, Math.max(0, (s.t - meta.startedAt) / 1000));
    if (s.enabled && openedAt === undefined) openedAt = t;
    else if (!s.enabled && openedAt !== undefined) {
      close(openedAt, t);
      openedAt = undefined;
    }
  }
  // Still enabled when the recording ended (the clip was cut mid-run).
  if (openedAt !== undefined) close(openedAt, duration);

  return { binSeconds, red, blue, enabled };
}
