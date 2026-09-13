import type { NetworkBackend } from './node-ip/index.js';
import type { PortConfig, PortBridgeState, StationName } from './types.js';
import { bridgeName } from './networkManager.js';
import { appInfo, appWarn } from './appLogger.js';

/**
 * Manages runtime port-to-slot bridge mapping.
 *
 * When a team requests a physical port, its VLAN sub-interface is added
 * as a bridge member of the station's bridge (br-slotN). This extends the
 * station's L2 segment to include the physical Ethernet jack — a laptop
 * plugged into that port is on the same subnet as the radio VLAN.
 *
 * Port interface naming: `${physicalInterface}.p${vlanId}` (e.g., `eno1.p101`).
 * This keeps names under the 15-character Linux limit.
 */
export class PortBridgeManager {
  private readonly net: NetworkBackend;
  private readonly physicalInterface: string;
  private readonly portConfigs: PortConfig[];
  /** portVlanId → station currently bridged to */
  private readonly activeBridges = new Map<number, StationName>();
  /** Ports with a bridge/unbridge in flight — a double-click (or several
   *  station pages sending the same request) must not run the ip commands
   *  twice in parallel. */
  private readonly busy = new Set<number>();
  private onChange: (() => void) | null = null;

  constructor(net: NetworkBackend, physicalInterface: string, portConfigs: PortConfig[]) {
    this.net = net;
    this.physicalInterface = physicalInterface;
    this.portConfigs = portConfigs;
  }

  /** Register a callback to be called whenever the bridge state changes. */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Get the current state for broadcasting to clients. */
  getState(): PortBridgeState {
    const activeBridges: Record<number, StationName> = {};
    for (const [vlanId, station] of this.activeBridges) {
      activeBridges[vlanId] = station;
    }
    return {
      type: 'portBridgeState',
      ports: this.portConfigs,
      activeBridges,
    };
  }

  /** Whether port bridging is enabled (any ports configured). */
  get enabled(): boolean {
    return this.portConfigs.length > 0;
  }

  /** Interface name for a port VLAN. */
  private portIfName(vlanId: number): string {
    return `${this.physicalInterface}.p${vlanId}`;
  }

  /**
   * Bridge a physical port to a station.
   * Creates the port's VLAN sub-interface and adds it to the station's bridge.
   */
  async bridgePort(station: StationName, portVlanId: number): Promise<void> {
    // Validate port config exists
    const port = this.portConfigs.find(p => p.vlanId === portVlanId);
    if (!port) {
      throw new Error(`Unknown port VLAN ID: ${portVlanId}`);
    }

    // If this port is already bridged somewhere, unbind it first
    const existingStation = this.activeBridges.get(portVlanId);
    if (existingStation) {
      if (existingStation === station) return; // Already bridged to this station
      await this.unbridgePort(portVlanId);
    }
    if (this.busy.has(portVlanId)) {
      appInfo(`Port "${port.name}" is already being reconfigured — ignoring duplicate request`);
      return;
    }
    this.busy.add(portVlanId);
    try {
      await this.attach(station, port, portVlanId);
    } finally {
      this.busy.delete(portVlanId);
    }
  }

  private async attach(station: StationName, port: PortConfig, portVlanId: number): Promise<void> {
    const portIf = this.portIfName(portVlanId);
    const brName = bridgeName(station);

    // Create the port VLAN sub-interface and add it to the station's bridge
    appInfo(`Bridging port "${port.name}": creating ${portIf} (VLAN ${portVlanId}) → ${brName}`);
    await this.net.createVlan({ parent: this.physicalInterface, vlanId: portVlanId, name: portIf });
    await this.net.addBridgeMember(brName, portIf);
    await this.net.setInterfaceUp(portIf);
    // Record it now that the kernel side is in place: this is what the UI
    // shows as "connected" and what a later click disconnects. (Until
    // 2026-09-13 this was never set, so the button never changed and every
    // click re-bridged instead of toggling.)
    this.activeBridges.set(portVlanId, station);

    // Enable hairpin mode on both the port interface and the station's radio
    // VLAN interface. Both are sub-interfaces of the same physical NIC, so
    // bridged traffic needs to exit the same port it entered (different VLAN).
    // Without hairpin, the bridge silently drops these frames.
    const stationIf = `${this.physicalInterface}.${station}`;
    try {
      await this.net.setBridgeHairpin(portIf, true);
      await this.net.setBridgeHairpin(stationIf, true);
      appInfo(`Enabled hairpin mode on ${portIf} and ${stationIf}`);
    } catch (err) {
      appWarn(`Failed to enable hairpin mode: ${(err as Error).message}`);
    }

    // Verify the interface was created and is in the right bridge
    try {
      const ifaces = await this.net.listInterfaces(portIf);
      const info = ifaces[0];
      appInfo(
        `Bridged port "${port.name}" (VLAN ${portVlanId}) to ${station} (${brName}) — ` +
          `${portIf} state=${info?.state ?? 'unknown'}, ` +
          `addrs=[${info?.addresses?.map(a => a.address).join(', ') ?? 'none'}]`,
      );
    } catch {
      appInfo(`Bridged port "${port.name}" (VLAN ${portVlanId}) to ${station} (${brName}) — verification skipped`);
    }
    this.onChange?.();
  }

