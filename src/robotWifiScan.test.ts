import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attemptJoin,
  findStalls,
  holdIpv6Autoconf,
  joinProblem,
  keyMgmtFor,
  matchSavedRobot,
  pskHex,
  ssidHex,
  parseScanResults,
  parseWpaEvent,
  robotOfBroadcast,
  RobotWifiScanner,
  STALL_MS,
  candidateKeys,
  type ConnectAttempt,
  type KeyFound,
  type RobotWifiScannerOptions,
  type WifiRunner,
  type WpaEvent,
} from './robotWifiScan.js';
import type { RobotWifiScanState } from './types.js';
import type { SavedRobot } from './robotWifiScan.js';
import { WifiCard } from './wifiCard.js';

const HEADER = 'bssid / frequency / signal level / flags / ssid';
const row = (bssid: string, ssid: string, signal = -50, flags = '[WPA2-PSK-CCMP][ESS]') =>
  `${bssid}\t2437\t${signal}\t${flags}\t${ssid}`;

describe('parsing wpa_cli scan_results', () => {
  test('reads rows and drops the header and hidden networks', () => {
    const rows = parseScanResults(
      [
        HEADER,
        row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp'),
        row('aa:bb:cc:dd:ee:02', ''),
        row('aa:bb:cc:dd:ee:03', 'TSL Guest', -70),
      ].join('\n'),
    );
    expect(rows.map(r => r.ssid)).toEqual(['FRC-1234-Comp', 'TSL Guest']);
    expect(rows[0]).toMatchObject({ bssid: 'aa:bb:cc:dd:ee:01', frequency: 2437, signal: -50 });
  });
});

describe('recognising a robot network', () => {
  test('FRC-<team> and FRC-<team>-<suffix>', () => {
    expect(robotOfBroadcast('FRC-1234')).toEqual({ team: 1234, robotSsid: '1234' });
    expect(robotOfBroadcast('FRC-1234-Comp')).toEqual({ team: 1234, robotSsid: '1234-Comp' });
    expect(robotOfBroadcast('frc-254-practice')).toEqual({ team: 254, robotSsid: '254-practice' });
  });

  test('anything else is not a robot', () => {
    for (const ssid of ['1234-Comp', 'FRC-', 'FRC-abc', 'FRC-0', 'MyFRC-1234', 'FRC-123456'])
      expect(robotOfBroadcast(ssid)).toBeNull();
  });
});

describe('matching against saved robots', () => {
  test('exact beats capitalization-only', () => {
    expect(matchSavedRobot('1234-Comp', ['1234-comp', '1234-Comp'])).toEqual({ kind: 'exact', savedSsid: '1234-Comp' });
    expect(matchSavedRobot('1234-Comp', ['1234-comp'])).toEqual({ kind: 'caseOnly', savedSsid: '1234-comp' });
    expect(matchSavedRobot('1234-Comp', ['1234', '1234-Practice'])).toEqual({ kind: 'unknown' });
  });
});

describe('reading wpa_supplicant output', () => {
  test('connected, wrong key, other failures', () => {
    expect(parseWpaEvent('wlp0s20f3: CTRL-EVENT-CONNECTED - Connection to aa:bb:cc:dd:ee:01 completed')).toEqual({
      type: 'connected',
      bssid: 'aa:bb:cc:dd:ee:01',
    });
    expect(parseWpaEvent('wlp0s20f3: CTRL-EVENT-CONNECTED')).toEqual({ type: 'connected' });
    expect(parseWpaEvent('wlp0s20f3: WPA: 4-Way Handshake failed - pre-shared key may be incorrect')).toEqual({
      type: 'wrongKey',
    });
    expect(
      parseWpaEvent(
        'wlp0s20f3: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="FRC-1234" auth_failures=1 duration=10 reason=WRONG_KEY',
      ),
    ).toEqual({ type: 'wrongKey' });
    expect(
      parseWpaEvent(
        'wlp0s20f3: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="FRC-1234" auth_failures=1 duration=10 reason=CONN_FAILED',
      ),
    ).toEqual({ type: 'authFailed', reason: 'CONN_FAILED' });
    expect(parseWpaEvent('wlp0s20f3: Trying to associate with aa:bb:cc:dd:ee:01')).toBeNull();
  });

  test('how to join, from the scan flags', () => {
    expect(keyMgmtFor('[WPA2-PSK-CCMP][ESS]')).toBe('WPA-PSK');
    expect(keyMgmtFor('[WPA2-PSK+SAE-CCMP][ESS]')).toBe('WPA-PSK');
    expect(keyMgmtFor('[WPA2-SAE-CCMP][ESS]')).toBe('SAE');
    expect(keyMgmtFor('[ESS]')).toBe('open');
  });
});

