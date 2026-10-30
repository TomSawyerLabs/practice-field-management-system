import type { StationName, StationTestState, RobotTestState, WpaKeyCheckResult } from './types.js';
import { RobotTestMonitor } from './robotTestMonitor.js';
import type { PortBridgeManager } from './portBridgeManager.js';
import type { NetworkBackend } from './node-ip/index.js';
import type { FirmwareStore } from './firmwareStore.js';
import type RadioManager from './radioManager.js';
import { fetchOnInterface } from './interfaceFetch.js';
import { hashWpaKey } from './wpaKeyUtils.js';
import { teamSubnet } from './utils.js';
import { appInfo, appWarn } from './appLogger.js';

/** How long (ms) before an idle test port mode session auto-exits. */
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
/** How often to check for timed-out sessions. */
const TIMEOUT_CHECK_INTERVAL_MS = 30_000;

type StationProgress = NonNullable<StationTestState['progress']>;

interface ActiveSession {
  monitor: RobotTestMonitor;
  portVlanId: number;
  portName: string;
  startedAt: number;
  lastActivity: number;
  /** Latest WPA key check results (updated after each check cycle). */
  wpaKeyChecks?: WpaKeyCheckResult[];
  /** Latest step of a radio configure or firmware update. */
  progress?: StationProgress;
}

/**
 * Manages per-station test port mode sessions.
 *
 * When a user activates test port mode for a station, this manager:
 * 1. Bridges a physical port to the station's VLAN
 * 2. Creates a RobotTestMonitor on the bridge interface
 * 3. Broadcasts per-station test state
 * 4. Auto-exits after 5 minutes of inactivity
 */
