import { afterEach, describe, expect, test } from 'bun:test';
import {
  bssidFamily,
  classifySixGhz,
  inFieldChannel,
  parseSixGhzFreqs,
  SixGhzWatch,
  sixGhzChannel,
  type FieldRadio,
  type HeardBss,
} from './sixGhzWatch.js';
import type { WifiRunner } from './robotWifiScan.js';
import type { SixGhzWatchState } from './types.js';

const ch = (n: number) => 5950 + 5 * n; // 6 GHz channel → MHz

describe('6 GHz channels', () => {
  test('frequency to channel', () => {
    expect(sixGhzChannel(5955)).toBe(1);
    expect(sixGhzChannel(6015)).toBe(13);
  });

  test("the field's channel, widened to its bandwidth", () => {
    const field = { channel: 13, bandwidthMHz: 40 }; // 40 MHz: channels 9 + 13
    expect(inFieldChannel(ch(13), field)).toBe(true);
    expect(inFieldChannel(ch(9), field)).toBe(true);
    expect(inFieldChannel(ch(5), field)).toBe(false);
    expect(inFieldChannel(ch(17), field)).toBe(false);
    expect(inFieldChannel(ch(13), { channel: 13, bandwidthMHz: 20 })).toBe(true);
    expect(inFieldChannel(ch(9), { channel: 13, bandwidthMHz: 20 })).toBe(false);
    // 80 MHz: channels 1–13
    expect(inFieldChannel(ch(1), { channel: 13, bandwidthMHz: 80 })).toBe(true);
    expect(inFieldChannel(ch(17), { channel: 13, bandwidthMHz: 80 })).toBe(false);
    // Same channel number on another band is not the field
    expect(inFieldChannel(2472, field)).toBe(false);
  });

  test("the card's 6 GHz channels from get_capability", () => {
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
    expect(parseSixGhzFreqs(text)).toEqual([5955, 5975, 7115]);
    expect(parseSixGhzFreqs('Mode[A] Channels:\n 36 = 5180 MHz\n')).toEqual([]);
  });
});

const NOW = 1_000_000;
const bss = (bssid: string, ssid: string, channel: number, signal = -50): HeardBss => ({
  bssid,
  ssid,
  frequency: ch(channel),
  signal,
  lastSeen: NOW,
});
const field: FieldRadio = {
  channel: 13,
  bandwidthMHz: 40,
  serving: [
    { ssid: '1234-Robot', station: 'slot1' },
    { ssid: '972', station: 'slot4' },
  ],
};

describe('sorting out what was heard', () => {
  test('the field alone is no clash', () => {
    const r = classifySixGhz([bss('f0:00:00:00:00:01', '1234-Robot', 13)], field, []);
    expect(r.clashes).toEqual([]);
    expect(r.networks[0].kind).toBe('field');
  });

  test('a served name on another channel is competing', () => {
    const r = classifySixGhz(
      [bss('f0:00:00:00:00:01', '1234-Robot', 13), bss('aa:00:00:00:00:01', '1234-Robot', 37, -60)],
      field,
      [],
    );
    expect(r.clashes).toEqual([
      {
        ssid: '1234-Robot',
        team: 1234,
        kind: 'competing',
        station: 'slot1',
        others: [{ bssid: 'aa:00:00:00:00:01', frequency: ch(37), signal: -60 }],
      },
    ]);
    expect(r.networks.map(n => n.kind)).toEqual(['competing', 'field']);
  });

  test('two on the field channel: the strongest is taken for the field, the other competes', () => {
    const r = classifySixGhz(
      [bss('aa:00:00:00:00:01', '972', 9, -70), bss('f0:00:00:00:00:02', '972', 13, -40)],
      field,
      [],
    );
    expect(r.clashes).toHaveLength(1);
    expect(r.clashes[0].others.map(o => o.bssid)).toEqual(['aa:00:00:00:00:01']);
  });

  test("a served name heard only off the field's channel: all of it competes (the field may hide its name)", () => {
    const r = classifySixGhz([bss('aa:00:00:00:00:01', '1234-Robot', 37)], field, []);
    expect(r.clashes[0]).toMatchObject({ kind: 'competing', station: 'slot1' });
  });

  test("a saved robot's name the field isn't serving is a team AP", () => {
    const r = classifySixGhz([bss('aa:00:00:00:00:01', '254-Comp', 13)], field, ['254-Comp']);
    expect(r.clashes).toEqual([
      {
        ssid: '254-Comp',
        team: 254,
        kind: 'teamAp',
        others: [{ bssid: 'aa:00:00:00:00:01', frequency: ch(13), signal: -50 }],
      },
    ]);
  });

  test('names match exactly, capitals included', () => {
    const r = classifySixGhz([bss('aa:00:00:00:00:01', '1234-robot', 37)], field, ['254-comp']);
    expect(r.clashes).toEqual([]);
    expect(r.networks[0].kind).toBe('other');
  });

  test("without the field's status nothing is a clash", () => {
    const r = classifySixGhz([bss('f0:00:00:00:00:01', '1234-Robot', 13)], null, ['1234-Robot']);
    expect(r.clashes).toEqual([]);
  });

  test('hidden networks and strangers are listed, never clashes', () => {
    const r = classifySixGhz([bss('f0:00:00:00:00:09', '', 13), bss('bb:00:00:00:00:01', 'Guest', 5)], field, []);
    expect(r.clashes).toEqual([]);
    expect(r.networks.map(n => n.kind)).toEqual(['other', 'other']);
  });

  test('competing clashes come before team APs', () => {
    const r = classifySixGhz(
      [bss('aa:00:00:00:00:01', '254-Comp', 5), bss('aa:00:00:00:00:02', '1234-Robot', 37)],
      field,
      ['254-Comp'],
    );
    expect(r.clashes.map(c => c.kind)).toEqual(['competing', 'teamAp']);
  });
});

