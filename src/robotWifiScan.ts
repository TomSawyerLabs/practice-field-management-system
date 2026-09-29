/**
 * Robot Wi-Fi scan: listen for the 2.4 GHz network a team's robot radio
 * broadcasts (`FRC-<team>` or `FRC-<team>-<suffix>`), compare it with the
 * robots the team has saved, and — when a team's robot is taking a while to
 * join the field — try the field's passphrase on it.
 *
 * The field connects to the robot on 6 GHz with the SSID `<team>[-suffix]`,
 * which pFMS cannot hear from outside the field AP. The 2.4 GHz network
 * carries the same name with `FRC-` in front, so it is the closest thing to
 * "what is this robot actually called". Teams most often get the
 * capitalization of the suffix wrong; that is the case this exists for.
 *
 * pFMS runs its own wpa_supplicant on one wireless interface (a spare card,
 * chosen on the admin page) and drives it with wpa_cli. Nothing else on the
 * host is touched. See plans/robot-wifi-scan.md.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  RobotWifiBroadcast,
  RobotWifiKeyCheck,
  RobotWifiScanState,
  RobotWifiStall,
  StationName,
  WifiSecurity,
  WifiTestJoinResult,
} from './types.js';
import { teamOfSsid } from './utils.js';

// ── Pure helpers ────────────────────────────────────────────────────

/** One row of `wpa_cli scan_results`. */
export interface ScanRow {
  bssid: string;
  frequency: number;
  signal: number;
  flags: string;
  ssid: string;
}

/** Parse `wpa_cli scan_results`: a header line, then tab-separated rows of
 *  bssid, frequency, signal level, flags, ssid. Hidden networks have an
 *  empty SSID and are dropped. */
export function parseScanResults(text: string): ScanRow[] {
  const rows: ScanRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 5 || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(parts[0])) continue;
    const [bssid, freq, signal, flags, ...rest] = parts;
    const ssid = rest.join('\t');
    if (!ssid) continue;
    rows.push({ bssid, frequency: Number(freq), signal: Number(signal), flags, ssid });
  }
  return rows;
}

/** A robot radio's 2.4 GHz network name. The `FRC-` prefix is written by the
 *  radio firmware; accept any case of it, but keep the rest verbatim. */
const ROBOT_SSID = /^FRC-(\d{1,5})(-.+)?$/i;

/** `FRC-1234-Comp` → team 1234, robot SSID `1234-Comp` (what the team saves
 *  and the field uses on 6 GHz). Null for anything else. */
export function robotOfBroadcast(ssid: string): { team: number; robotSsid: string } | null {
  const m = ROBOT_SSID.exec(ssid);
  if (!m) return null;
  const team = Number(m[1]);
  if (!team) return null;
  return { team, robotSsid: `${m[1]}${m[2] ?? ''}` };
}

export type BroadcastMatch = RobotWifiBroadcast['match'];

/** Compare a broadcast robot SSID with the team's saved robots. An exact
 *  match wins over one that only differs in capitalization. */
export function matchSavedRobot(robotSsid: string, savedSsids: readonly string[]): BroadcastMatch {
  if (savedSsids.includes(robotSsid)) return { kind: 'exact', savedSsid: robotSsid };
  const lower = robotSsid.toLowerCase();
  const caseOnly = savedSsids.find(s => s.toLowerCase() === lower);
  if (caseOnly) return { kind: 'caseOnly', savedSsid: caseOnly };
  return { kind: 'unknown' };
}

/** What a line of wpa_supplicant's own output says about a join attempt. */
export type WpaEvent =
  | { type: 'connected'; bssid?: string }
  | { type: 'wrongKey' }
  | { type: 'authFailed'; reason: string };

