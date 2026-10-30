import { describe, expect, test } from 'bun:test';
import { describeDropout, RobotDropoutTracker } from './robotDropouts.js';
import type { RobotDropout, StationName } from './types.js';

const TEAM = 114;
const ST: StationName = 'slot1';

/** A tracker over one station, with a clock the test moves. Each step is one
 *  20 ms DS period; every packet is captured twice, as on the field. */
function field() {
  let clock = 1_000_000;
  let seq = 0;
  const logged: RobotDropout[] = [];
  const tracker = new RobotDropoutTracker((_station, _team, d) => logged.push(d));
  const step = (
    opts: { send?: boolean; forward?: boolean; answer?: boolean; volts?: number; brownout?: boolean } = {},
  ) => {
    const { send = true, forward = true, answer = true, volts = 12.2, brownout = false } = opts;
    clock += 20;
    if (!send) return;
    seq = (seq + 1) & 0xffff;
    tracker.control(ST, TEAM, seq, clock, { arriving: true, forwarded: false });
    if (!forward) return;
    tracker.control(ST, TEAM, seq, clock + 0.1, { arriving: false, forwarded: true });
    if (!answer) return;
    tracker.reply(ST, TEAM, seq, clock + 3, { brownout, batteryVoltage: volts });
    tracker.reply(ST, TEAM, seq, clock + 3.1, { brownout, batteryVoltage: volts });
  };
  const run = (ms: number, opts?: Parameters<typeof step>[0]) => {
    for (let t = 0; t < ms; t += 20) step(opts);
  };
  const settle = () => {
    run(4_000);
    tracker.tick(clock);
  };
  return { tracker, run, settle, logged, now: () => clock };
}

