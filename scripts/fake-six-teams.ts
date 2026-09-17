/**
 * Populate the production scoreboard with six fake robots for layout checks
 * (`bun x tsx scripts/fake-six-teams.ts [cleanup]`).
 *
 * Run ON the field server, in the repo working directory (it reads
 * active-config.json from the cwd and talks to the local backend). It:
 *   1. refuses to run if any station is already configured (someone is using
 *      the field) — cleanup mode only touches the six teams it configured;
 *   2. configures teams into slot1..slot6 over the backend WebSocket exactly
 *      like the control page does (sequentially — radioManager drops
 *      concurrent configure calls), waiting for each to land in
 *      active-config.json;
 *   3. streams plausible DS UDP telemetry (battery voltage wiggling around a
 *      per-team baseline, robot connected, disabled) for all six teams so the
 *      scoreboard's battery cards appear.
 *
 * Ctrl-C stops the telemetry; the station configs stay until `cleanup` is run
 * (or the nightly configuration-clearing cron wipes them at 6am).
 *
 * No match is created, no sounds fire — the scoreboard stays in idle freeplay.
 *
 * active-config.json is written even when the radio push fails, so a slot
 * appearing there doesn't prove the radio took it.
 */
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:9005/';
const UDP_HOST = '10.0.100.5';
const UDP_PORT = 1160;
const ACTIVE_CONFIG = 'active-config.json';
const SLOT_WAIT_MS = 90_000;
const SEND_INTERVAL_MS = 500;
const MAX_RUNTIME_MS = 20 * 60_000; // stop telemetry after 20 min in case we're forgotten

/** station → { team, base voltage } — voltages spread out like a real field */
const TEAMS: Record<string, { team: number; volts: number }> = {
  slot1: { team: 6962, volts: 12.2 },
  slot2: { team: 3049, volts: 12.6 },
  slot3: { team: 846, volts: 10.7 },
  slot4: { team: 5940, volts: 9.4 },
  slot5: { team: 9470, volts: 9.1 },
  slot6: { team: 1678, volts: 12.9 },
};
const SLOTS = Object.keys(TEAMS);

const cleanup = process.argv[2] === 'cleanup';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function readActiveConfig(): Record<string, { ssid?: string } | null> {
  try {
    return JSON.parse(readFileSync(ACTIVE_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

/** Last error the backend sent us — configureSlot treats any error arriving
 *  after its send as a failure (active-config.json is written even when the
 *  radio rejects a config, so disk state alone can't confirm success). */
let lastBackendError: string | null = null;

function openWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.error) lastBackendError = `${msg.error} ${msg.details ?? ''}`;
      } catch {
        /* state broadcasts — ignore */
      }
    });
  });
}

/** Configure one station and wait until active-config.json reflects it. */
/** Configure one station and wait until active-config.json reflects it.
 *
 *  Every commit pushes the WHOLE activeConfig to the radio, so while other
 *  slots still hold invalid configs (e.g. repairing after a bad run) the radio
 *  rejects intermediate pushes even though this slot's entry is fine. Callers
 *  pass strict=true on the final slot — that push contains only valid configs
 *  and must go through cleanly for radio and backend to agree. */
async function configureSlot(
  ws: WebSocket,
  station: string,
  ssid: string,
  wpaKey: string,
  strict: boolean,
): Promise<void> {
  lastBackendError = null;
  ws.send(JSON.stringify({ type: 'station', station, ssid, wpaKey }));
  const want = ssid || undefined;
  const deadline = Date.now() + SLOT_WAIT_MS;
  while (Date.now() < deadline) {
    const cfg = readActiveConfig();
    const got = cfg[station]?.ssid;
    if (got === want) {
      // Config landed on disk; give a rejected radio push a moment to surface
      await sleep(1500);
      if (lastBackendError) {
        if (strict) throw new Error(`${station}: ${lastBackendError}`);
        console.log(`  (radio push not clean yet: ${lastBackendError.trim()})`);
      }
      return;
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${station} to become ${want ?? '(cleared)'}`);
}

/** DS status byte: robotComms | radioPing | rioPing, disabled, teleOp mode. */
const STATUS_BYTE = 0x20 | 0x10 | 0x08;

function buildPacket(seq: number, team: number, volts: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(seq & 0xffff, 0);
  b.writeUInt8(0x01, 2); // comm version
  b.writeUInt8(STATUS_BYTE, 3);
  b.writeUInt16BE(team, 4);
  b.writeUInt16BE(Math.round(volts * 256), 6); // 8.8 fixed point
  return b;
}

async function main() {
  const initial = readActiveConfig();
  const configured = SLOTS.filter(s => initial[s]?.ssid);

  if (cleanup) {
    const ours = configured.filter(s => initial[s]?.ssid === String(TEAMS[s].team));
    const foreign = configured.filter(s => initial[s]?.ssid !== String(TEAMS[s].team));
    if (foreign.length) console.log(`leaving ${foreign.join(', ')} alone (not our teams)`);
    if (!ours.length) {
      console.log('nothing to clean up');
      return;
    }
    const ws = await openWs();
    for (const [i, station] of ours.entries()) {
      console.log(`clearing ${station}...`);
      await configureSlot(ws, station, '', '', i === ours.length - 1);
    }
    ws.close();
    console.log('cleanup done — active config restored');
    return;
  }

  // Refuse to clobber real teams — but slots already holding OUR fake teams
  // (e.g. from an earlier run) are fine to overwrite/repair.
  const foreign = configured.filter(s => initial[s]?.ssid !== String(TEAMS[s].team));
  if (foreign.length) {
    console.error(`refusing to run: stations already configured (${foreign.join(', ')}) — is someone using the field?`);
    process.exit(1);
  }

  const ws = await openWs();
  for (const [i, station] of SLOTS.entries()) {
    const { team } = TEAMS[station];
    console.log(`configuring ${station} → team ${team}...`);
    // Radio requires alphanumeric WPA keys; strict on the last slot only
    await configureSlot(ws, station, String(team), `practice${team}`, i === SLOTS.length - 1);
  }
  console.log('all six stations configured — starting telemetry');

  const sock = dgram.createSocket('udp4');
  let seq = 0;
  const phase: Record<string, number> = {};
  for (const s of SLOTS) phase[s] = Math.random() * Math.PI * 2;

  const timer = setInterval(() => {
    seq++;
    for (const station of SLOTS) {
      const { team, volts } = TEAMS[station];
      // Slow sine wander + jitter, with an occasional sag so the min-trace draws
      const wander = Math.sin(seq / 40 + phase[station]) * 0.25;
      const jitter = (Math.random() - 0.5) * 0.15;
      const sag = Math.random() < 0.02 ? -(0.5 + Math.random()) : 0;
      const v = Math.max(6, volts + wander + jitter + sag);
      sock.send(buildPacket(seq, team, v), UDP_PORT, UDP_HOST);
    }
  }, SEND_INTERVAL_MS);

  console.log(`telemetry streaming to ${UDP_HOST}:${UDP_PORT} — Ctrl-C to stop`);
  console.log(`(station configs remain; run with "cleanup" to clear them)`);

  const stop = () => {
    clearInterval(timer);
    sock.close();
    ws.close();
    console.log('\ntelemetry stopped — run with "cleanup" to clear the stations');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setTimeout(stop, MAX_RUNTIME_MS);
}

main().catch(err => {
  console.error('failed:', err);
  process.exit(1);
});
