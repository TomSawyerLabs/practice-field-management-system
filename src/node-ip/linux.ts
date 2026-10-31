import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkBackend } from './backend.js';
import type {
  InterfaceInfo,
  InterfaceAddress,
  VlanOptions,
  AddAddressOptions,
  ArpingOptions,
  SysctlOptions,
  IptablesOptions,
  IpRuleOptions,
  RouteOptions,
  ForwardCounter,
  IpRuleInfo,
  IptablesRuleInfo,
} from './types.js';

const execFile = promisify(execFileCb);

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(command, args);
  return stdout;
}

async function ip(...args: string[]): Promise<string> {
  return run('ip', args);
}

async function ipJson<T>(...args: string[]): Promise<T> {
  const out = await ip('-j', ...args);
  return JSON.parse(out || '[]');
}

interface IpAddrEntry {
  ifname: string;
  operstate: string;
  mtu: number;
  address?: string;
  link?: string;
  linkinfo?: {
    info_kind?: string;
    info_data?: { id?: number };
  };
  addr_info: Array<{
    family: string;
    local: string;
    prefixlen: number;
    broadcast?: string;
    scope?: string;
  }>;
}

interface IpRuleEntry {
  priority: number;
  src?: string;
  srclen?: number;
  dst?: string;
  dstlen?: number;
  table?: string;
}

/** `ip -j rule list` keeps a selector's prefix length in a field of its own:
 *  {"dst":"10.1.14.0","dstlen":24}, and no length at all for a single host. */
export function parseIpRule(entry: IpRuleEntry): IpRuleInfo {
  const cidr = (address?: string, length?: number) => (length === undefined ? address : `${address}/${length}`);
  return {
    priority: entry.priority,
    src: cidr(entry.src, entry.srclen),
    dst: cidr(entry.dst, entry.dstlen),
    table: entry.table,
  };
}

/** A line of `iptables -S`, if it's a rule with a comment. Our comments have no
 *  spaces, so iptables prints them unquoted. */
export function parseIptablesRule(table: string, line: string): IptablesRuleInfo | undefined {
  if (!line.startsWith('-A ')) return undefined;
  const spec = line.substring(3).split(/\s+/).filter(Boolean);
  const value = (flag: string) => {
    const at = spec.indexOf(flag);
    return at === -1 ? undefined : spec[at + 1];
  };
  const comment = value('--comment');
  if (!comment) return undefined;
  return { table, comment, source: value('-s'), outInterface: value('-o'), spec };
}

function ipRuleArgs(opts: IpRuleOptions): string[] {
  const args = ['from', opts.from];
  if (opts.to) args.push('to', opts.to);
  if (opts.priority !== undefined) args.push('priority', String(opts.priority));
  args.push('table', String(opts.table));
  return args;
}

function parseInterfaceInfo(entry: IpAddrEntry): InterfaceInfo {
  return {
    name: entry.ifname,
    state: entry.operstate ?? 'UNKNOWN',
    mtu: entry.mtu,
    mac: entry.address,
    addresses: (entry.addr_info ?? []).map(
      (a): InterfaceAddress => ({
        family: a.family as 'inet' | 'inet6',
        address: a.local,
        prefixLength: a.prefixlen,
        broadcast: a.broadcast,
        scope: a.scope,
      }),
    ),
    link:
      entry.linkinfo?.info_kind || entry.link
        ? {
            kind: entry.linkinfo?.info_kind,
            parent: entry.link,
            vlanId: entry.linkinfo?.info_data?.id,
          }
        : undefined,
  };
}

function isExecError(err: unknown): err is Error & { stderr: string } {
  return err instanceof Error && 'stderr' in err;
}

