import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDryRunBackend, type IptablesOptions, type NetworkBackend } from './node-ip/index.js';
import type { ChainRuleCounter, IptablesRuleInfo } from './node-ip/types.js';
import { TeamAuth } from './teamAuth.js';
import { TeamLock, lockRules, lockWebRules, teamSubnet } from './teamLock.js';
import type { StationName } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'pfms-team-lock-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Jumps and chains as a kernel keeps them: deleting a chain something still
 *  jumps to fails, as it does for real. */
function fakeKernel() {
  const jumps: (IptablesOptions & { table: string })[] = [];
  const chains = new Map<string, string[][]>();
  const counters = new Map<string, ChainRuleCounter[]>();
  const writes: string[] = [];
  const key = (o: IptablesOptions) =>
    `${o.table ?? 'filter'} ${o.chain} ${o.comment} ${o.jump} ${o.outInterface ?? ''}`;

  const backend: NetworkBackend = {
    ...createDryRunBackend(),
    async iptables(o) {
      const at = jumps.findIndex(j => key(j) === key(o));
      if (o.action === '-D') {
        if (at !== -1) jumps.splice(at, 1);
      } else if (at === -1) {
        jumps.unshift({ ...o, table: o.table ?? 'filter' });
      }
    },
    async listRulesByComment(prefix) {
      return jumps
        .filter(j => j.comment?.startsWith(prefix))
        .map(
          (j): IptablesRuleInfo => ({
            table: j.table,
            comment: j.comment!,
            outInterface: j.outInterface,
            spec: [j.chain, '-j', j.jump, '__key', key(j)],
          }),
        );
    },
    async deleteRule(rule) {
      const at = jumps.findIndex(j => key(j) === rule.spec[4]);
      if (at !== -1) jumps.splice(at, 1);
    },
    async flushRulesByComment(prefix) {
      for (let i = jumps.length - 1; i >= 0; i--) if (jumps[i].comment?.startsWith(prefix)) jumps.splice(i, 1);
    },
    async replaceChain(table, chain, rules) {
      chains.set(`${table}/${chain}`, rules);
      writes.push(`${table}/${chain}`);
    },
    async deleteChain(table, chain) {
      if (jumps.some(j => j.table === table && j.jump === chain)) throw new Error(`chain ${chain} is in use`);
      chains.delete(`${table}/${chain}`);
    },
    async listChains(table, prefix) {
      return [...chains.keys()]
        .filter(k => k.startsWith(`${table}/`))
        .map(k => k.slice(table.length + 1))
        .filter(c => c.startsWith(prefix));
    },
    async chainCounters(table, chain) {
      return counters.get(`${table}/${chain}`) ?? [];
    },
  };
  const summary = () =>
    jumps.map(j => `${j.table} ${j.chain} ${j.outInterface ?? j.destination ?? j.destinationPort} -> ${j.jump}`).sort();
  return { backend, jumps, chains, counters, writes, summary };
}

