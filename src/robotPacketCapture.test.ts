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
