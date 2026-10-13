/**
 * End-to-end check that a trunk interface chosen in the setup wizard takes
 * effect without a restart (`bun scripts/test-trunk-switch.ts`).
 *
 * Boots pFMS with DRY_RUN=1 against a fake radio on 127.0.0.1 — never the
 * field radio — in a fresh temp directory, then sets and clears the trunk
 * interface over the wizard's own WebSocket message and watches the log:
 * the field network is rebuilt on the new NIC, then stopped. DRY_RUN keeps
 * every host network change to a log line.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const repo = resolve(import.meta.dir, '..');

// ── Fake radio ──────────────────────────────────────────────────────
const stations = { red1: null, red2: null, red3: null, blue1: null, blue2: null, blue3: null };
// Like the real radio, a configuration POST puts it in CONFIGURING briefly.
let radioStatus: 'ACTIVE' | 'CONFIGURING' = 'ACTIVE';
const radio = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        channel: 13,
        channelBandwidth: '40MHz',
        redVlans: '10_20_30',
        blueVlans: '40_50_60',
        status: radioStatus,
        stationStatuses: stations,
        syslogIpAddress: '10.0.100.5',
        version: 'VH-113_AP_PRACTICE_FAKE',
      }),
    );
    return;
  }
  req.resume();
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/configuration') {
      radioStatus = 'CONFIGURING';
      setTimeout(() => (radioStatus = 'ACTIVE'), 1500);
    }
    res.end('{}');
  });
});
await new Promise<void>(r => radio.listen(0, '127.0.0.1', r));
const radioUrl = `http://127.0.0.1:${(radio.address() as { port: number }).port}`;

// ── pFMS, dry run, isolated ─────────────────────────────────────────
const cwd = mkdtempSync(join(tmpdir(), 'pfms-trunk-switch-'));
const port = 39000 + Math.floor(Math.random() * 900);
const log: string[] = [];
const pfms = spawn(process.execPath, [join(repo, 'src', 'index.ts')], {
  cwd,
  env: { ...process.env, DRY_RUN: '1', RADIO_URL: radioUrl, WEBSOCKET_PORT: String(port), VLAN_INTERFACE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [pfms.stdout, pfms.stderr]) {
  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => log.push(...chunk.split('\n')));
}

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};
const seen = (text: string) => log.some(l => l.includes(text));
async function until(text: string, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (seen(text)) return true;
  return false;
}

try {
  check('pFMS came up', await until(`Radio connected at ${radioUrl}`, 30_000), log.slice(-5).join(' | '));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  const save = (settings: Record<string, unknown>) =>
    ws.send(JSON.stringify({ type: 'updateSetupSettings', settings }));

  save({ vlanInterface: 'eth9' });
  check('choosing a trunk rebuilds the field network', await until('Trunk interface: none → eth9'));
  check('and it comes up on the new NIC', await until('Field network running on eth9'));
  check('without touching the host (dry run)', seen('[dry-run] Would'));

  save({ vlanInterface: 'eth7' });
  check('moving it tears down the old one', await until('Trunk interface: eth9 → eth7'));
  check('and brings up the new one', await until('Field network running on eth7'));

  save({ vlanInterface: null });
  check('clearing it stops the field network', await until('Field network stopped: no trunk interface is set'));
  check('no restart along the way', !seen('Restarting') && pfms.exitCode === null);
  ws.close();
} finally {
  pfms.kill();
  radio.close();
  await sleep(500);
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // Windows may hold a file a moment longer; it's a temp dir
  }
}

if (failures) {
  console.log('\nRelevant log lines:');
  for (const l of log) if (/trunk|field network|fail|error|configur/i.test(l)) console.log(`  ${l}`);
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
