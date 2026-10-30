import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import type { IpRuleInfo } from './node-ip/types.js';
import { parseIpRule } from './node-ip/linux.js';
import { useNetworkBackend } from './networkManager.js';
import {
  cleanupAllPreferences,
  clearRoutePreference,
  getPreference,
  onConfigChange,
  setRoutePreference,
  syncPreferencesWithKernel,
} from './routePreferenceManager.js';
import type { StationName } from './types.js';

const SYSTEM_RULES: IpRuleInfo[] = [
  { priority: 0, src: 'all', table: 'local' },
  { priority: 32766, src: 'all', table: 'main' },
  { priority: 32767, src: 'all', table: 'default' },
];

/** The kernel's rule list, as far as steamboat (6.14) showed it: without a
 *  priority, a rule goes one below the lowest in use and a duplicate is
 *  accepted; a removal takes the first rule that fits. */
function fakeKernel(start: IpRuleInfo[] = []) {
  const rules = [...SYSTEM_RULES, ...start];
  const backend: NetworkBackend = {
    ...createDryRunBackend(),
    async listIpRules() {
      return rules.map(r => ({ ...r }));
    },
    async addIpRule({ from, to, table, priority }) {
      const inUse = rules.filter(r => r.src !== 'all').map(r => r.priority);
      rules.push({ priority: priority ?? Math.min(32766, ...inUse) - 1, src: from, dst: to, table: String(table) });
      rules.sort((a, b) => a.priority - b.priority);
    },
    async removeIpRule({ from, to, table, priority }) {
      const i = rules.findIndex(
        r =>
          r.src === from &&
          r.dst === to &&
          r.table === String(table) &&
          (priority === undefined || r.priority === priority),
      );
      if (i >= 0) rules.splice(i, 1);
    },
  };
  return {
    backend,
    /** What's left beyond the system rules, as "laptop subnet table". */
    laptopRules: () => rules.filter(r => r.src !== 'all').map(r => `${r.src} ${r.dst} ${r.table}`),
    priorities: () => rules.filter(r => r.src !== 'all').map(r => r.priority),
  };
}

const rule = (priority: number, src: string, dst: string, table: number): IpRuleInfo => ({
  priority,
  src,
  dst,
  table: String(table),
});

const teams =
  (assigned: Partial<Record<StationName, number>>) =>
  (s: StationName): number | null =>
    assigned[s] ?? null;

beforeEach(() => {
  useNetworkBackend(fakeKernel().backend);
});
afterEach(async () => {
  await cleanupAllPreferences();
});

describe('reading ip rules', () => {
  test('a subnet keeps the prefix length ip -j reports separately', () => {
    // Verbatim from `ip -j rule list` on steamboat.
    const raw = { priority: 31927, src: '10.55.231.82', dst: '10.1.14.0', dstlen: 24, table: '20' };
    expect(parseIpRule(raw)).toEqual({ priority: 31927, src: '10.55.231.82', dst: '10.1.14.0/24', table: '20' });
  });

  test('a selector without a prefix length stays as it is, and a range keeps its own', () => {
    expect(parseIpRule({ priority: 0, src: 'all', table: 'local' }).src).toBe('all');
    expect(parseIpRule({ priority: 5, src: '10.0.0.0', srclen: 8, table: '10' }).src).toBe('10.0.0.0/8');
  });
});

