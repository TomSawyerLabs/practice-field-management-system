import { describe, expect, test } from 'bun:test';
import { isUpdateSetupSettings } from './types.js';
import type { QueueEntry } from './types.js';
import {
  hostTeamsInEffect,
  isRobotOfTeams,
  queueInUse,
  robotNameOf,
  teamLabelAmong,
  teamOfSsid,
  teamSubnet,
} from './utils.js';
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
  const queue = (lineOpen: boolean, ...statuses: QueueEntry['status'][]) => ({
    settings: { lineOpen, shape: { red: 3, blue: 3 }, noShowMinutes: null, allowShort: true },
    entries: statuses.map(status => ({ status }) as QueueEntry),
  });

  test('every robot of a host team counts, and no other', () => {
    expect(isRobotOfTeams('1967-Elsa', settings.hostTeams)).toBe(true);
    expect(isRobotOfTeams('5940', settings.hostTeams)).toBe(true);
    expect(isRobotOfTeams('254', settings.hostTeams)).toBe(false);
    expect(isRobotOfTeams('robot-1967', settings.hostTeams)).toBe(false);
  });

  test('the queue is in use with its line open, or a match lined up or playing', () => {
    expect(queueInUse(queue(true))).toBe(true);
    expect(queueInUse(queue(false, 'queued'))).toBe(true);
    expect(queueInUse(queue(false, 'onDeck'))).toBe(true);
    expect(queueInUse(queue(false, 'playing'))).toBe(true);
    expect(queueInUse(queue(false))).toBe(false);
    expect(queueInUse(queue(false, 'played', 'skipped'))).toBe(false);
  });

  test('nobody is the host while the queue is in use, and the list is back once it is done', () => {
    expect(hostTeamsInEffect(settings, queue(true))).toEqual([]);
    expect(hostTeamsInEffect(settings, queue(false, 'queued', 'played'))).toEqual([]);
    expect(hostTeamsInEffect(settings, queue(false, 'played'))).toEqual([1967, 5940]);
  });

  test('a page with no queue state yet, or a field with no host team', () => {
    expect(hostTeamsInEffect(settings, null)).toEqual([1967, 5940]);
    expect(hostTeamsInEffect({}, queue(false))).toEqual([]);
  });

  test('only an admin can change them, and only to real team numbers', () => {
    expect(accessOf('updateSetupSettings')).toBe('admin');
    const update = (settings: unknown) => isUpdateSetupSettings({ type: 'updateSetupSettings', settings });
    expect(update({ hostTeams: [1967, 5940] })).toBe(true);
    expect(update({ hostTeams: [] })).toBe(true);
    expect(update({ hostTeams: [1967.5] })).toBe(false);
    expect(update({ hostTeams: [0] })).toBe(false);
    expect(update({ hostTeams: '1967' })).toBe(false);
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