describe('joining just long enough for an answer', () => {
  /** A wpa_cli that answers `select_network` with the given event line. */
  function scripted(line: string) {
    const calls: string[] = [];
    let handler: ((e: WpaEvent) => void) | null = null;
    const cli = async (...args: string[]) => {
      calls.push(args[0]);
      if (args[0] === 'add_network') return '3\n';
      if (args[0] === 'select_network') setTimeout(() => handler?.(parseWpaEvent(line)!), 5);
      return 'OK\n';
    };
    return { calls, cli, listen: (h: ((e: WpaEvent) => void) | null) => (handler = h) };
  }
  const target = { ssid: 'FRC-1234', security: 'WPA-PSK' as const, passphrase: 'passphrase1' };

  test('connected: disconnects before anything else, then forgets the network', async () => {
    const w = scripted('wlan0: CTRL-EVENT-CONNECTED - Connection to aa:bb:cc:dd:ee:01 completed [id=3]');
    const r = await attemptJoin(w.cli, w.listen, target, 5_000);
    expect(r).toMatchObject({ outcome: 'connected', bssid: 'aa:bb:cc:dd:ee:01' });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.ms).toBeLessThan(5_000); // the answer's time, not the timeout's
    const after = w.calls.slice(w.calls.indexOf('select_network') + 1);
    expect(after).toEqual(['disconnect', 'remove_network']); // no status query in between
  });

  test('refused: the same', async () => {
    const w = scripted('wlan0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect');
    const r = await attemptJoin(w.cli, w.listen, target, 5_000);
    expect(r.outcome).toBe('wrongKey');
    expect(w.calls.slice(w.calls.indexOf('select_network') + 1)).toEqual(['disconnect', 'remove_network']);
  });
});

describe('keeping IPv6 autoconfiguration off the card', () => {
  const proc = mkdtempSync(join(tmpdir(), 'pfms-proc-'));
  afterAll(() => rmSync(proc, { recursive: true, force: true }));
  const conf = join(proc, 'sys/net/ipv6/conf/wlan0');
  mkdirSync(conf, { recursive: true });

  test('turns accept_ra and autoconf off while held, and puts them back', () => {
    writeFileSync(join(conf, 'accept_ra'), '1\n');
    writeFileSync(join(conf, 'autoconf'), '1\n');
    const restore = holdIpv6Autoconf('wlan0', proc);
    expect(readFileSync(join(conf, 'accept_ra'), 'utf8')).toBe('0');
    expect(readFileSync(join(conf, 'autoconf'), 'utf8')).toBe('0');
    restore();
    expect(readFileSync(join(conf, 'accept_ra'), 'utf8')).toBe('1');
    expect(readFileSync(join(conf, 'autoconf'), 'utf8')).toBe('1');
  });

  test('leaves alone what is already off, and a card it cannot see', () => {
    writeFileSync(join(conf, 'accept_ra'), '0');
    writeFileSync(join(conf, 'autoconf'), '0');
    holdIpv6Autoconf('wlan0', proc)();
    expect(readFileSync(join(conf, 'accept_ra'), 'utf8')).toBe('0');
    expect(() => holdIpv6Autoconf('wlan9', proc)()).not.toThrow();
  });
});

