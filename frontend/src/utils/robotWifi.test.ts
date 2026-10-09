import { describe, expect, test } from 'bun:test';
import type { RobotWifiBroadcast, RobotWifiScanState, RobotWifiStall } from '../../../src/types';
import {
  broadcastsForTeam,
  describeNameForTeam,
  describeStallForTeam,
  robotRowWifi,
  robotWifiStaffIssues,
  stallsForTeam,
  suffixOf,
} from './robotWifi';

const NOW = 10_000_000;

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

/** Team 1234's robot, set up as 1234-Comp, not joined for 2 minutes. */
function stall(over: Partial<RobotWifiStall> = {}): RobotWifiStall {
  return {
    station: 'slot3',
    team: 1234,
    fieldSsid: '1234-Comp',
    since: NOW - 125_000,
    broadcast: { ssid: 'FRC-1234-Comp', robotSsid: '1234-Comp', signal: -55, match: 'exact' },
    ...over,
  };
}

const key = (result: NonNullable<RobotWifiStall['keyCheck']>['result']) => ({
  keyCheck: { result, at: NOW, fieldSsid: '1234-Comp' },
});

function scan(
  broadcasts: RobotWifiBroadcast[],
  stalls: RobotWifiStall[] = [],
  over: Partial<RobotWifiScanState> = {},
): RobotWifiScanState {
  return { type: 'robotWifiScan', status: 'running', interfaces: [], broadcasts, stalls, ...over };
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

  test('only this team’s robots and stalls', () => {
    const s = scan([heard(), heard({ ssid: 'FRC-254', team: 254, robotSsid: '254' })], [stall()]);
    expect(broadcastsForTeam(s, 254).map(b => b.ssid)).toEqual(['FRC-254']);
    expect(broadcastsForTeam(null, 254)).toEqual([]);
    expect(stallsForTeam(s, 1234)).toHaveLength(1);
    expect(stallsForTeam(s, 254)).toEqual([]);
  });
});

describe('a robot taking too long to join, for the team', () => {
  test('says how long, and that the robot is on the air', () => {
    const { severity, lines } = describeStallForTeam(stall(), NOW);
    expect(severity).toBe('warning');
    expect(lines[0]).toBe(
      "Your robot hasn't joined the field after 2 min. We can hear it as FRC-1234-Comp, so it is on.",
    );
  });

  test('a wrong passphrase is an error, and says it was the 2.4 GHz network that refused it', () => {
    const { severity, lines } = describeStallForTeam(stall(key('wrongKey')), NOW);
    expect(severity).toBe('error');
    expect(lines[1]).toContain('passphrase the field is using is wrong');
    expect(lines[1]).toContain('2.4 GHz');
  });

  test('a passphrase that works points at the radio instead', () => {
    const { severity, lines } = describeStallForTeam(stall(key('ok')), NOW);
    expect(severity).toBe('warning');
    expect(lines[1]).toContain('correct');
    expect(lines[1]).toContain('power-cycling');
  });

  test("a passphrase that works asks after the team's own AP, unless the 6 GHz watch is looking", () => {
    expect(describeStallForTeam(stall(key('ok')), NOW).lines[2]).toContain('your own access point');
    expect(describeStallForTeam(stall(key('ok')), NOW, { sixGhzWatching: true }).lines).toHaveLength(2);
    // Only when the passphrase worked: otherwise there is a likelier cause
    expect(describeStallForTeam(stall(key('wrongKey')), NOW).lines.join(' ')).not.toContain('own access point');

    const staff = (watching: boolean) =>
      robotWifiStaffIssues(scan([heard()], [stall(key('ok'))]), NOW, { sixGhzWatching: watching })[0].fix;
    expect(staff(false)).toContain('own access point');
    expect(staff(true)).not.toContain('own access point');
  });

  test('capitals that differ from the field set-up are an error with the name to use', () => {
    const { severity, lines } = describeStallForTeam(
      stall({
        fieldSsid: '1234-comp',
        broadcast: { ssid: 'FRC-1234-Comp', robotSsid: '1234-Comp', signal: -55, match: 'caseOnly' },
      }),
      NOW,
    );
    expect(severity).toBe('error');
    expect(lines[0]).toContain('set up for 1234-comp');
    expect(lines[0]).toContain('Add it again as 1234-Comp');
  });

  test('another name from the team explains what Test connection will try', () => {
    const { lines } = describeStallForTeam(
      stall({ broadcast: { ssid: 'FRC-1234', robotSsid: '1234', signal: -55, match: 'otherName' } }),
      NOW,
    );
    expect(lines[0]).toContain('the robot we can hear is FRC-1234');
    expect(lines[1]).toBe("Test connection tries the field's passphrase for 1234-Comp on FRC-1234.");
  });
});

