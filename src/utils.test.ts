import { describe, expect, test } from 'bun:test';
import { isUpdateSetupSettings } from './types.js';
import { hostTeamsInEffect, isHostRobot, robotNameOf, teamLabelAmong, teamOfSsid, teamSubnet } from './utils.js';
import { accessOf } from './wsAccess.js';

describe('teamOfSsid', () => {
  test('reads the number before the first hyphen', () => {
    expect(teamOfSsid('1234-Comp')).toBe(1234);
    expect(teamOfSsid('5940')).toBe(5940);
  });
  test('null for nothing, or no leading number', () => {
    expect(teamOfSsid('')).toBeNull();
    expect(teamOfSsid(undefined)).toBeNull();
    expect(teamOfSsid('robot-1234')).toBeNull();
  });
});

describe('host teams', () => {
  const settings = { hostTeams: [1967, 5940] };

  test('every robot of a host team counts, and no other', () => {
    expect(isHostRobot('1967-Elsa', settings)).toBe(true);
    expect(isHostRobot('5940', settings)).toBe(true);
    expect(isHostRobot('254', settings)).toBe(false);
    expect(isHostRobot('robot-1967', settings)).toBe(false);
  });

  test('nobody is the host in a scrimmage, or with none set', () => {
    expect(hostTeamsInEffect({ ...settings, scrimmageMode: true })).toEqual([]);
    expect(isHostRobot('1967', { ...settings, scrimmageMode: true })).toBe(false);
    expect(isHostRobot('1967', {})).toBe(false);
  });

  test('only an admin can change them, and only to real team numbers', () => {
    expect(accessOf('updateSetupSettings')).toBe('admin');
    const update = (settings: unknown) => isUpdateSetupSettings({ type: 'updateSetupSettings', settings });
    expect(update({ hostTeams: [1967, 5940], scrimmageMode: true })).toBe(true);
    expect(update({ hostTeams: [] })).toBe(true);
    expect(update({ hostTeams: [1967.5] })).toBe(false);
    expect(update({ hostTeams: [0] })).toBe(false);
    expect(update({ hostTeams: '1967' })).toBe(false);
    expect(update({ scrimmageMode: 'yes' })).toBe(false);
  });
});

describe('teamLabelAmong', () => {
  const elsa = { teamNumber: 1967, robot: '1967-Elsa' };
  const lupe = { teamNumber: 1967, robot: '1967-Lupe' };
  const other = { teamNumber: 5940, robot: '5940' };

  test('just the number when the team has one robot here', () => {
    expect(teamLabelAmong(elsa, [elsa, other])).toBe('1967');
  });

  test("the robot's name when the team has two robots here", () => {
    expect(teamLabelAmong(elsa, [elsa, lupe, other])).toBe('1967 Elsa');
    expect(teamLabelAmong(lupe, [elsa, lupe, undefined])).toBe('1967 Lupe');
  });

  test('a robot without a suffix is named by its whole SSID; no team is null', () => {
    expect(robotNameOf('1967')).toBe('1967');
    expect(teamLabelAmong({ teamNumber: null, robot: null }, [elsa])).toBeNull();
    // Recorded before robots were tracked: no name to add
    expect(teamLabelAmong({ teamNumber: 1967 }, [{ teamNumber: 1967 }, lupe])).toBe('1967');
  });
});

describe('teamSubnet', () => {
  test('splits the team number into the 10.TE.AM octets', () => {
    expect(teamSubnet(1967)).toBe('10.19.67');
    expect(teamSubnet(254)).toBe('10.2.54');
    expect(teamSubnet(8)).toBe('10.0.8');
    expect(teamSubnet(10000)).toBe('10.100.0');
  });
});
