/**
 * End-to-end check of the setup wizard's WebSocket contract
 * (`bun scripts/test-setup-ws.ts`).
 *
 * Needs a backend already running, e.g.:
 *   DRY_RUN=1 SETUP_CONFIG_FILE=setup-config.wstest.json bun src/index.ts
 *
 * Verifies the full loop the /setup page depends on: config state arrives on
 * connect, asking for a probe returns one, settings and step marks round-trip
 * back as new state, and everything lands on disk so a restart resumes.
 */
import WebSocket from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { SetupStepOrder, type SetupConfigState, type SetupProbeState } from '../src/types.js';

const PORT = process.env.WEBSOCKET_PORT ?? '3000';
const CONFIG_FILE = process.env.SETUP_CONFIG_FILE ?? 'setup-config.json';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const received: Record<string, unknown[]> = {};

ws.on('message', raw => {
  try {
    const msg = JSON.parse(String(raw)) as { type?: string };
    if (typeof msg.type === 'string') (received[msg.type] ??= []).push(msg);
  } catch {
    // Non-JSON frames aren't part of this contract
  }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const latest = <T>(type: string): T | undefined => received[type]?.at(-1) as T | undefined;

await new Promise<void>((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
await sleep(1000);

// ── On connect ──────────────────────────────────────────────────────
const initialConfig = latest<SetupConfigState>('setupConfigState');
check('setupConfigState pushed on connect', initialConfig !== undefined);
check('reports a next step', initialConfig?.nextStep === 'host', `got ${initialConfig?.nextStep}`);

// ── Probe on request ────────────────────────────────────────────────
ws.send(JSON.stringify({ type: 'requestSetupProbe' }));
await sleep(2500);
const probe = latest<SetupProbeState>('setupProbeState');
check('probe returned after request', probe !== undefined);
check('probe covers every step', probe?.steps.length === SetupStepOrder.length, `got ${probe?.steps.length}`);
check('probe reports the deployment step', probe?.steps.some(s => s.id === 'deployment') ?? false);

// ── Settings round-trip ─────────────────────────────────────────────
ws.send(JSON.stringify({ type: 'updateSetupSettings', settings: { deploymentMode: 'systemd' } }));
await sleep(800);
check(
  'settings round-trip back as new state',
  latest<SetupConfigState>('setupConfigState')?.config.settings.deploymentMode === 'systemd',
);

// A settings change re-runs the probe, so the deployment step should react.
await sleep(2000);
const afterProbe = latest<SetupProbeState>('setupProbeState');
const deploymentStep = afterProbe?.steps.find(s => s.id === 'deployment');
check(
  'probe re-ran and picked up the new setting',
  deploymentStep?.checks.some(c => c.detail.includes('systemd service')) ?? false,
);

// ── Step marking ────────────────────────────────────────────────────
ws.send(JSON.stringify({ type: 'markSetupStep', step: 'host', status: 'done' }));
await sleep(800);
const marked = latest<SetupConfigState>('setupConfigState');
check('step marked done', marked?.config.steps.host?.status === 'done');
check('advances to the next step', marked?.nextStep === 'admin', `got ${marked?.nextStep}`);

// ── Persisted to disk, so a restart resumes ─────────────────────────
check('config file written', existsSync(CONFIG_FILE));
if (existsSync(CONFIG_FILE)) {
  const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as SetupConfigState['config'];
  check('disk has the setting', onDisk.settings.deploymentMode === 'systemd');
  check('disk has the step status', onDisk.steps.host?.status === 'done');
}

ws.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
