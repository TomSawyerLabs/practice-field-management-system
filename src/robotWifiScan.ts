/**
 * Robot Wi-Fi scan: listen for the 2.4 GHz network a team's robot radio
 * broadcasts (`FRC-<team>` or `FRC-<team>-<suffix>`), compare it with the
 * robots the team has saved, and — once per saved passphrase — try joining
 * it to see whether the passphrase works.
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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RobotWifiBroadcast, RobotWifiKeyCheck, RobotWifiScanState } from './types.js';

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
export type WpaEvent = { type: 'connected' } | { type: 'wrongKey' } | { type: 'authFailed'; reason: string };

export function parseWpaEvent(line: string): WpaEvent | null {
  if (line.includes('CTRL-EVENT-CONNECTED')) return { type: 'connected' };
  if (line.includes('pre-shared key may be incorrect')) return { type: 'wrongKey' };
  const temp = /CTRL-EVENT-SSID-TEMP-DISABLED .*reason=(\S+)/.exec(line);
  if (temp) return temp[1] === 'WRONG_KEY' ? { type: 'wrongKey' } : { type: 'authFailed', reason: temp[1] };
  return null;
}

/** How to join a network, from its scan flags. PSK where offered (the
 *  plainest failure path), SAE otherwise, and nothing to check if open. */
export function keyMgmtFor(flags: string): 'WPA-PSK' | 'SAE' | 'open' {
  if (/PSK/.test(flags)) return 'WPA-PSK';
  if (/SAE/.test(flags)) return 'SAE';
  if (!/WPA|RSN|WEP/.test(flags)) return 'open';
  return 'WPA-PSK';
}

/** Wireless interfaces on this host (Linux: anything with a `wireless` or
 *  `phy80211` entry under /sys/class/net). Empty elsewhere. */
export function listWirelessInterfaces(sysNet = '/sys/class/net'): string[] {
  if (platform() !== 'linux' || !existsSync(sysNet)) return [];
  return readdirSync(sysNet).filter(
    i => existsSync(join(sysNet, i, 'wireless')) || existsSync(join(sysNet, i, 'phy80211')),
  );
}

// ── Driving wpa_supplicant ──────────────────────────────────────────

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

  constructor(private readonly iface: string) {}

  async start(onLine: (line: string) => void, onExit: (why: string) => void): Promise<void> {
    if (platform() !== 'linux') throw new Error('the robot Wi-Fi scan needs Linux (wpa_supplicant)');
    if (!listWirelessInterfaces().includes(this.iface))
      throw new Error(`${this.iface} is not a wireless interface here`);
    mkdirSync(CTRL_DIR, { recursive: true });
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
  }
}

// ── The scanner ─────────────────────────────────────────────────────

/** A saved robot, as the scanner needs it. The key never leaves the server. */
export interface SavedRobot {
  ssid: string;
  wpaKey: string;
  wpaKeyHash: string;
}

/** 2.4 GHz channels 1–13 and 14: robot radios only broadcast there. */
const SCAN_FREQS = [2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, 2467, 2472, 2484].join(',');

export interface RobotWifiScannerOptions {
  iface: string;
  runner: WifiRunner;
  savedRobots: () => SavedRobot[];
  onChange: (state: RobotWifiScanState) => void;
  now?: () => number;
  scanIntervalMs?: number;
  /** How long after a scan to read its results. */
  scanSettleMs?: number;
  /** A network not seen for this long drops off the list. */
  expireMs?: number;
  /** How long a join attempt may take before it counts as unreachable. */
  keyCheckTimeoutMs?: number;
  /** Minimum gap between checks of the same network ("Check again"). */
  recheckMinMs?: number;
}

type Seen = Omit<RobotWifiBroadcast, 'match' | 'keyCheck'> & { flags: string };

export class RobotWifiScanner {
  private readonly o: Required<Omit<RobotWifiScannerOptions, 'now'>> & { now: () => number };
  private status: RobotWifiScanState['status'] = 'off';
  private error: string | undefined;
  private lastScanAt: number | undefined;
  private seen = new Map<string, Seen>();
  /** Key check results by `${broadcastSsid}\n${savedKeyHash}` — so a changed
   *  passphrase gets checked afresh, and an unchanged one never again. */
  private keyChecks = new Map<string, RobotWifiKeyCheck>();
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
      recheckMinMs: 30_000,
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
   *  results, then check any passphrase that has not been checked yet. */
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

  /** The saved robot a broadcast should be checked against, with its key. */
  private candidate(s: Seen): SavedRobot | null {
    const saved = this.o.savedRobots();
    const match = matchSavedRobot(
      s.robotSsid,
      saved.map(r => r.ssid),
    );
    if (match.kind === 'unknown') return null;
    return saved.find(r => r.ssid === match.savedSsid) ?? null;
  }

  private checkKey(s: Seen, robot: SavedRobot): string {
    return `${s.ssid}\n${robot.wpaKeyHash}`;
  }

