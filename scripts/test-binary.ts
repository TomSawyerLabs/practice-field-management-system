/**
 * Boot a single-file pFMS binary (scripts/build-binary.ts) from an empty
 * directory and check it runs on its embedded files alone: /health reports
 * the expected version, the frontend, admin page, sounds and diag script are
 * served, the bundle (with the addon, on Linux) is unpacked beside it, a
 * stray .env is ignored, and SIGHUP exits cleanly. Run by CI before a build
 * is published.
 *
 * DRY_RUN=1 against a fake radio on 127.0.0.1 — never the field radio.
 *
 *   bun scripts/test-binary.ts release/pfms-linux-x64 <short-commit>
 */
import { spawn } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [src, expected] = process.argv.slice(2);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const radio = createServer((req, res) => {
  req.resume();
  req.on('end', () =>
    res.end(
      req.url === '/status'
        ? JSON.stringify({
            channel: 13,
            channelBandwidth: '40MHz',
            redVlans: '10_20_30',
            blueVlans: '40_50_60',
            status: 'ACTIVE',
            stationStatuses: { red1: null, red2: null, red3: null, blue1: null, blue2: null, blue3: null },
            syslogIpAddress: '10.0.100.5',
            version: 'VH-113_AP_PRACTICE_FAKE',
          })
        : '{}',
    ),
  );
});
await new Promise<void>(r => radio.listen(0, '127.0.0.1', r));
const radioUrl = `http://127.0.0.1:${(radio.address() as { port: number }).port}`;

const dir = mkdtempSync(join(tmpdir(), 'pfms-bin-'));
const bin = join(dir, process.platform === 'win32' ? 'pfms.exe' : 'pfms');
copyFileSync(src, bin);
chmodSync(bin, 0o755);
const data = join(dir, 'data');
await Bun.write(join(data, '.keep'), '');
// A stray .env must be ignored by the binary.
await Bun.write(join(data, '.env'), 'WEBSOCKET_PORT=1\n');
const port = 39000 + Math.floor(Math.random() * 900);
const log: string[] = [];
const p = spawn(bin, [], {
  cwd: data,
  env: { ...process.env, DRY_RUN: '1', RADIO_URL: radioUrl, WEBSOCKET_PORT: String(port), VLAN_INTERFACE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [p.stdout, p.stderr]) {
  s.setEncoding('utf-8');
  s.on('data', (c: string) => log.push(...c.split('\n')));
}
const exited = new Promise<number | null>(r => p.on('exit', code => r(code)));

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};
const base = `http://127.0.0.1:${port}`;
try {
  let health: { version?: string } | undefined;
  for (const end = Date.now() + 60_000; Date.now() < end && !health; await sleep(500)) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) health = await r.json();
    } catch {}
  }
  check(
    `/health answers with version ${expected} (stray .env ignored)`,
    health?.version === expected,
    JSON.stringify(health) + ' | ' + log.slice(-6).join(' | '),
  );
  const html = await (await fetch(`${base}/`)).text();
  check(
    'serves the embedded frontend',
    html.includes('<div id="root"') || html.includes('<script'),
    html.slice(0, 120),
  );
  const admin = await fetch(`${base}/admin.html`);
  check('serves admin.html', admin.ok);
  const sound = await fetch(`${base}/sounds/abort.wav`);
  const soundBytes = sound.ok ? (await sound.arrayBuffer()).byteLength : 0;
  check(`serves sounds (${soundBytes} bytes)`, soundBytes > 1000);
  const ps1 = await fetch(`${base}/api/diag/wifi.ps1`);
  check('serves the diag script', ps1.ok && (await ps1.text()).length > 100);
  const assetsBase = join(dir, '.pfms-assets');
  const versions = existsSync(assetsBase) ? readdirSync(assetsBase) : [];
  check(`unpacked beside the binary (${versions.join(',')})`, versions.includes(expected));
  if (process.platform === 'linux') {
    const addon = join(
      assetsBase,
      expected,
      'native/mdns-socket/prebuilt',
      `mdns-socket.linux-${process.arch}-gnu.node`,
    );
    check('addon unpacked', existsSync(addon));
  }
  if (process.platform !== 'win32') {
    p.kill('SIGHUP');
    const code = await Promise.race([exited, sleep(10_000).then(() => -1)]);
    check(`SIGHUP graceful exit (${code})`, code === 0);
  }
} finally {
  p.kill('SIGKILL');
  radio.close();
  const errs = log.filter(l => /\b(TypeError|ReferenceError|Unhandled|ENOENT|Cannot find)\b/.test(l));
  check('no runtime errors in the log', errs.length === 0, errs.slice(0, 5).join(' | '));
  // Windows keeps the executable locked until the process is gone.
  await Promise.race([exited, sleep(5_000)]);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`Left ${dir}: ${(err as Error).message}`);
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
