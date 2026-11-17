/**
 * Fake backend for eyeballing the timeline chart on the team page's Radio tab
 * (`bun scripts/fake-timeline.ts`, then vite, then open /1967-Elsa#radio).
 * Serves /ws on :3000 (or $PORT) — the vite dev proxy target. No radio, no
 * robots: everything is made up here.
 *
 * Team 1967 has two robots on the field (Elsa on slot1, Lupe on slot2) and a
 * 90 s story plays on a loop, so every kind of mark turns up:
 *
 *    8 s  Elsa enabled (teleop); the battery sags under load
 *   20 s  a brownout, and the robot stops answering for 1.4 s
 *   28 s  disabled
 *   34 s  a field Wi-Fi update: both links drop for 12 s
 *   55 s  a match: auto, teleop at 60 s
 *   70 s  E-Stop
 *   76 s  the laptop loses the robot, then the roboRIO
 *   84 s  everything back, e-stop cleared
 *
 * Like the real server it keeps the last ten minutes and sends them to a page
 * that subscribes to the `timeline` topic, so the chart opens filled in. It
 * starts with HISTORY seconds of the story already behind it (default 300;
 * HISTORY=0 to watch a chart fill from nothing). START_AT=<seconds> shifts
 * where in the story "now" is.
 */
import { WebSocketServer } from 'ws';
import { MatchEngine } from '../src/matchEngine.js';
import { FieldTimeline } from '../src/timeline/store.js';
import { payloadFor } from '../src/topicSubscriptions.js';
import { isSubscribeTopic, type MatchPhase, type StationName, type TelemetryUpdate } from '../src/types.js';

const PORT = Number(process.env.PORT ?? 3000);
const LOOP_S = 90;
const HISTORY_S = Number(process.env.HISTORY ?? 300);
const started = Date.now() - (HISTORY_S + Number(process.env.START_AT ?? 0)) * 1000;
/** Seconds into the current loop at wall-clock time `t`. */
const storyAt = (t: number) => ((((t - started) / 1000) % LOOP_S) + LOOP_S) % LOOP_S;
const between = (s: number, from: number, to: number) => s >= from && s < to;

const ROBOTS: Partial<Record<StationName, string>> = { slot1: '1967-Elsa', slot2: '1967-Lupe', slot4: '254' };
const engine = new MatchEngine(s => (ROBOTS[s] ? Number.parseInt(ROBOTS[s]!, 10) : null));

const reconfiguring = (s: number) => between(s, 34, 46);

/** Whole seconds Elsa has spent enabled so far, for counters that only count up. */
function enabledSeconds(t: number): number {
  const elapsed = (t - started) / 1000;
  const s = storyAt(t);
  const thisLoop = Math.min(Math.max(s - 8, 0), 20) + Math.min(Math.max(s - 55, 0), 15);
  return Math.floor(Math.floor(elapsed / LOOP_S) * 35 + thisLoop);
}

// ── Radio status: polled every 100 ms, registers move once a second ──

function stationDetails(station: StationName, t: number) {
  const ssid = ROBOTS[station];
  if (!ssid) return null;
  const s = storyAt(t);
  const second = Math.floor(t / 1000);
  // Each link comes back a little after the update finishes.
  const isLinked = !between(s, 34, station === 'slot1' ? 47 : 49);
  const far = station === 'slot2' ? 9 : 0;
  const wobble = Math.sin(second / 3 + (station === 'slot2' ? 2 : 0));
  const signalDbm = Math.round(-54 - far + wobble * 4 - (between(s, 62, 70) ? 14 : 0));
  const noiseDbm = Math.round(-95 + Math.sin(second / 7) * 2);
  const enabled = station === 'slot1' && (between(s, 8, 28) || between(s, 55, 70));
  return {
    ssid,
    hashedWpaKey: '',
    wpaKeySalt: '',
    isLinked,
    macAddress: isLinked ? '00:80:2F:AA:BB:0' + station.slice(-1) : '',
    dataAgeMs: isLinked ? Math.round(5 + (t % 1000) / 12) : 0,
    signalDbm: isLinked ? signalDbm : 0,
    noiseDbm: isLinked ? noiseDbm : 0,
    signalNoiseRatio: isLinked ? signalDbm - noiseDbm : 0,
    rxRateMbps: isLinked ? (signalDbm > -62 ? 144 : 86) : 0,
    rxPackets: isLinked ? second * 60 + enabledSeconds(t) * 180 : 0,
    rxBytes: 0,
    txRateMbps: isLinked ? (signalDbm > -62 ? 130 : 65) : 0,
    txPackets: isLinked ? second * 50 + enabledSeconds(t) * 70 : 0,
    txBytes: 0,
    bandwidthUsedMbps: isLinked ? Math.round((enabled ? 2.8 + wobble * 1.6 : 0.3 + wobble * 0.1) * 10) / 10 : 0,
    connectionQuality: !isLinked ? '' : signalDbm > -62 ? 'excellent' : signalDbm > -70 ? 'good' : 'caution',
  };
}

