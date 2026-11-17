import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { decodeAll } from './msgpack.js';
import { readRobotNt, RobotNtReader, type ConnectTcp } from './robotNt.js';
import { WebSocketClient } from './webSocketClient.js';

/** Just enough MessagePack encoding to play an NT4 server. */
const BIN = Symbol('bin');
/** A value sent as msgpack bin, the way NT4 sends a "msgpack"-typed topic. */
const packed = (v: unknown) => ({ [BIN]: pack(v) });

function pack(v: unknown): Buffer {
  if (v && typeof v === 'object' && BIN in v) {
    const b = (v as { [BIN]: Buffer })[BIN];
    return Buffer.concat([Buffer.from([0xc4, b.length]), b]);
  }
  if (v === null) return Buffer.from([0xc0]);
  if (typeof v === 'boolean') return Buffer.from([v ? 0xc3 : 0xc2]);
  if (typeof v === 'number' && Number.isInteger(v)) {
    if (v >= 0 && v < 128) return Buffer.from([v]);
    if (v < 0 && v >= -32) return Buffer.from([v + 0x100]);
    const b = Buffer.alloc(9);
    b[0] = 0xd3;
    b.writeBigInt64BE(BigInt(v), 1);
    return b;
  }
  if (typeof v === 'number') {
    const b = Buffer.alloc(9);
    b[0] = 0xcb;
    b.writeDoubleBE(v, 1);
    return b;
  }
  if (typeof v === 'string') {
    const s = Buffer.from(v);
    return Buffer.concat([s.length < 32 ? Buffer.from([0xa0 | s.length]) : Buffer.from([0xd9, s.length]), s]);
  }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from([0x90 | v.length]), ...v.map(pack)]);
  const entries = Object.entries(v as object);
  return Buffer.concat([Buffer.from([0x80 | entries.length]), ...entries.flatMap(([k, x]) => [pack(k), pack(x)])]);
}

describe('msgpack', () => {
  test('decodes what NT4 sends, several values to a frame', () => {
    const buf = Buffer.concat([
      pack([3, 1234567890123, 2, 42]),
      pack([{ id: 'AdvantageScope@1', conn: '10.55.18.177:51234' }]),
      pack([true, false, null, -5, 1.5, 'x'.repeat(40)]),
    ]);
    expect(decodeAll(buf)).toEqual([
      [3, 1234567890123, 2, 42],
      [{ id: 'AdvantageScope@1', conn: '10.55.18.177:51234' }],
      [true, false, null, -5, 1.5, 'x'.repeat(40)],
    ]);
  });

  test('a truncated value throws', () => {
    expect(() => decodeAll(pack('hello').subarray(0, 3))).toThrow('truncated');
  });
});

/** Server-side WebSocket frame (unmasked). */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const head =
    payload.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length])
      : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Read a client's masked frames back out. */
