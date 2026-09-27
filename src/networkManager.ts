import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { StationName, StationNameList } from './types.js';
import { appInfo, appWarn } from './appLogger.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import type { NetworkBackend } from './node-ip/index.js';

const net: NetworkBackend = process.env.DRY_RUN ? createDryRunBackend() : createBackend();
const commentPrefix = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';
const vlanHostOctet = Number(process.env.VLAN_HOST_OCTET) || 254;
if (vlanHostOctet < 220 || vlanHostOctet > 254) {
  throw new Error(`VLAN_HOST_OCTET must be between 220 and 254 (got ${vlanHostOctet})`);
}

function teamIp(team: number, end: number | string = '') {
  if (team < 1 || team > 25599) {
    throw new Error(`Invalid team number: ${team}`);
  }
  if (typeof end === 'number' && (end < 0 || end > 255)) {
    throw new Error(`Invalid end number: ${end}`);
  }
  if (typeof end === 'string') {
    if (end.includes('.')) throw new Error(`Invalid end string: ${end}`);
  } else if (typeof end !== 'number') {
    throw new Error(`Invalid end type: ${typeof end}`);
  }

  const low = team % 100;
  const high = Math.floor(team / 100);

  return `10.${high}.${low}.${end}`;
}

// ── DHCP Server (dnsmasq, OFFSEASON mode) ──────────────────────────

/** Track running dnsmasq processes per station */
const dhcpServerProcesses = new Map<StationName, ChildProcess>();

/** Stop a running DHCP server for a station */
function stopDHCPServer(station: StationName) {
  const proc = dhcpServerProcesses.get(station);
  if (proc) {
    proc.kill();
    dhcpServerProcesses.delete(station);
    console.log(`DHCP server stopped for ${station}`);
  }
}

export async function startDHCPServer(station: StationName, team: number | undefined, interfaceName: string) {
  // Always stop the previous instance for this station (in-process tracking)
  stopDHCPServer(station);

  const brName = bridgeName(station);

  // Kill any orphaned dnsmasq processes from a previous session that we no longer
  // have a handle to (pkill exits 1 when nothing matched — that is expected and ignored).
  // Check for both old-style (eno1.slot1) and new-style (br-slot1) interface names.
  for (const pattern of [`--interface=${interfaceName}.${station}`, `--interface=${brName}`]) {
    try {
      await execFileAsync('pkill', ['-f', pattern]);
    } catch {
      // No matching process found, or pkill not available — both are fine.
    }
  }

  if (team === undefined) {
    console.log(`No team for ${station}, skipping DHCP server`);
    return;
  }

  const gateway = teamIp(team, vlanHostOctet);
  const rangeStart = teamIp(team, 100);
  const rangeEnd = teamIp(team, 199);

  if (process.env.DRY_RUN) {
    console.log(`[dry-run] DHCP server not started for ${station} (${team})`);
    console.log(`  Interface: ${brName}`);
    console.log(`  Range: ${rangeStart} - ${rangeEnd}`);
    console.log(`  Gateway: ${gateway}`);
    return;
  }

  const proc = spawn(
    'dnsmasq',
    [
      '--no-daemon',
      '--port=0', // disable DNS
      `--interface=${brName}`,
      '--bind-interfaces',
      `--dhcp-range=${rangeStart},${rangeEnd},255.255.255.0,1h`,
      `--dhcp-option=3,${gateway}`, // router
      '--dhcp-option=6', // no DNS servers
      `--dhcp-leasefile=/tmp/dnsmasq-${station}.leases`,
      '--log-dhcp',
      '--log-facility=-', // log to stderr instead of syslog
      '--no-ping',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.stdout!.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      console.log(`[dhcp:${station}] ${line}`);
    }
  });

  proc.stderr!.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      console.log(`[dhcp:${station}] ${line}`);
    }
  });

  proc.on('exit', (code, signal) => {
    dhcpServerProcesses.delete(station);
    if (signal) {
      console.log(`DHCP server for ${station} killed by ${signal}`);
    } else if (code !== 0) {
      console.error(`DHCP server for ${station} exited with code ${code}`);
    }
  });

  dhcpServerProcesses.set(station, proc);
  console.log(`DHCP server started for ${station} (team ${team}) on ${brName}`);
}

// ── Cleanup ────────────────────────────────────────────────────────

/** Stop all running DHCP servers (for cleanup on shutdown) */
export function stopAllDHCP() {
  for (const station of dhcpServerProcesses.keys()) {
    stopDHCPServer(station);
  }
}

// ── Network configuration ──────────────────────────────────────────

// TODO: load this map from the radio config
export const vlanMap: Record<StationName, number> = {
  slot1: 10,
  slot2: 20,
  slot3: 30,
  slot4: 40,
  slot5: 50,
  slot6: 60,
};

