/**
 * Wireless cards on the pFMS host, for the admin page: what each is doing —
 * pFMS's robot Wi-Fi scan or 6 GHz watch, something else on the host, or
 * nothing — and a staff "test join" on the ones pFMS may use. A test join
 * only associates (no DHCP, no address, no routes) and then leaves, so it
 * cannot disturb the host's networking. See plans/admin-wifi-cards.md.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { networkInterfaces, platform } from 'node:os';
import { join } from 'node:path';
import {
  listWirelessInterfaces,
  parseWpaEvent,
  testJoin,
  WpaSupplicantRunner,
  type WifiRunner,
  type WpaEvent,
} from './robotWifiScan.js';
import type { WifiCardInfo, WifiCardsState, WifiTestJoinResult } from './types.js';

// ── Reading the host ────────────────────────────────────────────────

/** What the host says about one wireless card. */
export interface WifiCardFacts {
  iface: string;
  mac?: string;
  driver?: string;
  operstate?: string;
  /** rfkill state of the card's radio, if blocked */
  rfkill?: 'soft' | 'hard';
  /** Addresses other than link-local */
  addresses: string[];
  /** The host's default route (v4 or v6) goes through it */
  defaultRoute: boolean;
  /** Other programs holding a control socket for it (not pFMS's own) */
  controllers: string[];
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
};

/** Interfaces the host routes its default traffic through, from
 *  /proc/net/route (v4) and /proc/net/ipv6_route (v6). */
