import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { StationName, StationNameList } from './types.js';
import { appError, appInfo, appWarn } from './appLogger.js';
import { skippedInDryRun } from './dryRun.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import type { NetworkBackend } from './node-ip/index.js';

let backend: NetworkBackend | undefined;

/** The network backend, built on first use rather than when this module
 *  loads: createBackend() throws off Linux, and importing the module (the
 *  route preference manager, tests, a non-Linux dev box) shouldn't need a
 *  network stack until something actually configures one. Shared with
 *  routePreferenceManager. */
export function networkBackend(): NetworkBackend {
  return (backend ??= process.env.DRY_RUN ? createDryRunBackend() : createBackend());
}

/** Run against this backend instead (tests: a fake that records calls). */
export function useNetworkBackend(b: NetworkBackend): void {
  backend = b;
}

const net = networkBackend;
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

/** Stations whose last pass failed part-way. They are torn down and set up
 *  again on the next pass even if their team hasn't changed — their kernel
 *  state is unknown. */
const failedStations = new Set<StationName>();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bring every station's bridge in line with `stations`. Each station is
 * handled on its own: one that fails is reported, recorded for a retry on
 * the next pass, and doesn't stop the others. Throws at the end if any
 * station failed, so the caller's commit still shows as failed.
 */
async function updateNetworkConfig(stations: Stations, physical_interface: string, practiceMode: boolean) {
  const failures: string[] = [];
  for (const station of StationNameList) {
    const team = stations[station];
    const prevTeam = previousStations[station];
    try {
      await updateStation(station, team, prevTeam, physical_interface, practiceMode);
      previousStations[station] = team;
      failedStations.delete(station);
    } catch (err) {
      // Whatever got part-applied belongs to the team just attempted (or,
      // when clearing the station, the one being removed) — the next
      // pass's teardown starts from that.
      previousStations[station] = team ?? prevTeam;
      failedStations.add(station);
      const who = team ? `team ${team}` : prevTeam ? `clearing team ${prevTeam}` : 'no team';
      appError(`Network setup for ${station} (${who}) failed: ${errorText(err)}`);
      failures.push(`${station}: ${errorText(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Network configuration failed for ${failures.length} station(s) — ${failures.join('; ')}`);
  }
  appInfo('Network configuration applied');
}

async function updateStation(
  station: StationName,
  team: number | undefined,
  prevTeam: number | undefined,
  physical_interface: string,
  practiceMode: boolean,
): Promise<void> {
  const vlanId = vlanMap[station];
  const vlanIfName = `${physical_interface}.${station}`; // For VLAN creation + bridge membership only
  const brName = bridgeName(station); // For everything else (IP, iptables, routes, DHCP)

  // Ensure the VLAN sub-interface and bridge exist with correct membership
  await net().createVlan({ parent: physical_interface, vlanId, name: vlanIfName });
  await net().createBridge(brName);
  await net().addBridgeMember(brName, vlanIfName);
  await net().setInterfaceUp(vlanIfName);

  // Skip stations that haven't changed — unless the bridge is missing its IP
  // (migration case: first restart after switching from bare VLAN to bridge architecture,
  // enslaving the VLAN sub-interface to the bridge removes its IP).
  if (team === prevTeam && !failedStations.has(station)) {
    if (team) {
      const expectedIp = teamIp(team, vlanHostOctet);
      const brInterfaces = await net().listInterfaces(brName);
      const hasIp = brInterfaces[0]?.addresses.some(a => a.family === 'inet' && a.address === expectedIp);
      if (hasIp) {
        await migrateBridgeNat(station);
        return;
      }
      appInfo(`Bridge ${brName} missing IP ${expectedIp}, re-applying config for ${station}`);
    } else {
      return;
    }
  }

  // Tear down the old config for this station. Best effort, step by step:
  // anything left behind is either harmless or cleared by the stale-address
  // sweep below, and a teardown error used to abort the whole pass — and,
  // since previousStations was never updated, every pass after it.
  if (prevTeam) {
    const undo = async (what: string, step: () => Promise<void>) => {
      try {
        await step();
      } catch (err) {
        appWarn(`Teardown of team ${prevTeam} on ${station}: could not ${what}: ${errorText(err)}`);
      }
    };
    // Remove the specific old team IP rather than flushing all addresses — avoids
    // disturbing IPv6 link-local and other addresses managed outside this code.
    await undo('remove its address', () =>
      net().removeAddress({ interfaceName: brName, address: teamIp(prevTeam, vlanHostOctet), prefixLength: 24 }),
    );
    await undo('remove the outbound forward rule', () =>
      net().iptables({
        chain: 'FORWARD',
        inInterface: brName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-${station}`,
        action: '-D',
      }),
    );
    await undo('remove the inbound forward rule', () =>
      net().iptables({
        chain: 'FORWARD',
        outInterface: brName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-in-${station}`,
        action: '-D',
      }),
    );
    await undo('remove the MASQUERADE', () => net().iptables(bridgeMasquerade(station, '-D')));
    await undo('remove the legacy MASQUERADE', () => net().iptables(bridgeMasquerade(station, '-D', { legacy: true })));
    // Remove the per-station routing table entry used for laptop route preferences
    await undo('remove its route-preference route', () =>
      net().removeRoute({ destination: teamIp(prevTeam, '0/24'), device: brName, table: vlanId }),
    );
  }

  if (team) {
    await net().setInterfaceUp(brName);

    const us = teamIp(team, vlanHostOctet);

    // Remove any stale IPv4 addresses that don't belong to this team.
    // This covers the process-restart case where previousStations is empty
    // and the teardown above was skipped, leaving addresses from a prior session.
    const interfaces = await net().listInterfaces(brName);
    for (const addr of interfaces[0]?.addresses ?? []) {
      if (addr.family === 'inet' && addr.address !== us) {
        appWarn(`Removing stale address ${addr.address}/${addr.prefixLength} from ${brName}`);
        await net().removeAddress({ interfaceName: brName, address: addr.address, prefixLength: addr.prefixLength });
      }
    }

    if (!practiceMode) {
      const conflict = await net().arping({ interfaceName: brName, address: us });
      if (conflict) {
        throw new Error(`address conflict: ${us} is already in use on ${brName}`);
      }
    }

    await net().addAddress({ interfaceName: brName, address: us, prefixLength: 24 });

    // Add forwarding rules
    await net().iptables({
      chain: 'FORWARD',
      inInterface: brName,
      jump: 'ACCEPT',
      comment: `${commentPrefix}fwd-${station}`,
      action: '-A',
    });
    await net().iptables({
      chain: 'FORWARD',
      outInterface: brName,
      jump: 'ACCEPT',
      comment: `${commentPrefix}fwd-in-${station}`,
      action: '-A',
    });
    // MASQUERADE traffic entering the VLAN so return traffic comes back to the same host
    await net().iptables(bridgeMasquerade(station, '-A'));
    // Add a per-station routing table entry so laptops can select which robot to talk to
    // when multiple stations share the same team subnet (same team, different robot suffix)
    await net().addRoute({ destination: teamIp(team, '0/24'), device: brName, table: vlanId });
  } else {
    await net().setInterfaceDown(brName);
  }
}

/**
 * The MASQUERADE on a station's bridge: traffic forwarded into the robot's
 * VLAN (from laptops) leaves with steamboat's address, so the robot's
 * replies come back through steamboat. Forwarded traffic only: steamboat's
 * own packets already carry its address. Matching them too broke two
 * things on 2026-10-12, when one team had robots on two bridges that share
 * an address: a second address on a bridge was rewritten to the gateway
 * one, and the kernel dropped (EPERM) an mDNS query sent out one bridge
 * because conntrack had the same flow masqueraded out the other
 * (nf_nat_oif_changed). `legacy`: the old form without that match, to
 * remove it.
 */
function bridgeMasquerade(station: StationName, action: '-A' | '-D', { legacy = false } = {}) {
  return {
    table: 'nat',
    chain: 'POSTROUTING',
    outInterface: bridgeName(station),
    ...(legacy ? {} : { notLocalSource: true }),
    jump: 'MASQUERADE',
    comment: `${commentPrefix}nat-vlan-${station}`,
    action,
  } as const;
}

/**
 * Bring a configured bridge's NAT up to date without reconfiguring it: add
 * the forwarded-only MASQUERADE before removing the old form (so forwarded
 * traffic is never left un-masqueraded), and remove what the reverted
 * per-station mDNS address attempt left (its /32 and RETURN rule).
 */
async function migrateBridgeNat(station: StationName): Promise<void> {
  await net().iptables(bridgeMasquerade(station, '-A'));
  await net().iptables(bridgeMasquerade(station, '-D', { legacy: true }));
  const brName = bridgeName(station);
  const slot = Number(station.replace(/^slot/, ''));
  for (const addr of (await net().listInterfaces(brName))[0]?.addresses ?? []) {
    if (addr.family !== 'inet' || addr.prefixLength !== 32) continue;
    if (Number(addr.address.split('.')[3]) !== vlanHostOctet - slot) continue;
    await net().removeAddress({ interfaceName: brName, address: addr.address, prefixLength: 32 });
    appInfo(`Removed leftover mDNS address ${addr.address}/32 from ${brName}`);
  }
}

/** migrateBridgeNat for every configured station. For a graceful restart,
 *  which keeps the bridges as they were and doesn't run the network config. */
export async function migrateAllBridgeNat(getTeamForStation: (s: StationName) => number | null): Promise<void> {
  for (const station of StationNameList) {
    if (getTeamForStation(station) === null) continue;
    try {
      await migrateBridgeNat(station);
    } catch (err) {
      appWarn(`Could not update the NAT rules of ${station}: ${(err as Error).message}`);
    }
  }
  await net().flushRulesByComment(`${commentPrefix}nat-mdns-`);
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
      const ifaces = await net().listInterfaces(oldIfName);
      if (ifaces.length > 0) {
        appWarn(`Removing legacy VLAN interface ${oldIfName}`);
        await net().setInterfaceDown(oldIfName);
        await net().deleteInterface(oldIfName);
      }
    } catch {
      // Interface doesn't exist — nothing to do
    }
  }
}

