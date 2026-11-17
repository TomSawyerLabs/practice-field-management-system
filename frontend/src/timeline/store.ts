/**
 * Everything the timeline chart can draw, kept per station, and the code
 * that fills it from the messages the server sends today. No React and no
 * socket in here (see live.ts for the wiring), so it can be tested.
 *
 * Each source keeps its own clock: the radio's status registers change about
 * once a second, robot telemetry arrives several times a second, and state
 * changes and field events arrive whenever they happen. Nothing is resampled
 * onto a common tick.
 */
import {
  StationNameList,
  type ConnectionQuality,
  type MatchPhase,
  type RadioReconfigureState,
  type RobotDropoutsState,
  type StationName,
  type StatusEntry,
  type TelemetryUpdate,
} from '../../../src/types';
import { EventSeries, NumericSeries, StateSeries, type EventTone } from './series';

/** How much history the page keeps. */
export const RETAIN_MS = 10 * 60_000;

/** Radio status is only re-sent when it changes, with a heartbeat every 15 s. */
const RADIO_STALE_MS = 20_000;
/** Robot and Driver Station telemetry: several a second while there is any. */
const TELEMETRY_STALE_MS = 3_000;
/** Battery readings come ≥4 a second; a longer silence is not joined up. */
const BATTERY_GAP_MS = 1_500;

export type WifiState = 'none' | 'unlinked' | 'linked' | ConnectionQuality;
/** How far the Driver Station reaches: nothing, the robot radio, the
 *  roboRIO, or the robot's code answering. */
export type CommsState = 'none' | 'radio' | 'rio' | 'robot';
export type RobotState = 'disabled' | 'auto' | 'teleop' | 'test' | 'util' | 'estop' | 'astop';

const ENABLED_STATES: readonly RobotState[] = ['auto', 'teleop', 'test', 'util'];
const MODE_LABEL: Record<string, string> = { auto: 'Auto', teleop: 'Teleop', test: 'Test', util: 'Utility' };

export const NUMERIC_KEYS = [
  'battery',
  'signalDbm',
  'noiseDbm',
  'rxRateMbps',
  'txRateMbps',
  'bandwidthMbps',
  'dataAgeMs',
  'rxPacketsPerSec',
  'txPacketsPerSec',
  'linkRttMs',
  'dsRttMs',
  'linkLossPct',
  'dsCpuPercent',
] as const;
export type NumericKey = (typeof NUMERIC_KEYS)[number];

const RADIO_KEYS: readonly NumericKey[] = [
  'signalDbm',
  'noiseDbm',
  'rxRateMbps',
  'txRateMbps',
  'bandwidthMbps',
  'dataAgeMs',
  'rxPacketsPerSec',
  'txPacketsPerSec',
];

function newNumeric(key: NumericKey): NumericSeries {
  if (RADIO_KEYS.includes(key)) return new NumericSeries({ mode: 'hold', staleAfterMs: RADIO_STALE_MS });
  if (key === 'battery') return new NumericSeries({ mode: 'linear', staleAfterMs: BATTERY_GAP_MS });
  return new NumericSeries({ mode: 'linear', staleAfterMs: TELEMETRY_STALE_MS });
}

/** A cumulative counter turned into a rate between the reports that moved it. */
class CounterRate {
  private count: number | null = null;
  private at = 0;

  /** Returns the rate per second once the counter has moved, else null. */
  note(t: number, count: number): number | null {
    if (this.count === null || count < this.count) {
      // First reading, or the counter restarted (the radio rebooted).
      this.count = count;
      this.at = t;
      return null;
    }
    if (count === this.count || t <= this.at) return null;
    const rate = ((count - this.count) / (t - this.at)) * 1000;
    this.count = count;
    this.at = t;
    return rate;
  }

  reset(): void {
    this.count = null;
  }
}

