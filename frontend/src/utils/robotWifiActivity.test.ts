import { describe, expect, test } from 'bun:test';
import type { RobotWifiBroadcast, RobotWifiScanState } from '../../../src/types';
import { robotWifiUnderWay } from './robotWifiActivity';

const heard = (over: Partial<RobotWifiBroadcast>): RobotWifiBroadcast => ({
  ssid: 'FRC-1234-Comp',
  team: 1234,
  robotSsid: '1234-Comp',
  signal: -50,
  frequency: 2437,
  lastSeen: 0,
  match: { kind: 'exact', savedSsid: '1234-Comp' },
  ...over,
});
const scan = (over: Partial<RobotWifiScanState>): RobotWifiScanState => ({
  type: 'robotWifiScan',
  status: 'running',
  interfaces: [],
  broadcasts: [],
  stalls: [],
  ...over,
});

describe("the CSA page's robot Wi-Fi panel: what is under way", () => {
  test('nothing under way, nothing said', () => {
    expect(robotWifiUnderWay(null, 0)).toEqual([]);
    expect(
      robotWifiUnderWay(scan({ broadcasts: [heard({ keyCheck: { result: 'ok', at: 0, fieldSsid: 'x' } })] }), 0),
    ).toEqual([]);
  });

  test('a reconfiguration coming up, and who it waits for', () => {
    const s = scan({ upcoming: { at: 4_000, robots: ['1234-Comp', '5678'], waitingFor: ['254'] } });
    expect(robotWifiUnderWay(s, 0)).toEqual([
      'Field Wi-Fi reconfiguration in 4 s to add 1234-Comp, 5678, once robots are disabled',
      'Waiting for 254 to finish its check, to join it',
    ]);
    expect(robotWifiUnderWay(s, 5_000)[0]).toBe(
      'Field Wi-Fi reconfiguration to add 1234-Comp, 5678, once robots are disabled',
    );
  });

  test('checks, searches, retries and team requests', () => {
    const s = scan({
      awaiting: ['5678'],
      broadcasts: [
        heard({ keyCheck: { result: 'checking', at: 0, fieldSsid: 'x' } }),
        heard({ robotSsid: '254', keySearch: 'searching', keyCheck: { result: 'wrongKey', at: 0, fieldSsid: 'x' } }),
        heard({ robotSsid: '971', keyCheck: { result: 'unreachable', at: 0, fieldSsid: 'x', retryAt: 120_000 } }),
      ],
    });
    expect(robotWifiUnderWay(s, 0)).toEqual([
      '5678: the team asked to connect it; waiting for its passphrase to check out on the robot',
      '1234-Comp: checking its passphrase on the robot',
      "254: trying the team's other passphrases",
      "971: didn't answer its passphrase check; trying again in 2 min",
    ]);
  });
});