describe('TeamLock', () => {
  let kernel: ReturnType<typeof fakeKernel>;
  let auth: TeamAuth;
  let now: number;
  let onBridges: Partial<Record<StationName, number>>;
  let lock: TeamLock;

  beforeEach(() => {
    kernel = fakeKernel();
    now = 1_000_000;
    auth = new TeamAuth(join(dir, `${Math.random()}.json`), () => now);
    onBridges = { slot1: 1234, slot2: 5678 };
    lock = new TeamLock({
      auth,
      net: () => kernel.backend,
      teamsOnBridges: () => onBridges,
      bridgeName: s => `br-${s}`,
      portalPort: 8180,
      idleMs: () => 12 * 3600_000,
    });
    void lock.activate();
  });

  async function lockedTeam(team = 1234) {
    const r = await auth.setPassword(team, 'gearbox42!');
    if (!r || !('token' in r)) throw new Error('set failed');
    auth.setLock(team, true);
    return r.device;
  }

  test('nothing happens before it is activated', async () => {
    const idle = new TeamLock({
      auth,
      net: () => kernel.backend,
      teamsOnBridges: () => ({}),
      bridgeName: s => `br-${s}`,
      portalPort: 8180,
      idleMs: () => 1,
    });
    await lockedTeam();
    await lock.reconcile();
    const before = kernel.summary();
    await idle.reconcile(); // would tear everything down if it acted
    expect(kernel.summary()).toEqual(before);
  });

  test('nothing happens for teams without a lock', async () => {
    await auth.setPassword(1234, 'gearbox42!');
    await lock.reconcile();
    expect(kernel.jumps).toEqual([]);
    expect(kernel.chains.size).toBe(0);
  });

  test('a locked team gets its chains, then the jumps to them', async () => {
    const device = await lockedTeam();
    auth.bindAddress(1234, device.id, '192.168.3.10');
    await lock.reconcile();

    expect(kernel.chains.get('filter/pfms-lock-1234')).toEqual(lockRules(1234, ['192.168.3.10']));
    expect(kernel.chains.get('nat/pfms-lockweb-1234')).toEqual(lockWebRules(1234, ['192.168.3.10'], 8180));
    expect(kernel.summary()).toEqual([
      'filter FORWARD br-slot1 -> pfms-lock-1234',
      'filter INPUT 8180 -> ACCEPT',
      'nat PREROUTING 10.12.34.0/24 -> pfms-lockweb-1234',
    ]);
  });

  test('the rules let through replies, the team, and bound laptops, and refuse the rest', () => {
    expect(teamSubnet(1234)).toBe('10.12.34.0/24');
    expect(teamSubnet(5)).toBe('10.0.5.0/24');
    expect(lockRules(1234, ['192.168.3.10'])).toEqual([
      ['-m', 'conntrack', '--ctdir', 'REPLY', '-j', 'RETURN'],
      ['-s', '10.12.34.0/24', '-j', 'RETURN'],
      ['-s', '192.168.3.10/32', '-j', 'RETURN'],
      ['-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset'],
      ['-j', 'REJECT', '--reject-with', 'icmp-admin-prohibited'],
    ]);
  });

  test('a laptop moving address rewrites the chain, and only that', async () => {
    const device = await lockedTeam();
    auth.bindAddress(1234, device.id, '192.168.3.10');
    await lock.reconcile();
    kernel.writes.length = 0;

    await lock.reconcile();
    expect(kernel.writes).toEqual([]);

    auth.bindAddress(1234, device.id, '192.168.3.20');
    await lock.reconcile();
    expect(kernel.writes).toEqual(['filter/pfms-lock-1234', 'nat/pfms-lockweb-1234']);
    expect(kernel.chains.get('filter/pfms-lock-1234')).toEqual(lockRules(1234, ['192.168.3.20']));
  });

  test('a team with two robots is locked on both stations', async () => {
    onBridges = { slot1: 1234, slot4: 1234 };
    await lockedTeam();
    await lock.reconcile();
    expect(kernel.summary()).toContain('filter FORWARD br-slot1 -> pfms-lock-1234');
    expect(kernel.summary()).toContain('filter FORWARD br-slot4 -> pfms-lock-1234');
  });

  test('unlocking, resetting or leaving the field removes everything', async () => {
    await lockedTeam();
    await lock.reconcile();

    auth.setLock(1234, false);
    await lock.reconcile();
    expect(kernel.jumps).toEqual([]);
    expect(kernel.chains.size).toBe(0);

    auth.setLock(1234, true);
    await lock.reconcile();
    expect(kernel.jumps.length).toBe(3);

    onBridges = { slot2: 5678 };
    await lock.reconcile();
    expect(kernel.jumps).toEqual([]);
    expect(kernel.chains.size).toBe(0);
  });

  test('a station changing hands moves its jump to the new team', async () => {
    await lockedTeam(1234);
    await lockedTeam(5678);
    await lock.reconcile();
    onBridges = { slot1: 5678 };
    await lock.reconcile();
    expect(kernel.summary()).toEqual([
      'filter FORWARD br-slot1 -> pfms-lock-5678',
      'filter INPUT 8180 -> ACCEPT',
      'nat PREROUTING 10.56.78.0/24 -> pfms-lockweb-5678',
    ]);
    expect([...kernel.chains.keys()].sort()).toEqual(['filter/pfms-lock-5678', 'nat/pfms-lockweb-5678']);
  });

  test('a restart that flushed the jumps but left the chains puts them back', async () => {
    await lockedTeam();
    await lock.reconcile();
    await kernel.backend.flushRulesByComment('pfms-');
    const fresh = new TeamLock({
      auth,
      net: () => kernel.backend,
      teamsOnBridges: () => onBridges,
      bridgeName: s => `br-${s}`,
      portalPort: 8180,
      idleMs: () => 12 * 3600_000,
    });
    await fresh.reconcile();
    expect(kernel.jumps.length).toBe(0); // not before it knows the bridges
    await fresh.activate();
    expect(kernel.jumps.length).toBe(3);
  });

  test('traffic keeps a binding alive; silence ends it', async () => {
    const device = await lockedTeam();
    auth.bindAddress(1234, device.id, '192.168.3.10');
    await lock.reconcile();
    const counters = (packets: number) =>
      kernel.counters.set('filter/pfms-lock-1234', [
        { target: 'RETURN', packets: 999, source: '0.0.0.0/0' },
        { target: 'RETURN', packets: 999, source: '10.12.34.0/24' },
        { target: 'RETURN', packets, source: '192.168.3.10' },
      ]);

    counters(5);
    now += 11 * 3600_000;
    await lock.poll();
    now += 11 * 3600_000;
    await lock.poll(); // no new packets, but within 12 h of the last
    expect(auth.allowedAddresses(1234)).toEqual(['192.168.3.10']);

    now += 2 * 3600_000;
    await lock.poll();
    expect(auth.allowedAddresses(1234)).toEqual([]);
    await lock.reconcile();
    expect(kernel.chains.get('filter/pfms-lock-1234')).toEqual(lockRules(1234, []));
  });

  test('removeAll takes every rule and chain', async () => {
    await lockedTeam();
    await lock.reconcile();
    await lock.removeAll();
    expect(kernel.jumps).toEqual([]);
    expect(kernel.chains.size).toBe(0);
  });
});
