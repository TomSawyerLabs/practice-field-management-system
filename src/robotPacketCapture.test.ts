import { describe, expect, test } from 'bun:test';
import type { LinkHop } from './robotLinkWatch.js';
import type { TelemetryUpdate } from './types.js';
import { countDsJoysticks, RobotLinkTimer, RobotPacketCapture } from './robotPacketCapture.js';

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

/** An Ethernet frame (802.1Q-tagged when `vlan` is given) carrying IPv4 UDP. */
function frame(src: string, dst: string, dstPort: number, payload: number[], vlan?: number, srcPort = 1024): Buffer {
  const ip = (a: string) => a.split('.').map(Number);
  const eth = [...Array(12).fill(0), ...(vlan === undefined ? [] : [0x81, 0x00, 0, vlan]), 0x08, 0x00];
  const ipHeader = [0x45, 0, 0, 0, 0, 0, 0, 0, 64, 17, 0, 0, ...ip(src), ...ip(dst)];
  const udp = [srcPort >> 8, srcPort & 0xff, dstPort >> 8, dstPort & 0xff, 0, 0, 0, 0];
  return Buffer.from([...eth, ...ipHeader, ...udp, ...payload]);
}
const ROBOT_STATUS = [0x12, 0x34, 0x01, 0x00, 0x20, 12, 128, 0];

describe('RobotPacketCapture hops', () => {
  test('reports each control and reply packet with its captured addresses', () => {
    const hops: LinkHop[] = [];
    const capture = new RobotPacketCapture(
      'eno1',
      () => ({ 840: 'slot2' }),
      () => {},
      true,
      vlan => (vlan === 20 ? 'slot2' : undefined),
      undefined,
      hop => hops.push(hop),
    );
    const parse = (data: Buffer, at: number) =>
      (capture as unknown as { parsePacket(d: Buffer, at: number): void }).parsePacket(data, at);

    parse(frame('10.55.132.86', '10.8.40.2', 1110, HEADER), 1);
    parse(frame('10.8.40.254', '10.8.40.2', 1110, HEADER, 20), 2);
    parse(frame('10.8.40.2', '10.8.40.254', 1150, ROBOT_STATUS, 20), 3);
    parse(frame('10.8.40.2', '10.55.132.86', 1150, ROBOT_STATUS), 4);

    expect(hops).toEqual([
      { station: 'slot2', kind: 'control', src: '10.55.132.86', dst: '10.8.40.2', at: 1 },
      { station: 'slot2', kind: 'control', src: '10.8.40.254', dst: '10.8.40.2', at: 2 },
      { station: 'slot2', kind: 'reply', src: '10.8.40.2', dst: '10.8.40.254', at: 3 },
      { station: 'slot2', kind: 'reply', src: '10.8.40.2', dst: '10.55.132.86', at: 4 },
    ]);
  });
});

describe('RobotPacketCapture DS commands', () => {
  test('reports whether a DS is commanding its robot enabled, from the copy arriving at the field', () => {
    const seen: (boolean | null)[] = [];
    const capture = new RobotPacketCapture(
      'eno1',
      () => ({ 840: 'slot2' }),
      () => {},
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (_station, enabled) => seen.push(enabled),
    );
    const parse = (data: Buffer) =>
      (capture as unknown as { parsePacket(d: Buffer, at: number): void }).parsePacket(data, 1);

    parse(frame('10.55.132.86', '10.8.40.2', 1110, [0, 1, 1, 0x04, 0, 0]));
    parse(frame('10.55.132.86', '10.8.40.2', 1110, [0, 2, 1, 0x00, 0, 0]));
    parse(frame('10.55.132.86', '10.8.40.2', 1110, [0, 3, 2, 0x04, 0, 0]));
    expect(seen).toEqual([true, false, null]);
  });
});