export class StationTracks {
  /** The robot (Wi-Fi name) these tracks describe. */
  ssid = '';
  readonly numeric = Object.fromEntries(NUMERIC_KEYS.map(k => [k, newNumeric(k)])) as Record<NumericKey, NumericSeries>;
  readonly wifi = new StateSeries<WifiState>({ staleAfterMs: RADIO_STALE_MS });
  readonly comms = new StateSeries<CommsState>({ staleAfterMs: TELEMETRY_STALE_MS });
  readonly robot = new StateSeries<RobotState>({ staleAfterMs: TELEMETRY_STALE_MS });
  readonly brownout = new StateSeries<boolean>({ staleAfterMs: TELEMETRY_STALE_MS });
  readonly events = new EventSeries();
  readonly rxPackets = new CounterRate();
  readonly txPackets = new CounterRate();

  clear(): void {
    for (const k of NUMERIC_KEYS) this.numeric[k].clear();
    this.wifi.clear();
    this.comms.clear();
    this.robot.clear();
    this.brownout.clear();
    this.events.clear();
    this.rxPackets.reset();
    this.txPackets.reset();
  }

  trim(before: number, now: number): void {
    for (const k of NUMERIC_KEYS) this.numeric[k].trimBefore(before);
    this.wifi.trimBefore(before);
    this.comms.trimBefore(before);
    this.robot.trimBefore(before);
    this.brownout.trimBefore(before);
    this.events.trimBefore(before, now);
  }
}

const PHASE_EVENT: Partial<Record<MatchPhase, { label: string; tone: EventTone }>> = {
  auto: { label: 'Auto', tone: 'neutral' },
  teleop: { label: 'Teleop', tone: 'neutral' },
  endgame: { label: 'Endgame', tone: 'neutral' },
  postMatch: { label: 'Match over', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'warning' },
  autoPause: { label: 'Paused', tone: 'warning' },
};

export class FieldTimeline {
  readonly stations = Object.fromEntries(StationNameList.map(s => [s, new StationTracks()])) as Record<
    StationName,
    StationTracks
  >;
  /** Things that happen to the whole field: Wi-Fi updates, match phases. */
  readonly field = new EventSeries();

  private lastStatusAt = -Infinity;
  private phase: MatchPhase | undefined;
  /** The field Wi-Fi update in progress, if any. */
  private reconfigure: { id: string; sawConfiguring: boolean } | null = null;
  private radioDownId: string | null = null;
  private nextId = 1;

  // ── Radio status ───────────────────────────────────────────────────

  /** The status history the server replays on connect, in any order. */
  ingestHistory(entries: readonly StatusEntry[]): void {
    for (const entry of [...entries].sort((a, b) => a.timestamp - b.timestamp)) this.ingestStatus(entry);
  }