export function parseWpaEvent(line: string): WpaEvent | null {
  if (line.includes('CTRL-EVENT-CONNECTED')) {
    // "… CTRL-EVENT-CONNECTED - Connection to aa:bb:cc:dd:ee:01 completed …"
    const bssid = /Connection to ([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(line)?.[1];
    return bssid ? { type: 'connected', bssid } : { type: 'connected' };
  }
  if (line.includes('pre-shared key may be incorrect')) return { type: 'wrongKey' };
  const temp = /CTRL-EVENT-SSID-TEMP-DISABLED .*reason=(\S+)/.exec(line);
  if (temp) return temp[1] === 'WRONG_KEY' ? { type: 'wrongKey' } : { type: 'authFailed', reason: temp[1] };
  return null;
}

/** How to join a network, from its scan flags. PSK where offered (the
 *  plainest failure path), SAE otherwise, and nothing to check if open. */
export function keyMgmtFor(flags: string): WifiSecurity {
  if (/PSK/.test(flags)) return 'WPA-PSK';
  if (/SAE/.test(flags)) return 'SAE';
  if (!/WPA|RSN|WEP/.test(flags)) return 'open';
  return 'WPA-PSK';
}

/** Wireless interfaces on this host (Linux: anything with a `wireless` or
 *  `phy80211` entry under /sys/class/net). Empty elsewhere. */
export function listWirelessInterfaces(sysNet = '/sys/class/net', os: string = platform()): string[] {
  if (os !== 'linux' || !existsSync(sysNet)) return [];
  return readdirSync(sysNet).filter(
    i => existsSync(join(sysNet, i, 'wireless')) || existsSync(join(sysNet, i, 'phy80211')),
  );
}

/** An SSID as wpa_cli takes it unquoted: hex bytes. Any SSID survives this
 *  — quotes, backslashes, non-ASCII — where a quoted string would not. */
export function ssidHex(ssid: string): string {
  return Buffer.from(ssid, 'utf8').toString('hex');
}

/** The WPA2 pre-shared key for a passphrase (PBKDF2-SHA1, 4096 rounds, SSID
 *  as salt), as the 64 hex digits wpa_cli takes unquoted — so a passphrase
 *  never has to be quoted onto a command line. */
export function pskHex(passphrase: string, ssid: string): string {
  return pbkdf2Sync(passphrase, Buffer.from(ssid, 'utf8'), 4096, 32, 'sha1').toString('hex');
}

/** Why a join cannot be attempted as asked, or null if it can. */
export function joinProblem(ssid: string, security: WifiSecurity, passphrase: string | undefined): string | null {
  const bytes = Buffer.byteLength(ssid, 'utf8');
  if (bytes < 1 || bytes > 32) return 'An SSID is 1 to 32 bytes';
  if (security === 'open') return null;
  if (!passphrase) return 'This network needs a passphrase';
  if (!/^[\x20-\x7e]{8,63}$/.test(passphrase)) return 'A passphrase is 8 to 63 printable ASCII characters';
  // SAE takes the passphrase itself, quoted — refuse what would break out.
  if (security === 'SAE' && /["\\]/.test(passphrase))
    return 'This network uses WPA3 (SAE); its passphrase cannot contain " or \\ here';
  return null;
}

export type Cli = (...args: string[]) => Promise<string>;
/** Route wpa_supplicant's events to a handler (null to stop). */
export type Listen = (handler: ((e: WpaEvent) => void) | null) => void;

export interface JoinOutcome {
  outcome: 'connected' | 'wrongKey' | 'failed' | 'timeout';
  /** wpa_supplicant's reason, for `failed` */
  reason?: string;
  /** The access point it associated with, when connected */
  bssid?: string;
  /** From asking to join to the answer (connected, refused, …) */
  ms?: number;
}

/** Join a network once, report how it went, and leave: the network is
 *  removed afterwards and nothing is retried. Association only — no DHCP,
 *  no address. The caller has checked joinProblem() first. */
export async function attemptJoin(
  cli: Cli,
  listen: Listen,
  target: { ssid: string; security: WifiSecurity; passphrase?: string },
  timeoutMs: number,
): Promise<JoinOutcome> {
  let id: string | null = null;
  try {
    id = (await cli('add_network')).trim();
    if (!/^\d+$/.test(id)) throw new Error(`add_network answered ${id}`);
    const set = async (...args: string[]) => {
      const out = (await cli('set_network', id!, ...args)).trim();
      if (out !== 'OK') throw new Error(`set_network ${args[0]} answered ${out}`);
    };
    await set('ssid', ssidHex(target.ssid));
    if (target.security === 'open') {
      await set('key_mgmt', 'NONE');
    } else if (target.security === 'SAE') {
      await set('key_mgmt', 'SAE');
      await set('ieee80211w', '2');
      await set('sae_password', `"${target.passphrase}"`);
    } else {
      await set('key_mgmt', 'WPA-PSK');
      await set('psk', pskHex(target.passphrase!, target.ssid));
    }
    await set('scan_ssid', '1');

    const asked = Date.now();
    return await new Promise<JoinOutcome>(resolve => {
      let done = false;
      // The answer is all we came for: stop listening and leave at once
      // (the finally below disconnects before anything else runs).
      const finish = (r: JoinOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        clearInterval(poll);
        listen(null);
        resolve(r.outcome === 'timeout' ? r : { ...r, ms: Date.now() - asked });
      };
      const timeout = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
      listen(e => {
        if (e.type === 'connected') finish({ outcome: 'connected', ...(e.bssid && { bssid: e.bssid }) });
        else if (e.type === 'wrongKey') finish({ outcome: 'wrongKey' });
        else finish({ outcome: 'failed', reason: e.reason });
      });
      // Belt and braces: if an event line is missed, the state still says it.
      const poll = setInterval(() => {
        cli('status')
          .then(out => {
            if (/^wpa_state=COMPLETED$/m.test(out))
              finish({ outcome: 'connected', bssid: /^bssid=(\S+)$/m.exec(out)?.[1] });
          })
          .catch(() => {});
      }, 1000);
      cli('select_network', id!).catch(err => finish({ outcome: 'failed', reason: String(err?.message ?? err) }));
    });
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    // Leave straight away — disconnect first, then forget the network so
    // wpa_supplicant never retries it. No lingering association.
    await cli('disconnect').catch(() => {});
    if (id !== null && /^\d+$/.test(id)) await cli('remove_network', id).catch(() => {});
  }
}

/** A staff test join, minus the bookkeeping: scan every band for the SSID,
 *  pick its strongest access point, and try it. */
export async function testJoin(
  cli: Cli,
  listen: Listen,
  request: { ssid: string; passphrase?: string },
  opts: { settleMs: number; timeoutMs: number },
): Promise<Omit<WifiTestJoinResult, 'id' | 'iface' | 'at'>> {
  const started = Date.now();
  let answer = (await cli('scan')).trim();
  if (answer === 'FAIL-BUSY') {
    await new Promise(r => setTimeout(r, opts.settleMs));
    answer = (await cli('scan')).trim();
  }
  await new Promise(r => setTimeout(r, opts.settleMs));
  const heard = parseScanResults(await cli('scan_results'))
    .filter(r => r.ssid === request.ssid)
    .sort((a, b) => b.signal - a.signal)[0];
  if (!heard) return { ssid: request.ssid, outcome: 'notFound', durationMs: Date.now() - started };

  const security = keyMgmtFor(heard.flags);
  const seen = { ssid: request.ssid, bssid: heard.bssid, frequency: heard.frequency, signal: heard.signal, security };
  const problem = joinProblem(request.ssid, security, request.passphrase);
  if (problem) {
    const outcome = security !== 'open' && !request.passphrase ? 'needsPassphrase' : 'failed';
    return { ...seen, outcome, detail: problem, durationMs: Date.now() - started };
  }
  const r = await attemptJoin(
    cli,
    listen,
    { ssid: request.ssid, security, passphrase: request.passphrase },
    opts.timeoutMs,
  );
  return {
    ...seen,
    ...(r.bssid && { bssid: r.bssid }),
    ...(r.ms !== undefined && { joinMs: r.ms }),
    outcome: r.outcome,
    ...(r.reason && { detail: r.reason }),
    durationMs: Date.now() - started,
  };
}

// ── Driving wpa_supplicant ──────────────────────────────────────────

/** Keep IPv6 autoconfiguration off a card pFMS is joining networks on: with
 *  `accept_ra`/`autoconf` on (the default), a router advertisement heard
 *  during a brief test join would give the card an address — even a default
 *  route — that outlives the connection. IPv6 itself stays on (link-local
 *  only). Returns a function that puts the old values back. `procRoot` is
 *  for tests. */
export function holdIpv6Autoconf(iface: string, procRoot = '/proc'): () => void {
  const dir = join(procRoot, 'sys/net/ipv6/conf', iface);
  const saved: [string, string][] = [];
  for (const key of ['accept_ra', 'autoconf']) {
    const path = join(dir, key);
    try {
      const was = readFileSync(path, 'utf8').trim();
      if (was !== '0') {
        writeFileSync(path, '0');
        saved.push([path, was]);
      }
    } catch (err) {
      console.warn(`Could not turn off IPv6 ${key} on ${iface}:`, err instanceof Error ? err.message : err);
    }
  }
  return () => {
    for (const [path, was] of saved) {
      try {
        writeFileSync(path, was);
      } catch {
        // the card may have gone (USB); nothing to put back then
      }
    }
  };
}

/** What the scanner needs from the host. Swapped for a fake in tests. */
export interface WifiRunner {
  /** Start wpa_supplicant on the interface. Resolves once wpa_cli answers. */
  start(onLine: (line: string) => void, onExit: (why: string) => void): Promise<void>;
  /** Run one wpa_cli command, returning its output. */
  cli(...args: string[]): Promise<string>;
  stop(): void;
}

const CTRL_DIR = '/run/pfms-wifi';

/** The real thing: a private wpa_supplicant in the foreground, its output
 *  line-buffered (glibc block-buffers a pipe otherwise), plus wpa_cli. */
export class WpaSupplicantRunner implements WifiRunner {
  private child: ChildProcess | null = null;
  private restoreIpv6: (() => void) | null = null;

  constructor(private readonly iface: string) {}

  async start(onLine: (line: string) => void, onExit: (why: string) => void): Promise<void> {
    if (platform() !== 'linux') throw new Error('the robot Wi-Fi scan needs Linux (wpa_supplicant)');
    if (!listWirelessInterfaces().includes(this.iface))
      throw new Error(`${this.iface} is not a wireless interface here`);
    mkdirSync(CTRL_DIR, { recursive: true });
    this.restoreIpv6 ??= holdIpv6Autoconf(this.iface);
    // A socket left by a previous run (crash, kill -9) stops wpa_supplicant starting.
    rmSync(join(CTRL_DIR, this.iface), { force: true });
    const conf = join(CTRL_DIR, 'wpa_supplicant.conf');
    // Forget networks not seen in two scans, so a robot that leaves drops out.
    writeFileSync(
      conf,
      `ctrl_interface=${CTRL_DIR}\nupdate_config=0\nbss_expiration_age=60\nbss_expiration_scan_count=2\n`,
    );
    const child = spawn('stdbuf', ['-oL', '-eL', 'wpa_supplicant', '-i', this.iface, '-D', 'nl80211', '-c', conf], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', onLine);
    }
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      onExit(signal ? `wpa_supplicant stopped (${signal})` : `wpa_supplicant exited with code ${code}`);
    });
    child.on('error', err => onExit(`could not start wpa_supplicant: ${err.message}`));

    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (!this.child) throw new Error('wpa_supplicant exited during startup');
      if ((await this.cli('ping').catch(() => '')).trim() === 'PONG') return;
    }
    this.stop();
    throw new Error('wpa_supplicant did not answer on its control socket');
  }

  cli(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('wpa_cli', ['-p', CTRL_DIR, '-i', this.iface, ...args], { timeout: 5000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.restoreIpv6?.();
    this.restoreIpv6 = null;
  }
}

// ── The scanner ─────────────────────────────────────────────────────

/** A station the field is trying to connect a robot on. */
export interface ConnectAttempt {
  station: StationName;
  /** The SSID the field is set up to join (the station's active config) */
  ssid: string;
  /** Its passphrase. Never leaves the server. */
  wpaKey: string;
  /** Epoch ms it has been trying since: the latest of the team taking the
   *  station, the radio going ACTIVE, and the robot last being linked. */
  since: number;
  /** The robot radio is linked right now */
  linked: boolean;
}

/** How long a robot may take to join before it counts as stalled. A healthy
 *  robot links well inside this once the radio is up. */
export const STALL_MS = 60_000;

type Heard = Pick<RobotWifiBroadcast, 'ssid' | 'team' | 'robotSsid' | 'signal'>;

export interface Stall {
  attempt: ConnectAttempt;
  broadcast: Heard;
  match: RobotWifiStall['broadcast']['match'];
}

/** Connect attempts that have stalled while the team's robot network is on
 *  the air, each with the network to test against: the one named like the
 *  field's SSID (exactly, then ignoring capitals), else the team's
 *  strongest. Attempts with nothing heard for the team give nothing. */
export function findStalls(attempts: ConnectAttempt[], heard: Heard[], now: number, stallMs = STALL_MS): Stall[] {
  const stalls: Stall[] = [];
  for (const attempt of attempts) {
    if (attempt.linked || now - attempt.since < stallMs) continue;
    const team = teamOfSsid(attempt.ssid);
    const mine = heard.filter(h => h.team === team).sort((a, b) => b.signal - a.signal);
    const exact = mine.find(h => h.robotSsid === attempt.ssid);
    const caseOnly = mine.find(h => h.robotSsid.toLowerCase() === attempt.ssid.toLowerCase());
    const broadcast = exact ?? caseOnly ?? mine[0];
    if (!broadcast) continue;
    stalls.push({ attempt, broadcast, match: exact ? 'exact' : caseOnly ? 'caseOnly' : 'otherName' });
  }
  return stalls;
}

/** 2.4 GHz channels 1–13 and 14: robot radios only broadcast there. */
const SCAN_FREQS = [2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, 2467, 2472, 2484].join(',');

export interface RobotWifiScannerOptions {
  iface: string;
  runner: WifiRunner;
  /** SSIDs of the robots teams have saved, for name matching */
  savedSsids: () => string[];
  /** Stations the field is trying to connect robots on */
  connectAttempts: () => ConnectAttempt[];
  onChange: (state: RobotWifiScanState) => void;
  now?: () => number;
  scanIntervalMs?: number;
  /** How long after a scan to read its results. */
  scanSettleMs?: number;
  /** A network not seen for this long drops off the list. */
  expireMs?: number;
  /** How long a join attempt may take before it counts as unreachable. */
  keyCheckTimeoutMs?: number;
  /** How long a robot may take to join before it counts as stalled. */
  stallMs?: number;
  /** Minimum gap between tests of one station ("Test connection"). */
  testMinGapMs?: number;
}

type Seen = RobotWifiBroadcast & { flags: string };

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

export class RobotWifiScanner {
  private readonly o: Required<Omit<RobotWifiScannerOptions, 'now'>> & { now: () => number };
  private status: RobotWifiScanState['status'] = 'off';
  private error: string | undefined;
  private lastScanAt: number | undefined;
  private seen = new Map<string, Omit<Seen, 'match'>>();
  /** Results by `${broadcastSsid}\n${hash of the field's key}` — a changed
   *  passphrase is a new test; an unchanged one is not re-run by itself. */
  private keyChecks = new Map<string, RobotWifiKeyCheck>();
  /** Stations whose team pressed "Test connection", waiting for the radio */
  private asked = new Set<StationName>();
  private checking: string | null = null;
  private pendingEvents: ((e: WpaEvent) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  get iface(): string {
    return this.o.iface;
  }

  constructor(options: RobotWifiScannerOptions) {
    this.o = {
      now: Date.now,
      scanIntervalMs: 20_000,
      scanSettleMs: 5_000,
      expireMs: 90_000,
      keyCheckTimeoutMs: 20_000,
      stallMs: STALL_MS,
      testMinGapMs: 30_000,
      ...options,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus('starting');
    try {
      await this.o.runner.start(
        line => this.onLine(line),
        why => {
          if (this.stopped) return;
          this.error = why;
          this.setStatus('error');
          this.clearTimer();
        },
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setStatus('error');
      return;
    }
    if (this.stopped) return;
    this.error = undefined;
    this.setStatus('running');
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), this.o.scanIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.o.runner.stop();
    this.seen.clear();
    this.setStatus('off');
  }

  private clearTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setStatus(status: RobotWifiScanState['status']) {
    this.status = status;
    this.emit();
  }

  private emit() {
    this.o.onChange(this.getState());
  }

  private onLine(line: string) {
    const event = parseWpaEvent(line);
    if (event) this.pendingEvents?.(event);
  }

  /** One scan: trigger it, give the card time to hop the channels, read the
   *  results, then test any stalled connection that is due one. */
  async scanOnce(): Promise<void> {
    if (this.status !== 'running' || this.checking) return; // a join attempt owns the radio
    try {
      await this.o.runner.cli('scan', `freq=${SCAN_FREQS}`);
      await new Promise(r => setTimeout(r, this.o.scanSettleMs));
      if (this.status !== 'running') return;
      this.ingest(parseScanResults(await this.o.runner.cli('scan_results')));
    } catch (err) {
      console.warn('Robot Wi-Fi scan failed:', err instanceof Error ? err.message : err);
      return;
    }
    await this.checkNextKey();
  }

  /** Fold a scan into what has been seen, dropping networks gone quiet. */
  ingest(rows: ScanRow[]): void {
    const now = this.o.now();
    this.lastScanAt = now;
    for (const row of rows) {
      const robot = robotOfBroadcast(row.ssid);
      if (!robot) continue;
      const prev = this.seen.get(row.ssid);
      // Several BSSIDs can carry one name; keep the strongest from this scan.
      if (prev && prev.lastSeen === now && prev.signal >= row.signal) continue;
      this.seen.set(row.ssid, {
        ssid: row.ssid,
        team: robot.team,
        robotSsid: robot.robotSsid,
        signal: row.signal,
        frequency: row.frequency,
        lastSeen: now,
        flags: row.flags,
      });
    }
    for (const [ssid, s] of this.seen) if (now - s.lastSeen > this.o.expireMs) this.seen.delete(ssid);
    this.emit();
  }

  private stalls(): Stall[] {
    return findStalls(this.o.connectAttempts(), [...this.seen.values()], this.o.now(), this.o.stallMs);
  }

  private checkId(st: Stall): string {
    return `${st.broadcast.ssid}\n${keyHash(st.attempt.wpaKey)}`;
  }

  /** Test one stalled connection, if one is due: first any a team asked
   *  for, then any not yet tested whose robot is named like the field
   *  expects (capitals aside). One at a time — the radio also scans. */
  async checkNextKey(): Promise<void> {
    if (this.checking || this.status !== 'running') return;
    const stalls = this.stalls();
    for (const station of this.asked)
      if (!stalls.some(st => st.attempt.station === station)) this.asked.delete(station);
    const next =
      stalls.find(st => this.asked.has(st.attempt.station)) ??
      stalls.find(st => st.match !== 'otherName' && !this.keyChecks.has(this.checkId(st)));
    if (!next) return;
    this.asked.delete(next.attempt.station);
    await this.runKeyCheck(next);
    if (this.asked.size) void this.checkNextKey();
  }

  /** "Test connection" for a stalled station: try the field's passphrase
   *  now. Rate-limited, so a button cannot hammer a robot. */
  test(station: StationName): void {
    const st = this.stalls().find(s => s.attempt.station === station);
    if (!st) return;
    const prev = this.keyChecks.get(this.checkId(st));
    if (prev && (prev.result === 'checking' || this.o.now() - prev.at < this.o.testMinGapMs)) return;
    this.asked.add(station);
    void this.checkNextKey();
  }

  private async runKeyCheck(st: Stall): Promise<void> {
    const id = this.checkId(st);
    const seen = this.seen.get(st.broadcast.ssid);
    if (!seen) return;
    const { ssid: fieldSsid, wpaKey } = st.attempt;
    const security = keyMgmtFor(seen.flags);
    if (security === 'open') {
      this.keyChecks.set(id, { result: 'open', at: this.o.now(), fieldSsid });
      this.emit();
      return;
    }
    if (joinProblem(seen.ssid, security, wpaKey)) return;

    this.checking = seen.ssid;
    this.keyChecks.set(id, { result: 'checking', at: this.o.now(), fieldSsid });
    this.emit();
    let result: RobotWifiKeyCheck['result'];
    try {
      const r = await attemptJoin(
        this.o.runner.cli.bind(this.o.runner),
        h => (this.pendingEvents = h),
        { ssid: seen.ssid, security, passphrase: wpaKey },
        this.o.keyCheckTimeoutMs,
      );
      if (r.outcome === 'failed') console.warn(`Robot Wi-Fi passphrase check for ${seen.ssid} failed: ${r.reason}`);
      result = r.outcome === 'connected' ? 'ok' : r.outcome === 'wrongKey' ? 'wrongKey' : 'unreachable';
    } finally {
      this.checking = null;
    }
    console.log(
      `Robot Wi-Fi passphrase check: ${st.attempt.station} set up for ${fieldSsid}, stalled; ` +
        `field passphrase on ${seen.ssid}: ${result}`,
    );
    this.keyChecks.set(id, { result, at: this.o.now(), fieldSsid });
    this.emit();
  }

  /** A staff test join through this scan's wpa_supplicant. The scan pauses
   *  for it (and it waits for a passphrase check already under way). */
  async testJoin(
    request: { ssid: string; passphrase?: string },
    opts: { settleMs: number; timeoutMs: number },
  ): Promise<Omit<WifiTestJoinResult, 'id' | 'iface' | 'at'>> {
    if (this.status !== 'running') throw new Error(`the robot scan on ${this.o.iface} is not running`);
    for (let i = 0; this.checking && i < 60; i++) await new Promise(r => setTimeout(r, 500));
    if (this.checking) throw new Error(`${this.o.iface} is busy`);
    this.checking = `test:${request.ssid}`;
    try {
      return await testJoin(this.o.runner.cli.bind(this.o.runner), h => (this.pendingEvents = h), request, opts);
    } finally {
      this.checking = null;
    }
  }

  getState(): RobotWifiScanState {
    const savedSsids = this.o.savedSsids();
    const broadcasts: RobotWifiBroadcast[] = [...this.seen.values()]
      .sort((a, b) => a.team - b.team || a.ssid.localeCompare(b.ssid))
      .map(({ flags: _flags, ...s }) => ({ ...s, match: matchSavedRobot(s.robotSsid, savedSsids) }));
    const stalls: RobotWifiStall[] = this.stalls().map(st => {
      const keyCheck = this.keyChecks.get(this.checkId(st));
      return {
        station: st.attempt.station,
        team: st.broadcast.team,
        fieldSsid: st.attempt.ssid,
        since: st.attempt.since,
        broadcast: {
          ssid: st.broadcast.ssid,
          robotSsid: st.broadcast.robotSsid,
          signal: st.broadcast.signal,
          match: st.match,
        },
        ...(keyCheck && { keyCheck }),
      };
    });
    return {
      type: 'robotWifiScan',
      status: this.status,
      iface: this.o.iface,
      ...(this.error && { error: this.error }),
      ...(this.lastScanAt !== undefined && { lastScanAt: this.lastScanAt }),
      interfaces: [],
      broadcasts,
      stalls,
    };
  }
}
