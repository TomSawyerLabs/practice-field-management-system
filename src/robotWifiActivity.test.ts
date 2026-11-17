import { describe, expect, test } from 'bun:test';
import { RobotWifiActivityLog } from './robotWifiActivity';

describe('the robot Wi-Fi activity log', () => {
  test('newest first, capped, and old entries dropped', () => {
    let now = 0;
    const log = new RobotWifiActivityLog({ max: 3, keepMs: 1_000, now: () => now });
    for (const robot of ['a', 'b', 'c', 'd']) {
      log.add(robot, 'heard');
      now += 100;
    }
    expect(log.list().map(e => e.robot)).toEqual(['d', 'c', 'b']);
    now = 1_150; // 'b' (at 100) is now more than 1 s old
    expect(log.list().map(e => e.robot)).toEqual(['d', 'c']);
    expect(log.list()[0]).toEqual({ at: 300, robot: 'd', text: 'heard', tone: 'info' });
  });
});
