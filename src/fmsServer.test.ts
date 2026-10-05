import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { startFMSServer, type FmsServer } from './fmsServer.js';

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
  const answers: Record<number, 'red2' | 'release'> = { 254: 'red2', 6036: 'release' };

  beforeAll(async () => {
    fms = await startFMSServer({
      address: ADDRESS,
      tcp: TCP2,
      udp: UDP + 1,
      resolveTeamSlot: team => answers[team],
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

  test('a released team gets the status-2 "not in match" reply', async () => {
    expect([...(await replyTo(6036))]).toEqual([0x00, 0x03, 0x19, 0, 2]);
  });
});
