/**
 * The trunk interface: the NIC carrying the team station VLANs (tagged) and,
 * unless a separate field-control interface is set, field control (native). Bringing one up is what pFMS does at startup; tearing
 * one down is what it does when the setup wizard moves it to another NIC (or
 * to none), so a change takes effect without a restart.
 *
 * Only the NIC-specific state lives here. Everything on the station bridges
 * (addresses, forwarding, NAT, DNAT, DHCP) is rebuilt by the radio manager's
 * next commit; index.ts orchestrates the services that use the trunk.
 */
import { isDryRun } from './dryRun.js';
import { FIELD_CONTROL_ADDRESS } from './types.js';
import { checkInterfaceIps } from './startupChecks.js';
import { REQUIRED_TOOLS, aptInstallCommand, missingTools } from './hostTools.js';
import {
  cleanupOldVlanInterfaces,
  clearTeamStopCuts,
  dropHairpinForwarding,
  flushManagedNetworkState,
  networkBackend,
  removeStationInterfaces,
  stopAllDHCP,
  vlanMap,
} from './networkManager.js';
import type { NetworkBackend } from './node-ip/index.js';

export type TrunkResult = { ok: true } | { ok: false; reason: string };

export interface TrunkOptions {
  /** A graceful restart, whose rules are still in the kernel and are
   *  adopted rather than flushed. */
  keepNetwork: boolean;
  /** Where field control lives, when it isn't the trunk's native VLAN: a
   *  separate NIC, or a tagged sub-interface (`eno1.100`). Unset: the trunk. */
  fieldControl?: string;
}

/**
 * Get the field-control interface ready to take pFMS's address. One that
 * exists is used as it is (the operator's netplan VLAN, a second NIC). One
 * that doesn't but is named `<parent>.<vlan id>` is created as an 802.1Q
 * sub-interface — unless that would land on a station VLAN of the trunk.
 */
async function prepareFieldControl(
  iface: string,
  trunk: string,
  net: NetworkBackend,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if ((await net.listInterfaces(iface)).length > 0) return { ok: true };

  const vlan = /^(.+)\.(\d{1,4})$/.exec(iface);
  const parent = vlan?.[1];
  const vlanId = Number(vlan?.[2]);
  if (!parent || !(vlanId >= 1 && vlanId <= 4094)) {
    return { ok: false, reason: `field-control interface ${iface} does not exist on this host` };
  }
  if (parent === trunk && Object.values(vlanMap).includes(vlanId)) {
    return {
      ok: false,
      reason: `field-control interface ${iface} would use VLAN ${vlanId}, which is a team station VLAN on ${trunk}`,
    };
  }
  if ((await net.listInterfaces(parent)).length === 0) {
    return { ok: false, reason: `field-control interface ${iface}: ${parent} does not exist on this host` };
  }
  await net.createVlan({ parent, vlanId, name: iface });
  return { ok: true };
}

/**
 * Make `iface` the trunk. Refuses — leaving pFMS running without a field
 * network, so the setup wizard can say why — when a tool is missing, the
 * NIC doesn't exist, or the field-control interface can't be had.
 */
export async function bringUpTrunk(iface: string, { keepNetwork, fieldControl }: TrunkOptions): Promise<TrunkResult> {
  const net = networkBackend();
  // A dry run has no real NIC or tools to check.
  if (!isDryRun()) {
    const missing = await missingTools(REQUIRED_TOOLS);
    if (missing.length > 0) {
      return { ok: false, reason: `missing required tools: ${missing.join(', ')} (${aptInstallCommand(missing)})` };
    }
    if ((await net.listInterfaces(iface)).length === 0) {
      return { ok: false, reason: `${iface} does not exist on this host` };
    }
  }

  const fieldControlIface = fieldControl ?? iface;
  if (fieldControlIface !== iface) {
    const prepared = await prepareFieldControl(fieldControlIface, iface, net);
    if (!prepared.ok) return prepared;
  }

  // Nothing reaches the radio over a link that is administratively down.
  await net.setInterfaceUp(iface);
  if (fieldControlIface !== iface) await net.setInterfaceUp(fieldControlIface);
  await checkInterfaceIps(fieldControlIface, [FIELD_CONTROL_ADDRESS], net);

  // Always remove legacy VLAN interfaces from the previous version that used
  // radio-native station names (eno1.red1, eno1.blue3). These hold VLAN IDs
  // that conflict with the current eno1.slot1-slot6 names, so they must be
  // cleaned up even during graceful restarts.
  await cleanupOldVlanInterfaces(iface);

  if (keepNetwork) {
    // Preserve existing rules — this is a graceful restart. Preferences are
    // restored from the kernel by index.ts, after the WebSocket server is up.
    console.log('KEEP_NETWORK=true: skipping iptables flush');
  } else {
    // Clean up stale rules and routes from a previous run (e.g. after a crash).
    await flushManagedNetworkState();
  }

  // Required for inter-VLAN routing.
  await net.setSysctl({ key: 'net.ipv4.ip_forward', value: '1' });

  // …but never straight back out the uplink (the gateway ping-pong for team
  // subnets that have no station here). Done here as well as on every radio
  // commit, so a graceful restart with KEEP_NETWORK — which skips the flush
  // and does not touch the radio — still gets the rule (2026-09-27: the
  // first deploy of it installed nothing until the next radio change).
  await dropHairpinForwarding(iface);

  // No station starts stopped, so no team Stop cut may survive a graceful
  // restart (KEEP_NETWORK keeps rules but not the engine state behind them).
  await clearTeamStopCuts();

  // Size the kernel neighbor (ARP/NDP) table for what this host does: the
  // subnet scanner sweeps every configured team /24 every 10 s, and each
  // sweep parks ~250 INCOMPLETE/FAILED entries per slot for ~60 s. Ubuntu's
  // default gc_thresh3 of 1024 overflowed with the 4th team at the
  // 2026-09-13 scrimmage ("neighbour: arp_cache: neighbor table overflow!"),
  // and a full table black-holes packets to any host without an entry —
  // three Driver Stations lost their robots in the same second mid-match.
  // 6 slots × 254 + guest network + headroom comfortably fits in 8192.
  for (const family of ['ipv4', 'ipv6']) {
    for (const [key, value] of [
      ['gc_thresh1', '2048'],
      ['gc_thresh2', '4096'],
      ['gc_thresh3', '8192'],
    ] as const) {
      await net.setSysctl({ key: `net.${family}.neigh.default.${key}`, value }).catch(err => {
        console.warn(`Could not set net.${family}.neigh.default.${key}: ${(err as Error).message}`);
      });
    }
  }
  return { ok: true };
}

/**
 * Take pFMS off `iface`: stop the station DHCP servers, delete the station
 * VLANs and bridges, drop pFMS's field-control address, and flush every rule
 * and route pFMS added. The NIC is left up, and a separate field-control
 * interface is left in place — pFMS can't tell whether the operator made it.
 */
export async function tearDownTrunk(iface: string, { fieldControl }: { fieldControl?: string } = {}): Promise<void> {
  stopAllDHCP();
  await removeStationInterfaces(iface);
  const fieldControlIface = fieldControl ?? iface;
  try {
    await networkBackend().removeAddress({
      interfaceName: fieldControlIface,
      address: FIELD_CONTROL_ADDRESS,
      prefixLength: 24,
    });
  } catch (err) {
    console.warn(`Could not remove ${FIELD_CONTROL_ADDRESS} from ${fieldControlIface}: ${(err as Error).message}`);
  }
  await flushManagedNetworkState();
}
