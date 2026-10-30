import { describe, expect, test } from 'bun:test';
import { RobotEStopWatch } from './robotEStopWatch.js';
import type { StationName } from './types.js';

const TEAM = 114;
const MAIN = '10.55.150.65';
const TESTBIRD = '10.55.231.82';

function field() {
  const log: string[] = [];
  const driving = new Map<string, StationName>([
    [MAIN, 'slot1'],
    [TESTBIRD, 'slot2'],
  ]);
  const robots: Partial<Record<StationName, string>> = { slot1: '114', slot2: '114-TestBird' };
  const watch = new RobotEStopWatch({
    robotOn: s => robots[s],
    stationDrivenBy: laptop => driving.get(laptop),
    hostnameOf: laptop => (laptop === TESTBIRD ? 'DriverStation-2' : undefined),
    info: m => log.push(`info: ${m}`),
    warn: m => log.push(`warn: ${m}`),
  });
  /** A healthy stream to `station` from `laptop`, ending at `at`. */
  const healthy = (station: StationName, laptop: string, at: number) => {
    for (let t = at - 200; t <= at; t += 20) {
      watch.control(station, TEAM, laptop, false, t);
      watch.reply(station, TEAM, { eStop: false, enabled: false }, t + 2);
    }
  };
  return { watch, log, healthy, driving };
}

describe('RobotEStopWatch', () => {
  test('nothing latched, nothing to report', () => {
    const f = field();
    f.healthy('slot2', TESTBIRD, 1_000);
    expect(f.log).toEqual([]);
    expect(f.watch.snapshot().stations).toEqual({});
  });

  test('blames the laptop driving the robot, with how long after enable', () => {
    const f = field();
    f.healthy('slot2', TESTBIRD, 1_000);
    f.watch.reply('slot2', TEAM, { eStop: false, enabled: true }, 1_100);
    f.watch.control('slot2', TEAM, TESTBIRD, true, 1_115);
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_121);
    expect(f.watch.snapshot().stations.slot2).toEqual({
      team: TEAM,
      since: 1_121,
      origin: {
        kind: 'ds',
        laptop: TESTBIRD,
        hostname: 'DriverStation-2',
        drives: 'slot2',
        drivesRobot: '114-TestBird',
        drivesThis: true,
      },
    });
    expect(f.log).toEqual([
      'info: DS 10.55.231.82 (DriverStation-2) sent an e-stop to slot2 (114-TestBird): the laptop driving it',
      'warn: Robot e-stopped on slot2 (114-TestBird), 21 ms after it enabled: sent by DS 10.55.231.82 (DriverStation-2), the laptop driving it; laptops sending to it: 10.55.231.82 (DriverStation-2). It stays e-stopped until it reboots',
    ]);
  });

  test('names the team’s other laptop when its packet reached this robot', () => {
    const f = field();
    f.healthy('slot2', TESTBIRD, 1_000);
    f.watch.control('slot2', TEAM, MAIN, true, 1_010);
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_020);
    const o = f.watch.snapshot().stations.slot2!.origin;
    expect(o).toMatchObject({ kind: 'ds', laptop: MAIN, drives: 'slot1', drivesThis: false });
    expect(f.log.at(-1)).toContain('which drives slot1 (114), not this robot');
    expect(f.log.at(-1)).toContain('laptops sending to it: 10.55.231.82 (DriverStation-2), 10.55.150.65');
  });

  test('no e-stop bit crossed the field: a DS the field can’t see', () => {
    const f = field();
    f.healthy('slot2', TESTBIRD, 1_000);
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_020);
    expect(f.watch.snapshot().stations.slot2!.origin).toEqual({ kind: 'unseen' });
    expect(f.log.at(-1)).toContain('tethered, or on its own Wi-Fi');
  });

  test('an old e-stop bit does not explain a new latch', () => {
    const f = field();
    f.healthy('slot2', TESTBIRD, 1_000);
    f.watch.control('slot2', TEAM, TESTBIRD, true, 1_010);
    f.healthy('slot2', TESTBIRD, 9_000);
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 9_020);
    expect(f.watch.snapshot().stations.slot2!.origin).toEqual({ kind: 'unseen' });
  });

  test('already latched when first heard (pFMS restarted)', () => {
    const f = field();
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_000);
    expect(f.watch.snapshot().stations.slot2!.origin).toEqual({ kind: 'already' });
  });

  test('stays latched through everything until the reply bit clears', () => {
    const f = field();
    f.healthy('slot2', TESTBIRD, 1_000);
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_020);
    const v = f.watch.getVersion();
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 200_000);
    expect(f.watch.getVersion()).toBe(v);
    f.watch.reply('slot2', TEAM, { eStop: false, enabled: false }, 241_020);
    expect(f.watch.snapshot().stations).toEqual({});
    expect(f.watch.getVersion()).toBeGreaterThan(v);
    expect(f.log.at(-1)).toBe('info: Robot e-stop gone on slot2 (114-TestBird) after 4m: the robot rebooted');
  });

  test('a repeating bit logs once per press', () => {
    const f = field();
    for (let t = 0; t < 1_000; t += 20) f.watch.control('slot2', TEAM, TESTBIRD, true, t);
    expect(f.log).toHaveLength(1);
  });

  test('a different team on the station drops the latch', () => {
    const f = field();
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_000);
    f.watch.reply('slot2', 254, { eStop: false, enabled: false }, 2_000);
    expect(f.watch.snapshot().stations).toEqual({});
  });

  test('a latched robot not heard from for half an hour is forgotten', () => {
    const f = field();
    f.watch.reply('slot2', TEAM, { eStop: true, enabled: false }, 1_000);
    f.watch.tick(20 * 60_000);
    expect(f.watch.snapshot().stations.slot2).toBeDefined();
    f.watch.tick(31 * 60_000 + 1_000);
    expect(f.watch.snapshot().stations).toEqual({});
  });
});