describe('after a graceful restart', () => {
  test('a laptop with live rules keeps one and the duplicates go', async () => {
    const kernel = fakeKernel([
      rule(31000, '10.55.65.16', '10.59.40.0/24', 10),
      rule(31001, '10.55.65.16', '10.59.40.0/24', 10),
      rule(32000, '10.55.65.16', '10.59.40.0/24', 10),
    ]);
    useNetworkBackend(kernel.backend);

    const result = await syncPreferencesWithKernel(teams({ slot1: 5940 }));

    expect(result).toEqual({ restored: 1, removed: 2 });
    expect(kernel.priorities()).toEqual([31000]);
    expect(getPreference('10.55.65.16')).toBe('slot1');
  });

  test('rules for a team that has left go', async () => {
    const kernel = fakeKernel([rule(31000, '10.55.65.16', '10.59.40.0/24', 10)]);
    useNetworkBackend(kernel.backend);

    expect(await syncPreferencesWithKernel(teams({ slot1: 114 }))).toEqual({ restored: 0, removed: 1 });

    expect(kernel.laptopRules()).toEqual([]);
    expect(getPreference('10.55.65.16')).toBeNull();
  });

  test("a rule pointing at the team's old slot goes when the team has moved", async () => {
    const kernel = fakeKernel([
      rule(31000, '10.55.65.16', '10.59.40.0/24', 10),
      rule(32000, '10.55.65.16', '10.59.40.0/24', 30),
    ]);
    useNetworkBackend(kernel.backend);

    await syncPreferencesWithKernel(teams({ slot3: 5940 }));

    expect(kernel.laptopRules()).toEqual(['10.55.65.16 10.59.40.0/24 30']);
    expect(getPreference('10.55.65.16')).toBe('slot3');
  });

  test('two robots of one team: each laptop stays on its own slot', async () => {
    const kernel = fakeKernel([
      rule(31927, '10.55.231.82', '10.1.14.0/24', 20),
      rule(31928, '10.55.231.82', '10.1.14.0/24', 20),
      rule(31929, '10.55.150.65', '10.1.14.0/24', 10),
    ]);
    useNetworkBackend(kernel.backend);

    await syncPreferencesWithKernel(teams({ slot1: 114, slot2: 114 }));

    expect(kernel.laptopRules()).toEqual(['10.55.231.82 10.1.14.0/24 20', '10.55.150.65 10.1.14.0/24 10']);
    expect(getPreference('10.55.231.82')).toBe('slot2');
    expect(getPreference('10.55.150.65')).toBe('slot1');
  });

  test('a laptop with rules for both robots stays on the one its traffic follows', async () => {
    const kernel = fakeKernel([
      rule(31000, '10.55.231.82', '10.1.14.0/24', 20),
      rule(32000, '10.55.231.82', '10.1.14.0/24', 10),
    ]);
    useNetworkBackend(kernel.backend);

    await syncPreferencesWithKernel(teams({ slot1: 114, slot2: 114 }));

    expect(getPreference('10.55.231.82')).toBe('slot2');
    expect(kernel.laptopRules()).toEqual(['10.55.231.82 10.1.14.0/24 20']);
  });

  test('a laptop that moved between teams keeps its newest live rule', async () => {
    const kernel = fakeKernel([
      rule(31000, '10.55.65.16', '10.1.14.0/24', 20),
      rule(32000, '10.55.65.16', '10.59.40.0/24', 10),
    ]);
    useNetworkBackend(kernel.backend);

    await syncPreferencesWithKernel(teams({ slot1: 5940, slot2: 114 }));

    expect(kernel.laptopRules()).toEqual(['10.55.65.16 10.1.14.0/24 20']);
  });

  test('leaves rules that are not per-laptop routes alone', async () => {
    const foreign = [
      rule(100, '10.55.1.1', '10.0.100.0/24', 10), // not a team subnet
      rule(101, '10.55.0.0/16', '10.1.14.0/24', 10), // a range, not a laptop
      rule(102, '10.55.1.1', '10.1.14.0/24', 99), // not a station table
      { priority: 103, src: '10.55.1.1', table: '10' }, // no destination
    ];
    const kernel = fakeKernel(foreign);
    useNetworkBackend(kernel.backend);

    expect(await syncPreferencesWithKernel(() => null)).toEqual({ restored: 0, removed: 0 });

    expect(kernel.priorities()).toEqual([100, 101, 102, 103]);
  });

  test('one rule that will not go does not stop the rest', async () => {
    const kernel = fakeKernel([
      rule(31000, '10.55.1.1', '10.1.14.0/24', 10),
      rule(31001, '10.55.1.2', '10.1.14.0/24', 10),
    ]);
    const { removeIpRule } = kernel.backend;
    useNetworkBackend({
      ...kernel.backend,
      async removeIpRule(opts) {
        if (opts.from === '10.55.1.1') throw new Error('nope');
        await removeIpRule(opts);
      },
    });

    expect(await syncPreferencesWithKernel(() => null)).toEqual({ restored: 0, removed: 1 });
    expect(kernel.laptopRules()).toEqual(['10.55.1.1 10.1.14.0/24 10']);
  });

  test('a restored preference is removed with its team', async () => {
    const kernel = fakeKernel([rule(31000, '10.55.65.16', '10.59.40.0/24', 10)]);
    useNetworkBackend(kernel.backend);
    await syncPreferencesWithKernel(teams({ slot1: 5940 }));

    await onConfigChange(teams({ slot1: 114 }));

    expect(kernel.laptopRules()).toEqual([]);
    expect(getPreference('10.55.65.16')).toBeNull();
  });

  test('asking again for the same route adds no rule', async () => {
    const kernel = fakeKernel([rule(31000, '10.55.65.16', '10.59.40.0/24', 10)]);
    useNetworkBackend(kernel.backend);
    await syncPreferencesWithKernel(teams({ slot1: 5940 }));

    await setRoutePreference('10.55.65.16', 'slot1', 5940);

    expect(kernel.priorities()).toEqual([31000]);
  });
});