export function defaultRouteInterfaces(root = '/'): Set<string> {
  const out = new Set<string>();
  for (const line of (readText(join(root, 'proc/net/route')) ?? '').split('\n').slice(1)) {
    const [iface, dest, , , , , , mask] = line.trim().split(/\s+/);
    if (iface && dest === '00000000' && mask === '00000000') out.add(iface);
  }
  for (const line of (readText(join(root, 'proc/net/ipv6_route')) ?? '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 10 && /^0{32}$/.test(f[0]) && f[1] === '00') out.add(f[9]);
  }
  return out;
}

/** Programs other than pFMS that control a card: wpa_supplicant and hostapd
 *  each leave a control socket named after the interface. */
const CONTROL_SOCKETS: [string, string][] = [
  ['run/wpa_supplicant', 'wpa_supplicant'],
  ['var/run/wpa_supplicant', 'wpa_supplicant'],
  ['run/hostapd', 'hostapd'],
  ['var/run/hostapd', 'hostapd'],
];

/** Read every wireless card's facts. `root` and `addressesOf` are for tests. */
export function readWifiCardFacts(
  root = '/',
  os: string = platform(),
  addressesOf: (iface: string) => string[] = iface =>
    (networkInterfaces()[iface] ?? [])
      .filter(a => !a.internal && !(a.family === 'IPv6' && a.address.toLowerCase().startsWith('fe80')))
      .map(a => a.address),
): WifiCardFacts[] {
  const sysNet = join(root, 'sys/class/net');
  const defaults = defaultRouteInterfaces(root);
  return listWirelessInterfaces(sysNet, os).map(iface => {
    const dir = join(sysNet, iface);
    const driver = /^DRIVER=(.+)$/m.exec(readText(join(dir, 'device/uevent')) ?? '')?.[1];
    let rfkill: WifiCardFacts['rfkill'];
    const phy = join(dir, 'phy80211');
    if (existsSync(phy)) {
      for (const entry of readdirSync(phy).filter(e => e.startsWith('rfkill'))) {
        if (readText(join(phy, entry, 'hard')) === '1') rfkill = 'hard';
        else if (readText(join(phy, entry, 'soft')) === '1') rfkill ??= 'soft';
      }
    }
    const controllers = [
      ...new Set(CONTROL_SOCKETS.filter(([d]) => existsSync(join(root, d, iface))).map(([, name]) => name)),
    ];
    return {
      iface,
      mac: readText(join(dir, 'address')),
      ...(driver && { driver }),
      operstate: readText(join(dir, 'operstate')),
      ...(rfkill && { rfkill }),
      addresses: addressesOf(iface),
      defaultRoute: defaults.has(iface),
      controllers,
    };
  });
}

// ── Deciding what a card is doing ───────────────────────────────────

/** What pFMS itself is doing with the cards. */
export interface PfmsWifiUse {
  /** The robot scan's card, and whether it is running */
  robotScan?: { iface: string; status: 'off' | 'starting' | 'running' | 'error'; error?: string };
  /** The 6 GHz watch's card, and whether it is running */
  sixGhzWatch?: { iface: string; status: 'off' | 'starting' | 'running' | 'error'; error?: string };
  /** The card a test join is running on */
  testIface?: string;
}

export function classifyCard(f: WifiCardFacts, pfms: PfmsWifiUse): WifiCardInfo {
  const base = {
    iface: f.iface,
    ...(f.mac && { mac: f.mac }),
    ...(f.driver && { driver: f.driver }),
    ...(f.operstate && { operstate: f.operstate }),
    addresses: f.addresses,
  };
  if (pfms.testIface === f.iface) {
    return {
      ...base,
      use: 'test',
      detail: 'Running a test join',
      canTestJoin: false,
      canRobotScan: false,
      canSixGhzWatch: false,
    };
  }

  // Someone else's card: never touch it. (pFMS's own wpa_supplicant keeps its
  // socket elsewhere, so it never shows up here.)
  const hostReasons = [
    ...f.controllers.map(c => `${c} is running on it`),
    ...(f.addresses.length ? [`it has an address (${f.addresses.join(', ')})`] : []),
    ...(f.defaultRoute ? ['the host routes through it'] : []),
  ];
  const scan = pfms.robotScan?.iface === f.iface ? pfms.robotScan : undefined;
  const watch = pfms.sixGhzWatch?.iface === f.iface ? pfms.sixGhzWatch : undefined;
  // Keep an existing choice selectable, so it can be turned off.
  const kept = { canRobotScan: !!scan, canSixGhzWatch: !!watch };
  if (hostReasons.length) {
    const detail = `In use by the host: ${hostReasons.join('; ')}`;
    return { ...base, use: 'host', detail, canTestJoin: false, ...kept };
  }
  if (f.rfkill) {
    const detail = `Radio blocked by rfkill (${f.rfkill === 'hard' ? 'hardware switch' : 'software'})`;
    return { ...base, use: 'blocked', detail, canTestJoin: false, ...kept };
  }
  // One job per card: a card one of them owns can't be picked for the other.
  if (scan) {
    const detail =
      scan.status === 'running'
        ? 'Listening for robots (robot Wi-Fi scan)'
        : scan.status === 'starting'
          ? 'Robot Wi-Fi scan starting'
          : `Robot Wi-Fi scan stopped${scan.error ? `: ${scan.error}` : ''}`;
    return {
      ...base,
      use: 'robotScan',
      detail,
      canTestJoin: scan.status === 'running',
      canRobotScan: true,
      canSixGhzWatch: false,
    };
  }
  if (watch) {
    const detail =
      watch.status === 'running'
        ? 'Listening on 6 GHz for other access points (6 GHz watch)'
        : watch.status === 'starting'
          ? '6 GHz watch starting'
          : `6 GHz watch stopped${watch.error ? `: ${watch.error}` : ''}`;
    // Scan only: its wpa_supplicant never joins, so no test joins here.
    return { ...base, use: 'sixGhzWatch', detail, canTestJoin: false, canRobotScan: false, canSixGhzWatch: true };
  }
  const detail = f.operstate === 'up' ? 'Free (up, not connected)' : 'Free (switched off)';
  return { ...base, use: 'free', detail, canTestJoin: true, canRobotScan: true, canSixGhzWatch: true };
}

// ── The manager ─────────────────────────────────────────────────────

type TestResult = Omit<WifiTestJoinResult, 'id' | 'iface' | 'at'>;

export interface WifiCardsOptions {
  onChange: (state: WifiCardsState) => void;
  /** What pFMS's robot scan is doing, and a way to test-join through it */
  robotScan: () =>
    | (NonNullable<PfmsWifiUse['robotScan']> & {
        testJoin: (request: { ssid: string; passphrase?: string }, opts: TestOpts) => Promise<TestResult>;
      })
    | null;
  /** What pFMS's 6 GHz watch is doing */
  sixGhzWatch?: () => PfmsWifiUse['sixGhzWatch'] | null;
  /** True while a match is running — no test joins then */
  matchRunning: () => boolean;
  readFacts?: () => WifiCardFacts[];
  /** A wpa_supplicant for a free card, just for one test */
  makeRunner?: (iface: string) => WifiRunner;
  now?: () => number;
  settleMs?: number;
  timeoutMs?: number;
}

interface TestOpts {
  settleMs: number;
  timeoutMs: number;
}

/** Keep this many test results. */
const TEST_HISTORY = 10;

export class WifiCards {
  private readonly o: Required<Omit<WifiCardsOptions, 'robotScan' | 'onChange' | 'matchRunning' | 'sixGhzWatch'>> &
    Pick<WifiCardsOptions, 'robotScan' | 'onChange' | 'matchRunning' | 'sixGhzWatch'>;
  private tests: WifiTestJoinResult[] = [];
  private testIface: string | undefined;
  private nextId = 1;
  private lastJson = '';

  constructor(options: WifiCardsOptions) {
    this.o = {
      readFacts: () => readWifiCardFacts(),
      makeRunner: iface => new WpaSupplicantRunner(iface),
      now: Date.now,
      settleMs: 5_000,
      timeoutMs: 20_000,
      ...options,
    };
  }

  getState(): WifiCardsState {
    const scan = this.o.robotScan();
    const watch = this.o.sixGhzWatch?.();
    const pfms: PfmsWifiUse = {
      ...(scan && { robotScan: { iface: scan.iface, status: scan.status, ...(scan.error && { error: scan.error }) } }),
      ...(watch && { sixGhzWatch: watch }),
      ...(this.testIface && { testIface: this.testIface }),
    };
    return {
      type: 'wifiCards',
      cards: this.o.readFacts().map(f => classifyCard(f, pfms)),
      tests: this.tests,
    };
  }

  /** Re-read the host and tell clients if anything changed. */
  refresh(): void {
    const state = this.getState();
    const json = JSON.stringify(state);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.o.onChange(state);
  }

  /** Test-join a network on a card. Throws, with a message for staff, when
   *  it can't be tried at all; otherwise the result lands in the state. */
  async testJoin(iface: string, ssid: string, passphrase?: string): Promise<WifiTestJoinResult> {
    if (this.o.matchRunning()) throw new Error('Not during a match');
    if (this.testIface) throw new Error(`A test join is already running on ${this.testIface}`);
    const card = this.getState().cards.find(c => c.iface === iface);
    if (!card) throw new Error(`${iface} is not a wireless card on this host`);
    if (!card.canTestJoin) throw new Error(`${iface} can't be used: ${card.detail}`);

    const scan = this.o.robotScan();
    const entry: WifiTestJoinResult = { id: this.nextId++, iface, ssid, at: this.o.now(), outcome: 'running' };
    this.testIface = iface;
    this.tests = [entry, ...this.tests].slice(0, TEST_HISTORY);
    this.refresh();
    let result: TestResult;
    try {
      const opts = { settleMs: this.o.settleMs, timeoutMs: this.o.timeoutMs };
      result =
        scan?.iface === iface
          ? await scan.testJoin({ ssid, passphrase }, opts)
          : await this.testOnFreeCard(iface, { ssid, passphrase }, opts);
    } catch (err) {
      result = { ssid, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      this.testIface = undefined;
    }
    const done: WifiTestJoinResult = { ...entry, ...result, id: entry.id, iface, at: entry.at };
    this.tests = this.tests.map(t => (t.id === entry.id ? done : t));
    console.log(
      `Wi-Fi test join on ${iface} to "${ssid}": ${done.outcome}${done.detail ? ` (${done.detail})` : ''}` +
        `${done.bssid ? ` via ${done.bssid}` : ''}`,
    );
    this.refresh();
    return done;
  }

  /** A card nothing uses: bring up a wpa_supplicant just for this test. */
  private async testOnFreeCard(
    iface: string,
    request: { ssid: string; passphrase?: string },
    opts: TestOpts,
  ): Promise<TestResult> {
    const runner = this.o.makeRunner(iface);
    let handler: ((e: WpaEvent) => void) | null = null;
    const supplicant = { exited: null as string | null };
    await runner.start(
      line => {
        const e = parseWpaEvent(line);
        if (e) handler?.(e);
      },
      why => {
        supplicant.exited = why;
        handler?.({ type: 'authFailed', reason: why });
      },
    );
    try {
      const r = await testJoin(runner.cli.bind(runner), h => (handler = h), request, opts);
      const exited = supplicant.exited;
      return exited && r.outcome !== 'connected' ? { ...r, detail: r.detail ?? exited } : r;
    } finally {
      runner.stop();
    }
  }
}
