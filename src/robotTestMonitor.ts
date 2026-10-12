import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RobotTestState,
  RobotTestPhase,
  CheckResult,
  FirmwareUpdateProgress,
  RadioConfigureProgress,
} from './types.js';
import { checkRadio, checkRobotController, checkFactoryDefault } from './teamChecker.js';
import { updateRadioFirmware } from './firmwareUpdater.js';
import type { FirmwareStore } from './firmwareStore.js';
import type { NetworkBackend } from './node-ip/index.js';

const execFile = promisify(execFileCb);

const LINK_POLL_MS = 200;
const CHECK_INTERVAL_MS = 1_500;
/** Default secondary IP added to the test interface so we can reach factory-default radios at 192.168.69.1. */
const DEFAULT_FACTORY_PROBE_IP = '192.168.69.8';
const FACTORY_PROBE_PREFIX = 24;

/** Parse a team number from an IP in the 10.TE.AM.x range. */
function teamFromIp(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts[0] !== '10') return null;
  const high = parseInt(parts[1], 10);
  const low = parseInt(parts[2], 10);
  if (isNaN(high) || isNaN(low)) return null;
  const team = high * 100 + low;
  return team > 0 && team <= 25599 ? team : null;
}

/** Read the DHCP-assigned IPv4 address on an interface, skipping any static addresses we added. */
async function getInterfaceIp(
  iface: string,
  excludeIps: string[] = [],
): Promise<{ ip: string; prefixLength: number } | null> {
  try {
    const { stdout } = await execFile('ip', ['-j', 'addr', 'show', 'dev', iface]);
    const data = JSON.parse(stdout);
    if (!data[0]?.addr_info) return null;
    const v4 = data[0].addr_info.find(
      (a: { family: string; local: string }) => a.family === 'inet' && !excludeIps.includes(a.local),
    );
    if (!v4) return null;
    return { ip: v4.local, prefixLength: v4.prefixlen ?? 24 };
  } catch {
    return null;
  }
}

/** Read the default gateway for an interface from the routing table. */
async function getInterfaceGateway(iface: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('ip', ['-j', 'route', 'show', 'dev', iface, 'default']);
    const routes = JSON.parse(stdout);
    return routes[0]?.gateway;
  } catch {
    return undefined;
  }
}

export class RobotTestMonitor {
  private phase: RobotTestPhase = 'link_down';
  private linkUp = false;
  private macAddress?: string;
  private teamNumber?: number;
  private leasedIp?: string;
  private leasedPrefix = 24;
  private routerIp?: string;
  private checks: CheckResult[] = [];
  private linkPollTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private dhcpProc: ChildProcess | null = null;
  private checking = false;
  private firmwareUpdating = false;
  private radioConfiguring = false;
  private factoryProbeTimer: NodeJS.Timeout | null = null;
  /** True if the interface is a VLAN sub-interface (link state mirrors parent, not meaningful). */
  private skipLinkDetection = false;
  /** IP where the factory-default radio was last seen (set by probeFactoryDefault). */
  private factoryRadioIp: string | null = null;
  /** Timestamp when a radio reconfiguration or firmware update completed — network is "settling". */
  private reconfiguredAt?: number;
  /** Max settling window (ms). VLAN "all devices down" reset is suppressed during this window. */
  private reconfigureTimeoutMs?: number;
  /** What kind of reconfiguration triggered the settling period. */
  private reconfigureType?: 'radio' | 'firmware';

  constructor(
    private readonly interfaceName: string,
    private readonly net: NetworkBackend,
    private readonly onStateChange: (state: RobotTestState) => void,
    private readonly onFirmwareProgress?: (progress: FirmwareUpdateProgress) => void,
    private readonly firmwareStore?: FirmwareStore,
    private readonly dryRun = false,
    private readonly hasClients?: () => boolean,
    private readonly onRadioConfigureProgress?: (progress: RadioConfigureProgress) => void,
    private readonly factoryProbeIp: string = DEFAULT_FACTORY_PROBE_IP,
  ) {}

