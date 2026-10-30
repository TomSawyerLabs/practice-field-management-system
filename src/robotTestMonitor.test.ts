import { afterEach, beforeEach, describe, expect, jest, spyOn, test, type Mock } from 'bun:test';
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
import * as firmwareUpdater from './firmwareUpdater.js';
import * as interfaceFetch from './interfaceFetch.js';
import type { FirmwareStore } from './firmwareStore.js';
import * as teamChecker from './teamChecker.js';
import type { CheckResult, RobotTestState } from './types.js';

// Everything the tester does to the host goes through fakes here: dhcpcd, the
// network backend and fetchOnInterface (the factory-radio probe). Nothing touches
// a NIC or a radio. The DHCP tests lease a non-team address so no team checks run.
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
  async function startMonitor(firmwareStore?: FirmwareStore): Promise<void> {
    monitor = new RobotTestMonitor(
      IFACE,
      net,
      state => states.push(state),
      undefined,
      firmwareStore,
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
    spyOn(interfaceFetch, 'fetchOnInterface').mockImplementation(() =>
      radioResponds
        ? Promise.resolve(Response.json({ teamNumber: 1234, version: '2.0' }))
        : Promise.reject(new Error('no radio')),
    );
    // A request by the routing table could reach the team's robot on a station
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('left by the routing table'));
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

    test('--reboot leaves a server time to answer a REQUEST, which dhcpcd 10.0.x times with the same value', () => {
      const args = dhcpcdArgs(IFACE);
      expect(Number(args[args.indexOf('--reboot') + 1])).toBeGreaterThanOrEqual(2);
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

  describe('during a radio configure or firmware update', () => {
    const CHECK_INTERVAL_MS = 1_500;
    const radioDown: CheckResult[] = [{ name: 'Radio', status: 'error', message: 'Unreachable' }];
    const radioUp: CheckResult[] = [{ name: 'Radio Team', status: 'pass', message: 'OK' }];
    const firmwareStore = {} as FirmwareStore;

    /** Holds checkRadio open until called, when a test sets it. */
    let finishCheck: ((results: CheckResult[]) => void) | undefined;
    let holdCheck: boolean;
    let checkRadio: Mock<typeof teamChecker.checkRadio>;
    let finishFirmware: (err?: Error) => void;

    const team = () => states.at(-1)?.teamNumber;
    const checkCount = () => checkRadio.mock.calls.length;
    const fetchSpy = () => interfaceFetch.fetchOnInterface as Mock<typeof interfaceFetch.fetchOnInterface>;
    const statusProbes = () => fetchSpy().mock.calls.filter(([, url]) => url.endsWith('/status')).length;

    /** Run time forward in small steps, so awaits between timers get to go. */
    async function runFor(ms: number): Promise<void> {
      for (let elapsed = 0; elapsed < ms; elapsed += 500) {
        jest.advanceTimersByTime(500);
        await settle();
      }
    }

    /** A robot on a team address, with its first round of checks finished. */
    async function startWithRobot(): Promise<void> {
      await startMonitor(firmwareStore);
      address = { ip: '10.12.34.100', prefixLength: 24 };
      procs[0].exit(0);
      await settle();
      expect(phase()).toBe('complete');
      expect(team()).toBe(1234);
    }

    /** A configure stopped at its reboot wait, which polls until the team number shows. */
    async function startConfigure(): Promise<void> {
      radioResponds = true;
      monitor.configureTeamRadio(5678, 'passphrase').catch(() => {});
      await settle();
    }

    beforeEach(() => {
      finishCheck = undefined;
      holdCheck = false;
      spyOn(teamChecker, 'checkFactoryDefault').mockImplementation(() => Promise.resolve([]));
      spyOn(teamChecker, 'checkRobotController').mockImplementation(() =>
        Promise.resolve({ checks: radioDown, controller: null } as never),
      );
      checkRadio = spyOn(teamChecker, 'checkRadio').mockImplementation(() =>
        holdCheck
          ? new Promise(resolve => {
              finishCheck = resolve;
            })
          : Promise.resolve(radioUp),
      );
      spyOn(firmwareUpdater, 'updateRadioFirmware').mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            finishFirmware = err => (err ? reject(err) : resolve());
          }),
      );
    });

    test('a check in flight when a configure starts is dropped, so the reboot looks like nothing', async () => {
      await startWithRobot();
      holdCheck = true;
      await runFor(CHECK_INTERVAL_MS);
      expect(phase()).toBe('checking');

      await startConfigure();
      expect(phase()).toBe('ready');

      // The radio went down for the reboot. On a VLAN that used to read as the robot leaving.
      finishCheck?.(radioDown);
      await settle();

      expect(phase()).toBe('ready');
      expect(team()).toBe(1234);
      expect(spawnCount()).toBe(1);
    });

    test('no check starts during a configure', async () => {
      await startWithRobot();
      await startConfigure();
      const checks = checkCount();

      await runFor(30_000);

      expect(checkCount()).toBe(checks);
      expect(team()).toBe(1234);
    });

    test('a configure that fails restarts the checks and the factory probe', async () => {
      await startWithRobot();
      fetchSpy().mockImplementation(() => Promise.resolve(new Response('nope', { status: 400 })));
      const configure = monitor.configureTeamRadio(5678, 'passphrase');
      await expect(configure).rejects.toThrow('Radio rejected configuration');
      const checks = checkCount();
      expect(checks).toBeGreaterThan(1);

      const probes = statusProbes();
      await runFor(10_000);

      expect(checkCount()).toBeGreaterThan(checks);
      expect(statusProbes()).toBeGreaterThan(probes);
    });

    test('a configure that finishes looks for the new lease, with the checks still off until then', async () => {
      await startWithRobot();
      const checks = checkCount();
      fetchSpy().mockImplementation(() => Promise.resolve(Response.json({ teamNumber: 5678, version: '2.0' })));
      const configure = monitor.configureTeamRadio(5678, 'passphrase');
      await runFor(6_000);
      await configure;
      await settle();

      expect(team()).toBeUndefined();
      expect(phase()).toBe('dhcp_requesting');
      expect(spawnCount()).toBe(2);
      expect(checkCount()).toBe(checks);
    });

    test('a firmware update stops the checks and the factory probe, then restarts both when it fails', async () => {
      await startWithRobot();
      const update = monitor.startFirmwareUpdate('passphrase', undefined);
      update.catch(() => {});
      await settle();
      expect(phase()).toBe('ready');

      const checks = checkCount();
      const probes = statusProbes();
      await runFor(10_000);
      expect(checkCount()).toBe(checks);
      expect(statusProbes()).toBe(probes);

      finishFirmware(new Error('Upload failed'));
      await expect(update).rejects.toThrow('Upload failed');
      await settle();
      expect(checkCount()).toBe(checks + 1);

      await runFor(CHECK_INTERVAL_MS + 500);
      expect(checkCount()).toBeGreaterThan(checks + 1);
      expect(statusProbes()).toBeGreaterThan(probes);
    });

    test('a firmware update that finishes starts the settling window and checks again', async () => {
      await startWithRobot();
      const update = monitor.startFirmwareUpdate('passphrase', undefined);
      await settle();
      const checks = checkCount();

      finishFirmware();
      await update;
      await settle();

      expect(checkCount()).toBe(checks + 1);
    });

    test("a configure and its reboot wait stay on the tester's interface", async () => {
      await startWithRobot();
      fetchSpy().mockImplementation(() => Promise.resolve(Response.json({ teamNumber: 5678, version: '2.0' })));
      fetchSpy().mockClear();
      const configure = monitor.configureTeamRadio(5678, 'passphrase');
      await runFor(6_000);
      await configure;

      const urls = fetchSpy().mock.calls.map(([ifname, url]) => `${ifname} ${url}`);
      expect(urls).toContain(`${IFACE} http://10.12.34.1/configuration`);
      expect(urls).toContain(`${IFACE} http://192.168.69.1/status`);
      expect(urls.every(url => url.startsWith(`${IFACE} `))).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test("the checks and the firmware update are given the tester's interface", async () => {
      await startWithRobot();
      const source = { ifname: IFACE };
      expect(teamChecker.checkFactoryDefault).toHaveBeenCalledWith(1234, source);
      expect(teamChecker.checkRobotController).toHaveBeenCalledWith(1234, [], source);
      expect(checkRadio).toHaveBeenCalledWith(1234, source, null);

      monitor.startFirmwareUpdate('passphrase', undefined).catch(() => {});
      await settle();
      expect(
        (firmwareUpdater.updateRadioFirmware as Mock<typeof firmwareUpdater.updateRadioFirmware>).mock.calls[0][1],
      ).toBe(IFACE);
    });

    test('a configure refuses a firmware update', async () => {
      await startWithRobot();
      await startConfigure();
      await expect(monitor.startFirmwareUpdate('passphrase', undefined)).rejects.toThrow('Radio configuration');
    });

    test('a firmware update refuses a configure', async () => {
      await startWithRobot();
      monitor.startFirmwareUpdate('passphrase', undefined).catch(() => {});
      await settle();
      await expect(monitor.configureTeamRadio(5678, 'passphrase')).rejects.toThrow('Firmware update in progress');
    });

    test('an operation that ends after stop() restarts nothing', async () => {
      await startWithRobot();
      const update = monitor.startFirmwareUpdate('passphrase', undefined);
      await settle();
      monitor.stop();
      const checks = checkCount();
      const probes = statusProbes();

      finishFirmware();
      await update;
      await runFor(10_000);

      expect(checkCount()).toBe(checks);
      expect(statusProbes()).toBe(probes);
      expect(spawnCount()).toBe(1);
    });

    test('a check in flight at stop() can not schedule another', async () => {
      await startWithRobot();
      holdCheck = true;
      await runFor(CHECK_INTERVAL_MS);
      const checks = checkCount();

      monitor.stop();
      holdCheck = false;
      finishCheck?.(radioUp);
      await runFor(10_000);

      expect(checkCount()).toBe(checks);
    });
  });
});