function statusEntry(t: number) {
  return {
    timestamp: t,
    radioUpdate: {
      channel: 5,
      channelBandwidth: '20MHz',
      redVlans: '10_20_30',
      blueVlans: '40_50_60',
      status: reconfiguring(storyAt(t)) ? 'CONFIGURING' : 'ACTIVE',
      stationStatuses: Object.fromEntries(
        (['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6'] as const).map(st => [st, stationDetails(st, t)]),
      ),
      syslogIpAddress: '10.0.100.40',
      version: 'fake',
    },
  };
}

// ── Telemetry: four a second per robot, as the server throttles it ──

function telemetry(station: StationName, t: number): TelemetryUpdate | null {
  const s = storyAt(t);
  const linked = stationDetails(station, t)?.isLinked;
  const elsa = station === 'slot1';
  // The laptop is wired to the field, so it keeps reporting when Wi-Fi drops.
  const radioPing = !!linked && !(elsa && between(s, 79, 84));
  const rioPing = radioPing && !(elsa && between(s, 78, 84));
  const robotComms = rioPing && !(elsa && (between(s, 20.6, 22) || between(s, 76, 84)));
  const eStop = elsa && between(s, 70, 84);
  const enabled = elsa && !eStop && (between(s, 8, 28) || between(s, 55, 70));
  const mode = elsa && between(s, 55, 60) ? 'auto' : 'teleOp';
  const brownout = elsa && between(s, 20, 20.8);
  const dsStatus = { eStop, aStop: false, robotComms, radioPing, rioPing, enabled, mode } as const;
  if (!robotComms) return { type: 'telemetry', station, timestamp: t, dsStatus };

  const rest = elsa ? 12.6 : 12.1;
  const load = enabled ? 1.1 + Math.sin(t / 700) * 0.6 + Math.random() * 0.3 : Math.random() * 0.05;
  const batteryVoltage = brownout ? 6.4 + Math.random() * 0.3 : rest - load;
  // What the server's 4 Hz summary of ~12 readings carries: under load the
  // voltage ripples, and now and then dips hard between two broadcasts.
  const ripple = enabled && !brownout ? 0.15 + Math.random() * 0.25 : 0;
  const dip = enabled && Math.random() < 0.25 ? 0.8 + Math.random() * 1.5 : 0;
  return {
    type: 'telemetry',
    station,
    timestamp: t,
    batteryVoltage,
    batteryVoltageMin: ripple || dip ? batteryVoltage - ripple - dip : undefined,
    batteryVoltageMax: ripple ? batteryVoltage + ripple : undefined,
    batteryVoltageAvg: ripple || dip ? batteryVoltage - dip / 12 : undefined,
    robotLinkRttMs: Math.round(4 + (elsa ? 0 : 3) + Math.random() * 3 + (elsa && between(s, 62, 70) ? 22 : 0)),
    robotLinkLossPct: elsa && between(s, 62, 70) ? Math.round(Math.random() * 12) : 0,
    rttMs: Math.round(7 + Math.random() * 4),
    dsCpuPercent: Math.round(30 + Math.sin(t / 5000) * 10),
    brownout,
    dsStatus,
  };
}

// ── Everything else ─────────────────────────────────────────────────

function phaseAt(s: number): MatchPhase {
  if (between(s, 52, 55)) return 'countdown';
  if (between(s, 55, 60)) return 'auto';
  if (between(s, 60, 70)) return 'teleop';
  if (between(s, 70, 74)) return 'postMatch';
  return 'idle';
}

