/**
 * Harness for RadioManager's config reconciliation, commit-queue isolation,
 * and station-preserving setSyslogIP (`DRY_RUN=1 bun
 * scripts/test-radio-reconcile.ts` — DRY_RUN lets it run on non-Linux). No
 * radio or root needed: spins a fake radio HTTP API on 127.0.0.1 and points a
 * real RadioManager at it (no radioManagementInterface, so no kernel calls).
 *
 * The fake mirrors observed VH-109 semantics (2026-07-24 incident): a
 * syslog-only /configuration POST wipes every station config; a
 * station-bearing POST replaces stations and preserves the syslog IP.
 *
 * Scenarios:
 *  1. Radio comes up empty while active-config has a team → automatic
 *     re-commit with no user action (startup-race incident replay).
 *  2. A commit whose POST returns 500 must not poison the queue — the next
 *     commit still reaches the radio.
 *  3. setSyslogIP with the IP the radio already reports → no POST at all
 *     (the every-deploy case that used to wipe the radio).
 *  4. setSyslogIP with a new IP → POST includes the active stations.
 *  5. Radio station config wiped mid-session → reconcile re-commits within
 *     the debounce window.
 *  6. setSyslogIP and a clear-all arriving while a commit is mid-reconfigure
 *     queue behind it — every push reaches the radio, none is dropped.
 */
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const activeConfigPath = join(tmpdir(), `test-reconcile-active-${process.pid}.json`);
const stagedConfigPath = join(tmpdir(), `test-reconcile-staged-${process.pid}.json`);
process.env.ACTIVE_CONFIG_FILE = activeConfigPath;
process.env.STAGED_CONFIG_FILE = stagedConfigPath;
process.env.RADIO_RECONCILE_DEBOUNCE_MS = '500';

writeFileSync(activeConfigPath, JSON.stringify({ slot1: { ssid: '8048-COMP', wpaKey: '80488048' } }));

const { default: RadioManager } = await import('../src/radioManager.js');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fake radio ───────────────────────────────────────────────────────
const RADIO_STATIONS = ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'] as const;
const stationDetails = (ssid: string) => ({
  ssid,
  hashedWpaKey: 'deadbeef',
  wpaKeySalt: 'salt',
  isLinked: false,
  macAddress: '',
  dataAgeMs: 0,
  signalDbm: -50,
  noiseDbm: -96,
  signalNoiseRatio: 46,
  rxRateMbps: 0,
  rxPackets: 0,
  rxBytes: 0,
  txRateMbps: 0,
  txPackets: 0,
  txBytes: 0,
  bandwidthUsedMbps: 0,
  connectionQuality: 'excellent',
});

let radioStatus: 'ACTIVE' | 'CONFIGURING' = 'ACTIVE';
let syslogIpAddress = '10.0.100.5';
let stationStatuses: Record<string, ReturnType<typeof stationDetails> | null> = Object.fromEntries(
  RADIO_STATIONS.map(s => [s, null]),
);
let fail500 = false;
const configPosts: any[] = [];

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        channel: 13,
        channelBandwidth: '40MHz',
        redVlans: '10_20_30',
        blueVlans: '40_50_60',
        status: radioStatus,
        stationStatuses,
        syslogIpAddress,
        version: 'VH-109_AP_PRACTICE_TEST',
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/configuration') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (fail500) {
        res.statusCode = 500;
        res.end('injected failure');
        return;
      }
      const config = JSON.parse(body);
      configPosts.push(config);
      radioStatus = 'CONFIGURING';
      setTimeout(() => {
        // Observed semantics: stations always replaced (syslog-only body
        // wipes them all); syslog IP only changes when the body carries one.
        stationStatuses = Object.fromEntries(
          RADIO_STATIONS.map(s => [
            s,
            config.stationConfigurations?.[s] ? stationDetails(config.stationConfigurations[s].ssid) : null,
          ]),
        );
        if (config.syslogIpAddress) syslogIpAddress = config.syslogIpAddress;
        radioStatus = 'ACTIVE';
      }, 300);
      res.end('{}');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
};

