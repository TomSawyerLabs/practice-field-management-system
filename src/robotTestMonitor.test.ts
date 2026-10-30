import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { NetworkBackend } from './node-ip/index.js';
import {
  DHCP_ATTEMPT_MS,
  DHCP_RETRY_MS,
  DHCP_STOP_GRACE_MS,
  dhcpcdArgs,
  RobotTestMonitor,
  type DhcpHost,
} from './robotTestMonitor.js';
import type { RobotTestState } from './types.js';

// Everything the tester does to the host goes through fakes here: dhcpcd, the
// network backend and fetch (the factory-radio probe). Nothing touches a NIC or
// a radio. The lease is on a non-team address so no team checks run either.
const IFACE = 'test0.99';

/** A dhcpcd that does what the test says. SIGTERM exits 0, as the real one does. */
class FakeDhcpcd extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: (NodeJS.Signals | undefined)[] = [];
  ignoresSigterm = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL') {
      this.signalCode = signal;
      this.emit('exit', null, signal);
    } else if (!this.ignoresSigterm) {
      this.exit(0);
    }
    return true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** Let the promise chains the tester awaits run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('RobotTestMonitor DHCP', () => {
  let procs: FakeDhcpcd[];
  /** Host commands and dhcpcd spawns, in the order they happened. */
  let calls: string[];
  let address: { ip: string; prefixLength: number } | null;
  /** Holds `dhcpcd --release` open until called, when a test sets it. */
  let finishRelease: (() => void) | undefined;
  let holdRelease: boolean;
  let radioResponds: boolean;
  let states: RobotTestState[];
  let monitor: RobotTestMonitor;

  const host: DhcpHost = {
    spawnDhcpcd: () => {
      calls.push('spawn');
      const proc = new FakeDhcpcd();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    },
    run: (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'dhcpcd' && holdRelease) {
        return new Promise(resolve => {
          finishRelease = () => resolve(undefined);
        });
      }
      return Promise.resolve();
    },
    readInterfaceIp: () => Promise.resolve(address),
    readInterfaceGateway: () => Promise.resolve('192.0.2.1'),
  };

  const net = {
    setInterfaceUp: () => Promise.resolve(),
    listInterfaces: () => Promise.resolve([{ link: { kind: 'vlan' } }]),
    addAddress: () => Promise.resolve(),
    removeAddress: () => Promise.resolve(),
    flushAddresses: () => Promise.resolve(),
  } as unknown as NetworkBackend;

  const phase = () => states.at(-1)?.phase;
  const spawnCount = () => calls.filter(c => c === 'spawn').length;

  /** Start the tester on a VLAN, which goes straight to its first dhcpcd. */
  async function startMonitor(): Promise<void> {
    monitor = new RobotTestMonitor(
      IFACE,
      net,
      state => states.push(state),
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      host,
    );
    await monitor.start();
    await settle();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    procs = [];
    calls = [];
    address = null;
    finishRelease = undefined;
    holdRelease = false;
    radioResponds = false;
    states = [];
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      radioResponds
        ? Promise.resolve(Response.json({ teamNumber: 1234, version: '2.0' }))
        : Promise.reject(new Error('no radio'))) as unknown as typeof fetch);
  });

  afterEach(() => {
    monitor?.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('dhcpcd arguments', () => {
    test('the interface is the only positional argument, so dhcpcd stays a single-interface instance', () => {
      const args = dhcpcdArgs(IFACE);
      expect(args.at(-1)).toBe(IFACE);
      expect(args).toContain('--waitip=4');
      expect(args).not.toContain('4');
    });

    test('does not pass --timeout, which --nobackground makes dhcpcd ignore', () => {
      expect(dhcpcdArgs(IFACE)).toContain('--nobackground');
      expect(dhcpcdArgs(IFACE)).not.toContain('--timeout');
    });
  });

  test('stops an attempt nothing answered, without mistaking its exit 0 for a lease, and tries again', async () => {
    await startMonitor();
    expect(spawnCount()).toBe(1);

    jest.advanceTimersByTime(DHCP_ATTEMPT_MS);
    await settle();

    expect(procs[0].signals).toEqual([undefined]);
    expect(phase()).toBe('dhcp_requesting');
    expect(console.log).not.toHaveBeenCalledWith('RobotTestMonitor: dhcpcd succeeded but no IP on interface');
    expect(spawnCount()).toBe(1);

    jest.advanceTimersByTime(DHCP_RETRY_MS);
    await settle();
    expect(spawnCount()).toBe(2);
  });

  test('keeps retrying for as long as nothing answers', async () => {
    await startMonitor();
    for (let attempt = 2; attempt <= 5; attempt++) {
      jest.advanceTimersByTime(DHCP_ATTEMPT_MS);
      await settle();
      jest.advanceTimersByTime(DHCP_RETRY_MS);
      await settle();
      expect(spawnCount()).toBe(attempt);
    }
  });

  test('a retry does not run dhcpcd --release, which only adds log noise when nothing is running', async () => {
    await startMonitor();
    const before = calls.filter(c => c.includes('--release')).length;

    jest.advanceTimersByTime(DHCP_ATTEMPT_MS + DHCP_RETRY_MS);
    await settle();

    expect(spawnCount()).toBe(2);
    expect(calls.filter(c => c.includes('--release')).length).toBe(before);
  });

  test('sends SIGKILL to a dhcpcd that ignores SIGTERM, and still retries once it dies', async () => {
    await startMonitor();
    procs[0].ignoresSigterm = true;

    jest.advanceTimersByTime(DHCP_ATTEMPT_MS);
    await settle();
    expect(procs[0].signals).toEqual([undefined]);

    jest.advanceTimersByTime(DHCP_STOP_GRACE_MS);
    await settle();
    expect(procs[0].signals).toEqual([undefined, 'SIGKILL']);

    jest.advanceTimersByTime(DHCP_RETRY_MS);
    await settle();
    expect(spawnCount()).toBe(2);
  });

  test('a lease moves the tester on and stops the attempt timer', async () => {
    await startMonitor();
    address = { ip: '192.0.2.50', prefixLength: 24 };
    procs[0].exit(0);
    await settle();

    expect(phase()).toBe('ready');
    expect(states.at(-1)?.leasedIp).toBe('192.0.2.50');
    expect(states.at(-1)?.routerIp).toBe('192.0.2.1');

    jest.advanceTimersByTime(DHCP_ATTEMPT_MS + DHCP_RETRY_MS);
    await settle();
    expect(procs[0].signals).toEqual([]);
    expect(spawnCount()).toBe(1);
  });

  test('retries when dhcpcd exits 0 without a lease, as it does after passing its arguments to another dhcpcd', async () => {
    await startMonitor();
    procs[0].exit(0);
    await settle();
    expect(phase()).toBe('dhcp_requesting');

    jest.advanceTimersByTime(DHCP_RETRY_MS);
    await settle();
    expect(spawnCount()).toBe(2);
  });

  test('retries after dhcpcd fails', async () => {
    await startMonitor();
    procs[0].exit(1);
    await settle();

    jest.advanceTimersByTime(DHCP_RETRY_MS);
    await settle();
    expect(spawnCount()).toBe(2);
  });

  test('retries when dhcpcd cannot be started at all', async () => {
    await startMonitor();
    procs[0].emit('error', new Error('Executable not found'));
    await settle();

    jest.advanceTimersByTime(DHCP_RETRY_MS);
    await settle();
    expect(spawnCount()).toBe(2);
  });

  test('releases with --ipv4only, the name the running instance goes by', async () => {
    await startMonitor();
    expect(calls).toContain(`dhcpcd --ipv4only --release ${IFACE}`);
  });

  test('waits for --release to finish before starting dhcpcd', async () => {
    holdRelease = true;
    await startMonitor();
    expect(spawnCount()).toBe(0);

    finishRelease?.();
    await settle();
    expect(spawnCount()).toBe(1);
    expect(calls.indexOf(`dhcpcd --ipv4only --release ${IFACE}`)).toBeLessThan(calls.indexOf('spawn'));
  });

  test('a stop during cleanup cancels the pending start', async () => {
    holdRelease = true;
    await startMonitor();
    monitor.stop();

    finishRelease?.();
    await settle();
    expect(spawnCount()).toBe(0);
  });

  test('stopping between attempts cancels the retry', async () => {
    await startMonitor();
    procs[0].exit(1);
    await settle();
    monitor.stop();

    jest.advanceTimersByTime(DHCP_RETRY_MS);
    await settle();
    expect(spawnCount()).toBe(1);
  });

  test('a dhcpcd stopped by the tester leaves no attempt timer or retry behind', async () => {
    await startMonitor();
    monitor.stop();
    await settle();
    expect(procs[0].signals).toEqual([undefined]);

    jest.advanceTimersByTime(DHCP_ATTEMPT_MS + DHCP_RETRY_MS);
    await settle();
    expect(procs[0].signals).toEqual([undefined]);
    expect(spawnCount()).toBe(1);
  });

  test('a detected radio cuts the wait between attempts short, without doubling up', async () => {
    await startMonitor();
    procs[0].exit(1);
    await settle();

    radioResponds = true;
    jest.advanceTimersByTime(2_000); // The next factory probe
    await settle();
    expect(spawnCount()).toBe(2);

    jest.advanceTimersByTime(DHCP_RETRY_MS - 2_000);
    await settle();
    expect(spawnCount()).toBe(2);
  });
});
