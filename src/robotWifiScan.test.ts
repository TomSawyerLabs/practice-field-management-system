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
  type ConnectAttempt,
  type WifiRunner,
  type WpaEvent,
} from './robotWifiScan.js';
import type { RobotWifiScanState } from './types.js';

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
    expect(r.ms).toBeLessThan(1_000);
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
  outcome: JoinOutcome = 'connect';
  private onLine: (line: string) => void = () => {};

  async start(onLine: (line: string) => void): Promise<void> {
    this.onLine = onLine;
  }

  async cli(...args: string[]): Promise<string> {
    this.calls.push(args);
    switch (args[0]) {
      case 'scan_results':
        return this.scanText;
      case 'add_network':
        return '0\n';
      case 'status':
        return 'wpa_state=SCANNING\n';
      case 'select_network':
        setTimeout(() => {
          if (this.outcome === 'connect') this.onLine('wlp0s20f3: CTRL-EVENT-CONNECTED - Connection to x completed');
          if (this.outcome === 'wrongKey')
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

const flush = () => new Promise(r => setTimeout(r, 30));

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
afterEach(() => {
  scanner?.stop();
  scanner = null;
});

function setup(
  attempts: ConnectAttempt[],
  overrides: { now?: () => number; keyCheckTimeoutMs?: number; saved?: string[] } = {},
) {
  const runner = new FakeRunner();
  let state: RobotWifiScanState | null = null;
  scanner = new RobotWifiScanner({
    iface: 'wlan0',
    runner,
    savedSsids: () => overrides.saved ?? ['1234-Comp'],
    connectAttempts: () => attempts,
    onChange: s => (state = s),
    scanIntervalMs: 1_000_000, // tests drive scans by hand
    scanSettleMs: 0,
    now: () => NOW,
    ...overrides,
  });
  return { runner, scanner, state: () => state! };
}

describe('the scanner', () => {
  test('hearing a robot matches its name against saved robots, but never joins it', async () => {
    const { runner, scanner, state } = setup([]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp'), row('aa:bb:cc:dd:ee:09', 'Guest')].join('\n');
    await scanner.start();
    await flush();
    expect(state().broadcasts).toHaveLength(1); // the guest network is not a robot
    expect(state().broadcasts[0]).toMatchObject({ ssid: 'FRC-1234-Comp', match: { kind: 'exact' } });
    expect(state().stalls).toEqual([]);
    expect(runner.joins()).toBe(0);
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