export class StationTestManager {
  private readonly sessions = new Map<StationName, ActiveSession>();
  /** Ports currently owned by test mode (vs. manually bridged by the user).
   *  Used to distinguish test-mode bridges in port availability UI. */
  private readonly testModePorts = new Set<number>();
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly portBridgeManager: PortBridgeManager,
    private readonly net: NetworkBackend,
    private readonly firmwareStore: FirmwareStore | undefined,
    private readonly radioManager: RadioManager,
    private readonly onStateChange: (state: StationTestState) => void,
    private readonly dryRun: boolean,
    private readonly hasClients?: () => boolean,
  ) {
    this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);
  }

  /** Start test port mode for a station on a specific port. */
  async startTestMode(station: StationName, portVlanId: number): Promise<void> {
    // If already active for this station, stop it first
    if (this.sessions.has(station)) {
      await this.stopTestMode(station);
    }

    // Look up port name
    const portState = this.portBridgeManager.getState();
    const portConfig = portState.ports.find(p => p.vlanId === portVlanId);
    if (!portConfig) throw new Error(`Unknown port VLAN ID: ${portVlanId}`);

    // Create the port's VLAN sub-interface as an isolated interface (NOT bridged
    // to the station's br-slotN). The robot plugged into this port is the only
    // device on this L2 segment — same isolation as the dedicated test interface.
    appInfo(`StationTestManager: starting test mode for ${station} on ${portConfig.name} (VLAN ${portVlanId})`);
    const portIface = await this.portBridgeManager.createStandalonePort(portVlanId);
    this.testModePorts.add(portVlanId);

    const now = Date.now();
    const monitor = new RobotTestMonitor(
      portIface,
      this.net,
      state => this.handleStateChange(station, state),
      progress => this.handleProgress(station, monitor, progress),
      this.firmwareStore,
      this.dryRun,
      this.hasClients,
      progress => this.handleProgress(station, monitor, progress),
    );
    const session: ActiveSession = {
      monitor,
      portVlanId,
      portName: portConfig.name,
      startedAt: now,
      lastActivity: now,
    };

    this.sessions.set(station, session);
    await session.monitor.start();
    appInfo(`StationTestManager: test mode active for ${station} on ${session.portName}`);
  }

  /** Stop test port mode for a station. */
  async stopTestMode(station: StationName): Promise<void> {
    const session = this.sessions.get(station);
    if (!session) return;

    appInfo(`StationTestManager: stopping test mode for ${station}`);
    session.monitor.stop();
    this.testModePorts.delete(session.portVlanId);
    await this.portBridgeManager.deleteStandalonePort(session.portVlanId);

    this.sessions.delete(station);

    // Broadcast removal — station field present with a null testState signals "stopped"
    this.broadcastState(station);
  }

  /** Get the current test state for a station, or null if not active. */
  getState(station: StationName): StationTestState | null {
    const session = this.sessions.get(station);
    if (!session) return null;
    return this.buildState(station, session);
  }

  /** Get all active station test states. */
  getAllStates(): StationTestState[] {
    const states: StationTestState[] = [];
    for (const [station, session] of this.sessions) {
      states.push(this.buildState(station, session));
    }
    return states;
  }

  /** Whether a port is currently used for test mode. */
  isTestModePort(portVlanId: number): boolean {
    return this.testModePorts.has(portVlanId);
  }

  /** Configure a robot radio through a station's test port mode session. */
  async configureRadio(
    station: StationName,
    teamNumber: number,
    wpaKey6: string,
    wpaKey24?: string,
    ssidSuffix?: string,
  ): Promise<void> {
    const session = this.sessions.get(station);
    if (!session) throw new Error(`Test port mode is not active for ${station}`);
    session.lastActivity = Date.now();

    try {
      // Auto-resolve WPA key from station config if not provided
      const config = this.radioManager.getStationConfig(station);
      const resolvedKey6 = wpaKey6 || config?.wpaKey;
      if (!resolvedKey6) throw new Error('No WPA key provided and none configured for this station');

      await session.monitor.configureTeamRadio(teamNumber, resolvedKey6, wpaKey24 || resolvedKey6, ssidSuffix);
    } catch (err) {
      this.reportRefused(station, session, 'radioConfigureProgress', err);
      throw err;
    }
  }

  /** Start a firmware update through a station's test port mode session. */
  async startFirmwareUpdate(
    station: StationName,
    wpaKey?: string,
    wpaKey24?: string,
    skipReconfigure?: boolean,
  ): Promise<void> {
    const session = this.sessions.get(station);
    if (!session) throw new Error(`Test port mode is not active for ${station}`);
    session.lastActivity = Date.now();

    // Auto-detect WPA key from station config if not provided
    const config = this.radioManager.getStationConfig(station);
    const resolvedKey = wpaKey || config?.wpaKey;
    try {
      await session.monitor.startFirmwareUpdate(resolvedKey, wpaKey24, skipReconfigure);
    } catch (err) {
      this.reportRefused(station, session, 'firmwareUpdateProgress', err);
      throw err;
    }
  }

  /** Check WPA keys for a station's test session against the expected station config. */
  async checkWpaKeys(station: StationName): Promise<WpaKeyCheckResult[]> {
    const session = this.sessions.get(station);
    if (!session) return [];

    const config = this.radioManager.getStationConfig(station);
    if (!config?.wpaKey) return [];

    const testState = session.monitor.getState();
    if (!testState.teamNumber) return [];

    // Fetch radio status to get per-band WPA key hashes
    const team = testState.teamNumber;
    const radioIp = `${teamSubnet(team)}.1`;

    try {
      const res = await fetchOnInterface(testState.interfaceName, `http://${radioIp}/status`, {}, 3000);
      if (!res.ok) return [];

      const status = (await res.json()) as {
        networkStatus6?: { hashedWpaKey?: string; wpaKeySalt?: string };
        networkStatus24?: { hashedWpaKey?: string; wpaKeySalt?: string };
      };

      const results: WpaKeyCheckResult[] = [];
      const bands = [
        { name: '6GHz' as const, data: status.networkStatus6 },
        { name: '2.4GHz' as const, data: status.networkStatus24 },
      ];

      for (const { name, data } of bands) {
        if (!data?.hashedWpaKey || !data?.wpaKeySalt) {
          results.push({ band: name, status: 'unknown', message: `${name} band data not available` });
          continue;
        }
        const expected = hashWpaKey(config.wpaKey, data.wpaKeySalt);
        if (expected === data.hashedWpaKey) {
          results.push({ band: name, status: 'pass', message: `${name} passphrase matches` });
        } else {
          results.push({
            band: name,
            status: 'mismatch',
            message: `The robot radio's ${name} passphrase does not match this station's configuration. This commonly happens after attending a competition.`,
          });
        }
      }

      session.wpaKeyChecks = results;
      this.broadcastState(station);
      return results;
    } catch {
      return [];
    }
  }

  /** Stop all sessions and clean up. */
  async stopAll(): Promise<void> {
    for (const station of [...this.sessions.keys()]) {
      await this.stopTestMode(station);
    }
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  private handleStateChange(station: StationName, state: RobotTestState): void {
    const session = this.sessions.get(station);
    if (!session) return;
    session.lastActivity = Date.now();
    // A finished step stays up until the settling it started is over
    if (session.progress?.step === 'complete' && !state.reconfiguredAt) session.progress = undefined;
    this.broadcastState(station);

    // When checks complete, run WPA key verification automatically
    if (state.phase === 'complete' && state.teamNumber) {
      this.checkWpaKeys(station).catch(err => {
        appWarn(`StationTestManager: WPA key check failed for ${station}: ${(err as Error).message}`);
      });
    }
  }

  private handleProgress(station: StationName, monitor: RobotTestMonitor, progress: StationProgress): void {
    const session = this.sessions.get(station);
    // stop() doesn't abort an operation, so a stopped monitor can still report
    if (session?.monitor !== monitor) return;
    session.lastActivity = Date.now();
    session.progress = progress;
    // Those results describe the radio as it was before this change
    if (progress.step === 'complete') session.wpaKeyChecks = undefined;
    this.broadcastState(station);
  }

  /** The monitor only reports failures once an operation is under way. Show
   *  the requests it refused outright too. */
  private reportRefused(
    station: StationName,
    session: ActiveSession,
    type: StationProgress['type'],
    err: unknown,
  ): void {
    if (this.sessions.get(station) !== session) return;
    const { progress } = session;
    // A second request bounced off an operation that is still running
    if (progress && progress.step !== 'complete' && progress.step !== 'error') return;
    const message = (err as Error).message;
    // The monitor already reported this one
    if (progress?.error === message) return;
    session.progress = { type, step: 'error', message, progress: 0, elapsedMs: 0, error: message };
    this.broadcastState(station);
  }

  private broadcastState(station: StationName): void {
    const session = this.sessions.get(station);
    if (!session) {
      // Send a "stopped" state — station with no testState
      this.onStateChange({
        type: 'stationTestState',
        station,
        testState: {
          phase: 'disabled',
          interfaceName: '',
          linkUp: false,
          checks: [],
          lastUpdate: Date.now(),
        },
        portVlanId: 0,
        portName: '',
        timeoutRemaining: 0,
        startedAt: 0,
      });
      return;
    }
    this.onStateChange(this.buildState(station, session));
  }

  private buildState(station: StationName, session: ActiveSession): StationTestState {
    const { type: _, ...testState } = session.monitor.getState();
    const elapsed = Date.now() - session.lastActivity;
    const remaining = Math.max(0, Math.ceil((INACTIVITY_TIMEOUT_MS - elapsed) / 1000));
    return {
      type: 'stationTestState',
      station,
      testState,
      portVlanId: session.portVlanId,
      portName: session.portName,
      wpaKeyChecks: session.wpaKeyChecks,
      progress: session.progress,
      timeoutRemaining: remaining,
      startedAt: session.startedAt,
    };
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const [station, session] of this.sessions) {
      if (now - session.lastActivity >= INACTIVITY_TIMEOUT_MS) {
        appInfo(`StationTestManager: ${station} timed out after 5 minutes of inactivity`);
        this.stopTestMode(station).catch(err => {
          appWarn(`StationTestManager: failed to stop timed-out session for ${station}: ${(err as Error).message}`);
        });
      }
    }
  }
}
