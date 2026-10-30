import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import dgram from 'node:dgram';
import net from 'node:net';
import { parseIncomingUdpMessage, startFMSServer, type FmsServer } from './fmsServer.js';

// Loopback, on ports the OS picks as it binds (port 0). The real server binds
// 10.0.100.5:1750/1160, which a test cannot. Never a port chosen first and bound
// later: Windows reserves ranges (Hyper-V, WinNAT) that move while it runs, so
// a port found free can refuse the bind with EACCES a moment later.
const ADDRESS = '127.0.0.1';

/** Legacy NI DS team handshake: [size:2=3] [0x18] [team:2]. */
function handshake(team: number) {
  const b = Buffer.alloc(5);
  b.writeUInt16BE(3, 0);
  b.writeUInt8(0x18, 2);
  b.writeUInt16BE(team, 3);
  return b;
}

/** Resolves once the server has read this team's handshake. */
const handshaked = (fms: FmsServer, team: number) =>
  new Promise<void>(resolve => {
    fms.on('message', function heard({ data }) {
      if (!('teamNumber' in data) || data.teamNumber !== team) return;
      fms.off('message', heard);
      resolve();
    });
  });

/** Connect a fake DS and send its handshake. Resolves once the server has read it. */
async function connectDs(fms: FmsServer, team: number) {
  const read = handshaked(fms, team);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(fms.tcpPort, ADDRESS, () => {
      s.write(handshake(team), err => (err ? reject(err) : resolve(s)));
    });
    s.on('error', reject);
  });
  await read;
  return socket;
}

const closed = (socket: net.Socket) => new Promise<void>(resolve => socket.once('close', () => resolve()));
/** Time for something that must NOT happen to show itself. Anything a test
 *  needs to have happened gets waited for by name instead: a fixed wait for
 *  that fails on a busy machine. */
const settle = () => Bun.sleep(150);

describe('disconnectTeam closes the sessions of one team only', () => {
  let fms: FmsServer;

  beforeAll(async () => {
    fms = await startFMSServer({ address: ADDRESS, tcp: 0, udp: 0 });
  });
  afterAll(() => {
    fms.udpSocket.close();
  });

  test('a DS whose handshake named the team is closed; another team is left alone', async () => {
    const moved = await connectDs(fms, 4159);
    const bystander = await connectDs(fms, 581);
    let bystanderClosed = false;
    bystander.once('close', () => (bystanderClosed = true));

    fms.emit('disconnectTeam', { teamNumber: 4159, reason: 'slot4 joined' });
    await closed(moved);
    await settle();
    expect(bystanderClosed).toBe(false);
    bystander.destroy();
  });

  test('a connection that never handshaked is not touched', async () => {
    const silent = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(fms.tcpPort, ADDRESS, () => resolve(s));
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
    const ds = await connectDs(fms, 1868);
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
  const answers: Record<number, 'red2'> = { 254: 'red2' };
  const askedFrom: string[] = [];

  beforeAll(async () => {
    fms = await startFMSServer({
      address: ADDRESS,
      tcp: 0,
      udp: 0,
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
    const socket = await connectDs(fms, team);
    const chunks: Buffer[] = [];
    const replied = new Promise<void>(resolve =>
      socket.on('data', c => {
        chunks.push(c);
        resolve();
      }),
    );
    // Any reply was written before the server reported the handshake
    if (answers[team]) await replied;
    socket.destroy();
    return Buffer.concat(chunks);
  }

  test('a joined station gets its slot', async () => {
    expect([...(await replyTo(254))]).toEqual([0x00, 0x03, 0x19, 1, 0]);
  });

  test('a team the field is not controlling gets no reply (keeps its own Enable)', async () => {
    expect((await replyTo(6036)).length).toBe(0);
  });

  test("the resolver is told the DS's address", async () => {
    await replyTo(254); // its own handshake: not relying on the tests above having run first
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

  beforeAll(async () => {
    fms = await startFMSServer({ address: ADDRESS, tcp: 0, udp: 0 });
  });
  afterAll(() => {
    fms.udpSocket.close();
  });

  test('each new shape of bad packet from one address is logged with its payload', async () => {
    const log = spyOn(console, 'log');
    const client = dgram.createSocket('udp4');
    const { port } = fms.udpSocket.address();
    const send = (b: Buffer) => new Promise<void>(r => client.send(b, port, ADDRESS, () => r()));
    try {
      await send(Buffer.alloc(0));
      await send(Buffer.from([0xab, 0xcd, 0xef]));
      await send(Buffer.from([0xab, 0xcd, 0xef])); // same shape: counted, not re-logged
      const read = new Promise(resolve => fms.once('message', resolve));
      await send(status()); // a good packet, so the ones before it have been read
      await read;
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

describe('stopping the server (the field network went away)', () => {
  test('drops every DS and frees both ports, so it can start again', async () => {
    const first = await startFMSServer({ address: ADDRESS, tcp: 0, udp: 0 });
    const tcp = first.tcpPort;
    const { port: udp } = first.udpSocket.address();
    const ds = await connectDs(first, 4159);

    await first.close();
    await closed(ds);

    // The same address and ports bind again — what a trunk rebuild needs
    const second = await startFMSServer({ address: ADDRESS, tcp, udp });
    await second.close();
  });
});