describe('RobotDropoutTracker', () => {
  test('a healthy link reports nothing', () => {
    const f = field();
    f.run(10_000);
    f.tracker.tick(f.now());
    expect(f.logged).toEqual([]);
    expect(f.tracker.snapshot().stations).toEqual({});
  });

  test('the robot going quiet while the DS keeps sending is a robot dropout', () => {
    const f = field();
    f.run(2_000);
    f.run(1_200, { answer: false });
    f.settle();
    expect(f.logged).toHaveLength(1);
    const [d] = f.logged;
    expect(d.kind).toBe('robot');
    expect(d.cause).toBe('unknown');
    expect(d.durationMs).toBeGreaterThanOrEqual(1_200);
    expect(d.durationMs).toBeLessThan(1_300);
    // Duplicate captures count once.
    expect(d.unanswered).toBe(60);
  });

  test('a brownout just after the silence is blamed for it', () => {
    const f = field();
    f.run(2_000);
    f.run(1_000, { answer: false });
    f.run(200, { volts: 6.6, brownout: true });
    f.settle();
    expect(f.logged).toHaveLength(1);
    expect(f.logged[0].cause).toBe('brownout');
    expect(f.logged[0].minBatteryVoltage).toBeCloseTo(6.6);
    const st = f.tracker.snapshot().stations[ST]!;
    expect(st.brownouts.count).toBe(1);
    expect(st.brownouts.minVoltage).toBeCloseTo(6.6);
  });

  test('a battery under 7 V counts as a brownout without the bit', () => {
    const f = field();
    f.run(1_000, { volts: 6.9 });
    f.run(800, { answer: false });
    f.settle();
    expect(f.logged[0].cause).toBe('brownout');
  });

  test('a brownout long before the silence does not explain it', () => {
    const f = field();
    f.run(200, { volts: 6.6, brownout: true });
    f.run(5_000);
    f.run(1_000, { answer: false });
    f.settle();
    expect(f.logged).toHaveLength(1);
    expect(f.logged[0].cause).toBe('unknown');
  });

  test('the DS going quiet is a laptop dropout, not the robot', () => {
    const f = field();
    f.run(2_000);
    f.run(900, { send: false });
    f.run(200, { volts: 6.6, brownout: true });
    f.settle();
    expect(f.logged.map(d => d.kind)).toEqual(['laptop']);
    // The DS stopped sending regardless of the robot's battery.
    expect(f.logged[0].cause).toBe('unknown');
  });

  test('the field cutting control traffic is not the robot going quiet', () => {
    const f = field();
    f.run(2_000);
    f.run(3_000, { forward: false });
    f.settle();
    expect(f.logged).toEqual([]);
  });

  test('a DS wired onto the robot network has one copy of each packet', () => {
    let clock = 0;
    const logged: RobotDropout[] = [];
    const tracker = new RobotDropoutTracker((_s, _t, d) => logged.push(d));
    for (let seq = 1; seq < 400; seq++) {
      clock += 20;
      tracker.control(ST, TEAM, seq, clock, { arriving: true, forwarded: true });
      if (seq < 100 || seq > 150) tracker.reply(ST, TEAM, seq, clock + 2, { brownout: false, batteryVoltage: 12 });
    }
    tracker.tick(clock);
    expect(logged.map(d => [d.kind, d.unanswered])).toEqual([['robot', 51]]);
  });

  test('silences shorter than half a second or longer than ten are not dropouts', () => {
    const f = field();
    f.run(1_000);
    f.run(400, { answer: false });
    f.run(1_000);
    f.run(12_000, { answer: false });
    f.settle();
    expect(f.logged).toEqual([]);
  });

  test('a dropout is held back until its look-ahead has passed', () => {
    const f = field();
    f.run(1_000);
    f.run(1_000, { answer: false });
    f.run(100);
    f.tracker.tick(f.now());
    expect(f.logged).toEqual([]);
    f.settle();
    expect(f.logged).toHaveLength(1);
  });

  test('brownout samples close together are one episode', () => {
    const f = field();
    f.run(300, { volts: 6.7, brownout: true });
    f.run(200);
    f.run(300, { volts: 6.5, brownout: true });
    f.run(3_000);
    f.run(300, { volts: 6.8, brownout: true });
    const b = f.tracker.snapshot().stations[ST]!.brownouts;
    expect(b.count).toBe(2);
    expect(b.minVoltage).toBeCloseTo(6.5);
  });

  test('a different team on the station starts a fresh history', () => {
    const f = field();
    f.run(1_000);
    f.run(1_000, { answer: false });
    f.settle();
    expect(f.tracker.snapshot().stations[ST]?.dropouts).toHaveLength(1);
    const before = f.tracker.getVersion();
    f.tracker.control(ST, 254, 1, f.now() + 20, { arriving: true, forwarded: false });
    expect(f.tracker.getVersion()).toBeGreaterThan(before);
    expect(f.tracker.snapshot().stations[ST]).toBeUndefined();
  });

  test('the version only moves when the snapshot changes', () => {
    const f = field();
    f.run(1_000);
    const v = f.tracker.getVersion();
    f.run(5_000);
    f.tracker.tick(f.now());
    expect(f.tracker.getVersion()).toBe(v);
  });
});

describe('describeDropout', () => {
  test('robot dropout with a brownout', () => {
    expect(
      describeDropout('slot1', 114, {
        kind: 'robot',
        cause: 'brownout',
        startedAt: 0,
        endedAt: 1_420,
        durationMs: 1_420,
        unanswered: 71,
        minBatteryVoltage: 6.61,
      }),
    ).toBe(
      'Dropout on slot1 (114): the robot answered none of 71 control packets for 1.4s — brownout, battery down to 6.6 V',
    );
  });

  test('laptop dropout', () => {
    expect(
      describeDropout('slot2', 254, { kind: 'laptop', cause: 'unknown', startedAt: 0, endedAt: 800, durationMs: 800 }),
    ).toBe('Dropout on slot2 (254): the Driver Station sent its robot nothing for 0.8s (laptop side)');
  });
});