describe('joining safely', () => {
  test('SSIDs go to wpa_cli as hex, so any SSID works', () => {
    expect(ssidHex('FRC-1234')).toBe('4652432d31323334');
    expect(ssidHex('a"b\\c')).toBe('6122625c63');
  });

  test('the WPA2 PSK matches the IEEE 802.11i test vector', () => {
    expect(pskHex('password', 'IEEE')).toBe('f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e');
  });

  test('what can be joined as asked', () => {
    expect(joinProblem('FRC-1234', 'WPA-PSK', 'passphrase1')).toBeNull();
    expect(joinProblem('Guest', 'open', undefined)).toBeNull();
    expect(joinProblem('FRC-1234', 'WPA-PSK', undefined)).toMatch(/needs a passphrase/);
    expect(joinProblem('FRC-1234', 'WPA-PSK', 'short')).toMatch(/8 to 63/);
    expect(joinProblem('', 'open', undefined)).toMatch(/1 to 32/);
    expect(joinProblem('x'.repeat(33), 'open', undefined)).toMatch(/1 to 32/);
    // A quote is fine for WPA2 (the PSK goes as hex) but not for SAE
    expect(joinProblem('FRC-1234', 'WPA-PSK', 'pass"phrase')).toBeNull();
    expect(joinProblem('FRC-1234', 'SAE', 'pass"phrase')).toMatch(/SAE/);
  });
});

// ── The scanner, against a scripted wpa_supplicant ─────────────────

type JoinOutcome = 'connect' | 'wrongKey' | 'silent';

class FakeRunner implements WifiRunner {
  calls: string[][] = [];
  scanText = HEADER;
  /** A 2.4/5 GHz card, like the AC 9560 */
  capability = ['Mode[G] Channels:', ' 1 = 2412 MHz', ' 6 = 2437 MHz', 'Mode[A] Channels:', ' 36 = 5180 MHz'].join(
    '\n',
  );
  outcome: JoinOutcome = 'connect';
  /** When set, only this passphrase opens a robot (outcome is ignored) */
  rightKey: string | null = null;
  private onLine: (line: string) => void = () => {};

  /** The passphrases tried, in order (recovered from the PSKs sent) */
  triedKeys(candidates: string[]): string[] {
    const psks = this.calls.filter(c => c[0] === 'set_network' && c[2] === 'psk').map(c => c[3]);
    const ssids = this.calls.filter(c => c[0] === 'set_network' && c[2] === 'ssid').map(c => c[3]);
    return psks.map((psk, i) => {
      const ssid = Buffer.from(ssids[i], 'hex').toString('utf8');
      return candidates.find(k => pskHex(k, ssid) === psk) ?? '?';
    });
  }

  async start(onLine: (line: string) => void): Promise<void> {
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
        setTimeout(() => {
          const outcome =
            this.rightKey === null
              ? this.outcome
              : this.triedKeys([this.rightKey]).at(-1) === this.rightKey
                ? 'connect'
                : 'wrongKey';
          if (outcome === 'connect') this.onLine('wlp0s20f3: CTRL-EVENT-CONNECTED - Connection to x completed');
          if (outcome === 'wrongKey')
            this.onLine(
              'wlp0s20f3: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="x" auth_failures=1 duration=10 reason=WRONG_KEY',
            );
        }, 1);
        return 'OK\n';
      default:
        return 'OK\n';
    }
  }

  stop(): void {}

  joins(): number {
    return this.calls.filter(c => c[0] === 'add_network').length;
  }
}

const NOW = 10_000_000;
/** The field set up for a robot that has been trying for over a minute. */
const stalled = (over: Partial<ConnectAttempt> = {}): ConnectAttempt => ({
  station: 'slot3',
  ssid: '1234-Comp',
  wpaKey: 'passphrase1',
  since: NOW - STALL_MS - 1,
  linked: false,
  ...over,
});