function reconfigureState(t: number) {
  const s = storyAt(t);
  const active = reconfiguring(s);
  return {
    type: 'radioReconfigure',
    active,
    since: active ? t - (s - 34) * 1000 : undefined,
    expectedMs: 12_000,
    changes: active ? [{ station: 'slot4', from: '4321', to: '254' }] : [],
  };
}

/** The dropout of each loop so far: 1.4 s of nothing during the brownout. */
function dropoutsState(t: number) {
  const dropouts = [];
  for (let loop = Math.floor((t - started) / 1000 / LOOP_S); loop >= 0 && dropouts.length < 8; loop--) {
    const startedAt = started + (loop * LOOP_S + 20.6) * 1000;
    // The server only reports one a few seconds after it has ended.
    if (startedAt + 1400 + 3000 > t) continue;
    dropouts.unshift({
      kind: 'robot',
      cause: 'brownout',
      startedAt,
      endedAt: startedAt + 1400,
      durationMs: 1400,
      unanswered: 62,
      minBatteryVoltage: 6.4,
    });
  }
  return {
    type: 'robotDropouts',
    stations: dropouts.length
      ? { slot1: { team: 1967, since: started, dropouts, brownouts: { count: dropouts.length, minVoltage: 6.4 } } }
      : {},
  };
}

// ── One stream of messages, to the server's own copy and to every page ──

const timeline = new FieldTimeline();
let lastStatus = '';
let lastPhase: MatchPhase = 'idle';
let lastReconfigure = false;
let lastDropouts = '';
let tick = 0;
const lastDs = new Map<StationName, string>();

function statusChanged(station: StationName, update: TelemetryUpdate): boolean {
  const key = JSON.stringify([update.dsStatus, update.brownout]);
  if (lastDs.get(station) === key) return false;
  lastDs.set(station, key);
  return true;
}

/** Everything the server would broadcast in the 50 ms ending at `t`. */
function step(t: number, emit: (msg: unknown) => void): void {
  const s = storyAt(t);
  tick++;

  // Like the real poller: only a status that differs is sent on.
  const entry = statusEntry(t);
  const key = JSON.stringify(entry.radioUpdate);
  if (key !== lastStatus) {
    lastStatus = key;
    emit(entry);
  }
  // 4 Hz steady, and at once when a robot's status changes.
  for (const station of Object.keys(ROBOTS) as StationName[]) {
    const update = telemetry(station, t);
    if (update && (tick % 5 === 0 || statusChanged(station, update))) emit(update);
  }

  const phase = phaseAt(s);
  if (phase !== lastPhase) {
    lastPhase = phase;
    emit({ ...engine.getState(), phase });
  }
  if (reconfiguring(s) !== lastReconfigure) {
    lastReconfigure = reconfiguring(s);
    emit(reconfigureState(t));
  }
  const dropouts = JSON.stringify(dropoutsState(t));
  if (dropouts !== lastDropouts) {
    lastDropouts = dropouts;
    emit(JSON.parse(dropouts));
  }
}

// The story so far, as if the server had been up all along.
const startedAt = Date.now();
for (let t = started; t < startedAt; t += 50) step(t, msg => timeline.ingestMessage(msg, t));

const wss = new WebSocketServer({ port: PORT });
setInterval(() => {
  const t = Date.now();
  step(t, msg => {
    timeline.ingestMessage(msg, t);
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
  });
}, 50);
setInterval(() => timeline.trim(Date.now()), 5000);

wss.on('connection', ws => {
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));
  const now = Date.now();
  // 'unknown' keeps the page from reloading itself to match the server's build.
  send({ type: 'serverInfo', startTime: started, version: 'unknown', now });
  send({ ...engine.getState(), phase: phaseAt(storyAt(now)) });
  // The last minute of radio status, as the real server replays it.
  const history = [];
  for (let t = Math.max(started, now - 60_000); t < now; t += 500) history.push(statusEntry(t));
  send(history);
  send(reconfigureState(now));
  send(dropoutsState(now));

  ws.on('message', raw => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // The chart's history, for the team that asks (the only topic served here).
    if (isSubscribeTopic(msg) && msg.topic === 'timeline') {
      send(payloadFor('timeline', timeline.snapshot(Date.now()), msg.teams ?? null));
    }
  });
});
console.log(`fake timeline backend on :${PORT}, ${HISTORY_S} s of history`);
