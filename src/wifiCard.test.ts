import { afterEach, describe, expect, test } from 'bun:test';
import { RobotWifiScanner, type WifiRunner } from './robotWifiScan.js';
import { SixGhzWatch, type FieldRadio } from './sixGhzWatch.js';
import type { RobotWifiScanState, SixGhzWatchState, WifiBand } from './types.js';
import {
  bandOf,
  bandsOfCard,
  bandsOfFreqs,
  parseCapabilityFreqs,
  scanSettleMs,
  WifiCard,
  type WifiCardJob,
} from './wifiCard.js';

describe('bands and channels', () => {
  test('frequency to band', () => {
    expect(bandOf(2412)).toBe('2.4');
    expect(bandOf(2484)).toBe('2.4');
    expect(bandOf(5180)).toBe('5');
    expect(bandOf(5885)).toBe('5');
    expect(bandOf(5955)).toBe('6');
    expect(bandOf(7115)).toBe('6');
    expect(bandOf(60480)).toBeNull(); // 60 GHz
  });

  test("the card's channels from get_capability", () => {
    const text = [
      'Mode[G] Channels:',
      ' 1 = 2412 MHz',
      'Mode[A] Channels:',
      ' 36 = 5180 MHz',
      ' 100 = 5500 MHz (DFS)',
      ' 1 = 5955 MHz',
      ' 5 = 5975 MHz (NO_IR)',
      ' 233 = 7115 MHz',
    ].join('\n');
    const freqs = parseCapabilityFreqs(text);
    expect(freqs).toEqual([2412, 5180, 5500, 5955, 5975, 7115]);
    expect(bandsOfFreqs(freqs)).toEqual(['2.4', '5', '6']);
    expect(bandsOfFreqs(parseCapabilityFreqs('Mode[A] Channels:\n 36 = 5180 MHz\n'))).toEqual(['5']);
    expect(parseCapabilityFreqs('OK\n')).toEqual([]);
  });

  test('a scan waits longer the more channels it covers', () => {
    expect(scanSettleMs(14)).toBe(5_000);
    expect(scanSettleMs(98)).toBe(19_600);
  });
});

// ── One card, scripted ──────────────────────────────────────────────

const HEADER = 'bssid / frequency / signal level / flags / ssid';
const row = (bssid: string, mhz: number, ssid: string, signal = -50, flags = '[WPA2-PSK-CCMP][ESS]') =>
  `${bssid}\t${mhz}\t${signal}\t${flags}\t${ssid}`;

/** A tri-band card, like the MT7921AU: 2.4 GHz ch 1 & 6, 5 GHz ch 36, 6 GHz ch 13. */
const TRI_BAND = [
  'Mode[G] Channels:',
  ' 1 = 2412 MHz',
  ' 6 = 2437 MHz',
  'Mode[A] Channels:',
  ' 36 = 5180 MHz',
  ' 13 = 6015 MHz',
].join('\n');

class FakeRunner implements WifiRunner {
  calls: string[][] = [];
  scanText = HEADER;
  capability = TRI_BAND;
  starts = 0;
  stopped = false;
  /** How long a join takes to answer */
  joinMs = 1;
  private onLine: (line: string) => void = () => {};

  async start(onLine: (line: string) => void): Promise<void> {
    this.starts++;
    this.stopped = false;
    this.onLine = onLine;
  }

  async cli(...args: string[]): Promise<string> {
    this.calls.push(args);
    switch (args[0]) {
      case 'scan_results':
        return this.scanText;
      case 'get_capability':
        return this.capability;
      case 'add_network':
        return '0\n';
      case 'status':
        return 'wpa_state=SCANNING\n';
      case 'select_network':
        setTimeout(
          () => this.onLine('wlx0: CTRL-EVENT-CONNECTED - Connection to aa:bb:cc:dd:ee:01 completed'),
          this.joinMs,
        );
        return 'OK\n';
      default:
        return 'OK\n';
    }
  }

  stop(): void {
    this.stopped = true;
  }

  scans(): string[][] {
    return this.calls.filter(c => c[0] === 'scan');
  }
}

