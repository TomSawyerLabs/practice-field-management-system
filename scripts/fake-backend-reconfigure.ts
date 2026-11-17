/**
 * Minimal fake backend for eyeballing the radio reconfigure UI
 * (`ELAPSED_S=12 bun scripts/fake-backend-reconfigure.ts`): the team page's
 * banner and Radio tab callout, the status bar fill, and the scoreboard's
 * reconfigure screen. Serves /ws and /ws/scores on :3000 (the vite dev proxy
 * target) with a reconfigure that started ELAPSED_S seconds ago. No radio.
 */
import { WebSocketServer } from 'ws';
import { MatchEngine } from '../src/matchEngine.js';

const engine = new MatchEngine(s => (s === 'slot2' ? 1234 : s === 'slot5' ? 254 : null));
const station = (ssid: string, isLinked: boolean) => ({
  ssid,
  hashedWpaKey: '',
  wpaKeySalt: '',
  isLinked,
  macAddress: '',
  dataAgeMs: 0,
  signalDbm: -50,
  noiseDbm: -95,
  signalNoiseRatio: 45,
  rxRateMbps: 100,
  rxPackets: 0,
  rxBytes: 0,
  txRateMbps: 100,
  txPackets: 0,
  txBytes: 0,
  bandwidthUsedMbps: 0,
  connectionQuality: '',
});
const entry = (status: string, timestamp: number) => ({
  timestamp,
  radioUpdate: {
    channel: 5,
    channelBandwidth: '20MHz',
    redVlans: '10_20_30',
    blueVlans: '40_50_60',
    status,
    stationStatuses: {
      slot1: null,
      slot2: station('1234', status === 'ACTIVE'),
      slot3: null,
      slot4: null,
      slot5: status === 'ACTIVE' ? null : station('254', false),
      slot6: null,
    },
    syslogIpAddress: '10.0.100.40',
    version: 'fake',
  },
});

const ELAPSED = Number(process.env.ELAPSED_S ?? 12) * 1000;
const since = Date.now() - ELAPSED;
const reconfig = {
  type: 'radioReconfigure',
  active: true,
  since,
  expectedMs: 38_000,
  changes: [
    { station: 'slot1', to: '118' },
    { station: 'slot2', from: '4321', to: '1234' },
    { station: 'slot5', from: '254' },
  ],
};

const wss = new WebSocketServer({ port: 3000 });
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'serverInfo', startTime: since - 3_600_000, version: 'dev', now: Date.now() }));
  ws.send(JSON.stringify(engine.getState()));
  ws.send(JSON.stringify([entry('ACTIVE', since - 500), entry('CONFIGURING', since + 500)]));
  ws.send(JSON.stringify(reconfig));
  const t = setInterval(() => ws.send(JSON.stringify(entry('CONFIGURING', Date.now()))), 1000);
  ws.on('close', () => clearInterval(t));
});
console.log('fake backend on :3000');