describe('knowing the field AP by its addresses', () => {
  // As heard on steamboat 2026-10-05: one access point per station slot,
  // `no-team-<n>` on slots with no team.
  const fieldAp = (slot: number, ssid: string, signal = -57) => bss(`4a:da:35:b1:24:0${slot}`, ssid, 13, signal);

  test('placeholders are the field, and teach its addresses', () => {
    expect(bssidFamily('4A:DA:35:B1:24:0F')).toBe('4a:da:35:b1:24');
    const r = classifySixGhz([fieldAp(1, 'no-team-2'), fieldAp(2, 'no-team-3')], field, []);
    expect(r.networks.map(n => n.kind)).toEqual(['field', 'field']);
    expect(r.clashes).toEqual([]);
  });

  test("a louder AP on the field's own channel with a served name is caught", () => {
    const r = classifySixGhz(
      [fieldAp(0, '1234-Robot', -60), fieldAp(1, 'no-team-2'), bss('aa:00:00:00:00:01', '1234-Robot', 13, -35)],
      field,
      [],
    );
    expect(r.clashes).toEqual([
      expect.objectContaining({ kind: 'competing', others: [expect.objectContaining({ bssid: 'aa:00:00:00:00:01' })] }),
    ]);
    expect(r.networks.find(n => n.bssid === '4a:da:35:b1:24:00')?.kind).toBe('field');
  });

  test('addresses learned earlier still count once every slot has a team', () => {
    const heard = [fieldAp(0, '1234-Robot', -60), bss('aa:00:00:00:00:01', '1234-Robot', 13, -35)];
    const known = new Set(['4a:da:35:b1:24']);
    expect(classifySixGhz(heard, field, [], known).clashes[0].others.map(o => o.bssid)).toEqual(['aa:00:00:00:00:01']);
    // Without them, the louder one would have been taken for the field
    expect(classifySixGhz(heard, field, []).clashes[0].others.map(o => o.bssid)).toEqual(['4a:da:35:b1:24:00']);
  });

  test('the field serving a saved name a moment before its status says so is not a team AP', () => {
    const r = classifySixGhz([fieldAp(5, '254-Comp'), fieldAp(1, 'no-team-2')], field, ['254-Comp']);
    expect(r.clashes).toEqual([]);
  });

  test("a placeholder off the field's channel teaches nothing", () => {
    const r = classifySixGhz([bss('4a:da:35:b1:24:01', 'no-team-2', 37)], field, []);
    expect(r.networks[0].kind).toBe('other');
  });
});

// ── The watch, against a scripted wpa_supplicant ─────────────────

const HEADER = 'bssid / frequency / signal level / flags / ssid';
const row = (bssid: string, channelOrMhz: number, ssid: string, signal = -50) =>
  `${bssid}\t${channelOrMhz > 1000 ? channelOrMhz : ch(channelOrMhz)}\t${signal}\t[WPA2-SAE-CCMP][ESS]\t${ssid}`;

class FakeRunner implements WifiRunner {
  calls: string[][] = [];
  scanText = HEADER;
  capability = 'Mode[A] Channels:\n 36 = 5180 MHz\n 1 = 5955 MHz\n 13 = 6015 MHz\n 37 = 6135 MHz\n';
  started = false;
  stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async cli(...args: string[]): Promise<string> {
    this.calls.push(args);
    if (args[0] === 'scan_results') return this.scanText;
    if (args[0] === 'get_capability') return this.capability;
    return 'OK\n';
  }