  ingestStatus(entry: StatusEntry): void {
    const t = entry.timestamp;
    if (!Number.isFinite(t) || t <= this.lastStatusAt) return;
    this.lastStatusAt = t;

    const radio = entry.radioUpdate;
    if (!radio) {
      // The field radio is not answering: nothing is known about any link.
      if (!this.radioDownId) {
        this.radioDownId = `radioDown:${t}`;
        this.field.upsert({
          id: this.radioDownId,
          t,
          open: true,
          label: 'Field radio not answering',
          tone: 'critical',
        });
      }
      for (const station of StationNameList) {
        const tracks = this.stations[station];
        tracks.wifi.set(t, null);
        for (const k of RADIO_KEYS) tracks.numeric[k].gap(t);
      }
      return;
    }
    if (this.radioDownId) {
      this.field.close(this.radioDownId, t);
      this.radioDownId = null;
    }

    // A Wi-Fi update pFMS didn't announce still shows in the radio's status.
    if (radio.status === 'CONFIGURING') {
      if (!this.reconfigure) this.openReconfigure(`reconfigure:radio:${t}`, t);
      this.reconfigure!.sawConfiguring = true;
    } else if (radio.status === 'ACTIVE' && this.reconfigure?.sawConfiguring) {
      this.closeReconfigure(t);
    }

    for (const station of StationNameList) {
      const tracks = this.stations[station];
      const s = radio.stationStatuses[station];
      const ssid = s?.ssid ?? '';

      // A different robot on this station: the old tracks are not its story.
      // (A blank SSID in between — mid-update — keeps them.)
      if (ssid && tracks.ssid && ssid !== tracks.ssid) tracks.clear();
      if (ssid) tracks.ssid = ssid;

      const wifi: WifiState = !s || !ssid ? 'none' : !s.isLinked ? 'unlinked' : s.connectionQuality || 'linked';
      const before = tracks.wifi.set(t, wifi);
      if (before === 'unlinked' && wifi !== 'none') {
        this.stationEvent(tracks, t, 'Wi-Fi linked', 'good');
      } else if (wifi === 'unlinked' && before && before !== 'none') {
        this.stationEvent(tracks, t, 'Wi-Fi dropped', 'serious');
      }

      if (!s || !s.isLinked) {
        for (const k of RADIO_KEYS) tracks.numeric[k].gap(t);
        tracks.rxPackets.reset();
        tracks.txPackets.reset();
        continue;
      }

      const n = tracks.numeric;
      n.signalDbm.push(t, s.signalDbm);
      n.noiseDbm.push(t, s.noiseDbm);
      n.rxRateMbps.push(t, s.rxRateMbps);
      n.txRateMbps.push(t, s.txRateMbps);
      n.bandwidthMbps.push(t, s.bandwidthUsedMbps);
      n.dataAgeMs.push(t, s.dataAgeMs);
      const rx = tracks.rxPackets.note(t, s.rxPackets);
      if (rx !== null) n.rxPacketsPerSec.push(t, rx);
      const tx = tracks.txPackets.note(t, s.txPackets);
      if (tx !== null) n.txPacketsPerSec.push(t, tx);
    }
  }

  // ── Robot / Driver Station telemetry ───────────────────────────────

  ingestTelemetry(u: TelemetryUpdate): void {
    const tracks = this.stations[u.station];
    if (!tracks) return;
    const t = u.timestamp;
    const n = tracks.numeric;

    if (u.batteryVoltage !== undefined) n.battery.push(t, u.batteryVoltage, u.batteryVoltageMin);
    if (u.dsCpuPercent !== undefined) n.dsCpuPercent.push(t, u.dsCpuPercent);
    if (u.rttMs !== undefined) n.dsRttMs.push(t, u.rttMs);
    if (u.robotLinkRttMs !== undefined) n.linkRttMs.push(t, u.robotLinkRttMs);
    if (u.robotLinkLossPct !== undefined) n.linkLossPct.push(t, u.robotLinkLossPct);

    if (u.brownout !== undefined) {
      const before = tracks.brownout.set(t, u.brownout);
      if (u.brownout && before === false) this.stationEvent(tracks, t, 'Brownout', 'warning');
    }

    const ds = u.dsStatus;
    if (!ds) return;

    const comms: CommsState = ds.robotComms ? 'robot' : ds.rioPing ? 'rio' : ds.radioPing ? 'radio' : 'none';
    const commsBefore = tracks.comms.set(t, comms);
    if (commsBefore === 'robot') this.stationEvent(tracks, t, 'Comms lost', 'serious');
    else if (comms === 'robot' && commsBefore) this.stationEvent(tracks, t, 'Comms back', 'good');

    // What the robot is doing is only known while it answers — except a stop,
    // which the Driver Station holds whether or not the robot hears it.
    const robot: RobotState | null = ds.eStop
      ? 'estop'
      : ds.aStop
        ? 'astop'
        : !ds.robotComms
          ? null
          : !ds.enabled
            ? 'disabled'
            : ds.mode === 'auto'
              ? 'auto'
              : ds.mode === 'teleOp'
                ? 'teleop'
                : ds.mode === 'util'
                  ? 'util'
                  : 'test';
    const robotBefore = tracks.robot.set(t, robot);
    // `undefined`: no change. `null`: it wasn't known before, so this isn't
    // the moment it happened.
    if (robotBefore === undefined || robotBefore === null || robot === null) return;
    const wasEnabled = ENABLED_STATES.includes(robotBefore);
    if (robot === 'estop') this.stationEvent(tracks, t, 'E-Stop', 'critical', true);
    else if (robot === 'astop') this.stationEvent(tracks, t, 'A-Stop', 'warning', true);
    else if (robot === 'disabled') {
      if (wasEnabled) this.stationEvent(tracks, t, 'Disabled', 'neutral', true);
    } else if (!wasEnabled) this.stationEvent(tracks, t, 'Enabled', 'good', true, MODE_LABEL[robot]);
    else this.stationEvent(tracks, t, MODE_LABEL[robot], 'neutral');
  }

