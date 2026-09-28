import { afterEach, describe, expect, test } from 'bun:test';
import {
  keyMgmtFor,
  matchSavedRobot,
  parseScanResults,
  parseWpaEvent,
  robotOfBroadcast,
  RobotWifiScanner,
  type SavedRobot,
  type WifiRunner,
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
    });
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

let scanner: RobotWifiScanner | null = null;
afterEach(() => {
  scanner?.stop();
  scanner = null;
});

function setup(saved: SavedRobot[], overrides: { now?: () => number; keyCheckTimeoutMs?: number } = {}) {
  const runner = new FakeRunner();
  let state: RobotWifiScanState | null = null;
  scanner = new RobotWifiScanner({
    iface: 'wlan0',
    runner,
    savedRobots: () => saved,
    onChange: s => (state = s),
    scanIntervalMs: 1_000_000, // tests drive scans by hand
    scanSettleMs: 0,
    ...overrides,
  });
  return { runner, scanner, state: () => state! };
}

const comp: SavedRobot = { ssid: '1234-Comp', wpaKey: 'passphrase1', wpaKeyHash: 'hash-a' };

describe('the scanner', () => {
  test('reports a robot that matches a saved one, and checks its passphrase once', async () => {
    const { runner, scanner, state } = setup([comp]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp'), row('aa:bb:cc:dd:ee:09', 'Guest')].join('\n');
    await scanner.start();
    await flush();

    const [b] = state().broadcasts;
    expect(state().broadcasts).toHaveLength(1); // the guest network is not a robot
    expect(b).toMatchObject({ ssid: 'FRC-1234-Comp', team: 1234, robotSsid: '1234-Comp', match: { kind: 'exact' } });
    expect(b.keyCheck).toMatchObject({ result: 'ok', savedSsid: '1234-Comp' });
    expect(runner.calls).toContainEqual(['set_network', '0', 'ssid', '"FRC-1234-Comp"']);
    expect(runner.calls).toContainEqual(['remove_network', '0']); // leaves the robot alone afterwards

    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(1); // never twice for the same passphrase
  });

  test('never puts a passphrase in the state it broadcasts', async () => {
    const { runner, scanner, state } = setup([comp]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(JSON.stringify(state())).not.toContain('passphrase1');
  });

  test('a changed passphrase is checked afresh', async () => {
    const saved = [comp];
    const { runner, scanner, state } = setup(saved);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(state().broadcasts[0].keyCheck?.result).toBe('wrongKey');

    saved[0] = { ...comp, wpaKey: 'passphrase2', wpaKeyHash: 'hash-b' };
    runner.outcome = 'connect';
    await scanner.scanOnce();
    await flush();
    expect(runner.joins()).toBe(2);
    expect(state().broadcasts[0].keyCheck?.result).toBe('ok');
  });

  test('capitalization-only match is flagged and still checked with the saved passphrase', async () => {
    const { runner, scanner, state } = setup([{ ...comp, ssid: '1234-comp' }]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    await scanner.start();
    await flush();
    expect(state().broadcasts[0].match).toEqual({ kind: 'caseOnly', savedSsid: '1234-comp' });
    expect(state().broadcasts[0].keyCheck?.result).toBe('ok');
  });

  test('a robot the team has not saved is reported but not joined', async () => {
    const { runner, scanner, state } = setup([comp]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Practice')].join('\n');
    await scanner.start();
    await flush();
    expect(state().broadcasts[0].match).toEqual({ kind: 'unknown' });
    expect(runner.joins()).toBe(0);
  });

  test('no answer from the robot counts as unreachable', async () => {
    const { runner, scanner, state } = setup([comp], { keyCheckTimeoutMs: 20 });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'silent';
    await scanner.start();
    await flush();
    await flush();
    expect(state().broadcasts[0].keyCheck?.result).toBe('unreachable');
  });

  test('an open network has no passphrase to check', async () => {
    const { runner, scanner, state } = setup([comp]);
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp', -50, '[ESS]')].join('\n');
    await scanner.start();
    await flush();
    expect(state().broadcasts[0].keyCheck?.result).toBe('open');
    expect(runner.joins()).toBe(0);
  });

  test('a robot that goes quiet drops off the list', async () => {
    let t = 1_000_000;
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

  test('"Check again" re-tries, but not within the rate limit', async () => {
    let t = 1_000_000;
    const { runner, scanner } = setup([comp], { now: () => t });
    runner.scanText = [HEADER, row('aa:bb:cc:dd:ee:01', 'FRC-1234-Comp')].join('\n');
    runner.outcome = 'wrongKey';
    await scanner.start();
    await flush();
    expect(runner.joins()).toBe(1);

    scanner.recheck('FRC-1234-Comp');
    await flush();
    expect(runner.joins()).toBe(1); // too soon

    t += 31_000;
    scanner.recheck('FRC-1234-Comp');
    await flush();
    expect(runner.joins()).toBe(2);
  });
});
