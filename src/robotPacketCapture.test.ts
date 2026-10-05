import { describe, expect, test } from 'bun:test';
import { countDsJoysticks, RobotLinkTimer } from './robotPacketCapture.js';

/** DS→robot header: sequence, comm version, control, request, station. */
const HEADER = [0x12, 0x34, 0x01, 0x04, 0x00, 0x00];

/** A joystick tag: axis values, button states, POV angles. */
function joystickTag(axes: number, buttons: number, povs: number): number[] {
  const data = [
    axes,
    ...Array<number>(axes).fill(0),
    buttons,
    ...Array<number>(Math.ceil(buttons / 8)).fill(0),
    povs,
    ...Array<number>(povs * 2).fill(0xff),
  ];
  return [data.length + 1, 0x0c, ...data];
}

/** A non-joystick tag (0x07 countdown carries a 4-byte float). */
const COUNTDOWN_TAG = [5, 0x07, 0x41, 0x20, 0x00, 0x00];

const packet = (...tags: number[][]) => Buffer.from([...HEADER, ...tags.flat()]);

describe('countDsJoysticks', () => {
  test('a DS with no joysticks sends no joystick tags', () => {
    expect(countDsJoysticks(packet())).toBe(0);
  });

  test('counts each joystick tag', () => {
    expect(countDsJoysticks(packet(joystickTag(6, 10, 1)))).toBe(1);
    expect(countDsJoysticks(packet(joystickTag(6, 10, 1), joystickTag(4, 12, 1)))).toBe(2);
  });

  test('an empty slot tag is not a joystick', () => {
    expect(countDsJoysticks(packet(joystickTag(0, 0, 0), joystickTag(2, 0, 0)))).toBe(1);
  });

  test('skips other tags', () => {
    expect(countDsJoysticks(packet(COUNTDOWN_TAG, joystickTag(0, 16, 0), COUNTDOWN_TAG))).toBe(1);
  });

  test('rejects packets that are not legacy DS control packets', () => {
    expect(countDsJoysticks(Buffer.from([0x12, 0x34, 0x02, 0, 0, 0]))).toBeNull();
    expect(countDsJoysticks(Buffer.from([0x12, 0x34, 0x01]))).toBeNull();
  });

  test('rejects a tag that runs past the end of the packet', () => {
    const truncated = packet(joystickTag(6, 10, 1)).subarray(0, HEADER.length + 5);
    expect(countDsJoysticks(truncated)).toBeNull();
  });
});

describe('RobotLinkTimer', () => {
  /** 50 Hz control packets from t=0, each answered `rtt` ms later unless `drop` says not. */
  function run(timer: RobotLinkTimer, packets: number, rtt: number, drop: (i: number) => boolean = () => false) {
    for (let i = 0; i < packets; i++) {
      const t = i * 20;
      timer.sent(i, t);
      timer.sent(i, t + 0.05); // the forwarded copy
      if (!drop(i)) {
        timer.reply(i, t + rtt);
        timer.reply(i, t + rtt + 0.05); // only the first reply counts
      }
    }
    return packets * 20;
  }

  test('nothing to say before any packet has had time to be answered', () => {
    const timer = new RobotLinkTimer();
    timer.sent(1, 0);
    expect(timer.stats(10)).toBeUndefined();
  });

  test('median round trip from the forwarded copy, and no loss on a clean link', () => {
    const timer = new RobotLinkTimer();
    const end = run(timer, 200, 2);
    const stats = timer.stats(end + 1_500)!;
    expect(stats.lossPct).toBe(0);
    // Timed from the later (forwarded) copy: 2 ms - 0.05 ms.
    expect(stats.rttMs).toBeCloseTo(2, 0);
  });

  test('unanswered control packets count as lost', () => {
    const timer = new RobotLinkTimer();
    const end = run(timer, 200, 3, i => i % 4 === 0);
    expect(timer.stats(end + 1_500)!.lossPct).toBeCloseTo(25, 0);
  });

  test('a stopped robot (no replies at all) reads as 100% unanswered with no round trip', () => {
    const timer = new RobotLinkTimer();
    const end = run(timer, 100, 3, () => true);
    const stats = timer.stats(end + 1_500)!;
    expect(stats.lossPct).toBe(100);
    expect(stats.rttMs).toBeUndefined();
  });
});