describe("on a saved robot's row", () => {
  test('a robot off the field on the air under its saved name is the one to enable', () => {
    const w = robotRowWifi(scan([heard()]), '1234-Comp', null);
    expect(w?.onAir).toBe(true);
    expect(w?.chips.map(c => c.text)).toEqual(['Radio on']);
    expect(w?.line?.text).toContain('FRC-1234-Comp');
  });

  test("other saved robots aren't marked", () => {
    expect(robotRowWifi(scan([heard()]), '1234-Practice', null)).toBeNull();
  });

  test('a name that differs in capitals marks the saved row, not as on the air', () => {
    const w = robotRowWifi(
      scan([
        heard({ ssid: 'FRC-1234-comp', robotSsid: '1234-comp', match: { kind: 'caseOnly', savedSsid: '1234-Comp' } }),
      ]),
      '1234-Comp',
      null,
    );
    expect(w?.onAir).toBe(false);
    expect(w?.chips).toEqual([{ severity: 'error', text: 'Name differs' }]);
    expect(w?.line?.text).toContain('1234-comp');
  });

  test('an exact match wins over a capitals-only one', () => {
    const w = robotRowWifi(
      scan([
        heard({ ssid: 'FRC-1234-comp', robotSsid: '1234-comp', match: { kind: 'caseOnly', savedSsid: '1234-Comp' } }),
        heard(),
      ]),
      '1234-Comp',
      null,
    );
    expect(w?.onAir).toBe(true);
  });

  test('a robot on the field shows only what its passphrase check found', () => {
    expect(robotRowWifi(scan([heard()]), '1234-Comp', 'slot3')).toBeNull();
    const wrong = robotRowWifi(scan([heard()], [stall(key('wrongKey'))]), '1234-Comp', 'slot3');
    expect(wrong?.chips).toEqual([{ severity: 'error', text: 'Passphrase wrong' }]);
    const ok = robotRowWifi(scan([heard()], [stall(key('ok'))]), '1234-Comp', 'slot3');
    expect(ok?.chips).toEqual([{ severity: 'success', text: 'Passphrase OK' }]);
  });

  test("another station's stall doesn't mark this row", () => {
    expect(robotRowWifi(scan([heard()], [stall(key('wrongKey'))]), '1234-Comp', 'slot1')).toBeNull();
  });

  test('nothing while the scan is off', () => {
    expect(robotRowWifi(scan([heard()], [], { status: 'off' }), '1234-Comp', null)).toBeNull();
  });
});

describe('for the CSA', () => {
  test('healthy robots say nothing', () => {
    expect(robotWifiStaffIssues(scan([heard()]), NOW)).toEqual([]);
    expect(robotWifiStaffIssues(null)).toEqual([]);
  });

  test('a capitals mismatch is critical; an unsaved robot a note', () => {
    const issues = robotWifiStaffIssues(
      scan([
        heard({ match: { kind: 'caseOnly', savedSsid: '1234-comp' } }),
        heard({ ssid: 'FRC-971-B', team: 971, robotSsid: '971-B', match: { kind: 'unknown' } }),
      ]),
      NOW,
    );
    expect(issues.map(i => [i.team, i.severity])).toEqual([
      [1234, 'critical'],
      [971, 'info'],
    ]);
  });

  test('a stalled robot is a warning, critical once its passphrase is wrong; said once per robot', () => {
    const pending = robotWifiStaffIssues(scan([heard()], [stall()]), NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'robotWifi-stall-slot3',
      severity: 'warning',
      title: "Team 1234's robot hasn't joined the field after 2 min",
    });

    const wrong = robotWifiStaffIssues(scan([heard()], [stall(key('wrongKey'))]), NOW);
    expect(wrong[0].severity).toBe('critical');
    expect(wrong[0].detail).toContain('does not open');

    // The stall already covers the capitals mismatch on the same robot
    const caseOnly = robotWifiStaffIssues(
      scan(
        [heard({ match: { kind: 'caseOnly', savedSsid: '1234-comp' } })],
        [stall({ broadcast: { ssid: 'FRC-1234-Comp', robotSsid: '1234-Comp', signal: -55, match: 'caseOnly' } })],
      ),
      NOW,
    );
    expect(caseOnly.map(i => i.id)).toEqual(['robotWifi-stall-slot3']);
    expect(caseOnly[0].severity).toBe('critical');
  });

  test('a stopped scan is reported once, field-wide', () => {
    const issues = robotWifiStaffIssues(
      scan([], [], { status: 'error', error: 'wlan0 is not a wireless interface here' }),
      NOW,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('wlan0');
  });
});