  // ── Field-wide ─────────────────────────────────────────────────────

  /** The match moved on. The server doesn't say when a phase began, so the
   *  moment it is first seen (`now`) stands in. */
  ingestMatchPhase(phase: MatchPhase, now: number): void {
    const previous = this.phase;
    this.phase = phase;
    if (previous === undefined || previous === phase) return;
    const event = PHASE_EVENT[phase];
    if (!event) return;
    this.field.upsert({ id: `phase:${this.nextId++}`, t: now, rule: true, ...event });
  }

  ingestReconfigure(state: RadioReconfigureState, now: number): void {
    if (state.active) {
      const since = state.since ?? now;
      const id = `reconfigure:${since}`;
      const changed = state.changes.length;
      const detail =
        changed === 0 ? 'Re-applying the same settings' : `${changed} station${changed === 1 ? '' : 's'} change`;
      let sawConfiguring = false;
      if (this.reconfigure && this.reconfigure.id !== id) {
        if (this.reconfigure.id.startsWith('reconfigure:radio:')) {
          // The radio's status showed it first; the server's start is the real one.
          sawConfiguring = this.reconfigure.sawConfiguring;
          this.field.remove(this.reconfigure.id);
          this.reconfigure = null;
        } else {
          this.closeReconfigure(since);
        }
      }
      this.openReconfigure(id, since, detail);
      if (sawConfiguring) this.reconfigure!.sawConfiguring = true;
    } else if (this.reconfigure) {
      this.closeReconfigure(now);
    }
  }

  ingestDropouts(state: RobotDropoutsState): void {
    for (const station of StationNameList) {
      const tracks = this.stations[station];
      for (const d of state.stations[station]?.dropouts ?? []) {
        const seconds = (d.durationMs / 1000).toFixed(1);
        const low = d.minBatteryVoltage !== undefined ? `, battery down to ${d.minBatteryVoltage.toFixed(1)} V` : '';
        tracks.events.upsert({
          id: `dropout:${d.startedAt}`,
          t: d.startedAt,
          end: d.endedAt,
          label: d.kind === 'robot' ? 'Robot stopped answering' : 'Laptop went quiet',
          detail: `${seconds} s${d.cause === 'brownout' ? ' during a brownout' : ''}${low}`,
          tone: 'serious',
          lane: 'comms',
        });
      }
    }
  }

  /** Drop what has scrolled out of reach. */
  trim(now: number): void {
    const before = now - RETAIN_MS;
    for (const station of StationNameList) this.stations[station].trim(before, now);
    this.field.trimBefore(before, now);
  }

  // ── helpers ────────────────────────────────────────────────────────

  private stationEvent(
    tracks: StationTracks,
    t: number,
    label: string,
    tone: EventTone,
    rule = false,
    detail?: string,
  ): void {
    tracks.events.upsert({ id: `e:${this.nextId++}`, t, label, tone, rule, detail });
  }

  private openReconfigure(id: string, t: number, detail?: string): void {
    this.field.upsert({ id, t, open: true, label: 'Field Wi-Fi update', detail, tone: 'warning', rule: true });
    this.reconfigure = { id, sawConfiguring: this.reconfigure?.id === id ? this.reconfigure.sawConfiguring : false };
  }

  private closeReconfigure(t: number): void {
    if (!this.reconfigure) return;
    this.field.close(this.reconfigure.id, t);
    this.reconfigure = null;
  }
}
