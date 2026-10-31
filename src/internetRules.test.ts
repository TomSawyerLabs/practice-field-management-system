import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restorePreviousStations, syncInternetAccess, useNetworkBackend } from './networkManager.js';
import { createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import { parseIptablesRule } from './node-ip/linux.js';
import type { IptablesOptions, IptablesRuleInfo } from './node-ip/types.js';
import RadioManager from './radioManager.js';
import type { StationName } from './types.js';

/** What a commit needs of a host, with its iptables rules and addresses kept
 *  as a kernel would: a rule is added once and a delete takes only what fits. */
function fakeKernel() {
  const rules: IptablesOptions[] = [];
  const addresses = new Map<string, string[]>();
  const log: string[] = [];
  const failures = { addAddressOn: new Set<string>() };

  const same = (a: IptablesOptions, b: IptablesOptions) =>
    a.comment === b.comment &&
    a.source === b.source &&
    a.outInterface === b.outInterface &&
    a.chain === b.chain &&
    a.notLocalSource === b.notLocalSource;
  const remove = (rule: IptablesOptions) => {
    const at = rules.findIndex(r => same(r, rule));
    if (at === -1) return;
    rules.splice(at, 1);
    log.push(`-D ${rule.comment} ${rule.source ?? ''}`.trim());
  };

  const backend: NetworkBackend = {
    ...createDryRunBackend(),
    async listInterfaces(name?: string) {
      const names = name ? [name] : [...addresses.keys()];
      return names.map(n => ({
        name: n,
        state: 'UP',
        mtu: 1500,
        addresses: (addresses.get(n) ?? []).map(address => ({ family: 'inet' as const, address, prefixLength: 24 })),
      }));
    },
    async addAddress(o) {
      if (failures.addAddressOn.has(o.interfaceName)) throw new Error('RTNETLINK answers: Operation not permitted');
      addresses.set(o.interfaceName, [...(addresses.get(o.interfaceName) ?? []), o.address]);
    },
    async removeAddress(o) {
      addresses.set(
        o.interfaceName,
        (addresses.get(o.interfaceName) ?? []).filter(a => a !== o.address),
      );
    },
    async iptables(o) {
      if (o.action === '-D') return remove(o);
      if (rules.some(r => same(r, o))) return;
      rules.push(o);
      log.push(`-A ${o.comment} ${o.source ?? ''}`.trim());
    },
    async flushRulesByComment(prefix) {
      for (const rule of rules.filter(r => r.comment?.startsWith(prefix))) remove(rule);
    },
    async listRulesByComment(prefix) {
      return rules
        .filter(r => r.comment?.startsWith(prefix))
        .map(r => ({
          table: r.table ?? 'filter',
          comment: r.comment!,
          source: r.source,
          outInterface: r.outInterface,
          spec: [],
        }));
    },
    async deleteRule(rule: IptablesRuleInfo) {
      remove({ action: '-D', chain: 'POSTROUTING', jump: 'MASQUERADE', ...rule });
    },
  };
  const internet = () =>
    rules
      .filter(r => r.comment?.startsWith('pfms-nat-slot'))
      .map(r => `${r.comment} ${r.source}`)
      .sort();
  return { backend, rules, addresses, log, failures, internet };
}

/** A rule as a reload finds it, left there by the process before. */
const internetRule = (station: StationName, source: string, outInterface = 'eno1'): IptablesOptions => ({
  action: '-A',
  table: 'nat',
  chain: 'POSTROUTING',
  source,
  notDestination: '10.0.0.0/8',
  outInterface,
  jump: 'MASQUERADE',
  comment: `pfms-nat-${station}`,
});

const team = (ssid: string, internetAccess?: boolean) => ({ ssid, wpaKey: 'passphrase1', internetAccess });

let kernel: ReturnType<typeof fakeKernel>;
let dir: string;
const managers: RadioManager[] = [];

/** A radio manager on a trunk, with PRACTICE firmware so no dnsmasq starts and
 *  no radio to push to. */
function manager(): RadioManager {
  const rm = new RadioManager('http://127.0.0.1:1', 'eno1', 'PRACTICE');
  rm.stopPolling();
  managers.push(rm);
  return rm;
}

beforeEach(() => {
  kernel = fakeKernel();
  useNetworkBackend(kernel.backend);
  restorePreviousStations(() => null);
  dir = mkdtempSync(join(tmpdir(), 'pfms-internet-rules-'));
  process.env.ACTIVE_CONFIG_FILE = join(dir, 'active.json');
  process.env.STAGED_CONFIG_FILE = join(dir, 'staged.json');
});

afterEach(() => {
  for (const rm of managers.splice(0)) rm.stopPolling();
  useNetworkBackend(createDryRunBackend());
  rmSync(dir, { recursive: true, force: true });
});

describe('after a commit', () => {
  test("a cleared station's rule goes with its team", async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234', true));
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24']);
    await rm.clearAllConfigurations();
    expect(kernel.internet()).toEqual([]);
  });

  test('the daily clear of an empty field still removes a leftover', async () => {
    kernel.rules.push(internetRule('slot1', '10.1.0.0/24'));
    await manager().clearAllConfigurations();
    expect(kernel.internet()).toEqual([]);
  });

  /** The one commit that hands a station from one team to the next. */
  async function handOver(rm: RadioManager, next: ReturnType<typeof team>) {
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', team(''));
    await rm.configure('slot1', next);
    rm.setShouldHold(() => null);
    await rm.applyPendingChanges();
  }

  test("a station given to a new team loses the old team's rule", async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234', true));
    await handOver(rm, team('5678', true));
    expect(rm.getStationConfig('slot1')?.ssid).toBe('5678');
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.56.78.0/24']);
  });

  test("a new team with internet off doesn't inherit it", async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234', true));
    await handOver(rm, team('5678'));
    expect(kernel.internet()).toEqual([]);
  });

  test('a team moving station is never left without a rule', async () => {
    kernel.rules.push(internetRule('slot2', '10.12.34.0/24'));
    await syncInternetAccess({ slot3: 1234 }, 'eno1');
    expect(kernel.log).toEqual(['-A pfms-nat-slot3 10.12.34.0/24', '-D pfms-nat-slot2 10.12.34.0/24']);
  });

  test("one robot leaving keeps its team's other robot on the internet", async () => {
    const rm = manager();
    await rm.configure('slot3', team('1700-A', true));
    await rm.configure('slot4', team('1700-B', true));
    await rm.configure('slot3', team(''));
    expect(kernel.internet()).toEqual(['pfms-nat-slot4 10.17.0.0/24']);
  });

  test('never touches the bridge rule, which every robot on the field needs', async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234', true));
    await rm.configure('slot2', team('5678'));
    await rm.clearAllConfigurations(false, ssid => ssid === '5678');
    expect(kernel.rules.map(r => r.comment)).toContain('pfms-nat-vlan-slot2');
    expect(kernel.log.filter(l => l.startsWith('-D')).some(l => l.includes('slot2'))).toBe(false);
  });

  test('a rule for an old trunk is replaced', async () => {
    kernel.rules.push(internetRule('slot1', '10.12.34.0/24', 'eno9'));
    await manager().configure('slot1', team('1234', true));
    expect(kernel.rules.filter(r => r.comment === 'pfms-nat-slot1').map(r => r.outInterface)).toEqual(['eno1']);
  });

  test("a failed station doesn't hold up the others' internet", async () => {
    kernel.failures.addAddressOn.add('br-slot1');
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', team('254', true));
    await rm.configure('slot2', team('1678', true));
    rm.setShouldHold(() => null);
    await expect(rm.applyPendingChanges()).rejects.toThrow('slot1');
    expect(kernel.internet()).toContain('pfms-nat-slot2 10.16.78.0/24');
  });
});

