import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { RobotTestMonitor } from './robotTestMonitor.js';
import { StationTestManager } from './stationTestManager.js';
import type { PortBridgeManager } from './portBridgeManager.js';
import type RadioManager from './radioManager.js';
import type { NetworkBackend } from './node-ip/index.js';
import type { RadioConfigureProgress, RobotTestState, StationName, StationTestState } from './types.js';

const portBridge = {
  getState: () => ({
    type: 'portBridgeState',
    ports: [
      { name: 'Port A', vlanId: 101 },
      { name: 'Port B', vlanId: 102 },
    ],
    activeBridges: {},
  }),
  createStandalonePort: async (vlanId: number) => `test0.p${vlanId}`,
  deleteStandalonePort: async () => {},
} as unknown as PortBridgeManager;

const radioManager = { getStationConfig: () => ({ wpaKey: 'station-key' }) } as unknown as RadioManager;

type Step = Omit<RadioConfigureProgress, 'type' | 'elapsedMs'>;

/** Reach the callbacks the manager handed a monitor: `this` in a spied method. */
const internals = (monitor: RobotTestMonitor) =>
  monitor as unknown as {
    onRadioConfigureProgress: (p: RadioConfigureProgress) => void;
    onStateChange: (s: RobotTestState) => void;
  };

const sendRadioStep = (monitor: RobotTestMonitor, step: Step) =>
  internals(monitor).onRadioConfigureProgress({ type: 'radioConfigureProgress', elapsedMs: 1, ...step });

describe('StationTestManager progress', () => {
  let manager: StationTestManager;
  let broadcasts: StationTestState[];
  let spies: { mockRestore(): void }[];
  /** The monitor whose operation is "running", set by the configure spy. */
  let running: RobotTestMonitor | undefined;
  let finishConfigure: (err?: Error) => void;

  const latest = (station: StationName) => broadcasts.filter(b => b.station === station).at(-1);

  beforeEach(async () => {
    broadcasts = [];
    running = undefined;
    spies = [
      spyOn(console, 'log').mockImplementation(() => {}),
      // start() and stop() would poll a link and run dhcpcd
      spyOn(RobotTestMonitor.prototype, 'start').mockImplementation(async () => {}),
      spyOn(RobotTestMonitor.prototype, 'stop').mockImplementation(() => {}),
      spyOn(RobotTestMonitor.prototype, 'configureTeamRadio').mockImplementation(function (this: RobotTestMonitor) {
        running = this;
        return new Promise<void>((resolve, reject) => {
          finishConfigure = err => (err ? reject(err) : resolve());
        });
      }),
    ];
    manager = new StationTestManager(
      portBridge,
      {} as NetworkBackend,
      undefined,
      radioManager,
      state => broadcasts.push(state),
      true,
    );
    await manager.startTestMode('slot1', 101);
    await manager.startTestMode('slot2', 102);
  });

  afterEach(async () => {
    await manager.stopAll();
    for (const spy of spies) spy.mockRestore();
  });

  test('a step reaches only its own station, in its state', () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    sendRadioStep(running!, { step: 'sending', message: 'Sending...', progress: 10 });

    expect(latest('slot1')?.progress).toMatchObject({ type: 'radioConfigureProgress', step: 'sending', progress: 10 });
    expect(manager.getState('slot2')?.progress).toBeUndefined();
  });

  test('a client connecting mid-operation gets the current step', () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    sendRadioStep(running!, { step: 'waiting_reboot', message: 'Waiting...', progress: 30 });

    const replay = manager.getAllStates().find(s => s.station === 'slot1');
    expect(replay?.progress?.step).toBe('waiting_reboot');
  });

  test('progress counts as activity for the inactivity timeout', () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    const realNow = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(realNow + 4 * 60_000);
    spies.push(now);

    sendRadioStep(running!, { step: 'waiting_reboot', message: 'Waiting...', progress: 30 });

    expect(manager.getState('slot1')?.timeoutRemaining).toBe(300);
  });

  test('a finished step stays through settling, then clears', () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    const monitor = running!;
    const base = { ...monitor.getState(), phase: 'checking' as const };
    sendRadioStep(monitor, { step: 'complete', message: 'Done', progress: 100 });

    internals(monitor).onStateChange({ ...base, reconfiguredAt: Date.now() });
    expect(latest('slot1')?.progress?.step).toBe('complete');

    internals(monitor).onStateChange({ ...base, reconfiguredAt: undefined });
    expect(latest('slot1')?.progress).toBeUndefined();
  });

  test('a finished step drops the passphrase results from before the change', async () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    const monitor = running!;
    const session = (manager as unknown as { sessions: Map<StationName, { wpaKeyChecks?: unknown[] }> }).sessions;
    session.get('slot1')!.wpaKeyChecks = [{ band: '6GHz', status: 'mismatch', message: 'old' }];

    sendRadioStep(monitor, { step: 'waiting_reboot', message: 'Waiting...', progress: 30 });
    expect(latest('slot1')?.wpaKeyChecks).toHaveLength(1);

    sendRadioStep(monitor, { step: 'complete', message: 'Done', progress: 100 });
    expect(latest('slot1')?.wpaKeyChecks).toBeUndefined();
  });

  test('an error stays when later checks run', () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    const monitor = running!;
    sendRadioStep(monitor, { step: 'error', message: 'Nope', progress: 0, error: 'Nope' });

    internals(monitor).onStateChange({ ...monitor.getState(), phase: 'complete' });

    expect(latest('slot1')?.progress?.step).toBe('error');
  });

  test('a request the monitor refuses outright shows as an error', async () => {
    const pending = manager.configureRadio('slot1', 1234, 'k');
    finishConfigure(new Error('Link is down'));

    await expect(pending).rejects.toThrow('Link is down');

    expect(latest('slot1')?.progress).toMatchObject({
      type: 'radioConfigureProgress',
      step: 'error',
      error: 'Link is down',
    });
  });

  test('a refused second request leaves the running step alone', async () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    sendRadioStep(running!, { step: 'waiting_reboot', message: 'Waiting...', progress: 30 });

    const second = manager.configureRadio('slot1', 1234, 'k');
    finishConfigure(new Error('Radio configuration already in progress'));

    await expect(second).rejects.toThrow('already in progress');
    expect(latest('slot1')?.progress?.step).toBe('waiting_reboot');
  });

  test('a failure the monitor already reported is not reported twice', async () => {
    const pending = manager.configureRadio('slot1', 1234, 'k');
    sendRadioStep(running!, { step: 'error', message: 'Nope', progress: 0, error: 'Nope' });
    const count = broadcasts.length;

    finishConfigure(new Error('Nope'));
    await expect(pending).rejects.toThrow('Nope');

    expect(broadcasts.length).toBe(count);
  });

  test("a stopped session's monitor can't report into the next session", async () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    const stale = running!;
    await manager.stopTestMode('slot1');
    await manager.startTestMode('slot1', 101);

    sendRadioStep(stale, { step: 'error', message: 'Too late', progress: 0, error: 'Too late' });

    expect(manager.getState('slot1')?.progress).toBeUndefined();
  });

  test('a new operation replaces the last result', () => {
    manager.configureRadio('slot1', 1234, 'k').catch(() => {});
    const monitor = running!;
    sendRadioStep(monitor, { step: 'error', message: 'Nope', progress: 0, error: 'Nope' });

    sendRadioStep(monitor, { step: 'sending', message: 'Sending...', progress: 10 });

    expect(latest('slot1')?.progress?.step).toBe('sending');
  });
});