  /** Check the first seen network whose saved passphrase has not been tried. */
  async checkNextKey(): Promise<void> {
    if (this.checking || this.status !== 'running') return;
    for (const s of this.seen.values()) {
      const robot = this.candidate(s);
      if (!robot || this.keyChecks.has(this.checkKey(s, robot))) continue;
      await this.runKeyCheck(s, robot);
      return; // one per scan cycle — the radio is shared with scanning
    }
  }

  /** "Check again": forget the result for this network so the next cycle
   *  re-tries it. Rate-limited so a button cannot hammer a robot. */
  recheck(ssid: string): void {
    const s = this.seen.get(ssid);
    if (!s) return;
    const robot = this.candidate(s);
    if (!robot) return;
    const key = this.checkKey(s, robot);
    const prev = this.keyChecks.get(key);
    if (!prev || prev.result === 'checking' || this.o.now() - prev.at < this.o.recheckMinMs) return;
    this.keyChecks.delete(key);
    void this.checkNextKey();
  }

  private async runKeyCheck(s: Seen, robot: SavedRobot): Promise<void> {
    const key = this.checkKey(s, robot);
    const mgmt = keyMgmtFor(s.flags);
    if (mgmt === 'open') {
      this.keyChecks.set(key, { result: 'open', at: this.o.now(), savedSsid: robot.ssid });
      this.emit();
      return;
    }
    // Both go to wpa_cli in quotes; refuse anything that could break out.
    if (
      !/^[A-Za-z0-9 _.-]{1,32}$/.test(s.ssid) ||
      !/^[\x20-\x7e]{8,63}$/.test(robot.wpaKey) ||
      /"/.test(robot.wpaKey)
    ) {
      return;
    }

    this.checking = s.ssid;
    this.keyChecks.set(key, { result: 'checking', at: this.o.now(), savedSsid: robot.ssid });
    this.emit();

    const cli = this.o.runner.cli.bind(this.o.runner);
    let id: string | null = null;
    let result: RobotWifiKeyCheck['result'] = 'unreachable';
    try {
      id = (await cli('add_network')).trim();
      if (!/^\d+$/.test(id)) throw new Error(`add_network answered ${id}`);
      const set = async (...args: string[]) => {
        const out = (await cli('set_network', id!, ...args)).trim();
        if (out !== 'OK') throw new Error(`set_network ${args[0]} answered ${out}`);
      };
      await set('ssid', `"${s.ssid}"`);
      await set('key_mgmt', mgmt);
      if (mgmt === 'SAE') {
        await set('ieee80211w', '2');
        await set('sae_password', `"${robot.wpaKey}"`);
      } else {
        await set('psk', `"${robot.wpaKey}"`);
      }
      await set('scan_ssid', '1');

      result = await new Promise<RobotWifiKeyCheck['result']>(resolve => {
        let done = false;
        const finish = (r: RobotWifiKeyCheck['result']) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          clearInterval(poll);
          this.pendingEvents = null;
          resolve(r);
        };
        const timeout = setTimeout(() => finish('unreachable'), this.o.keyCheckTimeoutMs);
        this.pendingEvents = e =>
          finish(e.type === 'connected' ? 'ok' : e.type === 'wrongKey' ? 'wrongKey' : 'unreachable');
        // Belt and braces: if an event line is missed, the state still says it.
        const poll = setInterval(() => {
          cli('status')
            .then(out => {
              if (/^wpa_state=COMPLETED$/m.test(out)) finish('ok');
            })
            .catch(() => {});
        }, 1000);
        cli('select_network', id!).catch(() => finish('unreachable'));
      });
    } catch (err) {
      console.warn(`Robot Wi-Fi passphrase check for ${s.ssid} failed:`, err instanceof Error ? err.message : err);
      result = 'unreachable';
    } finally {
      // Leave the robot alone: no retries, no lingering association.
      if (id !== null && /^\d+$/.test(id)) await cli('remove_network', id).catch(() => {});
      await cli('disconnect').catch(() => {});
      this.checking = null;
    }
    console.log(`Robot Wi-Fi passphrase check for ${s.ssid} (saved as ${robot.ssid}): ${result}`);
    this.keyChecks.set(key, { result, at: this.o.now(), savedSsid: robot.ssid });
    this.emit();
  }

  getState(): RobotWifiScanState {
    const saved = this.o.savedRobots();
    const savedSsids = saved.map(r => r.ssid);
    const broadcasts: RobotWifiBroadcast[] = [...this.seen.values()]
      .sort((a, b) => a.team - b.team || a.ssid.localeCompare(b.ssid))
      .map(({ flags: _flags, ...s }) => {
        const match = matchSavedRobot(s.robotSsid, savedSsids);
        const robot = match.kind === 'unknown' ? undefined : saved.find(r => r.ssid === match.savedSsid);
        const keyCheck = robot ? this.keyChecks.get(`${s.ssid}\n${robot.wpaKeyHash}`) : undefined;
        return { ...s, match, ...(keyCheck && { keyCheck }) };
      });
    return {
      type: 'robotWifiScan',
      status: this.status,
      iface: this.o.iface,
      ...(this.error && { error: this.error }),
      ...(this.lastScanAt !== undefined && { lastScanAt: this.lastScanAt }),
      interfaces: [],
      broadcasts,
    };
  }
}