export function createLinuxBackend(): NetworkBackend {
  const backend: NetworkBackend = {
    async createVlan(opts: VlanOptions): Promise<void> {
      if (opts.name.length > 15) {
        throw new Error(`Interface name "${opts.name}" exceeds 15 character Linux limit`);
      }

      if (await backend.interfaceExists(opts.name)) {
        const [info] = await backend.listInterfaces(opts.name);
        if (info?.link?.kind === 'vlan' && info?.link?.parent === opts.parent && info?.link?.vlanId === opts.vlanId) {
          return;
        }
        await backend.deleteInterface(opts.name);
      }

      await ip('link', 'add', 'link', opts.parent, 'name', opts.name, 'type', 'vlan', 'id', String(opts.vlanId));
    },

    async deleteInterface(name: string): Promise<void> {
      if (!(await backend.interfaceExists(name))) return;
      await ip('link', 'delete', name);
    },

    async setInterfaceUp(name: string): Promise<void> {
      await ip('link', 'set', name, 'up');
    },

    async setInterfaceDown(name: string): Promise<void> {
      await ip('link', 'set', name, 'down');
    },

    async addAddress(opts: AddAddressOptions): Promise<void> {
      try {
        const cidr = `${opts.address}/${opts.prefixLength}`;
        const args = ['addr', 'add', cidr, 'dev', opts.interfaceName];
        if (opts.broadcast) args.push('broadcast', opts.broadcast);
        await ip(...args);
      } catch (err: unknown) {
        if (isExecError(err) && (err.stderr.includes('File exists') || err.stderr.includes('Address already assigned')))
          return;
        throw err;
      }
    },

    async removeAddress(opts: AddAddressOptions): Promise<void> {
      try {
        const cidr = `${opts.address}/${opts.prefixLength}`;
        await ip('addr', 'del', cidr, 'dev', opts.interfaceName);
      } catch (err: unknown) {
        if (isExecError(err) && err.stderr.includes('Cannot assign requested address')) return;
        if (isExecError(err) && err.stderr.includes('does not exist')) return;
        // Newer iproute2 reports a missing address as "Error: ipv4: Address not found."
        if (isExecError(err) && err.stderr.includes('Address not found')) return;
        throw err;
      }
    },

    async flushAddresses(interfaceName: string): Promise<void> {
      await ip('addr', 'flush', 'dev', interfaceName);
    },

    async listInterfaces(name?: string): Promise<InterfaceInfo[]> {
      const args = ['-d', 'addr', 'show'];
      if (name) args.push('dev', name);
      const entries = await ipJson<IpAddrEntry[]>(...args);
      return entries.map(parseInterfaceInfo);
    },

    async interfaceExists(name: string): Promise<boolean> {
      try {
        await ip('link', 'show', name);
        return true;
      } catch {
        return false;
      }
    },

    async arping(opts: ArpingOptions): Promise<boolean> {
      const count = String(opts.count ?? 2);
      const timeout = String(opts.timeout ?? 2);
      try {
        // -D = DAD mode, -f = quit on first reply
        await run('arping', ['-D', '-f', '-c', count, '-w', timeout, '-I', opts.interfaceName, opts.address]);
        return false; // exit 0 = no reply = IP is free
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          throw new Error('arping not found. Install iputils-arping: sudo apt install iputils-arping');
        }
        return true; // non-zero exit = reply received = conflict
      }
    },

    async setSysctl(opts: SysctlOptions): Promise<void> {
      await run('sysctl', ['-w', `${opts.key}=${opts.value}`]);
    },

    async getSysctl(key: string): Promise<string> {
      const out = await run('sysctl', ['-n', key]);
      return out.trim();
    },

    async iptables(opts: IptablesOptions): Promise<void> {
      function buildArgs(action: string): string[] {
        const args = ['-t', opts.table ?? 'filter', action, opts.chain];
        if (opts.source) args.push('-s', opts.source);
        if (opts.destination) args.push('-d', opts.destination);
        if (opts.notDestination) args.push('!', '-d', opts.notDestination);
        if (opts.inInterface) args.push('-i', opts.inInterface);
        if (opts.outInterface) args.push('-o', opts.outInterface);
        if (opts.notLocalSource) args.push('-m', 'addrtype', '!', '--src-type', 'LOCAL');
        if (opts.protocol) args.push('-p', opts.protocol);
        if (opts.destinationPort != null) args.push('--dport', String(opts.destinationPort));
        args.push('-j', opts.jump);
        if (opts.toDestination) args.push('--to-destination', opts.toDestination);
        if (opts.comment) args.push('-m', 'comment', '--comment', opts.comment);
        return args;
      }

      if (opts.action === '-A' || opts.action === '-I') {
        // Idempotent: check first, skip if already exists
        try {
          await run('iptables', buildArgs('-C'));
          return; // Rule already exists
        } catch {
          // Rule doesn't exist, proceed to add
        }
      }

      if (opts.action === '-D') {
        // Idempotent: check first, skip if doesn't exist
        try {
          await run('iptables', buildArgs('-C'));
        } catch {
          return; // Rule doesn't exist, nothing to delete
        }
      }

      await run('iptables', buildArgs(opts.action));
    },

    async getForwardCounters(commentPrefix: string): Promise<ForwardCounter[]> {
      let output: string;
      try {
        // -v for counters, -n for numeric, -x for exact byte counts
        output = await run('iptables', ['-t', 'filter', '-L', 'FORWARD', '-v', '-n', '-x']);
      } catch {
        return [];
      }

      // Expected columns: pkts bytes target prot opt in out source destination [match-extensions]
      // Example: 1234  567890 ACCEPT  all  --  eth0.red1  *  0.0.0.0/0  0.0.0.0/0  /* pfms-fwd-red1 */
      const lineRegex = /^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+.*\/\*\s*(\S+)\s*\*\//;

      const results: ForwardCounter[] = [];
      for (const line of output.split('\n')) {
        if (!line.includes(commentPrefix)) continue;

        const match = line.match(lineRegex);
        if (!match) {
          console.warn(`Failed to parse iptables FORWARD line (matched prefix "${commentPrefix}" but regex failed):`);
          console.warn(`  ${line.trim()}`);
          continue;
        }

        const [, packets, bytes, inIf, outIf, comment] = match;
        results.push({
          comment,
          packets: Number(packets),
          bytes: Number(bytes),
          inInterface: inIf === '*' ? undefined : inIf,
          outInterface: outIf === '*' ? undefined : outIf,
        });
      }

      return results;
    },

    async listIpRules(): Promise<IpRuleInfo[]> {
      const entries = await ipJson<IpRuleEntry[]>('rule', 'list');
      return entries.map(parseIpRule);
    },

    async addIpRule(opts: IpRuleOptions): Promise<void> {
      try {
        await ip('rule', 'add', ...ipRuleArgs(opts));
      } catch (err) {
        if (isExecError(err) && err.stderr.includes('File exists')) return;
        throw err;
      }
    },

    async removeIpRule(opts: IpRuleOptions): Promise<void> {
      try {
        await ip('rule', 'del', ...ipRuleArgs(opts));
      } catch (err) {
        if (isExecError(err) && (err.stderr.includes('No such') || err.stderr.includes('No rule'))) return;
        throw err;
      }
    },

    async addRoute(opts: RouteOptions): Promise<void> {
      try {
        await ip('route', 'add', opts.destination, 'dev', opts.device, 'table', String(opts.table));
      } catch (err) {
        if (isExecError(err) && err.stderr.includes('File exists')) return;
        throw err;
      }
    },

    async removeRoute(opts: RouteOptions): Promise<void> {
      try {
        await ip('route', 'del', opts.destination, 'dev', opts.device, 'table', String(opts.table));
      } catch (err) {
        if (isExecError(err) && (err.stderr.includes('No such') || err.stderr.includes('No route'))) return;
        throw err;
      }
    },

    async createBridge(name: string): Promise<void> {
      if (name.length > 15) {
        throw new Error(`Interface name "${name}" exceeds 15 character Linux limit`);
      }
      if (await backend.interfaceExists(name)) return;
      await ip('link', 'add', 'name', name, 'type', 'bridge');
    },

    async addBridgeMember(bridge: string, member: string): Promise<void> {
      await ip('link', 'set', member, 'master', bridge);
    },

    async removeBridgeMember(_bridge: string, member: string): Promise<void> {
      await ip('link', 'set', member, 'nomaster');
    },

    async setBridgeHairpin(member: string, enabled: boolean): Promise<void> {
      await execFile('bridge', ['link', 'set', 'dev', member, 'hairpin', enabled ? 'on' : 'off']);
    },

    async flushRulesByComment(commentPrefix: string): Promise<void> {
      if (!commentPrefix) throw new Error('Refusing to flush iptables rules with empty comment prefix');

      for (const rule of await backend.listRulesByComment(commentPrefix)) {
        try {
          await backend.deleteRule(rule);
        } catch (err) {
          console.warn(`Failed to clean up iptables rule: ${rule.spec.join(' ')}`, err);
        }
      }
    },

    async listRulesByComment(commentPrefix: string): Promise<IptablesRuleInfo[]> {
      const rules: IptablesRuleInfo[] = [];
      for (const table of ['filter', 'nat']) {
        let output: string;
        try {
          output = await run('iptables', ['-t', table, '-S']);
        } catch {
          continue;
        }

        for (const line of output.split('\n')) {
          const rule = parseIptablesRule(table, line);
          if (rule?.comment.startsWith(commentPrefix)) rules.push(rule);
        }
      }
      return rules;
    },

    async deleteRule(rule: IptablesRuleInfo): Promise<void> {
      await run('iptables', ['-t', rule.table, '-D', ...rule.spec]);
    },
  };

  return backend;
}