describe('which connections have stalled', () => {
  const heard = [
    { ssid: 'FRC-1234-Comp', team: 1234, robotSsid: '1234-Comp', signal: -60 },
    { ssid: 'FRC-1234', team: 1234, robotSsid: '1234', signal: -40 },
    { ssid: 'FRC-972', team: 972, robotSsid: '972', signal: -50 },
  ];

  test('a robot not joined for a minute, with its network on the air, has stalled', () => {
    const [st] = findStalls([stalled()], heard, NOW);
    expect(st.broadcast.ssid).toBe('FRC-1234-Comp'); // the name the field wants beats a stronger one
    expect(st.match).toBe('exact');
  });

  test('not while it is still within the minute, linked, or silent', () => {
    expect(findStalls([stalled({ since: NOW - STALL_MS + 1000 })], heard, NOW)).toEqual([]);
    expect(findStalls([stalled({ linked: true })], heard, NOW)).toEqual([]);
    expect(findStalls([stalled({ ssid: '254' })], heard, NOW)).toEqual([]);
  });

  test('a name that differs in capitals, or not at all like the field expects', () => {
    expect(findStalls([stalled({ ssid: '1234-comp' })], heard, NOW)[0]).toMatchObject({
      match: 'caseOnly',
      broadcast: { ssid: 'FRC-1234-Comp' },
    });
    expect(findStalls([stalled({ ssid: '1234-Practice' })], heard, NOW)[0]).toMatchObject({
      match: 'otherName',
      broadcast: { ssid: 'FRC-1234' }, // the team's strongest
    });
  });
});

let scanner: RobotWifiScanner | null = null;
let card: WifiCard | null = null;
afterEach(() => {
  scanner?.stop();
  scanner = null;
  card = null;
});

/** Wait for the card to finish what it is doing: a scan, and any passphrase
 *  check that follows it. Nothing that runs between those two is a timer, so
 *  a timer here can't land in the gap. */
async function flush() {
  do await Bun.sleep(1);
  while (card?.busy);
}

function setup(
  attempts: ConnectAttempt[],
  overrides: Partial<Omit<RobotWifiScannerOptions, 'card' | 'savedRobots' | 'connectAttempts' | 'onChange'>> & {
    saved?: (string | SavedRobot)[];
  } = {},
) {
  const { saved, ...rest } = overrides;
  const runner = new FakeRunner();
  let state: RobotWifiScanState | null = null;
  const now = rest.now ?? (() => NOW);
  // Tests drive scans by hand
  card = new WifiCard({ iface: 'wlan0', runner, country: 'US', now, scanGapMs: 1_000_000, settleMs: () => 0 });
  scanner = new RobotWifiScanner({
    card,
    savedRobots: () =>
      (saved ?? ['1234-Comp']).map(r => (typeof r === 'string' ? { ssid: r, wpaKey: 'passphrase1' } : r)),
    connectAttempts: () => attempts,
    onChange: s => (state = s),
    now: () => NOW,
    ...rest,
  });
  return { runner, card, scanner, state: () => state! };
}

