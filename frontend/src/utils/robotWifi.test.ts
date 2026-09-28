import { describe, expect, test } from 'bun:test';
import type { RobotWifiBroadcast, RobotWifiScanState } from '../../../src/types';
import {
  broadcastsForTeam,
  describeKeyForTeam,
  describeNameForTeam,
  robotWifiStaffIssues,
  suffixOf,
} from './robotWifi';

function heard(over: Partial<RobotWifiBroadcast> = {}): RobotWifiBroadcast {
  return {
    ssid: 'FRC-1234-Comp',
    team: 1234,
    robotSsid: '1234-Comp',
    signal: -55,
    frequency: 2437,
    lastSeen: 0,
    match: { kind: 'exact', savedSsid: '1234-Comp' },
    ...over,
  };
}

function scan(broadcasts: RobotWifiBroadcast[], over: Partial<RobotWifiScanState> = {}): RobotWifiScanState {
  return { type: 'robotWifiScan', status: 'running', interfaces: [], broadcasts, ...over };
}

describe('for the team', () => {
  test('the suffix to type comes straight from what the robot broadcasts', () => {
    expect(suffixOf('1234-Comp')).toBe('Comp');
    expect(suffixOf('1234')).toBe('');
    expect(suffixOf('1234-A-B')).toBe('A-B');
  });

  test('a capitalization-only mismatch is an error that says what to type', () => {
    const line = describeNameForTeam(heard({ match: { kind: 'caseOnly', savedSsid: '1234-comp' } }));
    expect(line.severity).toBe('error');
    expect(line.text).toContain('1234-comp');
    expect(line.text).toContain('Add it again as 1234-Comp');
  });

  test('an exact match is good news; an unknown robot is an invitation', () => {
    expect(describeNameForTeam(heard()).severity).toBe('success');
    expect(describeNameForTeam(heard({ match: { kind: 'unknown' } })).severity).toBe('info');
  });

  test('a wrong passphrase says it was the 2.4 GHz network that refused it', () => {
    const line = describeKeyForTeam(heard({ keyCheck: { result: 'wrongKey', at: 0, savedSsid: '1234-Comp' } }));
    expect(line?.severity).toBe('error');
    expect(line?.text).toContain('2.4 GHz');
    expect(describeKeyForTeam(heard())).toBeNull();
  });

  test('only this team’s robots', () => {
    const s = scan([heard(), heard({ ssid: 'FRC-254', team: 254, robotSsid: '254' })]);
    expect(broadcastsForTeam(s, 254).map(b => b.ssid)).toEqual(['FRC-254']);
    expect(broadcastsForTeam(null, 254)).toEqual([]);
  });
});

describe('for the CSA', () => {
  test('healthy robots say nothing', () => {
    expect(robotWifiStaffIssues(scan([heard({ keyCheck: { result: 'ok', at: 0, savedSsid: '1234-Comp' } })]))).toEqual(
      [],
    );
    expect(robotWifiStaffIssues(null)).toEqual([]);
  });

  test('capitals mismatch is critical, a wrong passphrase a warning, an unsaved robot a note', () => {
    const issues = robotWifiStaffIssues(
      scan([
        heard({ match: { kind: 'caseOnly', savedSsid: '1234-comp' } }),
        heard({
          ssid: 'FRC-254',
          team: 254,
          robotSsid: '254',
          match: { kind: 'exact', savedSsid: '254' },
          keyCheck: { result: 'wrongKey', at: 0, savedSsid: '254' },
        }),
        heard({ ssid: 'FRC-971-B', team: 971, robotSsid: '971-B', match: { kind: 'unknown' } }),
      ]),
    );
    expect(issues.map(i => [i.team, i.severity])).toEqual([
      [1234, 'critical'],
      [254, 'warning'],
      [971, 'info'],
    ]);
  });

  test('a stopped scan is reported once, field-wide', () => {
    const issues = robotWifiStaffIssues(scan([], { status: 'error', error: 'wlan0 is not a wireless interface here' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('wlan0');
  });
});