const flush = () => new Promise(r => setTimeout(r, 30));
const NOW = 5_000_000;

const field: FieldRadio = { channel: 13, bandwidthMHz: 20, serving: [{ ssid: '1234-Comp', station: 'slot1' }] };

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

function makeCard(runner = new FakeRunner(), iface = 'wlx0') {
  // Tests drive scans by hand
  const card = new WifiCard({ iface, runner, country: 'US', now: () => NOW, scanGapMs: 1_000_000, settleMs: () => 0 });
  return { runner, card };
}

function bothJobs(card: WifiCard) {
  let robot: RobotWifiScanState | null = null;
  let watch: SixGhzWatchState | null = null;
  const scanner = new RobotWifiScanner({
    card,
    savedRobots: () => [{ ssid: '1234-Comp', wpaKey: 'passphrase1' }],
    connectAttempts: () => [],
    onChange: s => (robot = s),
    now: () => NOW,
  });
  const sixGhz = new SixGhzWatch({
    card,
    field: () => field,
    savedSsids: () => ['1234-Comp'],
    onChange: s => (watch = s),
    now: () => NOW,
  });
  cleanup.push(
    () => scanner.stop(),
    () => sixGhz.stop(),
  );
  return { scanner, sixGhz, robot: () => robot!, watch: () => watch! };
}

describe('one card running both jobs', () => {
  test('one wpa_supplicant, one scan of every band, and both jobs hear it', async () => {
    const { runner, card } = makeCard();
    const { scanner, sixGhz, robot, watch } = bothJobs(card);
    runner.scanText = [
      HEADER,
      row('aa:00:00:00:00:01', 5180, 'FRC-972'), // a robot on 5 GHz
      row('f0:00:00:00:00:01', 6015, '1234-Comp', -40, '[RSN-SAE-CCMP][ESS]'), // the field
      row('bb:00:00:00:00:01', 6015, '1234-Comp', -45, '[RSN-SAE-CCMP][ESS]'), // a copy
    ].join('\n');
    await scanner.start();
    await sixGhz.start();
    await flush();
    await card.scanOnce();

    expect(runner.starts).toBe(1);
    // Every scan covers the robot bands and 6 GHz together
    expect(runner.scans().at(-1)).toEqual(['scan', 'non_coloc_6ghz=1', 'freq=2412,2437,5180,6015']);
    expect(robot()).toMatchObject({ status: 'running', iface: 'wlx0' });
    expect(robot().broadcasts.map(b => [b.ssid, b.frequency])).toEqual([['FRC-972', 5180]]);
    expect(watch()).toMatchObject({ status: 'running', iface: 'wlx0', channels: 1 });
    expect(watch().clashes).toEqual([expect.objectContaining({ ssid: '1234-Comp', kind: 'competing' })]);
    expect(bandsOfCard('wlx0')).toEqual(['2.4', '5', '6']);
  });

  test('the card keeps running until the last job stops', async () => {
    const { runner, card } = makeCard();
    const { scanner, sixGhz, watch } = bothJobs(card);
    await scanner.start();
    await sixGhz.start();
    await flush(); // its own first scan
    scanner.stop();
    expect(runner.stopped).toBe(false);
    expect(watch().status).toBe('running');
    // The watch alone scans 6 GHz only
    await card.scanOnce();
    expect(runner.scans().at(-1)).toEqual(['scan', 'non_coloc_6ghz=1', 'freq=6015']);
    sixGhz.stop();
    expect(runner.stopped).toBe(true);
    expect(card.status).toBe('off');
  });

  test('a join holds the radio: the next scan waits for it', async () => {
    const { runner, card } = makeCard();
    const job: WifiCardJob = { bands: () => ['2.4'], onScan: () => {}, onCardChange: () => {} };
    await card.attach(job);
    cleanup.push(() => card.detach(job));
    await flush(); // its own first scan
    runner.joinMs = 20;
    runner.calls = [];
    const joined = card.join({ ssid: 'FRC-1234-Comp', security: 'WPA-PSK', passphrase: 'passphrase1' }, 1_000);
    const scanned = card.scanOnce();
    expect(card.busy).toBe(true);
    expect((await joined).outcome).toBe('connected');
    await scanned;
    const order = runner.calls.map(c => c[0]);
    expect(order.indexOf('remove_network')).toBeLessThan(order.indexOf('scan'));
  });

  test("a staff test join goes through the card's own wpa_supplicant", async () => {
    const { runner, card } = makeCard();
    const job: WifiCardJob = { bands: () => ['6'], onScan: () => {}, onCardChange: () => {} };
    await card.attach(job);
    cleanup.push(() => card.detach(job));
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 2437, 'Guest', -48, '[ESS]')].join('\n');
    const r = await card.testJoin({ ssid: 'Guest' }, { settleMs: 0, timeoutMs: 500 });
    expect(r.outcome).toBe('connected');
    expect(runner.starts).toBe(1);
  });
});

