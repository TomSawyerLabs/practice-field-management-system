import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import dgram from 'node:dgram';
import net from 'node:net';
import { parseIncomingUdpMessage, startFMSServer, type FmsServer } from './fmsServer.js';

// Loopback, on ports nothing else on a dev box should hold. The real server
// binds 10.0.100.5:1750/1160, which a test cannot.
const ADDRESS = '127.0.0.1';
const TCP = 27_750 + Math.floor(Math.random() * 1000);
const UDP = 27_160 + Math.floor(Math.random() * 1000);

/** Legacy NI DS team handshake: [size:2=3] [0x18] [team:2]. */
function handshake(team: number) {
  const b = Buffer.alloc(5);
  b.writeUInt16BE(3, 0);
  b.writeUInt8(0x18, 2);
  b.writeUInt16BE(team, 3);
  return b;
}

/** Connect a fake DS and send its handshake. Resolves once the frame is out. */
function connectDs(team: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(TCP, ADDRESS, () => {
      socket.write(handshake(team), err => (err ? reject(err) : resolve(socket)));
    });
    socket.on('error', reject);
  });
}

const closed = (socket: net.Socket) => new Promise<void>(resolve => socket.once('close', () => resolve()));
const settle = () => Bun.sleep(150);

describe('disconnectTeam closes the sessions of one team only', () => {
  let fms: FmsServer;

  beforeAll(async () => {
    fms = await startFMSServer({ address: ADDRESS, tcp: TCP, udp: UDP });
  });
  afterAll(() => {
    fms.udpSocket.close();
  });

  test('a DS whose handshake named the team is closed; another team is left alone', async () => {
    const moved = await connectDs(4159);
    const bystander = await connectDs(581);
    let bystanderClosed = false;
    bystander.once('close', () => (bystanderClosed = true));
    await settle(); // let the server parse both handshakes

    fms.emit('disconnectTeam', { teamNumber: 4159, reason: 'slot4 joined' });
    await closed(moved);
    await settle();
    expect(bystanderClosed).toBe(false);
    bystander.destroy();
  });

  test('a connection that never handshaked is not touched', async () => {
    const silent = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(TCP, ADDRESS, () => resolve(s));
      s.on('error', reject);
    });
    let silentClosed = false;
    silent.once('close', () => (silentClosed = true));
    await settle();

    fms.emit('disconnectTeam', { teamNumber: 4159, reason: 'nothing to find' });
    await settle();
    expect(silentClosed).toBe(false);
    silent.destroy();
  });

  test('after disconnectDS by address, the team close finds nothing left to do', async () => {
    const ds = await connectDs(1868);
    await settle();
    fms.emit('disconnectDS', { address: ADDRESS });
    // Same tick: the socket is already flagged destroyed, so this is a no-op
    // rather than a second log line and a double destroy.
    fms.emit('disconnectTeam', { teamNumber: 1868, reason: 'slot3 joined' });
    await closed(ds);
    expect(ds.destroyed).toBe(true);
  });
});

describe('handshake reply follows the resolver', () => {
  let fms: FmsServer;
  const TCP2 = TCP + 1;
  const answers: Record<number, 'red2'> = { 254: 'red2' };
  const askedFrom: string[] = [];

  beforeAll(async () => {
    fms = await startFMSServer({
      address: ADDRESS,
      tcp: TCP2,
      udp: UDP + 1,
      resolveTeamSlot: (team, address) => {
        askedFrom.push(address);
        return answers[team];
      },
    });
  });
  afterAll(() => {
    fms.udpSocket.close();
  });

  /** Handshake as `team` and collect whatever the server sends back. */
  async function replyTo(team: number): Promise<Buffer> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(TCP2, ADDRESS, () => s.write(handshake(team), err => (err ? reject(err) : resolve(s))));
      s.on('error', reject);
    });
    const chunks: Buffer[] = [];
    socket.on('data', c => chunks.push(c));
    await settle();
    socket.destroy();
    return Buffer.concat(chunks);
  }

  test('a joined station gets its slot', async () => {
    expect([...(await replyTo(254))]).toEqual([0x00, 0x03, 0x19, 1, 0]);
  });

  test('a team the field is not controlling gets no reply (keeps its own Enable)', async () => {
    expect((await replyTo(6036)).length).toBe(0);
  });

  test("the resolver is told the DS's address", () => {
    expect(askedFrom.every(a => a === ADDRESS)).toBe(true);
    expect(askedFrom.length).toBeGreaterThan(0);
  });
});

/** DS UDP status header: seq 7, comm 0, status 0x3a, team 100, battery 12.5 V. */
const statusHeader = Buffer.from([0x00, 0x07, 0x00, 0x3a, 0x00, 0x64, 0x0c, 0x80]);
const status = (...tags: number[][]) => Buffer.concat([statusHeader, Buffer.from(tags.flat())]);

describe('DS UDP status parsing', () => {
  test('a well-formed packet keeps its header and tags', () => {
    const m = parseIncomingUdpMessage(status([4, 0x03, 50, 0x00, 0x10], [3, 0x02, 80, 20]));
    expect(m.teamNumber).toBe(100);
    expect(m.rawStatus).toBe(0x3a);
    expect(m.tags).toEqual([
      { type: 'robot', signalStrength: 50, bandwidthUtilization: 0x10 },
      { batteryPercent: 80, cpuPercent: 20 },
    ]);
  });

  test('a tag shorter than its layout is skipped; the header and later tags survive', () => {
    const m = parseIncomingUdpMessage(status([2, 0x03, 50], [3, 0x02, 80, 20]));
    expect(m.teamNumber).toBe(100);
    expect(m.tags).toEqual([{ batteryPercent: 80, cpuPercent: 20 }]);
  });

  test('a tag size running past the end of the packet keeps the header', () => {
    const m = parseIncomingUdpMessage(status([3, 0x02, 80, 20], [9, 0x01, 0]));
    expect(m.teamNumber).toBe(100);
    expect(m.tags).toEqual([{ batteryPercent: 80, cpuPercent: 20 }]);
  });

  test('a zero tag size ends tag parsing but keeps the header', () => {
    expect(parseIncomingUdpMessage(status([0, 0x02])).teamNumber).toBe(100);
  });

  test('a packet shorter than the header is still rejected', () => {
    expect(() => parseIncomingUdpMessage(Buffer.alloc(0))).toThrow();
    expect(() => parseIncomingUdpMessage(statusHeader.subarray(0, 5))).toThrow();
  });
});

describe('unparseable UDP status logging', () => {
  let fms: FmsServer;
  const UDP3 = UDP + 2;

  beforeAll(async () => {
    fms = await startFMSServer({ address: ADDRESS, tcp: TCP + 2, udp: UDP3 });
  });
  afterAll(() => {
    fms.udpSocket.close();
  });

  test('each new shape of bad packet from one address is logged with its payload', async () => {
    const log = spyOn(console, 'log');
    const client = dgram.createSocket('udp4');
    const send = (b: Buffer) => new Promise<void>(r => client.send(b, UDP3, ADDRESS, () => r()));
    try {
      await send(Buffer.alloc(0));
      await send(Buffer.from([0xab, 0xcd, 0xef]));
      await send(Buffer.from([0xab, 0xcd, 0xef])); // same shape: counted, not re-logged
      await settle();
      const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('Unparseable DS UDP status'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('0 bytes');
      expect(lines[1]).toContain('3 bytes): abcdef');
    } finally {
      client.close();
      log.mockRestore();
    }
  });
});