  async start(): Promise<void> {
    console.log(`RobotTestMonitor: starting on ${this.interfaceName}`);
    if (!this.dryRun) {
      await this.net.setInterfaceUp(this.interfaceName);
      // Detect if this is a VLAN sub-interface — link state mirrors the parent
      // and is meaningless for detecting whether a robot is plugged in.
      try {
        const interfaces = await this.net.listInterfaces(this.interfaceName);
        const iface = interfaces[0];
        if (iface?.link?.kind === 'vlan' || this.interfaceName.includes('.')) {
          this.skipLinkDetection = true;
          console.log(`RobotTestMonitor: ${this.interfaceName} is a VLAN — skipping link detection`);
        }
      } catch {
        // Fall back to link detection
      }
    }
    if (this.skipLinkDetection) {
      // VLAN interface: treat as always linked, go straight to DHCP
      this.handleLinkUp();
    }
    this.linkPollTimer = setInterval(() => this.pollLink(), LINK_POLL_MS);
    this.broadcast();
  }

  stop(): void {
    if (this.linkPollTimer) {
      clearInterval(this.linkPollTimer);
      this.linkPollTimer = null;
    }
    this.stopChecking();
    this.stopFactoryProbe();
    this.killDhcp();
    console.log('RobotTestMonitor: stopped');
  }

  getState(): RobotTestState {
    return {
      type: 'robotTestState',
      phase: this.phase,
      interfaceName: this.interfaceName,
      isVlan: this.skipLinkDetection,
      linkUp: this.linkUp,
      macAddress: this.macAddress,
      teamNumber: this.teamNumber,
      leasedIp: this.leasedIp,
      routerIp: this.routerIp,
      checks: this.checks,
      lastUpdate: Date.now(),
      reconfiguredAt: this.reconfiguredAt,
      reconfigureTimeoutMs: this.reconfiguredAt ? this.reconfigureTimeoutMs : undefined,
      reconfigureType: this.reconfiguredAt ? this.reconfigureType : undefined,
    };
  }

  // ── Link detection ────────────────────────────────────────────────

  private async pollLink(): Promise<void> {
    if (this.skipLinkDetection) return; // VLAN: link state is meaningless
    try {
      const interfaces = await this.net.listInterfaces(this.interfaceName);
      const iface = interfaces[0];
      if (!iface) {
        if (this.linkUp) this.handleLinkDown();
        return;
      }

      this.macAddress = iface.mac;
      const up = iface.state === 'UP';

      if (up && !this.linkUp) {
        this.handleLinkUp();
      } else if (!up && this.linkUp) {
        this.handleLinkDown();
      }
    } catch {
      // Interface might not exist yet
      if (this.linkUp) this.handleLinkDown();
    }
  }

  private handleLinkUp(): void {
    this.linkUp = true;
    this.phase = 'link_up';
    console.log(`RobotTestMonitor: link UP on ${this.interfaceName}`);
    this.broadcast();
    // Add secondary IP for factory-default radio detection (192.168.69.1)
    if (!this.dryRun) {
      this.net
        .addAddress({
          interfaceName: this.interfaceName,
          address: this.factoryProbeIp,
          prefixLength: FACTORY_PROBE_PREFIX,
        })
        .catch(() => {}); // May already exist from a previous link cycle
    }
    this.startFactoryProbe();
    this.startDhcp();
  }

  private handleLinkDown(): void {
    this.linkUp = false;
    this.phase = 'link_down';
    this.teamNumber = undefined;
    this.leasedIp = undefined;
    this.routerIp = undefined;
    this.checks = [];
    this.reconfiguredAt = undefined;
    this.reconfigureTimeoutMs = undefined;
    this.reconfigureType = undefined;
    this.stopChecking();
    this.stopFactoryProbe();
    this.killDhcp();
    if (!this.dryRun) {
      this.net.flushAddresses(this.interfaceName).catch(() => {});
    }
    console.log(`RobotTestMonitor: link DOWN on ${this.interfaceName}`);
    this.broadcast();
  }

  // ── Factory default probe ──────────────────────────────────────────

  private startFactoryProbe(): void {
    this.stopFactoryProbe();
    // Probe immediately, then every 2 seconds
    this.probeFactoryDefault();
    this.factoryProbeTimer = setInterval(() => this.probeFactoryDefault(), 2000);
  }