describe('a card missing a band', () => {
  test('a 2.4/5 GHz card: the robot scan runs, the 6 GHz watch says it has no 6 GHz', async () => {
    const runner = new FakeRunner();
    runner.capability = ['Mode[G] Channels:', ' 1 = 2412 MHz', 'Mode[A] Channels:', ' 36 = 5180 MHz'].join('\n');
    const { card } = makeCard(runner, 'wlp0');
    const { scanner, sixGhz, robot, watch } = bothJobs(card);
    await scanner.start();
    await sixGhz.start();
    await flush();
    await card.scanOnce();
    expect(runner.scans().at(-1)).toEqual(['scan', 'freq=2412,5180']); // no 6 GHz to ask for
    expect(robot().problem).toBeUndefined();
    expect(watch().problem).toContain('no 6 GHz channels');
    expect(bandsOfCard('wlp0')).toEqual(['2.4', '5'] satisfies WifiBand[]);
  });

  test('a card without 2.4 GHz: the robot scan stays off it, the watch still runs', async () => {
    const runner = new FakeRunner();
    runner.capability = ['Mode[A] Channels:', ' 36 = 5180 MHz', ' 13 = 6015 MHz'].join('\n');
    runner.scanText = [HEADER, row('aa:00:00:00:00:01', 5180, 'FRC-972')].join('\n');
    const { card } = makeCard(runner, 'wlx6');
    const { scanner, sixGhz, robot, watch } = bothJobs(card);
    await scanner.start();
    await sixGhz.start();
    await flush();
    await card.scanOnce();
    expect(robot().problem).toContain('no 2.4 GHz');
    expect(robot().broadcasts).toEqual([]);
    expect(watch().problem).toBeUndefined();
    expect(runner.scans().at(-1)).toEqual(['scan', 'non_coloc_6ghz=1', 'freq=6015']);
  });
});

describe('starting and stopping', () => {
  test('a card that failed starts again when a job picks it again', async () => {
    const runner = new FakeRunner();
    let fail = true;
    const realStart = runner.start.bind(runner);
    runner.start = async onLine => {
      if (fail) throw new Error('wpa_supplicant exited during startup');
      return realStart(onLine);
    };
    const { card } = makeCard(runner);
    const job: WifiCardJob = { bands: () => ['2.4'], onScan: () => {}, onCardChange: () => {} };
    await card.attach(job);
    expect(card.status).toBe('error');
    expect(card.error).toContain('exited during startup');
    fail = false;
    await card.attach(job);
    cleanup.push(() => card.detach(job));
    expect(card.status).toBe('running');
  });

  test('a new country goes to wpa_supplicant straight away', async () => {
    const { runner, card } = makeCard();
    const job: WifiCardJob = { bands: () => ['6'], onScan: () => {}, onCardChange: () => {} };
    await card.attach(job);
    cleanup.push(() => card.detach(job));
    expect(runner.calls).toContainEqual(['set', 'country', 'US']);
    card.setCountry('CA');
    await flush();
    expect(runner.calls).toContainEqual(['set', 'country', 'CA']);
    expect(card.country).toBe('CA');
  });
});
