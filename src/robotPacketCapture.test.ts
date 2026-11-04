import { describe, expect, test } from 'bun:test';
import type { LinkHop } from './robotLinkWatch.js';
import type { TelemetryUpdate } from './types.js';
import {
  countDsJoysticks,
  RobotLinkTimer,
  RobotPacketCapture,
  unusualSystemCoreControl,
  unusualSystemCoreReply,
} from './robotPacketCapture.js';

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

describe('which SystemCore packets are worth recording', () => {
  const reply = (status: number, trace: number, whole = 12, frac = 0x67) =>
    unusualSystemCoreReply(Buffer.from([0, 1, 0x02, status, trace, whole, frac]));
  test('everything seen on 2026-11-03 is not', () => {
    for (const status of [0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x82])
      for (const trace of [0x00, 0x40, 0x60, 0x61]) expect(reply(status, trace)).toBeNull();
    for (const control of [0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x11, 0x15, 0x82])
      expect(unusualSystemCoreControl(Buffer.from([0, 1, 0x02, control]))).toBeNull();
  });
  test('new status, trace or control bits, mode 0 and a low battery are', () => {
    expect(reply(0x12, 0x61)).toBe('status byte 0x12');
    expect(reply(0x46, 0x61)).toBe('status byte 0x46');
    expect(reply(0x04, 0x61)).toBe('status byte 0x04');
    expect(reply(0x06, 0x71)).toBe('trace byte 0x71');
    expect(reply(0x06, 0x61, 6, 0x80)).toBe('battery 6.50 V');
    expect(unusualSystemCoreControl(Buffer.from([0, 1, 0x02, 0x46]))).toBe('DS control byte 0x46');
  });
});

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
    const controls: unknown[][] = [];
    const replies: unknown[][] = [];
    const c = new RobotPacketCapture(
      'eno1',
      () => ({ 5940: 'slot3', 9940: 'slot2' }),
      u => telemetry.push(u),
      true,
      undefined,
      undefined,
      hop => hops.push(hop),
      undefined,
      { write: r => raw.push(r) },
      { control: (...a) => controls.push(a), reply: (...a) => replies.push(a) },
    );
    const parse = (data: Buffer, at: number) => {
      const record = Buffer.concat([Buffer.alloc(16), data]);
      (c as unknown as { parsePacket(d: Buffer, at: number, r: Buffer): void }).parsePacket(data, at, record);
    };
    return { parse, telemetry, hops, raw, controls, replies };
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

  // Real packets from team 5940, 2026-11-03: a control packet, and the
  // robot's reply to it at 12.40 V (0x0c + 0x67/256), trimmed after its tags.
  const SC_CONTROL = [0x00, 0x04, 0x02, 0x02, 0x40, 0x00, 0x8c, 0, 0, 0, 0, 0, 0, 0, 0, 0x02];
  const SC_REPLY = [0x00, 0x04, 0x02, 0x02, 0x61, 0x0c, 0x67, 0x00, 0, 0, 0, 0, 0, 0, 0, 0x02];

  test('a reply gives the battery, and the link is timed from its sequence number', () => {
    const f = capture();
    f.parse(frame('10.59.40.254', RIO, 1110, SC_CONTROL, undefined, 61619), 1_000);
    f.parse(frame(RIO, '10.59.40.254', 61619, SC_REPLY, undefined, 1110), 1_002);
    expect(f.telemetry).toHaveLength(1);
    const [t] = f.telemetry;
    expect(t.station).toBe('slot3');
    expect(t.batteryVoltage).toBeCloseTo(12.402, 3);
    expect(t.dsStatus).toMatchObject({ enabled: false, mode: 'teleOp', robotComms: true, eStop: false });
    // The brownout bit was never seen set, so it isn't reported.
    expect(t.brownout).toBeUndefined();
    expect(f.hops.map(h => h.kind)).toEqual(['control', 'reply']);
    // Nothing unusual, so nothing is recorded.
    expect(f.raw).toEqual([]);
  });

  test('an e-stop: the DS’s bit 7 is traced to its laptop, and the robot’s latch is reported', () => {
    const f = capture();
    // 9940, 2026-11-03 8:58:12 PM PST: the DS sent 0x82 (teleop + e-stop),
    // and the robot answered 0x82, enable dropped in the same packet.
    const RIO9940 = '10.99.40.2';
    const GW = '10.99.40.254';
    const LAPTOP = '10.55.40.20';
    const control = [0xd8, 0xe9, 0x02, 0x82, 0x00, 0x03, 0, 0];
    const reply = [0xd8, 0xe9, 0x02, 0x82, 0x61, 0x0c, 0x07, 0x00];
    f.parse(frame(LAPTOP, RIO9940, 1110, control, undefined, 62000), 1_000);
    // Only the copy that reached the robot counts.
    expect(f.controls).toEqual([]);
    f.parse(frame(GW, RIO9940, 1110, control, undefined, 62000), 1_001);
    expect(f.controls).toEqual([['slot2', 9940, LAPTOP, true, 1_001]]);
    f.parse(frame(RIO9940, GW, 62000, reply, undefined, 1110), 1_003);
    expect(f.replies).toEqual([['slot2', 9940, { eStop: true, enabled: false }, 1_003]]);
    expect(f.telemetry.at(-1)?.dsStatus).toMatchObject({ eStop: true, enabled: false, mode: 'teleOp' });
    // Known now, so it no longer triggers raw recording.
    expect(f.raw).toEqual([]);
  });

  test('a packet with bits not decoded yet records the robot’s packets from a few seconds before to 10 s after', () => {
    const f = capture();
    const reply = (status: number, at: number) =>
      f.parse(frame(RIO, DS, 61619, [0x00, 0x04, 0x02, status, 0x61, 0x0c, 0x67], undefined, 1110), at);
    for (let at = 0; at < 1_000; at += 20) reply(0x06, at);
    expect(f.raw).toEqual([]);
    reply(0x16, 1_000); // bit 4, brownout on NI, never seen on SystemCore
    expect(f.raw).toHaveLength(51);
    reply(0x06, 10_999);
    reply(0x06, 11_001);
    expect(f.raw).toHaveLength(52);
  });

  test('the status byte gives enable and the 2027 DS’s modes, numbered unlike NI’s', () => {
    const f = capture();
    const reply = (status: number, trace = 0x61) =>
      f.parse(frame(RIO, DS, 61619, [0x00, 0x04, 0x02, status, trace, 0x0c, 0x67], undefined, 1110), 1);
    // Status bytes seen on 5940 and 9940, 2026-11-03.
    reply(0x01);
    reply(0x05);
    reply(0x06);
    reply(0x03);
    reply(0x03, 0x40);
    expect(f.telemetry.map(t => [t.dsStatus?.mode, t.dsStatus?.enabled, t.dsStatus?.robotComms])).toEqual([
      ['auto', false, true],
      ['auto', true, true],
      ['teleOp', true, true],
      ['util', false, true],
      ['util', false, false],
    ]);
  });

  test('mode 0, never seen, reports no status', () => {
    const f = capture();
    f.parse(frame(RIO, DS, 61619, [0x00, 0x04, 0x02, 0x04, 0x61, 0x0c, 0x67], undefined, 1110), 1);
    expect(f.telemetry).toHaveLength(1);
    expect(f.telemetry[0].dsStatus).toBeUndefined();
    expect(f.telemetry[0].batteryVoltage).toBeCloseTo(12.402, 3);
  });

  test('a SystemCore reply with an unknown comm version is only kept raw', () => {
    const f = capture();
    f.parse(frame(RIO, DS, 61619, [0x00, 0x04, 0x03, ...SC_REPLY.slice(3)], undefined, 1110), 1);
    expect(f.telemetry).toEqual([]);
    expect(f.raw).toHaveLength(1);
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