  private stopFactoryProbe(): void {
    if (this.factoryProbeTimer) {
      clearInterval(this.factoryProbeTimer);
      this.factoryProbeTimer = null;
    }
  }

  // ── DHCP ──────────────────────────────────────────────────────────

  private startDhcp(): void {
    if (this.dryRun) {
      console.log(`[dry-run] Would run dhcpcd on ${this.interfaceName}`);
      this.phase = 'dhcp_requesting';
      this.broadcast();
      return;
    }

    this.phase = 'dhcp_requesting';
    this.broadcast();

    // Kill any stale dhcpcd for this interface
    this.killDhcp();

    // dhcpcd --oneshot: obtain a lease and exit
    // --nobackground: stay in foreground (we manage the process)
    // --waitip 4: wait until an IPv4 address is assigned
    // --noipv4ll: don't fall back to link-local (169.254.x.x) if no DHCP server responds
    // --reboot 0: skip rebinding the last lease, always do a fresh discover
    // --nohook resolv.conf: never register the lease's DNS servers with the host
    //   resolver — a robot radio's DNS must not affect name resolution for the
    //   rest of the host (we only need the IP to detect the team number)
    // --nohook hostname: never let a lease rename the host
    const proc = spawn(
      'dhcpcd',
      [
        '--oneshot',
        '--nobackground',
        '--waitip',
        '4',
        '--timeout',
        '1',
        '--noipv4ll',
        '--reboot',
        '0',
        '--nohook',
        'resolv.conf',
        '--nohook',
        'hostname',
        this.interfaceName,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.dhcpProc = proc;

    proc.on('error', err => {
      this.dhcpProc = null;
      console.error(`RobotTestMonitor: failed to start dhcpcd: ${err.message}`);
      // Retry after a delay if link is still up
      if (this.linkUp) {
        setTimeout(() => {
          if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
        }, 5000);
      }
    });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('exit', async code => {
      this.dhcpProc = null;
      if (!this.linkUp) return; // Link dropped during DHCP

      if (code === 0) {
        await this.handleDhcpSuccess();
      } else {
        console.log(`RobotTestMonitor: dhcpcd exited with code ${code}`);
        for (const line of output.trim().split('\n')) {
          console.log(`  dhcpcd: ${line}`);
        }
        // Retry after a delay if link is still up
        if (this.linkUp) {
          setTimeout(() => {
            if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
          }, 5000);
        }
      }
    });
  }

  private async handleDhcpSuccess(): Promise<void> {
    try {
      // Read the assigned IP directly from the interface
      const addr = await getInterfaceIp(this.interfaceName, [this.factoryProbeIp]);
      if (!addr) {
        console.log('RobotTestMonitor: dhcpcd succeeded but no IP on interface');
        return;
      }

      // Reject link-local addresses (169.254.x.x) — means no DHCP server responded
      if (addr.ip.startsWith('169.254.')) {
        console.log(`RobotTestMonitor: got link-local address ${addr.ip} — no DHCP server, retrying`);
        if (!this.dryRun) {
          this.net
            .removeAddress({ interfaceName: this.interfaceName, address: addr.ip, prefixLength: addr.prefixLength })
            .catch(() => {});
        }
        // Retry DHCP after a short delay
        if (this.linkUp) {
          setTimeout(() => {
            if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
          }, 500);
        }
        return;
      }

      this.leasedIp = addr.ip;
      this.leasedPrefix = addr.prefixLength;
      this.routerIp = await getInterfaceGateway(this.interfaceName);
      this.teamNumber = teamFromIp(addr.ip) ?? undefined;

      if (this.teamNumber) {
        this.phase = 'ready';
        console.log(`RobotTestMonitor: DHCP lease obtained — team ${this.teamNumber}, IP ${addr.ip}`);
      } else {
        this.phase = 'ready';
        console.log(`RobotTestMonitor: DHCP lease obtained — IP ${addr.ip} (not a team subnet)`);
      }

      this.broadcast();
      this.runChecks();
    } catch (err) {
      console.error('RobotTestMonitor: error reading interface address:', err);
    }
  }

  private killDhcp(): void {
    if (this.dhcpProc) {
      this.dhcpProc.kill();
      this.dhcpProc = null;
    }
    // Also release the lease and kill any orphaned dhcpcd for this interface
    execFile('dhcpcd', ['--release', this.interfaceName]).catch(() => {});
    // Drop any per-link DNS state a lease may have registered with
    // systemd-resolved. Leases acquired before the --nohook resolv.conf flag
    // was added persist across restarts and degrade host-wide name resolution
    // (a dead robot-radio DNS server stalls every lookup on the host).
    execFile('resolvectl', ['revert', this.interfaceName]).catch(() => {});
  }

  /** Continuously probe the factory default IP. Updates only the factory-related check result. */
  private async probeFactoryDefault(): Promise<void> {
    let factoryCheck: CheckResult | null = null;
    try {
      const res = await fetch(`http://192.168.69.1/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        this.factoryRadioIp = '192.168.69.1';
        const data = (await res.json()) as { teamNumber?: number; version?: string };
        if (!this.teamNumber) {
          // No DHCP yet — radio is there but we can't reach it via team IP
          factoryCheck = {
            name: 'Radio Detected',
            status: data.teamNumber ? 'warn' : 'fail',
            actual: `At 192.168.69.1${data.version ? ` (${data.version})` : ''}${data.teamNumber ? `, team ${data.teamNumber}` : ''}`,
            message: data.teamNumber
              ? `Radio configured for team ${data.teamNumber} but not providing DHCP — check network path`
              : 'Radio has no team number — needs to be configured',
          };
          // Radio detected — trigger an immediate DHCP attempt if we're waiting
          if (this.phase === 'dhcp_requesting' && !this.dhcpProc) {
            this.startDhcp();
          }
        }
        // When we DO have a team number, the full checkFactoryDefault() in runChecks handles it
      }
    } catch {
      // Not reachable — no factory-IP radio
      this.factoryRadioIp = null;
    }

    // Merge: remove old factory check, add new one if present
    const filtered = this.checks.filter(c => c.name !== 'Radio Detected' && c.name !== 'Radio Not Configured');
    const updated = factoryCheck ? [factoryCheck, ...filtered] : filtered;
    if (updated.length !== this.checks.length || factoryCheck) {
      this.checks = updated;
      this.broadcast();
    }
  }

  // ── Robot checks ──────────────────────────────────────────────────

  private async runChecks(): Promise<void> {
    if (!this.teamNumber || this.checking) return;

    this.checking = true;
    this.phase = 'checking';
    this.broadcast();

    try {
      // The controller (roboRIO or SystemCore) is identified first so the
      // radio's SystemCore mode can be judged against what is actually there.
      const [factoryResult, controllerResult] = await Promise.all([
        checkFactoryDefault(this.teamNumber),
        checkRobotController(this.teamNumber, [], this.leasedIp),
      ]);
      const radioResults = await checkRadio(this.teamNumber, this.leasedIp, controllerResult.controller);
      const rioResults = controllerResult.checks;
      this.checks = [...factoryResult, ...radioResults, ...rioResults];

      // Clear the settling state once the radio is reachable (at least one non-error check).
      const radioReachable = radioResults.some(c => c.status !== 'error');
      if (radioReachable && this.reconfiguredAt) {
        this.reconfiguredAt = undefined;
        this.reconfigureTimeoutMs = undefined;
        this.reconfigureType = undefined;
      }

      // On a VLAN, if both radio and roboRIO are unreachable, the robot is likely
      // disconnected. Release the DHCP lease and go back to requesting state so we
      // pick up the next robot that connects.
      // Suppress this reset while the network is still settling after a reconfiguration,
      // so the test page doesn't cycle between DHCP ↔ checks every few seconds.
      const allDevicesDown =
        radioResults.every(c => c.status === 'error') && rioResults.every(c => c.status === 'error');
      const settling =
        this.reconfiguredAt != null &&
        this.reconfigureTimeoutMs != null &&
        Date.now() - this.reconfiguredAt < this.reconfigureTimeoutMs;
      if (this.skipLinkDetection && allDevicesDown && factoryResult.length === 0 && !settling) {
        console.log('RobotTestMonitor: all devices unreachable on VLAN — resetting to DHCP');
        const oldIp = this.leasedIp;
        const oldPrefix = this.leasedPrefix;
        this.teamNumber = undefined;
        this.leasedIp = undefined;
        this.leasedPrefix = 24;
        this.routerIp = undefined;
        this.checks = [];
        this.killDhcp();
        if (!this.dryRun && oldIp) {
          // Remove only the DHCP address, keep the factory probe IP
          this.net
            .removeAddress({ interfaceName: this.interfaceName, address: oldIp, prefixLength: oldPrefix })
            .catch(() => {});
        }
        this.phase = 'link_up';
        this.broadcast();
        this.startDhcp();
        return; // Skip the re-check scheduling below
      }

      this.phase = 'complete';

      // Trigger background firmware download if the radio needs an update
      if (this.firmwareStore) {
        const fwCheck = radioResults.find(c => c.name === 'Radio Firmware');
        if (fwCheck?.status === 'fail') {
          this.firmwareStore.startBackgroundDownloads();
        }
      }
    } catch (err) {
      console.error('RobotTestMonitor: check error:', err);
    } finally {
      this.checking = false;
      this.broadcast();

      // Schedule re-check (only if someone is watching)
      this.stopChecking();
      this.checkTimer = setTimeout(() => {
        if (this.linkUp && this.teamNumber && (!this.hasClients || this.hasClients())) this.runChecks();
      }, CHECK_INTERVAL_MS);
    }
  }

  private stopChecking(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ── Firmware update ──────────────────────────────────────────────

  /** Check if the radio's current firmware needs an update. */
  radioNeedsFirmwareUpdate(): boolean {
    const fwCheck = this.checks.find(c => c.name === 'Radio Firmware');
    return fwCheck?.status === 'fail';
  }

  /** Run the full firmware update flow. Throws on failure. */
  async startFirmwareUpdate(
    wpaKey: string | undefined,
    wpaKey24: string | undefined,
    skipReconfigure = false,
  ): Promise<void> {
    if (this.firmwareUpdating) throw new Error('Firmware update already in progress');
    if (!this.teamNumber) throw new Error('No team number detected — plug in a robot first');
    if (!this.linkUp) throw new Error('Link is down — plug in a cable first');
    if (!skipReconfigure && !wpaKey)
      throw new Error('WPA passphrase required for reconfiguration (or check "Skip reconfiguration")');
    if (!this.firmwareStore) throw new Error('Firmware store not configured');

    this.firmwareUpdating = true;
    this.stopChecking();

    const startTime = Date.now();
    const sendProgress = (p: Omit<FirmwareUpdateProgress, 'type' | 'elapsedMs'>) => {
      this.onFirmwareProgress?.({ type: 'firmwareUpdateProgress', elapsedMs: Date.now() - startTime, ...p });
    };

    try {
      await updateRadioFirmware(this.teamNumber, wpaKey, wpaKey24, skipReconfigure, this.firmwareStore, sendProgress);
      // Mark the settling period — firmware updates take longer to stabilize
      this.reconfiguredAt = Date.now();
      this.reconfigureTimeoutMs = 180_000;
      this.reconfigureType = 'firmware';
      // Re-run checks after successful update
      this.runChecks();
    } catch (err) {
      sendProgress({
        step: 'error',
        message: err instanceof Error ? err.message : String(err),
        progress: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.firmwareUpdating = false;
    }
  }

  // ── Radio configuration (TEAM_ROBOT_RADIO mode) ─────────────────

  /** Configure a radio in TEAM_ROBOT_RADIO mode directly from the test interface. */
  async configureTeamRadio(teamNumber: number, wpaKey6: string, wpaKey24?: string, ssidSuffix?: string): Promise<void> {
    if (this.radioConfiguring) throw new Error('Radio configuration already in progress');
    if (this.firmwareUpdating) throw new Error('Firmware update in progress — wait for it to finish');
    if (!this.linkUp && !this.skipLinkDetection) throw new Error('Link is down — plug in a cable first');
    if (teamNumber < 1 || teamNumber > 25599 || !Number.isInteger(teamNumber))
      throw new Error('Invalid team number (must be 1-25599)');
    if (wpaKey6.length < 8) throw new Error('WPA passphrase must be at least 8 characters');
    if (wpaKey24 && wpaKey24.length < 8) throw new Error('2.4 GHz WPA passphrase must be at least 8 characters');

    this.radioConfiguring = true;
    this.stopChecking();
    this.stopFactoryProbe();

    const startTime = Date.now();
    const sendProgress = (p: Omit<RadioConfigureProgress, 'type' | 'elapsedMs'>) => {
      this.onRadioConfigureProgress?.({ type: 'radioConfigureProgress', elapsedMs: Date.now() - startTime, ...p });
    };

    try {
      // Determine which IP to reach the radio at
      const radioIp = this.factoryRadioIp ?? (this.teamNumber ? `${teamSubnetStr(this.teamNumber)}.1` : null);
      if (!radioIp) {
        throw new Error('No radio detected — connect a radio to the test interface first');
      }

      sendProgress({ step: 'sending', message: `Sending configuration to radio at ${radioIp}...`, progress: 10 });

      const configBody = {
        mode: 'TEAM_ROBOT_RADIO',
        teamNumber,
        ssidSuffix: ssidSuffix ?? '',
        wpaKey6,
        wpaKey24: wpaKey24 || wpaKey6,
        channel: 0,
      };

      let configRes: Response;
      try {
        configRes = await fetch(`http://${radioIp}/configuration`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configBody),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new Error(`Failed to reach radio at ${radioIp}: ${err instanceof Error ? err.message : err}`);
      }

      if (!configRes.ok) {
        const body = await configRes.text();
        throw new Error(`Radio rejected configuration (HTTP ${configRes.status}): ${body}`);
      }

      // Wait for the radio to reboot. Poll 192.168.69.1 — the radio keeps both the
      // factory IP and the team IP alive, and we already have a route via 192.168.69.8/24.
      sendProgress({ step: 'waiting_reboot', message: 'Waiting for radio to reboot...', progress: 30 });

      const deadline = Date.now() + 120_000; // 2 minute timeout

      // Give the radio a moment to start rebooting before polling
      await new Promise(r => setTimeout(r, 5_000));

      let radioVersion: string | undefined;
      let rebooted = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch('http://192.168.69.1/status', { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const data = (await res.json()) as { teamNumber?: number; version?: string };
            // Wait until the radio reports the new team number (not just that it's back up)
            if (data.teamNumber === teamNumber) {
              radioVersion = data.version;
              rebooted = true;
              break;
            }
          }
        } catch {
          // Not ready yet
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!rebooted) {
        throw new Error(`Radio did not come back with team ${teamNumber} within 2 minutes`);
      }

      sendProgress({
        step: 'complete',
        message: `Radio configured for team ${teamNumber}${radioVersion ? ` (firmware ${radioVersion})` : ''}`,
        progress: 100,
      });

      // Mark the settling period — suppresses the VLAN "all devices down" reset
      // and lets the UI show "network is settling" feedback while DHCP re-acquires.
      this.reconfiguredAt = Date.now();
      this.reconfigureTimeoutMs = 90_000;
      this.reconfigureType = 'radio';

      // Reset DHCP state so we pick up the newly configured radio
      this.killDhcp();
      this.teamNumber = undefined;
      this.leasedIp = undefined;
      this.leasedPrefix = 24;
      this.routerIp = undefined;
      this.checks = [];
      this.factoryRadioIp = null;
      this.phase = this.skipLinkDetection ? 'link_up' : this.linkUp ? 'link_up' : 'link_down';
      this.broadcast();
      this.startFactoryProbe();
      if (this.linkUp || this.skipLinkDetection) {
        this.startDhcp();
      }
    } catch (err) {
      sendProgress({
        step: 'error',
        message: err instanceof Error ? err.message : String(err),
        progress: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      // Restart probes and checks so the tester recovers
      this.startFactoryProbe();
      if (this.teamNumber) this.runChecks();
      throw err;
    } finally {
      this.radioConfiguring = false;
    }
  }

  // ── Broadcast ─────────────────────────────────────────────────────

  private broadcast(): void {
    this.onStateChange(this.getState());
  }
}

/** Format a team number as a subnet prefix: 10.TE.AM */
function teamSubnetStr(team: number): string {
  return `10.${Math.floor(team / 100)}.${team % 100}`;
}