/** Bridge interface name for a station. All IP/iptables/routes use the bridge. */
export function bridgeName(station: StationName): string {
  return `br-${station}`; // "br-slot1", "br-slot2", etc.
}

/** Track what's currently configured per station to avoid unnecessary teardown */
let previousStations: Stations = {} as Stations;

/**
 * After a graceful restart, tell networkManager which teams are already configured
 * in the kernel so that future config changes properly tear down old routes/rules.
 */
export function restorePreviousStations(getTeamForStation: (s: StationName) => number | null): void {
  for (const station of StationNameList) {
    const team = getTeamForStation(station);
    previousStations[station] = team ?? undefined;
  }
}

async function updateNetworkConfig(stations: Stations, physical_interface: string, practiceMode: boolean) {
  for (const station of StationNameList) {
    const team = stations[station];
    const prevTeam = previousStations[station];
    const vlanId = vlanMap[station];
    const vlanIfName = `${physical_interface}.${station}`; // For VLAN creation + bridge membership only
    const brName = bridgeName(station); // For everything else (IP, iptables, routes, DHCP)

    // Ensure the VLAN sub-interface and bridge exist with correct membership
    await net.createVlan({ parent: physical_interface, vlanId, name: vlanIfName });
    await net.createBridge(brName);
    await net.addBridgeMember(brName, vlanIfName);
    await net.setInterfaceUp(vlanIfName);

    // Skip stations that haven't changed — unless the bridge is missing its IP
    // (migration case: first restart after switching from bare VLAN to bridge architecture,
    // enslaving the VLAN sub-interface to the bridge removes its IP).
    if (team === prevTeam) {
      if (team) {
        const expectedIp = teamIp(team, vlanHostOctet);
        const brInterfaces = await net.listInterfaces(brName);
        const hasIp = brInterfaces[0]?.addresses.some(a => a.family === 'inet' && a.address === expectedIp);
        if (hasIp) continue;
        appInfo(`Bridge ${brName} missing IP ${expectedIp}, re-applying config for ${station}`);
      } else {
        continue;
      }
    }

    // Tear down the old config for this station
    if (prevTeam) {
      // Remove the specific old team IP rather than flushing all addresses — avoids
      // disturbing IPv6 link-local and other addresses managed outside this code.
      await net.removeAddress({ interfaceName: brName, address: teamIp(prevTeam, vlanHostOctet), prefixLength: 24 });
      await net.iptables({
        chain: 'FORWARD',
        inInterface: brName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-${station}`,
        action: '-D',
      });
      await net.iptables({
        chain: 'FORWARD',
        outInterface: brName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-in-${station}`,
        action: '-D',
      });
      await net.iptables({
        table: 'nat',
        chain: 'POSTROUTING',
        outInterface: brName,
        jump: 'MASQUERADE',
        comment: `${commentPrefix}nat-vlan-${station}`,
        action: '-D',
      });
      // Remove the per-station routing table entry used for laptop route preferences
      await net.removeRoute({ destination: teamIp(prevTeam, '0/24'), device: brName, table: vlanId });
    }

    if (team) {
      await net.setInterfaceUp(brName);

      const us = teamIp(team, vlanHostOctet);

      // Remove any stale IPv4 addresses that don't belong to this team.
      // This covers the process-restart case where previousStations is empty
      // and the teardown above was skipped, leaving addresses from a prior session.
      const interfaces = await net.listInterfaces(brName);
      for (const addr of interfaces[0]?.addresses ?? []) {
        if (addr.family === 'inet' && addr.address !== us) {
          appWarn(`Removing stale address ${addr.address}/${addr.prefixLength} from ${brName}`);
          await net.removeAddress({ interfaceName: brName, address: addr.address, prefixLength: addr.prefixLength });
        }
      }

      if (!practiceMode) {
        const conflict = await net.arping({ interfaceName: brName, address: us });
        if (conflict) {
          appWarn(`Address conflict: ${us} is already in use on ${brName}, skipping`);
          continue;
        }
      }

      await net.addAddress({ interfaceName: brName, address: us, prefixLength: 24 });

      // Add forwarding rules
      await net.iptables({
        chain: 'FORWARD',
        inInterface: brName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-${station}`,
        action: '-A',
      });
      await net.iptables({
        chain: 'FORWARD',
        outInterface: brName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-in-${station}`,
        action: '-A',
      });
      // MASQUERADE traffic entering the VLAN so return traffic comes back to the same host
      await net.iptables({
        table: 'nat',
        chain: 'POSTROUTING',
        outInterface: brName,
        jump: 'MASQUERADE',
        comment: `${commentPrefix}nat-vlan-${station}`,
        action: '-A',
      });
      // Add a per-station routing table entry so laptops can select which robot to talk to
      // when multiple stations share the same team subnet (same team, different robot suffix)
      await net.addRoute({ destination: teamIp(team, '0/24'), device: brName, table: vlanId });
    } else {
      await net.setInterfaceDown(brName);
    }
  }

  previousStations = { ...stations };
  appInfo('Network configuration applied');
}