/**
 * Remove every iptables rule pFMS added (they all carry the comment prefix)
 * and empty the per-station route tables, which aren't comment-tagged. What
 * a full start does first, a trunk teardown, and a clean shutdown.
 */
export async function flushManagedNetworkState(): Promise<void> {
  await net().flushRulesByComment(commentPrefix);
  for (const vlanId of Object.values(vlanMap)) {
    if (skippedInDryRun(`flush route table ${vlanId}`)) continue;
    try {
      await execFileAsync('ip', ['route', 'flush', 'table', String(vlanId)]);
    } catch {
      // Table may not exist yet — that's fine.
    }
  }
}

/**
 * Delete the station VLAN sub-interfaces on a trunk (`<nic>.slot1`…) and the
 * station bridges, and forget what was configured on them, so the next
 * commit builds every station from scratch. For moving pFMS off a trunk.
 */
export async function removeStationInterfaces(physicalInterface: string): Promise<void> {
  for (const station of StationNameList) {
    for (const name of [`${physicalInterface}.${station}`, bridgeName(station)]) {
      try {
        if ((await net().listInterfaces(name)).length === 0) continue;
        await net().setInterfaceDown(name);
        await net().deleteInterface(name);
      } catch (err) {
        appWarn(`Could not remove ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  restorePreviousStations(() => null);
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

  await net().iptables({
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
export async function dropHairpinForwarding(physicalInterface: string): Promise<void> {
  await net().iptables({
    chain: 'FORWARD',
    inInterface: physicalInterface,
    outInterface: physicalInterface,
    jump: 'DROP',
    comment: `${commentPrefix}no-hairpin`,
    action: '-I',
  });
}

/** UDP port a Driver Station sends its control packets to on the robot (the
 *  legacy NI DS and the 2027 DS alike). */
const DS_TO_ROBOT_CONTROL_PORT = 1110;

/**
 * Holds a second laptop's Driver Station off a robot another laptop is driving.
 * Only its control packets are dropped: code deploys, cameras, NetworkTables
 * and anything else that laptop does on the robot's network keep working.
 */
export function duplicateDsBlock(station: StationName, dsIp: string, comment: string) {
  return {
    chain: 'FORWARD',
    source: dsIp,
    outInterface: bridgeName(station),
    protocol: 'udp' as const,
    destinationPort: DS_TO_ROBOT_CONTROL_PORT,
    jump: 'DROP',
    comment,
  };
}

/**
 * A team Stop, network layer: drop every Driver Station → robot control packet
 * going into a station's bridge. A robot disables its outputs about 100 ms
 * after its control packets stop, whatever its Driver Station thinks — so this
 * stops a robot whose DS is not under field control (any robot out of a
 * match). Robot → DS traffic is untouched, so the field still sees the robot's
 * status. Idempotent both ways. The rule keeps its `estop-` name so that
 * startup still removes one left by an older version.
 */
export async function setTeamStopCut(station: StationName, on: boolean): Promise<void> {
  await net().iptables({
    action: on ? '-I' : '-D',
    chain: 'FORWARD',
    outInterface: bridgeName(station),
    protocol: 'udp',
    destinationPort: DS_TO_ROBOT_CONTROL_PORT,
    jump: 'DROP',
    comment: `${commentPrefix}estop-${station}`,
  });
}

/** Remove every team Stop cut — at startup, where no station is stopped yet
 *  (a graceful restart keeps rules, but not the stop state behind them). */
export async function clearTeamStopCuts(): Promise<void> {
  await net().flushRulesByComment(`${commentPrefix}estop-`);
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