// ── Scenario 1: reconcile pushes to an empty radio on startup ────────
const radioManager = new RadioManager(`http://127.0.0.1:${port}`);

await sleep(2500); // connect ~100ms, debounce 500ms, fake configure 300ms

check(
  'empty radio reconciled from active config with no user action',
  configPosts.length === 1 && configPosts[0]?.stationConfigurations?.red1?.ssid === '8048-COMP',
  `posts=${configPosts.length} body=${JSON.stringify(configPosts[0] ?? null)}`,
);
check('radio reflects the team after reconcile', stationStatuses.red1?.ssid === '8048-COMP');

// ── Scenario 2: failed commit must not poison the queue ──────────────
fail500 = true;
const firstErr = await radioManager.commitConfiguration().then(
  () => null,
  (err: unknown) => err,
);
check('commit with radio 500 rejects', firstErr instanceof Error, String(firstErr));

fail500 = false;
const secondErr = await radioManager.commitConfiguration().then(
  () => null,
  (err: unknown) => err,
);
check('next commit succeeds after a failed one', secondErr === null, String(secondErr));
check('next commit actually reached the radio', configPosts.length === 2, `posts=${configPosts.length}`);

// ── Scenario 3: setSyslogIP no-ops when the radio already has the IP ─
await radioManager.setSyslogIP('10.0.100.5');
check('setSyslogIP with current IP does not POST', configPosts.length === 2, `posts=${configPosts.length}`);

// ── Scenario 4: setSyslogIP with a new IP keeps the stations ─────────
await radioManager.setSyslogIP('10.0.100.99');
const syslogPost = configPosts[2];
check(
  'setSyslogIP with new IP posts syslog AND active stations',
  configPosts.length === 3 &&
    syslogPost?.syslogIpAddress === '10.0.100.99' &&
    syslogPost?.stationConfigurations?.red1?.ssid === '8048-COMP',
  `posts=${configPosts.length} body=${JSON.stringify(syslogPost ?? null)}`,
);
await sleep(500); // let the fake finish CONFIGURING before the next scenario

// ── Scenario 5: mid-session wipe is detected and repaired ────────────
stationStatuses = Object.fromEntries(RADIO_STATIONS.map(s => [s, null]));
await sleep(2500); // debounce + reconcile commit + fake configure

check(
  'mid-session station wipe auto-repaired',
  configPosts.length === 4 && stationStatuses.red1?.ssid === '8048-COMP',
  `posts=${configPosts.length} red1=${JSON.stringify(stationStatuses.red1 ?? null)}`,
);

// ── Scenario 6: pushes that overlap a reconfigure queue, not drop ────
const before6 = configPosts.length;
const inFlight = radioManager.commitConfiguration();
await sleep(50); // the commit's POST is out; the radio is CONFIGURING
const overlapErrors: unknown[] = [];
const syslogDuring = radioManager.setSyslogIP('10.0.100.5').catch(err => overlapErrors.push(err));
const clearDuring = radioManager.clearAllConfigurations();
await Promise.all([inFlight, syslogDuring, clearDuring]);
await sleep(500);
check(
  'overlapping setSyslogIP and clear both reach the radio after the commit',
  configPosts.length === before6 + 3 && overlapErrors.length === 0,
  `posts=${configPosts.length - before6} errors=${overlapErrors.map(String).join('; ')}`,
);
check('the overlapping syslog push landed', syslogIpAddress === '10.0.100.5', syslogIpAddress);
check(
  'the clear landed last',
  Object.values(stationStatuses).every(s => s === null),
  JSON.stringify(stationStatuses.red1 ?? null),
);

// ── Cleanup ──────────────────────────────────────────────────────────
radioManager.stopPolling();
server.close();
rmSync(activeConfigPath, { force: true });
rmSync(stagedConfigPath, { force: true });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