describe('the scanner', () => {
  test('hearing a robot nobody saved matches nothing, and never joins it', async () => {
    const { runner, scanner, state } = setup([]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-5678'), row('aa:bb:cc:dd:ee:09', 'Guest')].join('\n');
    await scanner.start();
    await flush();
    expect(state().broadcasts).toHaveLength(1); // the guest network is not a robot
    expect(state().broadcasts[0]).toMatchObject({ ssid: 'FRC-5678', match: { kind: 'unknown' } });
    expect(state().broadcasts[0].keyCheck).toBeUndefined();
    expect(state().stalls).toEqual([]);
    expect(runner.joins()).toBe(0);
  });

  test('a saved robot heard off the field gets its saved passphrase tried once, before anyone enables it', async () => {
    const { runner, scanner, state } = setup([]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(state().broadcasts[0]).toMatchObject({
      match: { kind: 'exact', savedSsid: '1234-Comp' },
      keyCheck: { result: 'wrongKey', fieldSsid: '1234-Comp' },
    });
    expect(runner.calls).toContainEqual(['set_network', '0', 'psk', pskHex('passphrase1', 'FRC-1234-Comp')]);
    expect(JSON.stringify(state())).not.toContain('passphrase1');

    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(1); // not again by itself
  });

  test('a saved passphrase that changes is tried afresh', async () => {
    const saved: SavedRobot[] = [{ ssid: '1234-Comp', wpaKey: 'passphrase1' }];
    const { runner, scanner, state } = setup([], { saved });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(state().broadcasts[0].keyCheck?.result).toBe('wrongKey');

    saved[0] = { ssid: '1234-Comp', wpaKey: 'passphrase2' };
    runner.outcome = 'connect';
    expect(scanner.getState().broadcasts[0].keyCheck).toBeUndefined(); // the old answer is for the old passphrase
    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(2);
    expect(state().broadcasts[0].keyCheck?.result).toBe('ok');
  });

  test('a saved robot already on the field is left to the stall check', async () => {
    const { runner, scanner, state } = setup([stalled({ since: NOW })]); // trying, not stalled yet
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(state().stalls).toEqual([]);
    expect(runner.joins()).toBe(0);
  });

  test("a saved passphrase already found right isn't tried again when that robot stalls", async () => {
    const attempts: ConnectAttempt[] = [];
    const { runner, scanner, state } = setup(attempts);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(runner.joins()).toBe(1);

    attempts.push(stalled());
    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(1);
    expect(state().stalls[0].keyCheck?.result).toBe('ok');
  });

  test("a stalled connection gets the field's passphrase tried once, automatically", async () => {
    const { runner, scanner, state } = setup([stalled()]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();

    expect(state().stalls).toEqual([
      {
        station: 'slot3',
        team: 1234,
        fieldSsid: '1234-Comp',
        since: NOW - STALL_MS - 1,
        broadcast: { ssid: 'FRC-1234-Comp', robotSsid: '1234-Comp', signal: -50, match: 'exact' },
        keyCheck: { result: 'ok', at: NOW, fieldSsid: '1234-Comp' },
      },
    ]);
    expect(runner.calls).toContainEqual(['set_network', '0', 'ssid', ssidHex('FRC-1234-Comp')]);
    expect(runner.calls).toContainEqual(['set_network', '0', 'psk', pskHex('passphrase1', 'FRC-1234-Comp')]);
    // The passphrase itself never goes on a command line, or to a client
    expect(runner.calls.flat().some(a => a.includes('passphrase1'))).toBe(false);
    expect(JSON.stringify(state())).not.toContain('passphrase1');
    expect(runner.calls).toContainEqual(['remove_network', '0']); // leaves the robot alone afterwards

    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(1); // not again by itself
  });

  test('a wrong passphrase is reported, and a changed one is tried afresh', async () => {
    const attempts = [stalled()];
    const { runner, scanner, state } = setup(attempts);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(state().stalls[0].keyCheck?.result).toBe('wrongKey');

    attempts[0] = stalled({ wpaKey: 'passphrase2' });
    runner.outcome = 'connect';
    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(2);
    expect(state().stalls[0].keyCheck?.result).toBe('ok');
  });

  test('capitals-only difference is still tested automatically', async () => {
    const { runner, scanner, state } = setup([stalled({ ssid: '1234-comp' })], { saved: ['1234-comp'] });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(state().stalls[0]).toMatchObject({ broadcast: { match: 'caseOnly' }, keyCheck: { result: 'ok' } });
    expect(state().broadcasts[0].match).toEqual({ kind: 'caseOnly', savedSsid: '1234-comp' });
  });

  test('another name from the team waits for "Test connection"', async () => {
    const { runner, scanner, state } = setup([stalled({ ssid: '1234-Practice' })]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234')].join('\n');
    await scanner.start();
    await flush();
    expect(state().stalls[0]).toMatchObject({ broadcast: { ssid: 'FRC-1234', match: 'otherName' } });
    expect(state().stalls[0].keyCheck).toBeUndefined();
    expect(runner.joins()).toBe(0);

    scanner.test('slot3');
    await flush();
    expect(runner.joins()).toBe(1);
    expect(state().stalls[0].keyCheck?.result).toBe('ok');
  });

  test('"Test connection" re-tries, but not within the rate limit, and only for a stall', async () => {
    let t = NOW;
    const { runner, scanner } = setup([stalled()], { now: () => t });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(runner.joins()).toBe(1);

    scanner.test('slot3');
    await flush();
    expect(runner.joins()).toBe(1); // too soon

    t += 31_000;
    scanner.test('slot3');
    await flush();
    expect(runner.joins()).toBe(2);

    scanner.test('slot1'); // nothing stalled there
    await flush();
    expect(runner.joins()).toBe(2);
  });

  test('no answer from the robot counts as unreachable', async () => {
    const { runner, scanner, state } = setup([stalled()], { keyCheckTimeoutMs: 20 });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'silent';
    await scanner.start();
    await flush();
    await flush();
    expect(state().stalls[0].keyCheck?.result).toBe('unreachable');
  });

  test('an open network has no passphrase to check', async () => {
    const { runner, scanner, state } = setup([stalled()]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp', -50, '[ESS]')].join('\n');
    await scanner.start();
    await flush();
    expect(state().stalls[0].keyCheck?.result).toBe('open');
    expect(runner.joins()).toBe(0);
  });

  test('a robot that goes quiet drops off the list', async () => {
    let t = NOW;
    const { runner, scanner, state } = setup([], { now: () => t });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(state().broadcasts).toHaveLength(1);

    runner.scanText = HEADER;
    t += 60_000;
    await scanner.scanOnce();
    expect(state().broadcasts).toHaveLength(1); // not yet — scans miss things
    t += 60_000;
    await scanner.scanOnce();
    expect(state().broadcasts).toHaveLength(0);
  });
});

describe("trying a team's other passphrases", () => {
  test('known passphrases first, then the team number twice; distinct, valid, a few', () => {
    expect(candidateKeys(1234, ['passphrase1', 'passphrase2', 'passphrase1'])).toEqual([
      'passphrase1',
      'passphrase2',
      '12341234',
    ]);
    expect(candidateKeys(1234, ['short', '12341234'])).toEqual(['12341234']);
    // A 3-digit team's pattern is too short for WPA
    expect(candidateKeys(254, ['passphrase1'])).toEqual(['passphrase1']);
    const many = ['key00001', 'key00002', 'key00003', 'key00004', 'key00005', 'key00006', 'key00007'];
    expect(candidateKeys(1234, many)).toEqual([...many.slice(0, 5), '12341234']);
  });
});

describe('recovering a forgotten passphrase', () => {
  const KEYS = ['passphrase1', 'otherkey1', 'otherkey2', '12341234'];

  test("a saved robot its own passphrase doesn't open: the team's others are tried until one works", async () => {
    const found: KeyFound[] = [];
    const saved: SavedRobot[] = [{ ssid: '1234-Comp', wpaKey: 'passphrase1' }];
    const { runner, scanner, state } = setup([], {
      saved,
      teamKeys: () => ['passphrase1', 'otherkey1', 'otherkey2'],
      onKeyFound: f => {
        found.push(f);
        saved[0] = { ssid: f.robotSsid, wpaKey: f.wpaKey };
      },
    });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.rightKey = 'otherkey2';
    await scanner.start();
    await flush();
    // Stops at the one that works
    expect(runner.triedKeys(KEYS)).toEqual(['passphrase1', 'otherkey1', 'otherkey2']);
    expect(found).toEqual([
      { heardSsid: 'FRC-1234-Comp', robotSsid: '1234-Comp', savedSsid: '1234-Comp', wpaKey: 'otherkey2' },
    ]);
    expect(state().broadcasts[0].keyCheck).toMatchObject({ result: 'ok', recovered: true });
    expect(state().broadcasts[0].keySearch).toBeUndefined();
    expect(JSON.stringify(state())).not.toContain('otherkey');
  });

  test('the team number twice is tried last', async () => {
    const found: KeyFound[] = [];
    const { runner, scanner } = setup([], { teamKeys: () => ['passphrase1'], onKeyFound: f => found.push(f) });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.rightKey = '12341234';
    await scanner.start();
    await flush();
    expect(runner.triedKeys(KEYS)).toEqual(['passphrase1', '12341234']);
    expect(found[0].wpaKey).toBe('12341234');
  });

  test('when none works, the search says so and stops', async () => {
    const { runner, scanner, state } = setup([], { teamKeys: () => ['passphrase1', 'otherkey1'] });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.rightKey = 'nobodyknows';
    await scanner.start();
    await flush();
    expect(runner.joins()).toBe(3);
    expect(state().broadcasts[0]).toMatchObject({ keyCheck: { result: 'wrongKey' }, keySearch: 'exhausted' });
    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(3);
  });

  test('a name the team never saved is searched, and found under the name it broadcasts', async () => {
    const found: KeyFound[] = [];
    const { runner, scanner } = setup([], {
      teamKeys: () => ['passphrase1'],
      onKeyFound: f => found.push(f),
    });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Practice')].join('\n');
    await scanner.start();
    await flush();
    expect(found).toEqual([{ heardSsid: 'FRC-1234-Practice', robotSsid: '1234-Practice', wpaKey: 'passphrase1' }]);
  });

  test('a team pFMS has no passphrases for is left alone', async () => {
    const { runner, scanner } = setup([], { teamKeys: () => [] });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-5678')].join('\n');
    await scanner.start();
    await flush();
    expect(runner.joins()).toBe(0);
  });

  test('a name differing only in capitals, opened by the saved passphrase, is found under the name it uses', async () => {
    const found: KeyFound[] = [];
    const { runner, scanner } = setup([], {
      saved: ['1234-comp'],
      teamKeys: () => ['passphrase1'],
      onKeyFound: f => found.push(f),
    });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(found).toEqual([
      { heardSsid: 'FRC-1234-Comp', robotSsid: '1234-Comp', savedSsid: '1234-comp', wpaKey: 'passphrase1' },
    ]);
    expect(runner.joins()).toBe(1);
  });

  test('a stalled connection whose field passphrase is wrong: found for that station', async () => {
    const found: KeyFound[] = [];
    const { runner, scanner } = setup([stalled()], {
      teamKeys: () => ['passphrase1', 'otherkey1'],
      onKeyFound: f => found.push(f),
    });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.rightKey = 'otherkey1';
    await scanner.start();
    await flush();
    expect(found).toEqual([
      {
        heardSsid: 'FRC-1234-Comp',
        robotSsid: '1234-Comp',
        savedSsid: '1234-Comp',
        station: 'slot3',
        wpaKey: 'otherkey1',
      },
    ]);
  });

  test("a robot that doesn't answer is tried again after a while", async () => {
    let t = NOW;
    const { runner, scanner, state } = setup([], {
      now: () => t,
      keyCheckTimeoutMs: 20,
      retryUnreachableMs: 120_000,
    });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'silent';
    await scanner.start();
    await flush();
    await flush();
    expect(state().broadcasts[0].keyCheck?.result).toBe('unreachable');
    // No answer is not a wrong passphrase: nothing else is tried
    expect(state().broadcasts[0].keySearch).toBeUndefined();

    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(1);
    t += 120_000;
    runner.outcome = 'connect';
    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(2);
    expect(state().broadcasts[0].keyCheck?.result).toBe('ok');
  });
});

describe('putting a robot on the field by itself', () => {
  function arrival(over: Parameters<typeof setup>[1] = {}) {
    const enabled: [string, string][] = [];
    const placed = new Set<string>();
    const s = setup([], {
      placed: ssid => placed.has(ssid),
      enableRobot: (r, why) => {
        enabled.push([r.ssid, why]);
        placed.add(r.ssid);
      },
      ...over,
    });
    s.runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    return { ...s, enabled, placed };
  }

  test('a saved robot heard, its passphrase checked: on the field once', async () => {
    const { scanner, enabled } = arrival();
    await scanner.start();
    await flush();
    expect(enabled).toEqual([['1234-Comp', 'arrived']]);
    await scanner.scanOnce();
    await flush();
    expect(enabled).toHaveLength(1);
  });

  test('not with a wrong passphrase', async () => {
    const { runner, scanner, enabled } = arrival();
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(enabled).toEqual([]);
  });

  test('not when the team turned it off for that robot', async () => {
    const { scanner, enabled } = arrival({ saved: [{ ssid: '1234-Comp', wpaKey: 'passphrase1', autoConnect: false }] });
    await scanner.start();
    await flush();
    expect(enabled).toEqual([]);
  });

  test('not during a match: it goes on once the match is over', async () => {
    let matchOn = true;
    const { scanner, enabled } = arrival({ canAutoConnect: () => !matchOn });
    await scanner.start();
    await flush();
    expect(enabled).toEqual([]);
    matchOn = false;
    await scanner.scanOnce();
    await flush();
    expect(enabled).toEqual([['1234-Comp', 'arrived']]);
  });

  test('a robot released while still on is not put back; powered off and on again, it is', async () => {
    let t = NOW;
    const { runner, scanner, enabled, placed } = arrival({ now: () => t });
    await scanner.start();
    await flush();
    expect(enabled).toHaveLength(1);

    placed.delete('1234-Comp'); // released (by the team, idle release, after a match)
    t += 20_000;
    await scanner.scanOnce();
    await flush();
    expect(enabled).toHaveLength(1);

    runner.scanText = HEADER; // powered off
    t += 100_000;
    await scanner.scanOnce();
    expect(scanner.getState().broadcasts).toEqual([]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    t += 20_000;
    await scanner.scanOnce();
    await flush();
    expect(enabled).toEqual([
      ['1234-Comp', 'arrived'],
      ['1234-Comp', 'arrived'],
    ]);
    expect(runner.joins()).toBe(2); // checked afresh on its return
  });

  test('gone quiet while on the field is not leaving', async () => {
    let t = NOW;
    const { runner, scanner, enabled, placed } = arrival({ now: () => t });
    await scanner.start();
    await flush();
    runner.scanText = HEADER; // stops broadcasting while on the field
    t += 100_000;
    await scanner.scanOnce();
    placed.delete('1234-Comp'); // released, broadcasting again
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    t += 20_000;
    await scanner.scanOnce();
    await flush();
    expect(enabled).toHaveLength(1);
  });

  test('a robot already on the field when first heard counts as connected', async () => {
    const { scanner, enabled, placed } = arrival();
    placed.add('1234-Comp');
    await scanner.start();
    await flush();
    placed.delete('1234-Comp');
    await scanner.scanOnce();
    await flush();
    expect(enabled).toEqual([]);
  });

  test("a team's request waits for the check, even with auto-connect off", async () => {
    const { runner, scanner, enabled, state } = arrival({
      saved: [{ ssid: '1234-Comp', wpaKey: 'passphrase1', autoConnect: false }],
    });
    runner.scanText = HEADER; // not on yet
    await scanner.start();
    await flush();
    scanner.requestConnect('1234-Comp');
    await flush();
    expect(state().awaiting).toEqual(['1234-Comp']);
    expect(enabled).toEqual([]);

    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.scanOnce();
    await flush();
    expect(enabled).toEqual([['1234-Comp', 'asked']]);
    expect(state().awaiting).toBeUndefined();
  });

  test("a team's request with the wrong passphrase never reaches the field", async () => {
    const { runner, scanner, enabled, state } = arrival();
    runner.outcome = 'wrongKey';
    await scanner.start();
    scanner.requestConnect('1234-Comp');
    await flush();
    expect(enabled).toEqual([]);
    expect(state().awaiting).toEqual(['1234-Comp']);
    expect(state().broadcasts[0].keyCheck?.result).toBe('wrongKey');
  });

  test('a recovered passphrase is saved, and then the robot goes on', async () => {
    const saved: SavedRobot[] = [{ ssid: '1234-Comp', wpaKey: 'passphrase1' }];
    const { runner, scanner, enabled } = arrival({
      saved,
      teamKeys: () => ['passphrase1', 'otherkey1'],
      onKeyFound: f => (saved[0] = { ssid: f.robotSsid, wpaKey: f.wpaKey }),
    });
    runner.rightKey = 'otherkey1';
    await scanner.start();
    await flush();
    expect(enabled).toEqual([['1234-Comp', 'arrived']]);
  });
});