/**
 * Remove any legacy VLAN interfaces from a previous version that used
 * radio-native station names (eno1.red1, eno1.blue3, etc.) as interface names.
 * Also removes legacy bare VLAN interfaces (eno1.slot1) that predate the
 * always-bridge architecture (which uses br-slot1 with eno1.slot1 as a member).
 * Called once at startup to clean up orphans.
 */
export async function cleanupOldVlanInterfaces(physicalInterface: string): Promise<void> {
  const oldNames = ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'];
  for (const oldName of oldNames) {
    const oldIfName = `${physicalInterface}.${oldName}`;
    try {
      const ifaces = await net.listInterfaces(oldIfName);
      if (ifaces.length > 0) {
        appWarn(`Removing legacy VLAN interface ${oldIfName}`);
        await net.setInterfaceDown(oldIfName);
        await net.deleteInterface(oldIfName);
      }
    } catch {
      // Interface doesn't exist — nothing to do
    }
  }
}

/** Enable or disable internet access (NAT + forwarding) for a team subnet. */
export async function setInternetAccess(
  station: StationName,
  team: number,
  physicalInterface: string,
  enabled: boolean,
): Promise<void> {
  // FORWARD rules are handled by updateNetworkConfig (interface-based, always on).
  // Internet toggle only controls MASQUERADE — without it, return traffic from the internet
  // can't find its way back (the robot's 10.TE.AM.x source IP isn't routable externally).
  const subnet = teamIp(team, '0/24');

  const action = enabled ? '-A' : '-D';

  await net.iptables({
    action,
    table: 'nat',
    chain: 'POSTROUTING',
    source: subnet,
    notDestination: '10.0.0.0/8',
    outInterface: physicalInterface,
    jump: 'MASQUERADE',
    comment: `${commentPrefix}nat-${station}`,
  });

  console.log(`Internet access ${enabled ? 'enabled' : 'disabled'} for ${station} (team ${team})`);
}

type Stations = Record<StationName, number | undefined>;

/**
 * Never forward a packet back out the interface it came in on.
 *
 * The site gateway routes all team subnets (10.TE.AM.0/24) to this host. A
 * Driver Station whose team has no station here still sends 50 Hz control
 * packets to 10.TE.AM.2; we have no bridge for that subnet, so the default
 * route sends them straight back to the gateway, which sends them here again
 * — a ping-pong until the TTL runs out (seen 2026-09-27: ~6 000 packets/s per
 * such DS, the same IP id with TTL 19, 18, 17 …). Everything legitimate we
 * forward crosses interfaces (gateway ↔ station bridge), so a same-interface
 * hairpin on the uplink is always this loop. FORWARD policy is ACCEPT, so the
 * rule is needed; DROP rather than REJECT keeps the gateway from seeing
 * ICMP for every packet.
 */
async function dropHairpinForwarding(physicalInterface: string): Promise<void> {
  await net.iptables({
    chain: 'FORWARD',
    inInterface: physicalInterface,
    outInterface: physicalInterface,
    jump: 'DROP',
    comment: `${commentPrefix}no-hairpin`,
    action: '-I',
  });
}

export async function configureNetwork(stations: Stations, interfaceName: string, practiceMode = false) {
  console.log('configureNetwork');
  await dropHairpinForwarding(interfaceName);
  await updateNetworkConfig(stations, interfaceName, practiceMode);

  if (practiceMode) return;

  for (const station of StationNameList) {
    await startDHCPServer(station, stations[station], interfaceName);
  }
}

/**
 * Resolve a source IP to a station by checking the kernel neighbor (ARP) table.
 * Returns the station name if the IP is reachable via a known bridge interface,
 * or undefined if not found. Useful for disambiguating duplicate team numbers.
 */
export async function resolveStationByNeighbor(
  ip: string,
  _physicalInterface: string,
): Promise<StationName | undefined> {
  const ifMap = new Map<string, StationName>();
  for (const station of StationNameList) {
    ifMap.set(bridgeName(station), station);
  }

  try {
    const { stdout } = await execFileAsync('ip', ['neigh', 'show', ip]);
    // Output format: "10.7.66.2 dev br-slot1 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
    for (const line of stdout.split('\n')) {
      const devMatch = line.match(/dev\s+(\S+)/);
      if (devMatch) {
        const station = ifMap.get(devMatch[1]);
        if (station) return station;
      }
    }
  } catch {
    // ip neigh failed — fall through
  }
  return undefined;
}
