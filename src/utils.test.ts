import { describe, expect, test } from 'bun:test';
import { robotNameOf, teamLabelAmong, teamOfSsid } from './utils.js';

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