  stop(): void {
    this.stopped = true;
  }
}

const flush = () => new Promise(r => setTimeout(r, 20));

let watch: SixGhzWatch | null = null;
afterEach(() => {
  watch?.stop();
  watch = null;
});

function setup(overrides: { field?: FieldRadio | null; saved?: string[]; now?: () => number } = {}) {
  const runner = new FakeRunner();
  let state: SixGhzWatchState | null = null;
  watch = new SixGhzWatch({
    iface: 'wlx0',
    runner,
    country: 'US',
    field: () => (overrides.field === undefined ? field : overrides.field),
    savedSsids: () => overrides.saved ?? [],
    onChange: s => (state = s),
    scanIntervalMs: 1_000_000, // tests drive scans by hand
    scanSettleMs: 0,
    now: overrides.now ?? (() => NOW),
  });
  return { runner, watch, state: () => state! };
}

describe('the watch', () => {
  test('scans only the 6 GHz channels the card offers, and never joins', async () => {
    const { runner, watch, state } = setup();
    runner.scanText = [
      HEADER,
      row('f0:00:00:00:00:01', 13, '1234-Robot'),
      row('aa:00:00:00:00:01', 37, '1234-Robot', -65),
      row('cc:00:00:00:00:01', 2437, '1234-Robot'), // 2.4 GHz: robots don't join there
    ].join('\n');
    await watch.start();
    await flush();
    expect(runner.calls).toContainEqual(['set', 'country', 'US']);
    expect(runner.calls).toContainEqual(['scan', 'non_coloc_6ghz=1', 'freq=5955,6015,6135']);
    expect(runner.calls.some(c => ['add_network', 'select_network'].includes(c[0]))).toBe(false);
    const s = state();
    expect(s).toMatchObject({
      status: 'running',
      channels: 3,
      country: 'US',
      field: { channel: 13, bandwidthMHz: 40 },
    });
    expect(s.networks).toHaveLength(2);
    expect(s.clashes).toEqual([expect.objectContaining({ ssid: '1234-Robot', kind: 'competing', station: 'slot1' })]);
  });

  test('a card with no 6 GHz channels says so, and asks again next time', async () => {
    const { runner, watch, state } = setup();
    runner.capability = 'Mode[G] Channels:\n 1 = 2412 MHz\n';
    await watch.start();
    await flush();
    expect(state().channels).toBe(0);
    expect(state().problem).toContain('no 6 GHz channels');
    expect(runner.calls.some(c => c[0] === 'scan')).toBe(false);

    runner.capability = 'Mode[A] Channels:\n 13 = 6015 MHz\n';
    await watch.scanOnce();
    expect(state().channels).toBe(1);
    expect(state().problem).toBeUndefined();
    expect(runner.calls).toContainEqual(['scan', 'non_coloc_6ghz=1', 'freq=6015']);
  });

  test("remembers the field AP's addresses after its placeholders go", async () => {
    const { runner, watch, state } = setup();
    runner.scanText = [HEADER, row('4a:da:35:b1:24:01', 13, 'no-team-2')].join('\n');
    await watch.start();
    await flush();
    // Every slot taken now: no placeholders, and a louder copy on the field's channel
    runner.scanText = [
      HEADER,
      row('4a:da:35:b1:24:00', 13, '1234-Robot', -60),
      row('aa:00:00:00:00:01', 13, '1234-Robot', -35),
    ].join('\n');
    await watch.scanOnce();
    expect(state().clashes[0].others.map(o => o.bssid)).toEqual(['aa:00:00:00:00:01']);
  });

  test('an access point switched off drops out after a while', async () => {
    let now = NOW;
    const { runner, watch, state } = setup({ saved: ['254'], now: () => now });
    runner.scanText = [HEADER, row('aa:00:00:00:00:01', 5, '254')].join('\n');
    await watch.start();
    await flush();
    expect(state().clashes).toHaveLength(1);

    runner.scanText = HEADER;
    now += 60_000;
    await watch.scanOnce();
    expect(state().clashes).toHaveLength(1); // still remembered
    now += 61_000;
    await watch.scanOnce();
    expect(state().clashes).toEqual([]);
  });

  test('stopping stops wpa_supplicant and forgets what was heard', async () => {
    const { runner, watch, state } = setup({ saved: ['254'] });
    runner.scanText = [HEADER, row('aa:00:00:00:00:01', 5, '254')].join('\n');
    await watch.start();
    await flush();
    watch.stop();
    expect(runner.stopped).toBe(true);
    expect(state()).toMatchObject({ status: 'off', networks: [], clashes: [] });
  });
});
