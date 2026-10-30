import { describe, expect, test } from 'bun:test';
import type { RobotEStop, RobotEStopOrigin } from '../../../src/types';
import { describeRobotEStop, robotEStopStaffIssues } from './robotEStop';

const eStop = (origin: RobotEStopOrigin): RobotEStop => ({ team: 114, since: 1_000, origin });

describe('describeRobotEStop', () => {
  test('always says to power cycle, and that nothing else clears it', () => {
    const a = describeRobotEStop(eStop({ kind: 'already' }));
    expect(a.subtitle).toBe('Power cycle the robot to clear it');
    expect(a.lines[0]).toContain('will not release it');
  });

  test('the laptop driving it', () => {
    const a = describeRobotEStop(
      eStop({ kind: 'ds', laptop: '10.55.231.82', hostname: 'Bird', drives: 'slot2', drivesThis: true }),
    );
    expect(a.lines[1]).toBe(
      'It came from the Driver Station on Bird, the laptop driving this robot. The space bar is the usual cause.',
    );
  });

  test('the laptop driving the team’s other robot', () => {
    const a = describeRobotEStop(
      eStop({ kind: 'ds', laptop: '10.55.150.65', drives: 'slot1', drivesRobot: '114', drivesThis: false }),
    );
    expect(a.lines[1]).toBe('It came from the Driver Station at 10.55.150.65, the laptop driving 114, not this one.');
  });

  test('a Driver Station the field can’t see', () => {
    expect(describeRobotEStop(eStop({ kind: 'unseen' })).lines[1]).toContain('tethered');
  });
});

describe('robotEStopStaffIssues', () => {
  test('a critical issue per latched robot', () => {
    const issues = robotEStopStaffIssues({ slot2: eStop({ kind: 'unseen' }) }, () => '114-TestBird');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'robot-estop-slot2',
      severity: 'critical',
      station: 'slot2',
      title: '114-TestBird is e-stopped in the robot itself',
    });
    expect(issues[0].fix).toContain('power cycle');
  });
});
