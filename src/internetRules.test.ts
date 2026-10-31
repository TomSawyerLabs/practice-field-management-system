import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restorePreviousStations, syncInternetAccess, useNetworkBackend } from './networkManager.js';
import { createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import { parseIptablesRule } from './node-ip/linux.js';
import type { IptablesOptions, IptablesRuleInfo } from './node-ip/types.js';
import RadioManager from './radioManager.js';
import { ENABLED_STATE_WAIT_MS, TelemetryManager } from './telemetryManager.js';
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

describe('a toggle during a commit', () => {
  /** A commit stopped part-way through its rule sync. */
  async function commitInProgress(rm: RadioManager) {
    const list = kernel.backend.listRulesByComment;
    let release = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    let reached = () => {};
    const atGate = new Promise<void>(resolve => (reached = resolve));
    kernel.backend.listRulesByComment = async prefix => {
      const rules = await list(prefix);
      reached();
      await gate;
      return rules;
    };
    const commit = rm.commitConfiguration();
    await atGate;
    return { commit, release };
  }

  test('waits its turn, so it can’t land in the middle of the rule sync', async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234'));
    const { commit, release } = await commitInProgress(rm);

    const toggled = rm.toggleInternetAccess('slot1', true);
    await Bun.sleep(5);
    expect(kernel.internet()).toEqual([]);

    release();
    await Promise.all([commit, toggled]);
    expect(kernel.internet()).toEqual(['pfms-nat-slot1 10.12.34.0/24']);
  });

  test('does nothing if the team left while it waited', async () => {
    const rm = manager();
    await rm.configure('slot1', team('1234'));
    const { commit, release } = await commitInProgress(rm);

    const toggled = rm.toggleInternetAccess('slot1', true);
    const cleared = rm.clearAllConfigurations();
    release();
    await Promise.all([commit, toggled, cleared]);
    expect(kernel.internet()).toEqual([]);
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

describe('a commit lost to a restart', () => {
  /** A restart: the old process and what it held in memory are gone, the
   *  kernel and active-config.json stay. */
  function restart(before: RadioManager) {
    before.stopPolling();
    restorePreviousStations(() => null);
    const rm = manager();
    rm.whenConnected = () => Promise.resolve();
    return rm;
  }

  /** The team's bridge is up, the config says it left, and the commit that
   *  would have joined the two went with the process. */
  async function clearLostToRestart() {
    const before = manager();
    await before.configure('slot1', team('1234', true));
    before.setShouldDefer(() => true);
    await before.clearAllConfigurations();
    return restart(before);
  }

  test('a clear still takes the bridge down', async () => {
    const rm = await clearLostToRestart();
    await rm.recoverLostCommit();
    expect(kernel.addresses.get('br-slot1')).toEqual([]);
    expect(kernel.rules.map(r => r.comment)).toEqual(['pfms-no-hairpin']);
  });

  test('waits for the radio, which says what firmware it has', async () => {
    const rm = await clearLostToRestart();
    let connect = () => {};
    rm.whenConnected = () => new Promise(resolve => (connect = resolve));
    const recovered = rm.recoverLostCommit();
    await Bun.sleep(0);
    expect(kernel.addresses.get('br-slot1')).toEqual(['10.12.34.254']);
    connect();
    await recovered;
    expect(kernel.addresses.get('br-slot1')).toEqual([]);
  });

  test('waits for robots like any commit', async () => {
    const rm = await clearLostToRestart();
    let robotsEnabled = true;
    rm.setShouldDefer(() => robotsEnabled);
    await rm.recoverLostCommit();
    expect(kernel.addresses.get('br-slot1')).toEqual(['10.12.34.254']);
    expect(rm.getPendingState().pending).toBe(true);

    robotsEnabled = false;
    await rm.commitConfiguration();
    expect(kernel.addresses.get('br-slot1')).toEqual([]);
  });

  describe('with nothing heard from any robot yet', () => {
    let clock: number;
    /** Wired as index.ts wires it. Stubbing shouldDefer can't catch this: the
     *  bug is what it answers before the first report arrives. */
    function waitingOnTelemetry(rm: RadioManager) {
      clock = 1_000_000;
      const telemetry = new TelemetryManager(
        () => rm.getFieldTeamMappings(),
        () => {},
        undefined,
        () => clock,
      );
      rm.setShouldDefer(() => telemetry.robotsMayBeEnabled(rm.stationsOnField()));
      return telemetry;
    }
    const committed = async (rm: RadioManager) => {
      rm.retryDeferredCommit();
      await rm.commitConfiguration();
      return kernel.addresses.get('br-slot1');
    };

    test('the commit waits instead of dropping a robot it knows nothing about', async () => {
      const rm = await clearLostToRestart();
      waitingOnTelemetry(rm);
      await rm.recoverLostCommit();
      expect(kernel.addresses.get('br-slot1')).toEqual(['10.12.34.254']);
      expect(rm.getPendingState().deferred).toBe(true);
    });

    test('a robot reporting disabled lets it go', async () => {
      const rm = await clearLostToRestart();
      const telemetry = waitingOnTelemetry(rm);
      await rm.recoverLostCommit();
      telemetry.noteRobotStatus('slot1', false);
      expect(await committed(rm)).toEqual([]);
    });

    test('an enabled robot holds it past the wait, though no DS is under field control', async () => {
      const rm = await clearLostToRestart();
      const telemetry = waitingOnTelemetry(rm);
      await rm.recoverLostCommit();
      telemetry.noteRobotStatus('slot1', true);
      clock += ENABLED_STATE_WAIT_MS * 3;
      telemetry.noteRobotStatus('slot1', true);
      expect(await committed(rm)).toEqual(['10.12.34.254']);
      telemetry.noteRobotStatus('slot1', false);
      expect(await committed(rm)).toEqual([]);
    });

    test('a DS reporting to the field counts, for a team only the bridge still has', async () => {
      const rm = await clearLostToRestart();
      const telemetry = waitingOnTelemetry(rm);
      await rm.recoverLostCommit();
      const status = (enabled: boolean) => ({
        address: '10.12.34.5',
        port: 1160,
        data: { teamNumber: 1234, BatteryVoltage: 12, tags: [], status: { enabled } },
      });
      telemetry.processFmsEvent(status(true) as unknown as Parameters<typeof telemetry.processFmsEvent>[0]);
      expect(await committed(rm)).toEqual(['10.12.34.254']);
      telemetry.processFmsEvent(status(false) as unknown as Parameters<typeof telemetry.processFmsEvent>[0]);
      expect(await committed(rm)).toEqual([]);
    });

    test('a robot that never reports stops holding it after the wait', async () => {
      const rm = await clearLostToRestart();
      waitingOnTelemetry(rm);
      await rm.recoverLostCommit();
      clock += ENABLED_STATE_WAIT_MS;
      expect(await committed(rm)).toEqual([]);
    });

    test('only the first commit waits for a free-driving robot', async () => {
      const rm = await clearLostToRestart();
      const telemetry = waitingOnTelemetry(rm);
      await rm.recoverLostCommit();
      telemetry.noteRobotStatus('slot1', false);
      await committed(rm);
      await rm.configure('slot2', team('5678'));
      telemetry.noteRobotStatus('slot2', true);
      expect(telemetry.robotsMayBeEnabled(rm.stationsOnField())).toBe(false);
    });
  });

  test('a station handed to a new team loses the old one', async () => {
    const before = manager();
    await before.configure('slot1', team('1234', true));
    before.setShouldDefer(() => true);
    before.setShouldHold(() => 'match');
    await before.configure('slot1', team(''));
    await before.configure('slot1', team('5678'));
    before.setShouldHold(() => null);
    await before.applyPendingChanges();

    await restart(before).recoverLostCommit();
    expect(kernel.addresses.get('br-slot1')).toEqual(['10.56.78.254']);
    expect(kernel.internet()).toEqual([]);
  });

  test('a team missing from its bridge is set up', async () => {
    const before = manager();
    await before.configure('slot1', team('1234'));
    kernel.addresses.delete('br-slot1');
    await restart(before).recoverLostCommit();
    expect(kernel.addresses.get('br-slot1')).toEqual(['10.12.34.254']);
  });

  test('nothing is committed when the bridges match, two robots of a team included', async () => {
    const before = manager();
    await before.configure('slot3', team('1700-A'));
    await before.configure('slot4', team('1700-B'));
    const rm = restart(before);
    const commit = spyOn(rm, 'commitConfiguration');
    await rm.recoverLostCommit();
    expect(commit).not.toHaveBeenCalled();
    expect(kernel.addresses.get('br-slot3')).toEqual(['10.17.0.254']);
  });

  test('in OFFSEASON, the DHCP servers the reload stopped come back', async () => {
    const dryRun = process.env.DRY_RUN;
    process.env.DRY_RUN = '1';
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const before = new RadioManager('http://127.0.0.1:1', 'eno1', 'OFFSEASON');
      before.stopPolling();
      managers.push(before);
      await before.configure('slot1', team('1234'));
      log.mockClear();

      restorePreviousStations(() => null);
      const rm = new RadioManager('http://127.0.0.1:1', 'eno1', 'OFFSEASON');
      rm.stopPolling();
      managers.push(rm);
      rm.whenConnected = () => Promise.resolve();
      await rm.recoverLostCommit();
      expect(log.mock.calls.flat()).toContain('[dry-run] DHCP server not started for slot1 (1234)');
    } finally {
      log.mockRestore();
      if (dryRun === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = dryRun;
    }
  });

  test('in OFFSEASON, the teams on the bridges get their DHCP even while the commit waits', async () => {
    const dryRun = process.env.DRY_RUN;
    process.env.DRY_RUN = '1';
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const before = new RadioManager('http://127.0.0.1:1', 'eno1', 'OFFSEASON');
      before.stopPolling();
      managers.push(before);
      await before.configure('slot1', team('1234'));
      before.setShouldDefer(() => true);
      await before.clearAllConfigurations();
      log.mockClear();

      restorePreviousStations(() => null);
      const rm = new RadioManager('http://127.0.0.1:1', 'eno1', 'OFFSEASON');
      rm.stopPolling();
      managers.push(rm);
      rm.whenConnected = () => Promise.resolve();
      rm.setShouldDefer(() => true);
      await rm.recoverLostCommit();
      expect(rm.getPendingState().deferred).toBe(true);
      expect(kernel.addresses.get('br-slot1')).toEqual(['10.12.34.254']);
      expect(log.mock.calls.flat()).toContain('[dry-run] DHCP server not started for slot1 (1234)');
    } finally {
      log.mockRestore();
      if (dryRun === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = dryRun;
    }
  });

  test('a later commit tears down a team recovery found', async () => {
    const before = manager();
    await before.configure('slot1', team('1234'));
    const rm = restart(before);
    await rm.recoverLostCommit();
    await rm.clearAllConfigurations();
    expect(kernel.addresses.get('br-slot1')).toEqual([]);
  });

  test("a bridge that can't be read gets the commit, in case", async () => {
    const before = manager();
    await before.configure('slot1', team('1234'));
    const rm = restart(before);
    kernel.backend.listInterfaces = async () => {
      throw new Error('ip: command failed');
    };
    const commit = spyOn(rm, 'commitConfiguration').mockResolvedValue();
    await rm.recoverLostCommit();
    expect(commit).toHaveBeenCalledTimes(1);
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
