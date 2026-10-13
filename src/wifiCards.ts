/**
 * Wireless cards on the pFMS host, for the admin page: what each is doing —
 * pFMS's robot Wi-Fi scan and/or 6 GHz watch, something else on the host, or
 * nothing — which bands it has, and a staff "test join" on the ones pFMS may
 * use. A test join
 * only associates (no DHCP, no address, no routes) and then leaves, so it
 * cannot disturb the host's networking. See plans/admin-wifi-cards.md.
 */
import { skippedInDryRun } from './dryRun.js';
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
import type { WifiBand, WifiCardInfo, WifiCardJobName, WifiCardsState, WifiTestJoinResult } from './types.js';
import { bandsOfCard } from './wifiCard.js';

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
  /** Its bands, once pFMS has run it */
  bands?: WifiBand[];
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

/** A card pFMS runs, and for what. */
export interface PfmsCardUse {
  iface: string;
  status: 'off' | 'starting' | 'running' | 'error';
  error?: string;
  jobs: WifiCardJobName[];
}

/** What pFMS itself is doing with the cards. */
export interface PfmsWifiUse {
  /** The cards pFMS runs, each for one job or both */
  cards?: PfmsCardUse[];
  /** The card a test join is running on */
  testIface?: string;
}

const JOB_NAME: Record<WifiCardJobName, string> = {
  robotScan: 'robot Wi-Fi scan',
  sixGhzWatch: '6 GHz watch',
};

/** "2.4/5 GHz", for a card's bands. */
export const bandsLabel = (bands: readonly WifiBand[]): string =>
  bands.length ? `${bands.join('/')} GHz` : 'no bands';

export function classifyCard(f: WifiCardFacts, pfms: PfmsWifiUse): WifiCardInfo {
  const pfmsCard = pfms.cards?.find(c => c.iface === f.iface && c.jobs.length);
  const jobs = pfmsCard?.jobs ?? [];
  const base = {
    iface: f.iface,
    ...(f.mac && { mac: f.mac }),
    ...(f.driver && { driver: f.driver }),
    ...(f.operstate && { operstate: f.operstate }),
    addresses: f.addresses,
    jobs,
    ...(f.bands && { bands: f.bands }),
  };
  if (pfms.testIface === f.iface && !pfmsCard) {
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
  // Keep an existing choice selectable, so it can be turned off.
  const kept = { canRobotScan: jobs.includes('robotScan'), canSixGhzWatch: jobs.includes('sixGhzWatch') };
  if (hostReasons.length) {
    const detail = `In use by the host: ${hostReasons.join('; ')}`;
    return { ...base, use: 'host', detail, canTestJoin: false, ...kept };
  }
  if (f.rfkill) {
    const detail = `Radio blocked by rfkill (${f.rfkill === 'hard' ? 'hardware switch' : 'software'})`;
    return { ...base, use: 'blocked', detail, canTestJoin: false, ...kept };
  }
  // A band the card lacks rules out the job that needs it: robots broadcast
  // on 2.4 GHz; the watch listens on 6 GHz. Unknown bands rule out nothing.
  const lacks = (band: WifiBand) => !!f.bands && !f.bands.includes(band);
  const can = {
    canRobotScan: kept.canRobotScan || !lacks('2.4'),
    canSixGhzWatch: kept.canSixGhzWatch || !lacks('6'),
  };
  const missing = [...(lacks('2.4') ? ['no 2.4 GHz'] : []), ...(lacks('6') ? ['no 6 GHz'] : [])];
  const bandNote = f.bands ? ` · ${bandsLabel(f.bands)}${missing.length ? ` (${missing.join(', ')})` : ''}` : '';
  if (pfmsCard) {
    const names = jobs.map(j => JOB_NAME[j]).join(' and ');
    const detail =
      pfms.testIface === f.iface
        ? `Running a test join (${names} paused)`
        : pfmsCard.status === 'running'
          ? `Running the ${names}`
          : pfmsCard.status === 'starting'
            ? `Starting the ${names}`
            : `The ${names} stopped${pfmsCard.error ? `: ${pfmsCard.error}` : ''}`;
    // A test join borrows the radio; the jobs' scans wait for it.
    const canTestJoin = pfmsCard.status === 'running' && pfms.testIface !== f.iface;
    return { ...base, use: 'pfms', detail: detail + bandNote, canTestJoin, ...can };
  }
  const detail = f.operstate === 'up' ? 'Free (up, not connected)' : 'Free (switched off)';
  return { ...base, use: 'free', detail: detail + bandNote, canTestJoin: true, ...can };
}

// ── The manager ─────────────────────────────────────────────────────

type TestResult = Omit<WifiTestJoinResult, 'id' | 'iface' | 'at'>;

export interface WifiCardsOptions {
  onChange: (state: WifiCardsState) => void;
  /** The cards pFMS runs, what for, and a way to test-join through each */
  pfmsCards: () => (PfmsCardUse & {
    testJoin: (request: { ssid: string; passphrase?: string }, opts: TestOpts) => Promise<TestResult>;
  })[];
  /** True while a match is running — no test joins then */
  matchRunning: () => boolean;
  readFacts?: () => WifiCardFacts[];
  /** A card's bands, if known */
  bandsOf?: (iface: string) => WifiBand[] | undefined;
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
  private readonly o: Required<WifiCardsOptions>;
  private tests: WifiTestJoinResult[] = [];
  private testIface: string | undefined;
  private nextId = 1;
  private lastJson = '';

  constructor(options: WifiCardsOptions) {
    this.o = {
      readFacts: () => readWifiCardFacts(),
      bandsOf: bandsOfCard,
      makeRunner: iface => new WpaSupplicantRunner(iface),
      now: Date.now,
      settleMs: 5_000,
      timeoutMs: 20_000,
      ...options,
    };
  }

  getState(): WifiCardsState {
    const pfms: PfmsWifiUse = {
      cards: this.o
        .pfmsCards()
        .map(({ iface, status, error, jobs }) => ({ iface, status, jobs, ...(error && { error }) })),
      ...(this.testIface && { testIface: this.testIface }),
    };
    return {
      type: 'wifiCards',
      cards: this.o.readFacts().map(f => {
        const bands = f.bands ?? this.o.bandsOf(f.iface);
        return classifyCard(bands ? { ...f, bands } : f, pfms);
      }),
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
    if (skippedInDryRun(`join ${ssid} on ${iface}`)) throw new Error('Dry run: the test join was not attempted');
    if (this.o.matchRunning()) throw new Error('Not during a match');
    if (this.testIface) throw new Error(`A test join is already running on ${this.testIface}`);
    const card = this.getState().cards.find(c => c.iface === iface);
    if (!card) throw new Error(`${iface} is not a wireless card on this host`);
    if (!card.canTestJoin) throw new Error(`${iface} can't be used: ${card.detail}`);

    const pfmsCard = this.o.pfmsCards().find(c => c.iface === iface && c.jobs.length);
    const entry: WifiTestJoinResult = { id: this.nextId++, iface, ssid, at: this.o.now(), outcome: 'running' };
    this.testIface = iface;
    this.tests = [entry, ...this.tests].slice(0, TEST_HISTORY);
    this.refresh();
    let result: TestResult;
    try {
      const opts = { settleMs: this.o.settleMs, timeoutMs: this.o.timeoutMs };
      result = pfmsCard
        ? await pfmsCard.testJoin({ ssid, passphrase }, opts)
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