  /** Unbind a specific port from its current bridge. */
  async unbridgePort(portVlanId: number): Promise<void> {
    const station = this.activeBridges.get(portVlanId);
    if (!station) return;
    if (this.busy.has(portVlanId)) return;
    this.busy.add(portVlanId);

    const portIf = this.portIfName(portVlanId);
    const port = this.portConfigs.find(p => p.vlanId === portVlanId);

    try {
      await this.net.removeBridgeMember(bridgeName(station), portIf);
      await this.net.setInterfaceDown(portIf);
      await this.net.deleteInterface(portIf);
    } catch (err) {
      appWarn(`Error unbridging port ${portVlanId} from ${station}: ${(err as Error).message}`);
    } finally {
      this.busy.delete(portVlanId);
    }

    this.activeBridges.delete(portVlanId);
    appInfo(`Unbridged port "${port?.name ?? portVlanId}" from ${station}`);
    this.onChange?.();
  }

  /** Unbind all ports from a specific station. */
  async unbridgeAllFromStation(station: StationName): Promise<void> {
    const toRemove: number[] = [];
    for (const [vlanId, s] of this.activeBridges) {
      if (s === station) toRemove.push(vlanId);
    }
    for (const vlanId of toRemove) {
      await this.unbridgePort(vlanId);
    }
  }

  /** Get which port (if any) is bridged to a station. */
  getPortForStation(station: StationName): PortConfig | null {
    for (const [vlanId, s] of this.activeBridges) {
      if (s === station) {
        return this.portConfigs.find(p => p.vlanId === vlanId) ?? null;
      }
    }
    return null;
  }

  /**
   * Create a port's VLAN sub-interface without bridging it.
   * Used by test port mode to get an isolated interface for diagnostics.
   * Returns the interface name (e.g., `eno1.p101`).
   */
  async createStandalonePort(portVlanId: number): Promise<string> {
    const port = this.portConfigs.find(p => p.vlanId === portVlanId);
    if (!port) throw new Error(`Unknown port VLAN ID: ${portVlanId}`);

    const portIf = this.portIfName(portVlanId);
    appInfo(`Creating standalone port interface ${portIf} (VLAN ${portVlanId}) for test mode`);
    await this.net.createVlan({ parent: this.physicalInterface, vlanId: portVlanId, name: portIf });
    await this.net.setInterfaceUp(portIf);
    return portIf;
  }

  /** Delete a standalone port interface (cleanup after test mode). */
  async deleteStandalonePort(portVlanId: number): Promise<void> {
    const portIf = this.portIfName(portVlanId);
    try {
      await this.net.setInterfaceDown(portIf);
      await this.net.deleteInterface(portIf);
      appInfo(`Deleted standalone port interface ${portIf}`);
    } catch (err) {
      appWarn(`Failed to delete port interface ${portIf}: ${(err as Error).message}`);
    }
  }

  /**
   * Clean up all port VLAN interfaces on startup.
   * Called on non-KEEP_NETWORK restarts to remove stale port interfaces.
   */
  async cleanupPortInterfaces(): Promise<void> {
    for (const port of this.portConfigs) {
      const portIf = this.portIfName(port.vlanId);
      try {
        if (await this.net.interfaceExists(portIf)) {
          appWarn(`Cleaning up stale port interface ${portIf}`);
          await this.net.setInterfaceDown(portIf);
          await this.net.deleteInterface(portIf);
        }
      } catch {
        // Interface doesn't exist or can't be removed — fine
      }
    }
    this.activeBridges.clear();
  }

  /**
   * Restore port bridge state from the kernel after a graceful restart.
   * Inspects each port VLAN interface to see if it's enslaved to a bridge.
   */
  async restoreFromKernel(): Promise<void> {
    for (const port of this.portConfigs) {
      const portIf = this.portIfName(port.vlanId);
      try {
        if (!(await this.net.interfaceExists(portIf))) continue;
        const interfaces = await this.net.listInterfaces(portIf);
        const info = interfaces[0];
        if (!info?.link?.parent) continue;

        // Check if it's enslaved to a br-slot bridge by looking at the link info.
        // The `link` field for a bridge member shows the bridge as the master,
        // but for VLAN interfaces it shows the parent. We need to check the master.
        // Actually, `ip -d addr show` for a VLAN interface enslaved to a bridge
        // shows the VLAN parent (eno1), not the bridge master. We need `ip link show`
        // to see the master. Let's just check if the interface exists and is UP —
        // if it is, assume it's still bridged to whatever station it was on.
        // We can't reliably determine the master from listInterfaces, so skip
        // kernel restoration for now — port bridges will need to be re-established.
      } catch {
        // Interface doesn't exist — skip
      }
    }
    // Port bridges don't survive graceful restarts perfectly — teams will need
    // to re-select their port. This is acceptable for a practice field.
    appInfo(`Port bridge manager initialized with ${this.portConfigs.length} port(s)`);
  }
}

/**
 * Parse the FIELD_PORTS environment variable.
 * Format: "101:Port A,102:Port B,103:Port C"
 * Returns empty array if not set or invalid.
 */
export function parseFieldPorts(envValue: string | undefined): PortConfig[] {
  if (!envValue?.trim()) return [];

  const ports: PortConfig[] = [];
  for (const entry of envValue.split(',')) {
    const [vlanStr, ...nameParts] = entry.trim().split(':');
    const vlanId = Number(vlanStr);
    const name = nameParts.join(':').trim();
    if (isNaN(vlanId) || vlanId < 1 || !name) {
      console.warn(`Invalid FIELD_PORTS entry: "${entry.trim()}" — skipping`);
      continue;
    }
    // Check interface name length: physicalInterface.pVVV
    // Longest realistic: eno1.p9999 = 10 chars (well under 15)
    ports.push({ vlanId, name });
  }
  return ports;
}