test('a full restart clears every per-laptop rule', async () => {
  const kernel = fakeKernel([
    rule(31000, '10.55.65.16', '10.59.40.0/24', 10),
    rule(31001, '10.55.65.17', '10.59.40.0/24', 10),
  ]);
  useNetworkBackend(kernel.backend);

  expect(await syncPreferencesWithKernel(() => null)).toEqual({ restored: 0, removed: 2 });

  expect(kernel.laptopRules()).toEqual([]);
  expect(getPreference('10.55.65.16')).toBeNull();
});

describe('choosing a route', () => {
  test('moving between the two robots of a team swaps the rule', async () => {
    const kernel = fakeKernel();
    useNetworkBackend(kernel.backend);

    await setRoutePreference('10.55.1.1', 'slot1', 114);
    await setRoutePreference('10.55.1.1', 'slot2', 114);

    expect(kernel.laptopRules()).toEqual(['10.55.1.1 10.1.14.0/24 20']);
    expect(getPreference('10.55.1.1')).toBe('slot2');
  });

  test('picks that land together leave one rule', async () => {
    const kernel = fakeKernel();
    useNetworkBackend(kernel.backend);

    await Promise.all([
      setRoutePreference('10.55.1.1', 'slot1', 114),
      setRoutePreference('10.55.1.1', 'slot1', 114),
      setRoutePreference('10.55.1.1', 'slot2', 114),
    ]);

    expect(kernel.laptopRules()).toEqual(['10.55.1.1 10.1.14.0/24 20']);
    expect(getPreference('10.55.1.1')).toBe('slot2');
  });

  test('priorities are reused, so churn never walks them down', async () => {
    const kernel = fakeKernel();
    useNetworkBackend(kernel.backend);
    await setRoutePreference('10.55.1.1', 'slot1', 114);

    for (let i = 0; i < 2000; i++) {
      await setRoutePreference('10.55.1.2', 'slot2', 254);
      await clearRoutePreference('10.55.1.2');
    }
    await setRoutePreference('10.55.1.2', 'slot2', 254);

    expect(kernel.priorities()).toEqual([32764, 32765]);
  });

  test('a restored rule keeps its priority out of the free list', async () => {
    const kernel = fakeKernel([rule(32765, '10.55.1.1', '10.1.14.0/24', 10)]);
    useNetworkBackend(kernel.backend);
    await syncPreferencesWithKernel(teams({ slot1: 114 }));

    await setRoutePreference('10.55.1.2', 'slot1', 114);

    expect(kernel.priorities()).toEqual([32764, 32765]);
  });

  test('a removal only ever takes its own rule', async () => {
    const kernel = fakeKernel([
      rule(31000, '10.55.1.1', '10.1.14.0/24', 10),
      rule(31001, '10.55.1.1', '10.1.14.0/24', 10),
    ]);
    useNetworkBackend(kernel.backend);
    await syncPreferencesWithKernel(teams({ slot1: 114 }));
    expect(kernel.priorities()).toEqual([31000]);

    await clearRoutePreference('10.55.1.1');

    expect(kernel.laptopRules()).toEqual([]);
  });

  test('a rule that will not go is still tracked, and retried', async () => {
    const kernel = fakeKernel();
    let fail = true;
    const { removeIpRule } = kernel.backend;
    useNetworkBackend({
      ...kernel.backend,
      async removeIpRule(opts) {
        if (fail) throw new Error('busy');
        await removeIpRule(opts);
      },
    });
    await setRoutePreference('10.55.1.1', 'slot1', 114);

    await expect(clearRoutePreference('10.55.1.1')).rejects.toThrow('busy');
    expect(getPreference('10.55.1.1')).toBe('slot1');

    fail = false;
    await clearRoutePreference('10.55.1.1');
    expect(kernel.laptopRules()).toEqual([]);
  });

  test('one failed change does not stop the next', async () => {
    const kernel = fakeKernel();
    const { addIpRule } = kernel.backend;
    let fail = true;
    useNetworkBackend({
      ...kernel.backend,
      async addIpRule(opts) {
        if (fail) throw new Error('busy');
        await addIpRule(opts);
      },
    });

    await expect(setRoutePreference('10.55.1.1', 'slot1', 114)).rejects.toThrow('busy');
    fail = false;
    await setRoutePreference('10.55.1.1', 'slot1', 114);

    expect(kernel.laptopRules()).toEqual(['10.55.1.1 10.1.14.0/24 10']);
  });
});
