/**
 * End-to-end check of self-update (src/selfUpdate.ts, src/updateManager.ts,
 * src/updateRollback.ts) with real binaries, on a Linux box that is NOT a
 * field host (dry run, fake radio on 127.0.0.1, a local release feed signed
 * with a throwaway key).
 *
 * Build four binaries of the same commit that report different versions:
 *
 *   for v in upd0001 upd0002 upd0003 upd0004; do
 *     PFMS_BUILD_VERSION=$v bun scripts/build-binary.ts bun-linux-x64 &&
 *       mv release/pfms-linux-x64 /tmp/pfms-$v
 *   done
 *   bun scripts/test-self-update.ts /tmp/pfms-upd000{1,2,3,4}
 *
 * Scenarios, in order (about seven minutes):
 * 1. Run by hand (no systemd): A updates to B from the admin page; A hands
 *    over to B itself; B is confirmed after a minute.
 * 2. Under a supervisor that restarts it like systemd: C with a bad
 *    signature is refused and nothing changes.
 * 3. C installs but can't start (here: its port is taken) — after four
 *    starts it puts B back, and C is remembered as failed.
 * 4. Auto-update ("whenever idle", 0 min) installs D with nobody pressing
 *    anything, skipping C.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bins = process.argv.slice(2, 6);
if (bins.length !== 4 || process.platform !== 'linux') {
  console.error('usage (Linux): bun scripts/test-self-update.ts <binA> <binB> <binC> <binD>');
  process.exit(1);
}
const versionOf = (bin: string) => execFileSync(bin, ['--version'], { encoding: 'utf-8' }).trim().split(/\s+/)[0];
const [A, B, C, D] = bins.map(versionOf);
const fileOf = Object.fromEntries(bins.map((b, i) => [[A, B, C, D][i], b]));
const assetName = `pfms-linux-${process.arch}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const listen = (s: Server) =>
  new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ── Release feed ────────────────────────────────────────────────────
const good = generateKeyPairSync('ed25519');
const bad = generateKeyPairSync('ed25519');
type Offer = { version: string; key: KeyObject; createdAt: string };
let offers: Offer[] = [];
const sha = (v: string) => createHash('sha256').update(readFileSync(fileOf[v])).digest('hex');
const feed = createServer((req, res) => {
  const url = req.url ?? '';
  if (url === '/releases') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        offers.map((o, i) => ({
          tag_name: `build-20261013-${1000 + i}-${o.version}`,
          created_at: o.createdAt,
          body: `test build ${o.version}`,
          html_url: `${feedBase}/release/${o.version}`,
          assets: [assetName, 'SHA256SUMS', 'SHA256SUMS.sig'].map(name => ({
            name,
            browser_download_url: `${feedBase}/assets/${o.version}/${name}`,
            size: name === assetName ? readFileSync(fileOf[o.version]).length : 100,
          })),
        })),
      ),
    );
    return;
  }
  const m = url.match(/^\/assets\/([^/]+)\/(.+)$/);
  const offer = m && offers.find(o => o.version === m[1]);
  if (!m || !offer) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const sums = `${sha(offer.version)}  ${assetName}\n`;
  if (m[2] === assetName) res.end(readFileSync(fileOf[offer.version]));
  else if (m[2] === 'SHA256SUMS') res.end(sums);
  else res.end(sign(null, Buffer.from(sums), offer.key).toString('base64'));
});
const feedBase = `http://127.0.0.1:${await listen(feed)}`;
const offer = (version: string, key = good.privateKey) => {
  offers = [...offers.filter(o => o.version !== version), { version, key, createdAt: new Date().toISOString() }];
};

// ── Fake radio, and a port taken so build C can't start ─────────────
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
const radioUrl = `http://127.0.0.1:${await listen(radio)}`;
const blocker = createTcpServer();
const blockedPort = await new Promise<number>(r =>
  blocker.listen(0, '127.0.0.1', () => r((blocker.address() as { port: number }).port)),
);

// ── The install ─────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pfms-selfupdate-'));
const exe = join(dir, 'pfms');
const data = join(dir, 'data');
copyFileSync(fileOf[A], exe);
chmodSync(exe, 0o755);
await Bun.write(join(data, '.keep'), '');
const port = 39000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const env = (version: string, supervised: boolean): Record<string, string> => {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DRY_RUN: '1',
    RADIO_URL: radioUrl,
    WEBSOCKET_PORT: String(version === C ? blockedPort : port),
    VLAN_INTERFACE: '',
    PFMS_UPDATE_FEED: `${feedBase}/releases`,
    PFMS_UPDATE_PUBLIC_KEY: good.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  if (supervised) e.INVOCATION_ID = 'test-self-update';
  else delete e.INVOCATION_ID;
  return e;
};
const log: string[] = [];
const capture = (p: ChildProcess, tag: string) => {
  for (const s of [p.stdout, p.stderr]) {
    s?.setEncoding('utf-8');
    s?.on('data', (c: string) => log.push(...c.split('\n').map(l => `[${tag}] ${l}`)));
  }
};
const state = () => {
  try {
    return JSON.parse(readFileSync(join(data, 'self-update.json'), 'utf-8'));
  } catch {
    return {};
  }
};

async function health(): Promise<string | null> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as { version: string }).version : null;
  } catch {
    return null;
  }
}
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await cond()) return true;
  return false;
}

/** Open the admin WebSocket, send `messages`, and collect selfUpdate statuses. */
async function admin(messages: object[], waitFor: (s: any) => boolean, ms = 60_000): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const statuses: any[] = [];
  const errors: string[] = [];
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'selfUpdate') statuses.push(m);
    if (m.error) errors.push(`${m.error}${m.details ? `: ${m.details}` : ''}`);
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  for (const m of messages) ws.send(JSON.stringify(m));
  await until(() => statuses.some(waitFor) || errors.length > 0, ms);
  ws.close();
  return { status: statuses.findLast(waitFor) ?? statuses.at(-1), errors };
}