function unmaskFrames(buf: Buffer): { opcode: number; payload: Buffer }[] {
  const out: { opcode: number; payload: Buffer }[] = [];
  let at = 0;
  while (at < buf.length) {
    const opcode = buf[at] & 0x0f;
    let len = buf[at + 1] & 0x7f;
    at += 2;
    if (len === 126) {
      len = buf.readUInt16BE(at);
      at += 2;
    }
    const mask = buf.subarray(at, at + 4);
    at += 4;
    const payload = Buffer.from(buf.subarray(at, at + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    out.push({ opcode, payload });
    at += len;
  }
  return out;
}

interface FakeRobot {
  /** What the robot's NT server has. */
  clients?: { id: string; conn: string }[];
  fms?: Record<string, unknown>;
  /** How the TCP connection goes. */
  connection?: 'ok' | 'refused' | 'timeout';
  /** Reply to the handshake with this instead of 101. */
  httpStatus?: string;
  /** Split everything the robot sends into chunks this big. */
  chunk?: number;
}

/** A pinned-TCP stand-in that plays a roboRIO's NT4 server. */
function fakeRobot(robot: FakeRobot) {
  const seen: { ifname: string; address: string; port: number; subscribed: unknown[] } = {
    ifname: '',
    address: '',
    port: 0,
    subscribed: [],
  };
  const connect: ConnectTcp = (ifname, address, port, _timeout, onEvent) => {
    Object.assign(seen, { ifname, address, port });
    const send = (data: Buffer) => {
      const size = robot.chunk ?? data.length;
      for (let i = 0; i < data.length; i += size) onEvent('data', data.subarray(i, i + size), '');
    };
    let handshook = false;
    let closed = false;
    queueMicrotask(() => {
      if (robot.connection === 'refused') onEvent('error', undefined, 'Connection refused (os error 111)');
      else if (robot.connection === 'timeout') onEvent('error', undefined, 'no answer within 2000 ms');
      else onEvent('connect', undefined, '');
    });
    return {
      write(data) {
        if (closed) throw new Error('not connected');
        if (!handshook) {
          handshook = true;
          const key = /Sec-WebSocket-Key: (\S+)/.exec(data.toString())![1];
          const accept = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          const status = robot.httpStatus ?? '101 Switching Protocols';
          send(
            Buffer.from(
              `HTTP/1.1 ${status}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: v4.1.networktables.first.wpi.edu\r\n\r\n`,
            ),
          );
          return;
        }
        for (const f of unmaskFrames(data)) {
          if (f.opcode !== 1) continue;
          seen.subscribed.push(...(JSON.parse(f.payload.toString()) as unknown[]));
          const topics: [string, unknown][] = [];
          // A meta topic: its value is msgpack inside msgpack (a bin)
          if (robot.clients) topics.push(['$clients', packed(robot.clients)]);
          for (const [k, v] of Object.entries(robot.fms ?? {})) topics.push([`/FMSInfo/${k}`, v]);
          send(
            frame(
              1,
              Buffer.from(
                JSON.stringify(
                  topics.map(([name], id) => ({ method: 'announce', params: { name, id: id + 10, type: 'x' } })),
                ),
              ),
            ),
          );
          send(frame(9, Buffer.from('ping')));
          const values = Buffer.concat(topics.map(([, v], id) => pack([id + 10, 1000, 0, v])));
          // Fragmented, to exercise continuation frames
          const half = Math.floor(values.length / 2);
          send(frame(2, values.subarray(0, half), false));
          send(frame(0, values.subarray(half)));
        }
      },
      close() {
        closed = true;
      },
    };
  };
  return { connect, seen };
}

const FMS_2854 = {
  EventName: 'TSL',
  MatchType: 1,
  MatchNumber: 3,
  ReplayNumber: 0,
  IsRedAlliance: true,
  StationNumber: 2,
  FMSControlData: 49,
  GameSpecificMessage: '',
};

describe('reading a robot', () => {
  test('robot code up: dashboards (not pFMS itself) and the match info the robot got', async () => {
    const { connect, seen } = fakeRobot({
      chunk: 7,
      clients: [
        { id: 'pFMS@2', conn: '10.28.54.254:40000' },
        { id: 'AdvantageScope@1', conn: '10.55.18.177:51234' },
        { id: 'elastic@3', conn: '10.28.54.5:50000' },
      ],
      fms: FMS_2854,
    });
    const result = await readRobotNt(connect, 'br-slot1', '10.28.54.2', { settleMs: 2_000 });
    expect(seen).toMatchObject({ ifname: 'br-slot1', address: '10.28.54.2', port: 5810 });
    expect(seen.subscribed).toEqual([
      { method: 'subscribe', params: { topics: ['$clients'], subuid: 1, options: {} } },
      { method: 'subscribe', params: { topics: ['/FMSInfo/'], subuid: 2, options: { prefix: true } } },
    ]);
    expect(result).toEqual({
      code: 'running',
      clients: [
        { name: 'AdvantageScope@1', address: '10.55.18.177:51234' },
        { name: 'elastic@3', address: '10.28.54.5:50000' },
      ],
      fms: {
        eventName: 'TSL',
        matchType: 1,
        matchNumber: 3,
        replayNumber: 0,
        isRedAlliance: true,
        stationNumber: 2,
        controlData: 49,
        gameMessage: '',
      },
    });
  });

  test('robot code without FMSInfo still counts as running, after the wait', async () => {
    const { connect } = fakeRobot({ clients: [] });
    expect(await readRobotNt(connect, 'br-slot1', '10.28.54.2', { settleMs: 20 })).toEqual({
      code: 'running',
      clients: [],
    });
  });

  test('a refused connection means no robot program; no answer means unreachable', async () => {
    expect(await readRobotNt(fakeRobot({ connection: 'refused' }).connect, 'br-slot1', '10.28.54.2')).toMatchObject({
      code: 'not running',
    });
    expect(await readRobotNt(fakeRobot({ connection: 'timeout' }).connect, 'br-slot1', '10.28.54.2')).toEqual({
      code: 'unreachable',
      error: 'no answer within 2000 ms',
    });
  });

  test('something on 5810 that is not NT4 is running, with the reason', async () => {
    const result = await readRobotNt(fakeRobot({ httpStatus: '404 Not Found' }).connect, 'br-slot1', '10.28.54.2');
    expect(result.code).toBe('running');
    expect(result.error).toContain('404');
  });

  test('an addon that cannot connect at all is unreachable, not a crash', async () => {
    const throwing: ConnectTcp = () => {
      throw new Error('older than 0.3');
    };
    expect(await readRobotNt(throwing, 'br-slot1', '10.28.54.2')).toEqual({
      code: 'unreachable',
      error: 'older than 0.3',
    });
  });
});

describe('RobotNtReader', () => {
  test('viewers asking together cost one visit, and a fresh reading is reused', async () => {
    let visits = 0;
    const { connect } = fakeRobot({ clients: [], fms: FMS_2854 });
    const counting: ConnectTcp = (...args) => {
      visits++;
      return connect(...args);
    };
    const reader = new RobotNtReader(counting, { minIntervalMs: 10_000 });
    const [a, b] = await Promise.all([
      reader.read('slot1', 2854, 'br-slot1', '10.28.54.2'),
      reader.read('slot1', 2854, 'br-slot1', '10.28.54.2'),
    ]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ station: 'slot1', team: 2854, ip: '10.28.54.2', code: 'running' });
    await reader.read('slot1', 2854, 'br-slot1', '10.28.54.2', Date.now() + 5_000);
    expect(visits).toBe(1);
    await reader.read('slot1', 2854, 'br-slot1', '10.28.54.2', Date.now() + 11_000);
    expect(visits).toBe(2);
  });
});

describe('WebSocketClient', () => {
  test('a refused handshake closes with the status line', () => {
    const closed: string[] = [];
    let written = '';
    const ws = new WebSocketClient(
      { write: d => void (written += d.toString()), close: () => {} },
      { host: 'h', path: '/nt/x' },
      { onOpen: () => {}, onText: () => {}, onBinary: () => {}, onClose: r => void closed.push(r) },
    );
    ws.open();
    expect(written).toStartWith('GET /nt/x HTTP/1.1\r\nHost: h\r\n');
    ws.receive(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'));
    expect(closed).toEqual(['The server answered "HTTP/1.1 400 Bad Request", not a WebSocket']);
  });
});

describe('GET /api/robot-nt', () => {
  test("reads the station's robot, and refuses off site or with no robot", async () => {
    const { handleRobotNtRequest } = await import('./robotNtApi.js');
    const call = (url: string, refuse = false, noRobot = false) => {
      let status = 0;
      let body = '';
      const reads: unknown[] = [];
      const res = {
        writeHead: (s: number) => void (status = s),
        end: (b: string) => void (body = b),
      } as unknown as import('node:http').ServerResponse;
      const handled = handleRobotNtRequest(
        { url, method: 'GET' } as import('node:http').IncomingMessage,
        res,
        {
          read: (...args) => {
            reads.push(args);
            return Promise.resolve({ station: 'slot1', team: 2854, ip: '10.28.54.2', at: 1, code: 'running' as const });
          },
        },
        { readRefusal: () => (refuse ? { status: 403, error: 'off site' } : null) },
        () =>
          noRobot
            ? { ok: false, status: 404, error: 'No robot on that station' }
            : { ok: true, team: 2854, ifname: 'br-slot1', ip: '10.28.54.2' },
      );
      return {
        handled,
        reads,
        get status() {
          return status;
        },
        get body() {
          return body;
        },
      };
    };
    const ok = call('/api/robot-nt?station=slot1');
    await Bun.sleep(0);
    expect(ok.reads).toEqual([['slot1', 2854, 'br-slot1', '10.28.54.2']]);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).code).toBe('running');
    expect(call('/api/robot-nt?station=slot1', true)).toMatchObject({ status: 403, reads: [] });
    expect(call('/api/robot-nt?station=slot1', false, true)).toMatchObject({ status: 404, reads: [] });
    expect(call('/api/robot-nt?station=slot9')).toMatchObject({ status: 400 });
    expect(call('/api/robot-ntx').handled).toBe(false);
  });
});
