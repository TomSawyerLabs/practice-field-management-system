import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  answerFor,
  MdnsReflector,
  PendingQueries,
  stationScope,
  withDnsId,
  withoutUnicastResponse,
} from './mdnsReflector.js';
import type { InterfaceSocket } from './mdnsSocket.js';
import type { StationName } from './types.js';

/**
 * The reflector's answer routing: a question forwarded to a VLAN is remembered
 * for a few seconds, and the VLAN's answer goes only to the laptop(s) with
 * that question open. This is what stops six radios all named `radio.local`
 * from fighting over every laptop's cache.
 */

const laptopA = { address: '10.55.0.20', port: 5353, id: 0 };
const laptopB = { address: '10.55.0.21', port: 5353, id: 0 };

describe('open questions', () => {
  test('an answer goes to the laptop that asked, on the VLAN it was asked of', () => {
    const q = new PendingQueries();
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['radio.local'], stationScope('slot4'), laptopB, 1_000);
    expect(q.match(['radio.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
    expect(q.match(['radio.local'], stationScope('slot4'), 1_100)).toEqual([laptopB]);
  });

  test('an answer nobody asked for goes nowhere', () => {
    const q = new PendingQueries();
    q.add(['roborio-1234-frc.local'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['radio.local'], stationScope('slot1'), 1_100)).toEqual([]);
    expect(q.match(['roborio-1234-frc.local'], stationScope('slot4'), 1_100)).toEqual([]);
  });

  test('names match case-insensitively and with or without the trailing dot', () => {
    const q = new PendingQueries();
    q.add(['RoboRIO-1234-FRC.local.'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['roborio-1234-frc.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
  });

  test('a question ages out after the TTL', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['radio.local'], stationScope('slot1'), 3_999)).toEqual([laptopA]);
    expect(q.match(['radio.local'], stationScope('slot1'), 4_000)).toEqual([]);
    expect(q.size).toBe(0);
  });

  test('a laptop asking again does not stack, and two laptops both get the answer', () => {
    const q = new PendingQueries();
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_500);
    q.add(['radio.local'], stationScope('slot1'), laptopB, 1_500);
    expect(q.size).toBe(2);
    expect(q.match(['radio.local'], stationScope('slot1'), 1_600)).toEqual([laptopA, laptopB]);
  });

  test('a multi-name answer reaches each asker once', () => {
    const q = new PendingQueries();
    q.add(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
  });

  test("two robots of one team: each station's answer goes to the laptop that asked through it", () => {
    // Both robots answer `limelight.local`; the station the question went to
    // says whose answer is whose, not the team number.
    const q = new PendingQueries();
    q.add(['limelight.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['limelight.local'], stationScope('slot2'), laptopB, 1_000);
    expect(q.match(['limelight.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
    expect(q.match(['limelight.local'], stationScope('slot2'), 1_100)).toEqual([laptopB]);
  });

  test('prune drops aged entries without touching live ones', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['radio.local'], stationScope('slot1'), laptopB, 3_000);
    q.prune(4_500);
    expect(q.match(['radio.local'], stationScope('slot1'), 4_500)).toEqual([laptopB]);
  });
});

describe('legacy one-shot queriers', () => {
  test('the answer carries the ID the querier sent', () => {
    const response = Buffer.alloc(12);
    response.writeUInt16BE(0x8400, 2);
    const patched = withDnsId(response, 0xbeef);
    expect(patched.readUInt16BE(0)).toBe(0xbeef);
    expect(patched.readUInt16BE(2)).toBe(0x8400);
    expect(response.readUInt16BE(0)).toBe(0); // original untouched
  });
});

describe('forwarded queries', () => {
  /** A query for `names`, each question with the QU bit set. */
  function quQuery(names: string[]): Buffer {
    const parts = [Buffer.from([0, 0, 0, 0, 0, names.length, 0, 0, 0, 0, 0, 0])];
    for (const name of names) {
      for (const label of name.split('.')) parts.push(Buffer.from([label.length]), Buffer.from(label));
      parts.push(Buffer.from([0, 0, 1, 0x80, 1])); // end of name, A, class IN | QU
    }
    return Buffer.concat(parts);
  }

  test('ask for multicast answers: the QU bit is cleared in every question', () => {
    const query = quQuery(['limelight-front.local', 'radio.local']);
    const out = withoutUnicastResponse(query);
    const classes: number[] = [];
    for (let i = 0; i < out.length - 1; i++)
      if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 1) classes.push(out.readUInt16BE(i + 3));
    expect(classes).toEqual([1, 1]);
    expect(query.readUInt16BE(query.length - 2)).toBe(0x8001); // original untouched
  });

  test('a truncated question section is left alone rather than misread', () => {
    const query = quQuery(['radio.local']).subarray(0, 16);
    expect(withoutUnicastResponse(query).equals(query)).toBe(true);
  });

  test('a name whose compression pointers loop is given up on, not followed forever', () => {
    const header = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    const toItself = Buffer.from([...header, 0xc0, 12, 0, 1, 0x80, 1]);
    const throughALabel = Buffer.from([...header, 1, 97, 0xc0, 12, 0, 1, 0x80, 1]);
    expect(withoutUnicastResponse(toItself).length).toBe(toItself.length);
    expect(withoutUnicastResponse(throughALabel).length).toBe(throughALabel.length);
  });

  test('answers carry the ID each laptop expects', () => {
    const response = Buffer.alloc(12);
    response.writeUInt16BE(0x1234, 0);
    expect(answerFor(response, { address: '10.55.0.20', port: 5353, id: 0x1234 }).readUInt16BE(0)).toBe(0);
    expect(answerFor(response, { address: '10.55.0.21', port: 50123, id: 0x1234 })).toBe(response);
  });
});

describe('an optional feature must not take the field down', () => {
  /** Stands in for dgram's socket, failing the way Bun's does in a network
   *  namespace with no default route (seen 2026-10-30). */
  class FakeSocket extends EventEmitter {
    joined: (string | undefined)[] = [];
    /** Interfaces with no network yet; undefined is the default one. */
    noNetwork = new Set<string | undefined>();
    alreadyJoined = new Set<string | undefined>();
    bindError: Error | null = null;
    bindCallback: (() => void) | null = null;
    deferBind = false;
    throwOnSend: Error | null = null;
    sends: { port: number; address: string }[] = [];
    closed = 0;

    bind(_port: number, callback: () => void) {
      if (this.bindError) this.emit('error', this.bindError);
      else if (this.deferBind) this.bindCallback = callback;
      else callback();
    }
    addMembership(_group: string, ip?: string) {
      if (this.noNetwork.has(ip)) {
        throw Object.assign(new Error('ENODEV: no such device, setsockopt'), { code: 'ENODEV' });
      }
      if (this.alreadyJoined.has(ip)) {
        throw Object.assign(new Error('EADDRINUSE: address already in use, setsockopt'), { code: 'EADDRINUSE' });
      }
      this.joined.push(ip);
    }
    setMulticastLoopback() {}
    setMulticastTTL() {}
    setTTL() {}
    send(_packet: Buffer, _o: number, _l: number, port: number, address: string, callback: (e: Error | null) => void) {
      if (this.throwOnSend) throw this.throwOnSend;
      this.sends.push({ port, address });
      callback(null);
    }
    close() {
      if (++this.closed > 1) throw new Error('Not running');
    }
  }

  const spies: { mockRestore(): void }[] = [];
  let reflector: MdnsReflector | undefined;

  afterEach(() => {
    reflector?.stop();
    reflector = undefined;
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  /** A reflector on fake sockets, with slot1 occupied. `sockets` are handed
   *  out in turn. `tick` is one pass of its timer, and `robotPacket` arrives
   *  on the station socket it opened. */
  function setup({
    sockets = [new FakeSocket()],
    listen = [],
    excludes,
    teamForStation = (station: StationName) => (station === 'slot1' ? 1234 : null),
    stationForRequester = () => 'slot1',
  }: {
    sockets?: FakeSocket[];
    listen?: string[];
    excludes?: string;
    teamForStation?: (station: StationName) => number | null;
    stationForRequester?: (ip: string) => StationName | null;
  } = {}) {
    const unused = [...sockets];
    spies.push(
      spyOn(dgram, 'createSocket').mockImplementation((() => unused.shift()) as unknown as typeof dgram.createSocket),
    );
    let tick = () => {};
    spies.push(
      spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
        tick = fn;
        return { unref() {} };
      }) as unknown as typeof setInterval),
    );
    for (const method of ['log', 'warn', 'error'] as const) {
      spies.push(spyOn(console, method).mockImplementation(() => {}));
    }

    const opened: string[] = [];
    let onPacket: (data: Buffer, address: string, port: number) => void = () => {};
    const openSocket = (ifname: string, _port: number, handler: typeof onPacket): InterfaceSocket => {
      opened.push(ifname);
      onPacket = handler;
      return { ifname, ifindex: 7, send() {}, sendTo() {}, close() {} };
    };
    reflector = new MdnsReflector(
      teamForStation,
      stationForRequester,
      station => station,
      excludes,
      listen,
      openSocket,
    );
    return {
      reflector,
      opened,
      tick: () => tick(),
      robotPacket: (data: Buffer) => onPacket(data, '10.12.34.1', 5353),
    };
  }

  const name = Buffer.from([5, ...Buffer.from('radio'), 5, ...Buffer.from('local'), 0]);
  /** A laptop asking for radio.local. */
  const query = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), name, Buffer.from([0, 1, 0, 1])]);
  const laptop = { address: '10.55.0.20', port: 5353, family: 'IPv4', size: query.length };
  /** The radio's answer. */
  const answer = Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
    name,
    Buffer.from([0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 10, 12, 34, 1]),
  ]);

  test('no default route at startup: logged, not thrown, and joined once the network is up', () => {
    const socket = new FakeSocket();
    socket.noNetwork.add(undefined);
    const { reflector, tick } = setup({ sockets: [socket] });

    expect(() => reflector.start()).not.toThrow();
    tick();
    expect(socket.joined).toEqual([]);

    socket.noNetwork.clear();
    tick();
    expect(socket.joined).toEqual([undefined]);

    tick();
    expect(socket.joined).toEqual([undefined]);
  });

  test('robots and other interfaces carry on while the default interface has no network', () => {
    const socket = new FakeSocket();
    socket.noNetwork.add(undefined);
    const { reflector, opened } = setup({ sockets: [socket], listen: ['10.55.0.1'] });

    reflector.start();
    expect(socket.joined).toEqual(['10.55.0.1']);
    expect(opened).toEqual(['slot1']);
  });

  test('a listen interface whose address is not up yet is joined when it is', () => {
    const socket = new FakeSocket();
    socket.noNetwork.add('10.55.0.1');
    const { reflector, tick } = setup({ sockets: [socket], listen: ['10.55.0.1'] });

    reflector.start();
    expect(socket.joined).toEqual([undefined]);

    socket.noNetwork.clear();
    tick();
    expect(socket.joined).toEqual([undefined, '10.55.0.1']);
  });

  test('an interface already joined counts as joined, not as one to keep retrying', () => {
    const socket = new FakeSocket();
    socket.alreadyJoined.add('10.55.0.1');
    const addMembership = spyOn(socket, 'addMembership');
    const { reflector, tick } = setup({ sockets: [socket], listen: ['10.55.0.1'] });

    reflector.start();
    const attempts = addMembership.mock.calls.length;
    tick();
    expect(addMembership.mock.calls.length).toBe(attempts);
  });

  test('port 5353 taken: starts on a fresh socket once it is free', () => {
    const taken = new FakeSocket();
    taken.bindError = Object.assign(new Error('bind EADDRINUSE 0.0.0.0'), { code: 'EADDRINUSE' });
    const free = new FakeSocket();
    const { reflector, tick, opened } = setup({ sockets: [taken, free] });

    expect(() => reflector.start()).not.toThrow();
    expect(taken.closed).toBe(1);
    expect(opened).toEqual([]);

    tick();
    expect(free.joined).toEqual([undefined]);
    expect(opened).toEqual(['slot1']);
  });

  test('stopped while still binding: the late bind does nothing', () => {
    const socket = new FakeSocket();
    socket.deferBind = true;
    socket.noNetwork.add(undefined);
    const { reflector } = setup({ sockets: [socket] });

    reflector.start();
    reflector.stop();
    expect(() => socket.bindCallback?.()).not.toThrow();
    expect(socket.closed).toBe(1);
  });

  test('closing a socket that already died is not fatal', () => {
    const socket = new FakeSocket();
    socket.closed = 1;
    const { reflector } = setup({ sockets: [socket] });

    reflector.start();
    expect(() => reflector.stop()).not.toThrow();
  });

  test('a send that throws loses that answer, not the process or the answers after it', () => {
    const socket = new FakeSocket();
    const { reflector, robotPacket } = setup({ sockets: [socket] });
    reflector.start();

    socket.emit('message', query, laptop);
    socket.throwOnSend = Object.assign(new Error('EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' });
    expect(() => robotPacket(answer)).not.toThrow();

    socket.throwOnSend = null;
    robotPacket(answer);
    expect(socket.sends).toEqual([{ port: 5353, address: laptop.address }]);
  });

  test('a throw while handling a laptop packet stays in the reflector', () => {
    const socket = new FakeSocket();
    const { reflector } = setup({
      sockets: [socket],
      stationForRequester: () => {
        throw new Error('lookup failed');
      },
    });
    reflector.start();

    expect(() => socket.emit('message', query, laptop)).not.toThrow();
  });

  test('a throw while handling a robot packet stays in the reflector', () => {
    let broken = false;
    const { reflector, robotPacket } = setup({
      teamForStation: station => {
        if (broken) throw new Error('lookup failed');
        return station === 'slot1' ? 1234 : null;
      },
    });
    reflector.start();

    broken = true;
    expect(() => robotPacket(answer)).not.toThrow();
    broken = false;
  });

  test('a bad MDNS_EXCLUDE_REQUESTERS entry is skipped, not fatal', () => {
    expect(() => setup({ excludes: '10.55.0.20, not-an-ip, 10.0.0.0/99, 10.0.0.9-1' })).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(3);
  });
});
