import type { NetworkBackend } from './backend.js';
import type {
  VlanOptions,
  AddAddressOptions,
  ArpingOptions,
  SysctlOptions,
  IptablesOptions,
  IpRuleOptions,
  RouteOptions,
  IpRuleInfo,
  IptablesRuleInfo,
} from './types.js';

/**
 * Creates a dry-run backend that logs operations instead of executing them.
 * If an inner backend is provided, read operations pass through to it.
 * Without an inner backend, read operations return empty results.
 */
export function createDryRunBackend(inner?: NetworkBackend): NetworkBackend {
  return {
    async createVlan(opts: VlanOptions) {
      console.log(`[dry-run] Would create VLAN ${opts.vlanId} on ${opts.parent} as ${opts.name}`);
    },

    async deleteInterface(name: string) {
      console.log(`[dry-run] Would delete interface ${name}`);
    },

    async setInterfaceUp(name: string) {
      console.log(`[dry-run] Would set ${name} up`);
    },

    async setInterfaceDown(name: string) {
      console.log(`[dry-run] Would set ${name} down`);
    },

    async addAddress(opts: AddAddressOptions) {
      console.log(`[dry-run] Would add ${opts.address}/${opts.prefixLength} to ${opts.interfaceName}`);
    },

    async removeAddress(opts: AddAddressOptions) {
      console.log(`[dry-run] Would remove ${opts.address}/${opts.prefixLength} from ${opts.interfaceName}`);
    },

    async flushAddresses(interfaceName: string) {
      console.log(`[dry-run] Would flush addresses on ${interfaceName}`);
    },

    async listInterfaces(name?: string) {
      if (inner) return inner.listInterfaces(name);
      return [];
    },

    async interfaceExists(name: string) {
      if (inner) return inner.interfaceExists(name);
      return false;
    },

    async arping(opts: ArpingOptions) {
      console.log(`[dry-run] Would arping ${opts.address} on ${opts.interfaceName}`);
      return false;
    },

    async setSysctl(opts: SysctlOptions) {
      console.log(`[dry-run] Would set sysctl ${opts.key}=${opts.value}`);
    },

    async getSysctl(key: string) {
      if (inner) return inner.getSysctl(key);
      return '';
    },

    async iptables(opts: IptablesOptions) {
      console.log(
        `[dry-run] Would run iptables ${opts.action} ${opts.chain} in ${opts.table ?? 'filter'} table` +
          (opts.source ? ` -s ${opts.source}` : '') +
          (opts.destination ? ` -d ${opts.destination}` : '') +
          (opts.notDestination ? ` ! -d ${opts.notDestination}` : '') +
          (opts.inInterface ? ` -i ${opts.inInterface}` : '') +
          (opts.outInterface ? ` -o ${opts.outInterface}` : '') +
          (opts.notLocalSource ? ' -m addrtype ! --src-type LOCAL' : '') +
          (opts.protocol ? ` -p ${opts.protocol}` : '') +
          (opts.destinationPort != null ? ` --dport ${opts.destinationPort}` : '') +
          ` -j ${opts.jump}` +
          (opts.toDestination ? ` --to-destination ${opts.toDestination}` : '') +
          (opts.comment ? ` (${opts.comment})` : ''),
      );
    },

    async getForwardCounters() {
      return [];
    },

    async flushRulesByComment(commentPrefix: string) {
      if (!commentPrefix) throw new Error('Refusing to flush iptables rules with empty comment prefix');
      console.log(`[dry-run] Would flush all iptables rules with comment prefix "${commentPrefix}"`);
    },

    async listRulesByComment(commentPrefix: string) {
      if (inner) return inner.listRulesByComment(commentPrefix);
      return [];
    },

    async deleteRule(rule: IptablesRuleInfo) {
      console.log(`[dry-run] Would delete iptables rule ${rule.spec.join(' ')} in ${rule.table} table`);
    },

    async listIpRules(): Promise<IpRuleInfo[]> {
      if (inner) return inner.listIpRules();
      return [];
    },

    async addIpRule(opts: IpRuleOptions) {
      console.log(
        `[dry-run] Would add ip rule: from ${opts.from}${opts.to ? ` to ${opts.to}` : ''}` +
          `${opts.priority !== undefined ? ` priority ${opts.priority}` : ''} table ${opts.table}`,
      );
    },

    async removeIpRule(opts: IpRuleOptions) {
      console.log(
        `[dry-run] Would remove ip rule: from ${opts.from}${opts.to ? ` to ${opts.to}` : ''}` +
          `${opts.priority !== undefined ? ` priority ${opts.priority}` : ''} table ${opts.table}`,
      );
    },

    async addRoute(opts: RouteOptions) {
      console.log(`[dry-run] Would add route: ${opts.destination} dev ${opts.device} table ${opts.table}`);
    },

    async removeRoute(opts: RouteOptions) {
      console.log(`[dry-run] Would remove route: ${opts.destination} dev ${opts.device} table ${opts.table}`);
    },

    async createBridge(name: string) {
      console.log(`[dry-run] Would create bridge ${name}`);
    },

    async addBridgeMember(bridge: string, member: string) {
      console.log(`[dry-run] Would add ${member} to bridge ${bridge}`);
    },

    async removeBridgeMember(_bridge: string, member: string) {
      console.log(`[dry-run] Would remove ${member} from its bridge`);
    },

    async setBridgeHairpin(member: string, enabled: boolean) {
      console.log(`[dry-run] Would set hairpin ${enabled ? 'on' : 'off'} on ${member}`);
    },
  };
}
