import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WifiRunner } from './robotWifiScan.js';
import type { WifiCardsState } from './types.js';
import {
  classifyCard,
  defaultRouteInterfaces,
  readWifiCardFacts,
  WifiCards,
  type WifiCardFacts,
  type WifiCardsOptions,
} from './wifiCards.js';

// ── A fake host: sysfs and procfs under a temp root ────────────────

const root = mkdtempSync(join(tmpdir(), 'pfms-wifi-cards-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text = '') {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

// Wired: not a wireless card
put('sys/class/net/eno1/operstate', 'up');
// The spare card: down, nothing on it
put('sys/class/net/wlp0s20f3/wireless/.keep');
put('sys/class/net/wlp0s20f3/address', '1c:69:7a:a2:71:3c');
put('sys/class/net/wlp0s20f3/operstate', 'down');
put('sys/class/net/wlp0s20f3/device/uevent', 'DRIVER=iwlwifi\nPCI_CLASS=28000\n');
put('sys/class/net/wlp0s20f3/phy80211/rfkill0/soft', '0');
put('sys/class/net/wlp0s20f3/phy80211/rfkill0/hard', '0');
// Switched off in software
put('sys/class/net/wlan1/phy80211/rfkill1/soft', '1');
put('sys/class/net/wlan1/phy80211/rfkill1/hard', '0');
// Driven by the host's own wpa_supplicant, and carrying the default route
put('sys/class/net/wlan2/wireless/.keep');
put('sys/class/net/wlan2/operstate', 'up');
put('run/wpa_supplicant/wlan2');
put(
  'proc/net/route',
  [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eno1\t00000000\t01FF000A\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'wlan2\t0000A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0',
  ].join('\n'),
);
put(
  'proc/net/ipv6_route',
  '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003     wlan2\n',
);

describe('reading the host', () => {
  test('default routes, v4 and v6', () => {
    expect([...defaultRouteInterfaces(root)].sort()).toEqual(['eno1', 'wlan2']);
  });

  test('finds only wireless cards, with what the host says about them', () => {
    const facts = readWifiCardFacts(root, 'linux', iface => (iface === 'wlan2' ? ['192.168.0.20'] : []));
    expect(facts.map(f => f.iface).sort()).toEqual(['wlan1', 'wlan2', 'wlp0s20f3']);
    const byName = Object.fromEntries(facts.map(f => [f.iface, f]));
    expect(byName.wlp0s20f3).toEqual({
      iface: 'wlp0s20f3',
      mac: '1c:69:7a:a2:71:3c',
      driver: 'iwlwifi',
      operstate: 'down',
      addresses: [],
      defaultRoute: false,
      controllers: [],
    });
    expect(byName.wlan1.rfkill).toBe('soft');
    expect(byName.wlan2).toMatchObject({
      controllers: ['wpa_supplicant'],
      defaultRoute: true,
      addresses: ['192.168.0.20'],
    });
  });

  test('nothing to read off Linux', () => {
    expect(readWifiCardFacts(root, 'win32')).toEqual([]);
  });
});

// ── What a card is doing ────────────────────────────────────────────

const card = (over: Partial<WifiCardFacts> = {}): WifiCardFacts => ({
  iface: 'wlp0s20f3',
  operstate: 'down',
  addresses: [],
  defaultRoute: false,
  controllers: [],
  ...over,
});

describe('classifying a card', () => {
  test('a card nothing uses is free for both', () => {
    expect(classifyCard(card(), {})).toMatchObject({ use: 'free', canTestJoin: true, canRobotScan: true });
    expect(classifyCard(card({ operstate: 'up' }), {}).detail).toMatch(/up, not connected/);
  });

  test('the host using a card in any way keeps pFMS off it, and says why', () => {
    for (const over of [{ controllers: ['hostapd'] }, { addresses: ['10.0.0.9'] }, { defaultRoute: true }]) {
      expect(classifyCard(card(over), {})).toMatchObject({ use: 'host', canTestJoin: false, canRobotScan: false });
    }
    expect(classifyCard(card({ controllers: ['wpa_supplicant'], defaultRoute: true }), {}).detail).toBe(
      'In use by the host: wpa_supplicant is running on it; the host routes through it',
    );
  });

  test('rfkill blocks it', () => {
    expect(classifyCard(card({ rfkill: 'hard' }), {})).toMatchObject({
      use: 'blocked',
      canTestJoin: false,
      detail: 'Radio blocked by rfkill (hardware switch)',
    });
  });

  test('the robot scan card can test-join through the scan while it runs', () => {
    const running = classifyCard(card(), { robotScan: { iface: 'wlp0s20f3', status: 'running' } });
    expect(running).toMatchObject({ use: 'robotScan', canTestJoin: true, canRobotScan: true });
    const stopped = classifyCard(card(), { robotScan: { iface: 'wlp0s20f3', status: 'error', error: 'no card' } });
    expect(stopped).toMatchObject({
      use: 'robotScan',
      canTestJoin: false,
      detail: 'Robot Wi-Fi scan stopped: no card',
    });
  });

  test('a robot-scan choice on a host card stays selectable, so it can be turned off', () => {
    const c = classifyCard(card({ addresses: ['10.0.0.9'] }), { robotScan: { iface: 'wlp0s20f3', status: 'error' } });
    expect(c).toMatchObject({ use: 'host', canRobotScan: true, canTestJoin: false });
  });

  test('one job per card: the robot scan card is not offered to the 6 GHz watch, nor the other way', () => {
    expect(classifyCard(card(), { robotScan: { iface: 'wlp0s20f3', status: 'running' } })).toMatchObject({
      canSixGhzWatch: false,
    });
    const watch = classifyCard(card(), { sixGhzWatch: { iface: 'wlp0s20f3', status: 'running' } });
    expect(watch).toMatchObject({
      use: 'sixGhzWatch',
      canSixGhzWatch: true,
      canRobotScan: false,
      canTestJoin: false, // the watch never joins
      detail: 'Listening on 6 GHz for other access points (6 GHz watch)',
    });
    expect(classifyCard(card(), {})).toMatchObject({ canSixGhzWatch: true });
  });

  test('a card under test is busy', () => {
    expect(classifyCard(card(), { testIface: 'wlp0s20f3' })).toMatchObject({ use: 'test', canTestJoin: false });
  });
});

// ── Test joins, against a scripted wpa_supplicant ──────────────────

const HEADER = 'bssid / frequency / signal level / flags / ssid';

class FakeRunner implements WifiRunner {
  calls: string[][] = [];
  started = false;
  stopped = false;
  scanText = [HEADER, 'aa:bb:cc:dd:ee:01\t2437\t-48\t[WPA2-PSK-CCMP][ESS]\tFRC-1234-Comp'].join('\n');
  outcome: 'connect' | 'wrongKey' = 'connect';
  private onLine: (line: string) => void = () => {};

  async start(onLine: (line: string) => void): Promise<void> {
    this.started = true;
    this.onLine = onLine;
  }

  async cli(...args: string[]): Promise<string> {
    this.calls.push(args);
    if (args[0] === 'scan_results') return this.scanText;
    if (args[0] === 'add_network') return '0\n';
    if (args[0] === 'status') return 'wpa_state=SCANNING\n';
    if (args[0] === 'select_network') {
      setTimeout(() =>
        this.onLine(
          this.outcome === 'connect'
            ? 'wlp0s20f3: CTRL-EVENT-CONNECTED - Connection to aa:bb:cc:dd:ee:01 completed'
            : 'wlp0s20f3: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="x" auth_failures=1 reason=WRONG_KEY',
        ),
      );
    }
    return 'OK\n';
  }

  stop(): void {
    this.stopped = true;
  }
}

function setup(over: Partial<WifiCardsOptions> = {}) {
  const runner = new FakeRunner();
  let state: WifiCardsState | null = null;
  const cards = new WifiCards({
    onChange: s => (state = s),
    robotScan: () => null,
    matchRunning: () => false,
    readFacts: () => [card(), card({ iface: 'wlan2', controllers: ['wpa_supplicant'] })],
    makeRunner: () => runner,
    settleMs: 0,
    timeoutMs: 50,
    ...over,
  });
  return { runner, cards, state: () => state! };
}

describe('test joins', () => {
  test('on a free card: its own wpa_supplicant, one join, then stopped', async () => {
    const { runner, cards, state } = setup();
    const result = await cards.testJoin('wlp0s20f3', 'FRC-1234-Comp', 'passphrase1');
    expect(result).toMatchObject({
      iface: 'wlp0s20f3',
      ssid: 'FRC-1234-Comp',
      outcome: 'connected',
      bssid: 'aa:bb:cc:dd:ee:01',
      frequency: 2437,
      signal: -48,
      security: 'WPA-PSK',
    });
    expect(runner.started && runner.stopped).toBe(true);
    expect(runner.calls).toContainEqual(['remove_network', '0']);
    expect(state().tests[0]).toMatchObject({ outcome: 'connected' });
    expect(state().cards.find(c => c.iface === 'wlp0s20f3')?.use).toBe('free'); // released
  });

  test('never keeps or sends back the passphrase', async () => {
    const { cards, state } = setup();
    await cards.testJoin('wlp0s20f3', 'FRC-1234-Comp', 'passphrase1');
    expect(JSON.stringify(state())).not.toContain('passphrase1');
  });

  test('wrong passphrase, missing passphrase, and a network not on the air', async () => {
    const { runner, cards } = setup();
    runner.outcome = 'wrongKey';
    expect((await cards.testJoin('wlp0s20f3', 'FRC-1234-Comp', 'wrongpass')).outcome).toBe('wrongKey');
    expect((await cards.testJoin('wlp0s20f3', 'FRC-1234-Comp')).outcome).toBe('needsPassphrase');
    expect((await cards.testJoin('wlp0s20f3', 'Nowhere', 'passphrase1')).outcome).toBe('notFound');
  });

  test('refuses during a match, on a host card, and on an unknown card', async () => {
    await expect(setup({ matchRunning: () => true }).cards.testJoin('wlp0s20f3', 'x')).rejects.toThrow(
      'Not during a match',
    );
    await expect(setup().cards.testJoin('wlan2', 'x')).rejects.toThrow(/In use by the host/);
    await expect(setup().cards.testJoin('wlan9', 'x')).rejects.toThrow(/not a wireless card/);
  });

  test('one at a time', async () => {
    const { cards } = setup();
    const first = cards.testJoin('wlp0s20f3', 'FRC-1234-Comp', 'passphrase1');
    await expect(cards.testJoin('wlp0s20f3', 'FRC-1234-Comp', 'passphrase1')).rejects.toThrow(/already running/);
    await first;
  });

  test("on the robot scan's card it goes through the scan", async () => {
    const calls: string[] = [];
    const { runner, cards } = setup({
      robotScan: () => ({
        iface: 'wlp0s20f3',
        status: 'running',
        testJoin: async request => {
          calls.push(request.ssid);
          return { ssid: request.ssid, outcome: 'connected' };
        },
      }),
    });
    expect((await cards.testJoin('wlp0s20f3', 'FRC-1234-Comp', 'passphrase1')).outcome).toBe('connected');
    expect(calls).toEqual(['FRC-1234-Comp']);
    expect(runner.started).toBe(false); // no second wpa_supplicant on the card
  });

  test('keeps the last ten results, newest first', async () => {
    const { cards, state } = setup();
    for (let i = 0; i < 12; i++) await cards.testJoin('wlp0s20f3', `Net${i}`);
    expect(state().tests).toHaveLength(10);
    expect(state().tests[0].ssid).toBe('Net11');
  });
});