const cleanup: (() => void)[] = [];
try {
  // ── 1. By hand: A → B ─────────────────────────────────────────────
  offer(B);
  const byHand = spawn(exe, [], { cwd: data, env: env(A, false), stdio: ['ignore', 'pipe', 'pipe'] });
  capture(byHand, 'hand');
  check(`run by hand: ${A} up`, await until(async () => (await health()) === A, 60_000), log.slice(-5).join(' | '));
  const checked = await admin([{ type: 'selfUpdateCheck' }], s => s.latest?.version === B);
  check(`the admin page sees ${B} available`, checked.status?.latest?.version === B, JSON.stringify(checked));
  const applied = await admin([{ type: 'selfUpdateApply' }], s => s.activity?.stage === 'restarting', 120_000);
  check(
    'Update downloads, checks and restarts',
    applied.status?.activity?.stage === 'restarting',
    JSON.stringify(applied),
  );
  check(
    `A handed over to ${B} by itself`,
    await until(async () => (await health()) === B, 60_000),
    log.slice(-8).join(' | '),
  );
  check('the previous binary is kept as pfms.prev', versionOf(`${exe}.prev`) === A);
  check(
    `${B} confirmed after a minute up`,
    await until(() => state().lastUpdate?.to === B, 90_000),
    JSON.stringify(state()),
  );
  execFileSync('pkill', ['-f', exe]);
  await until(async () => (await health()) === null, 15_000);

  // ── Supervised from here: restart whenever it exits, like systemd ──
  let supervising = true;
  const starts: string[] = [];
  let child: ChildProcess | null = null;
  const supervise = (async () => {
    while (supervising) {
      const v = versionOf(exe);
      starts.push(v);
      child = spawn(exe, [], { cwd: data, env: env(v, true), stdio: ['ignore', 'pipe', 'pipe'] });
      capture(child, `sup:${v}`);
      await new Promise(r => child!.on('exit', r));
      await sleep(500);
    }
  })();
  cleanup.push(() => {
    supervising = false;
    child?.kill('SIGKILL');
  });
  check(`supervised: ${B} up`, await until(async () => (await health()) === B, 60_000));

  // ── 2. Bad signature ──────────────────────────────────────────────
  offer(C, bad.privateKey);
  await admin([{ type: 'selfUpdateCheck' }], s => s.latest?.version === C);
  const refused = await admin([{ type: 'selfUpdateApply' }], s => !!s.lastError, 60_000);
  check(
    'a build with a bad signature is refused',
    /signature/.test(refused.status?.lastError?.message ?? ''),
    JSON.stringify(refused),
  );
  check(`…and ${B} keeps running, untouched`, (await health()) === B && versionOf(exe) === B);
  check('…with no download left behind', !existsSync(`${exe}.download`));

  // ── 3. A build that can't start is rolled back ────────────────────
  offer(C);
  await admin([{ type: 'selfUpdateCheck' }], s => s.latest?.version === C && !s.lastError);
  const startsBefore = starts.length;
  await admin([{ type: 'selfUpdateApply' }], s => s.activity?.stage === 'restarting', 120_000);
  check(
    `${C} reverted to ${B}`,
    await until(async () => (await health()) === B && starts.length > startsBefore + 2, 120_000),
  );
  const cStarts = starts.slice(startsBefore).filter(v => v === C).length;
  check(`${C} was started 4 times before the revert (${cStarts})`, cStarts === 4, starts.join(','));
  check(
    `state says ${C} was reverted and skips it`,
    state().reverted?.to === C && state().skip?.includes(C),
    JSON.stringify(state()),
  );
  check('the failed binary is kept as pfms.failed', versionOf(`${exe}.failed`) === C);
  const after = await admin([], s => s.type === 'selfUpdate', 10_000);
  check('the admin page shows the revert', after.status?.reverted?.to === C, JSON.stringify(after.status));

  // ── 4. Auto-update when idle ──────────────────────────────────────
  offer(D);
  await admin(
    [{ type: 'updateSetupSettings', settings: { autoUpdate: { mode: 'idle', idleMinutes: 0 } } }],
    () => true,
    3_000,
  );
  check(
    `auto-update installs ${D} with nobody pressing Update`,
    await until(async () => (await health()) === D, 200_000),
    log
      .filter(l => /Auto-update|Installing|failed/.test(l))
      .slice(-5)
      .join(' | '),
  );
  check(`${D} confirmed`, await until(() => state().lastUpdate?.to === D, 90_000), JSON.stringify(state()));
  const unpacked = readdirSync(join(dir, '.pfms-assets'));
  check(`old unpacked bundles pruned (${unpacked.join(',')})`, unpacked.length <= 2 && unpacked.includes(D));
} finally {
  for (const f of cleanup) f();
  try {
    execFileSync('pkill', ['-f', exe]);
  } catch {}
  feed.close();
  radio.close();
  blocker.close();
  const errs = log.filter(l => /\b(TypeError|ReferenceError|Unhandled)\b/.test(l));
  check('no unexpected runtime errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  if (failures)
    console.log(
      log
        .filter(l => l.trim().length > 12)
        .slice(-60)
        .join('\n'),
    );
  rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