describe('while a commit waits on the match', () => {
  test('the rule stays until the commit takes the team off the bridge', async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234', true));
    rm.setShouldDefer(() => true);
    await rm.clearAllConfigurations();
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24']);

    rm.setShouldDefer(() => false);
    await rm.commitConfiguration();
    expect(kernel.internet()).toEqual([]);
  });

  test("a toggle on another station leaves that team's rule alone", async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234', true));
    await rm.configure('slot2', team('5678'));
    rm.setShouldDefer(() => true);
    await rm.clearAllConfigurations(false, ssid => ssid === '5678');
    await rm.toggleInternetAccess('slot2', true);
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24', 'pfms-nat-slot2 10.56.78.0/24']);
  });
});

describe('after a graceful restart', () => {
  const restored = (config: object) => {
    writeFileSync(process.env.ACTIVE_CONFIG_FILE!, JSON.stringify(config));
    return manager();
  };

  test('what steamboat held on 2026-10-30 is removed', async () => {
    kernel.rules.push(
      internetRule('slot1', '10.1.0.0/24'),
      internetRule('slot3', '10.17.0.0/24'),
      internetRule('slot4', '10.17.0.0/24'),
    );
    await restored({}).removeStaleInternetRules();
    expect(kernel.internet()).toEqual([]);
  });

  test('a team on the field keeps its rule, and only that one goes', async () => {
    kernel.rules.push(internetRule('slot1', '10.12.34.0/24'), internetRule('slot2', '10.1.0.0/24'));
    kernel.addresses.set('br-slot1', ['10.12.34.254']);
    await restored({ slot1: team('1234', true) }).removeStaleInternetRules();
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24']);
    expect(kernel.log).toEqual(['-D pfms-nat-slot2 10.1.0.0/24']);
  });

  test('a team cleared but still on its bridge, its commit lost, keeps its rule', async () => {
    kernel.rules.push(internetRule('slot1', '10.12.34.0/24'));
    kernel.addresses.set('br-slot1', ['10.12.34.254']);
    await restored({}).removeStaleInternetRules();
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24']);
  });

  test("a rule whose team is on another station's bridge goes", async () => {
    kernel.rules.push(internetRule('slot1', '10.12.34.0/24'));
    kernel.addresses.set('br-slot2', ['10.12.34.254']);
    await restored({}).removeStaleInternetRules();
    expect(kernel.internet()).toEqual([]);
  });

  test('a rule the kernel lost is put back', async () => {
    await restored({ slot1: team('1234', true) }).removeStaleInternetRules();
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24']);
  });
});

test('reads a rule as steamboat prints it', () => {
  const line =
    '-A POSTROUTING -s 10.1.0.0/24 ! -d 10.0.0.0/8 -o eno1 -m comment --comment pfms-nat-slot1 -j MASQUERADE';
  expect(parseIptablesRule('nat', line)).toEqual({
    table: 'nat',
    comment: 'pfms-nat-slot1',
    source: '10.1.0.0/24',
    outInterface: 'eno1',
    spec: line.split(' ').slice(1),
  });
  expect(parseIptablesRule('nat', '-P POSTROUTING ACCEPT')).toBeUndefined();
  expect(parseIptablesRule('nat', '-A POSTROUTING -o eno1 -j MASQUERADE')).toBeUndefined();
});