describe('RobotPacketCapture SystemCore robots', () => {
  /** A capture over one station whose telemetry, hops and raw records the
   *  test can see. Records are tagged by their packet's first byte. */
  function capture() {
    const telemetry: TelemetryUpdate[] = [];
    const hops: LinkHop[] = [];
    const raw: Buffer[] = [];
    const c = new RobotPacketCapture(
      'eno1',
      () => ({ 5940: 'slot3' }),
      u => telemetry.push(u),
      true,
      undefined,
      undefined,
      hop => hops.push(hop),
      undefined,
      { write: r => raw.push(r) },
    );
    const parse = (data: Buffer, at: number) => {
      const record = Buffer.concat([Buffer.alloc(16), data]);
      (c as unknown as { parsePacket(d: Buffer, at: number, r: Buffer): void }).parsePacket(data, at, record);
    };
    return { parse, telemetry, hops, raw };
  }
  const DS = '10.55.65.16';
  const RIO = '10.59.40.2';

  test('replies from UDP 1110 are kept raw, not read as NI status', () => {
    const f = capture();
    f.parse(frame(RIO, '10.59.40.254', 54797, ROBOT_STATUS, undefined, 1110), 1);
    expect(f.raw).toHaveLength(1);
    expect(f.telemetry).toEqual([]);
    expect(f.hops).toEqual([]);
  });

  test('once its robot is known, the DS’s control packets are kept too, and still reported', () => {
    const f = capture();
    f.parse(frame(DS, RIO, 1110, HEADER, undefined, 54797), 1);
    expect(f.raw).toHaveLength(0);
    f.parse(frame(RIO, DS, 54797, ROBOT_STATUS, undefined, 1110), 2);
    f.parse(frame(DS, RIO, 1110, HEADER, undefined, 54797), 3);
    expect(f.raw).toHaveLength(2);
    expect(f.hops.map(h => h.kind)).toEqual(['control', 'control']);
  });

  test('an NI robot is never recorded', () => {
    const f = capture();
    f.parse(frame(DS, RIO, 1110, HEADER), 1);
    f.parse(frame(RIO, '10.59.40.254', 1150, ROBOT_STATUS), 2);
    expect(f.raw).toEqual([]);
    expect(f.telemetry).toHaveLength(1);
  });
});

describe('RobotPacketCapture two robots of one team', () => {
  const MAIN_DS = '10.55.150.65';
  const BIRD_DS = '10.55.231.82';
  const GW = '10.1.14.254';
  const RIO = '10.1.14.2';
  const STATUS_ESTOP = [0x12, 0x34, 0x01, 0x80, 0x20, 12, 128, 0];
  const CONTROL_ESTOP = [0x12, 0x35, 0x01, 0x80, 0x00, 0x00];

  function capture() {
    const telemetry: TelemetryUpdate[] = [];
    const hops: LinkHop[] = [];
    const controls: unknown[][] = [];
    const replies: unknown[][] = [];
    const drives: Record<string, 'slot1' | 'slot2'> = { [MAIN_DS]: 'slot1', [BIRD_DS]: 'slot2' };
    const c = new RobotPacketCapture(
      'eno1',
      () => ({ 114: 'slot1' }),
      u => telemetry.push(u),
      true,
      vlan => (vlan === 10 ? 'slot1' : vlan === 20 ? 'slot2' : undefined),
      undefined,
      hop => hops.push(hop),
      undefined,
      undefined,
      { control: (...a) => controls.push(a), reply: (...a) => replies.push(a) },
      laptop => drives[laptop],
      () => true,
    );
    const parse = (data: Buffer, at: number) =>
      (c as unknown as { parsePacket(d: Buffer, at: number, r: Buffer): void }).parsePacket(
        data,
        at,
        Buffer.concat([Buffer.alloc(16), data]),
      );
    return { parse, telemetry, hops, controls, replies };
  }

  test('a reply on its way to a laptop stays on that laptop’s robot', () => {
    const f = capture();
    f.parse(frame(RIO, GW, 1150, ROBOT_STATUS, 20), 1);
    f.parse(frame(RIO, BIRD_DS, 1150, ROBOT_STATUS, 3), 2);
    expect(f.telemetry.map(t => t.station)).toEqual(['slot2', 'slot2']);
  });

  test('a laptop pFMS can’t place is dropped, not guessed', () => {
    const f = capture();
    f.parse(frame(RIO, '10.55.1.1', 1150, ROBOT_STATUS, 3), 1);
    expect(f.telemetry).toEqual([]);
  });

  test('a laptop’s control packet is reported on its own robot', () => {
    const f = capture();
    f.parse(frame(BIRD_DS, RIO, 1110, HEADER, 3, 59142), 1);
    expect(f.hops).toEqual([{ station: 'slot2', kind: 'control', src: BIRD_DS, dst: RIO, at: 1 }]);
  });

  test('an e-stop is traced from the forwarded copy back to its laptop', () => {
    const f = capture();
    f.parse(frame(MAIN_DS, RIO, 1110, CONTROL_ESTOP, 3, 61305), 1);
    // Arriving copies don't count: the field may yet drop them.
    expect(f.controls).toEqual([]);
    // It left on slot2's VLAN, so it reached TestBird, whoever usually drives what.
    f.parse(frame(GW, RIO, 1110, CONTROL_ESTOP, 20, 61305), 2);
    expect(f.controls).toEqual([['slot2', 114, MAIN_DS, true, 2]]);
  });

  test('the robot’s e-stop flag is reported from its status byte', () => {
    const f = capture();
    f.parse(frame(RIO, GW, 1150, STATUS_ESTOP, 20), 1);
    expect(f.replies).toEqual([['slot2', 114, { eStop: true, enabled: false }, 1]]);
  });
});
