import { describe, expect, test } from 'bun:test';
import { DriveSessions, DS_STALE_TIMEOUT_MS, type BlockRule, type DnatRule } from './driveSessions.js';
import type { StationName } from './types.js';

/** A field: radio config, kernel, route preferences and match engine, all
 *  in memory, with a clock the test moves. */
function field(radio: Partial<Record<StationName, string>> = {}) {
  let clock = 1_000_000;
  const dnat = new Map<string, number>(); // "slot|team|ip" → copies in the kernel
  const blocks = new Set<string>(); // "slot|ip"
  const routes = new Map<string, StationName>();
  const engine = new Map<StationName, string>();
  const calls = { addDnat: 0, removeDnat: 0 };
  const failRemove = { times: 0 };
  const log: string[] = [];
  const k = (r: DnatRule) => `${r.station}|${r.team}|${r.dsIp}`;

  const ds = new DriveSessions({
    robotOn: s => radio[s] ?? null,
    addDnat: async r => {
      calls.addDnat++;
      dnat.set(k(r), (dnat.get(k(r)) ?? 0) + 1);
    },
    removeDnat: async (r, copies) => {
      calls.removeDnat++;
      if (failRemove.times > 0) {
        failRemove.times--;
        throw new Error('iptables busy');
      }
      const left = (dnat.get(k(r)) ?? 0) - copies;
      if (left > 0) dnat.set(k(r), left);
      else dnat.delete(k(r));
    },
    addBlock: async r => void blocks.add(`${r.station}|${r.dsIp}`),
    removeBlock: async r => void blocks.delete(`${r.station}|${r.dsIp}`),
    routeOf: ip => routes.get(ip) ?? null,
    setRoute: async (ip, station) => void routes.set(ip, station),
    clearRoute: async ip => void routes.delete(ip),
    engineSetDs: (s, ip) => void engine.set(s, ip),
    engineClearDs: s => void engine.delete(s),
    changed: () => {},
    info: m => log.push(m),
    warn: m => log.push(m),
    error: m => log.push(m),
    now: () => clock,
  });

  return {
    ds,
    radio,
    dnat,
    blocks,
    routes,
    engine,
    calls,
    failRemove,
    log,
    /** Apply a radio change, the way Apply now does. */
    apply(change: Partial<Record<StationName, string | null>>) {
      for (const [s, ssid] of Object.entries(change) as [StationName, string | null][]) {
        if (ssid) radio[s] = ssid;
        else delete radio[s];
      }
      ds.configChanged();
    },
    advance(ms: number) {
      clock += ms;
    },
    /** Let the kernel sync finish. */
    settle: () => ds.sync(),
  };
}

// Laptop addresses on the guest Wi-Fi, from the 2026-09-27 journal.
const LAPTOP_840 = '10.55.48.12';
const LAPTOP_751 = '10.55.165.238';
const LAPTOP_4159 = '10.55.59.170';

describe('a laptop drives its team’s robot', () => {
  test('the first handshake starts driving: DNAT, route and match engine all point at it', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();
    expect([...f.dnat.keys()]).toEqual([`slot4|840|${LAPTOP_840}`]);
    expect(f.routes.get(LAPTOP_840)).toBe('slot4');
    expect(f.engine.get('slot4')).toBe(LAPTOP_840);
    expect(f.ds.sessionsByStation().slot4?.dsIp).toBe(LAPTOP_840);
  });

  test('a burst of handshakes installs one DNAT rule, not one per message', async () => {
    const f = field({ slot4: '840-FuriousG' });
    for (let i = 0; i < 5; i++) f.ds.heard(LAPTOP_840, 840);
    await f.settle();
    expect(f.calls.addDnat).toBe(1);
    expect(f.dnat.get(`slot4|840|${LAPTOP_840}`)).toBe(1);
  });

  test('a laptop with no robot on the field drives nothing', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_751, 751);
    await f.settle();
    expect(f.dnat.size).toBe(0);
    expect(f.ds.laptopOn('slot4')).toBeUndefined();
  });
});

describe('a slot changes hands (2026-09-27, slot4: 840 → 751)', () => {
  test('the new team’s only laptop drives, and is never called a duplicate', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();

    f.apply({ slot4: '751-robotRadio' });
    // 840's laptop is still on the guest Wi-Fi, handshaking every few seconds.
    f.ds.heard(LAPTOP_840, 840);
    f.ds.heard(LAPTOP_840);
    f.ds.heard(LAPTOP_751, 751);
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();

    expect(f.ds.laptopOn('slot4')).toBe(LAPTOP_751);
    expect(f.ds.blockedByStation()).toEqual({});
    expect(f.blocks.size).toBe(0);
    expect([...f.dnat.keys()]).toEqual([`slot4|751|${LAPTOP_751}`]);
    expect(f.engine.get('slot4')).toBe(LAPTOP_751);
    expect(f.routes.has(LAPTOP_840)).toBe(false);
    expect(f.routes.get(LAPTOP_751)).toBe('slot4');
    expect(f.log.some(l => l.startsWith('Blocked duplicate DS'))).toBe(false);
  });

  test('the new laptop handshaking before the old session is cleaned up still wins', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();

    f.radio.slot4 = '751-robotRadio'; // radio changed, listener not run yet
    f.ds.heard(LAPTOP_751, 751);
    f.ds.heard(LAPTOP_840);
    f.ds.configChanged();
    await f.settle();

    expect(f.ds.laptopOn('slot4')).toBe(LAPTOP_751);
    expect(f.engine.get('slot4')).toBe(LAPTOP_751);
    expect([...f.dnat.keys()]).toEqual([`slot4|751|${LAPTOP_751}`]);
  });

  test('a laptop that was waiting for its robot takes it the moment the change applies', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    f.ds.heard(LAPTOP_4159, 4159); // 4159 asked for the slot; held by the match
    await f.settle();

    f.apply({ slot4: '4159' });
    await f.settle();
    expect(f.ds.laptopOn('slot4')).toBe(LAPTOP_4159);
  });

  test('the slot’s old rule is removed before the new one goes in', async () => {
    const f = field({ slot1: '972-radio5' });
    f.ds.heard('10.55.153.222', 972);
    await f.settle();
    const order: string[] = [];
    f.log.length = 0;
    f.apply({ slot1: '751-robotRadio' });
    f.ds.heard(LAPTOP_751, 751);
    await f.settle();
    for (const l of f.log) if (l.startsWith('DNAT rule')) order.push(l.split(':')[0]);
    expect(order).toEqual(['DNAT rule removed', 'DNAT rule added']);
  });
});

describe('a robot moves to another slot', () => {
  test('keeps its laptop; the rules follow the robot', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();

    f.apply({ slot4: null, slot1: '840-FuriousG' });
    await f.settle();
    expect(f.ds.laptopOn('slot1')).toBe(LAPTOP_840);
    expect([...f.dnat.keys()]).toEqual([`slot1|840|${LAPTOP_840}`]);
    expect(f.engine.has('slot4')).toBe(false);
    expect(f.engine.get('slot1')).toBe(LAPTOP_840);
    expect(f.routes.get(LAPTOP_840)).toBe('slot1');
  });
});

describe('two laptops for one robot', () => {
  test('the second is blocked until the first goes quiet', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    f.ds.heard('10.55.1.1', 840);
    await f.settle();
    expect(f.ds.blockedByStation()).toEqual({ slot4: ['10.55.1.1'] });
    expect(f.blocks.has('slot4|10.55.1.1')).toBe(true);

    // The first laptop closes; the second keeps talking.
    f.advance(DS_STALE_TIMEOUT_MS / 2);
    f.ds.heard('10.55.1.1', 840);
    f.advance(DS_STALE_TIMEOUT_MS / 2 + 1);
    f.ds.heard('10.55.1.1', 840);
    f.ds.sweep();
    f.ds.heard('10.55.1.1', 840);
    await f.settle();
    expect(f.ds.laptopOn('slot4')).toBe('10.55.1.1');
    expect(f.blocks.size).toBe(0);
    expect([...f.dnat.keys()]).toEqual([`slot4|840|10.55.1.1`]);
  });

  test('a blocked laptop that disconnects is unblocked', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    f.ds.heard('10.55.1.1', 840);
    await f.settle();
    f.ds.disconnected('10.55.1.1');
    await f.settle();
    expect(f.blocks.size).toBe(0);
    expect(f.ds.laptopOn('slot4')).toBe(LAPTOP_840);
  });
});

describe('two robots of one team', () => {
  test('nothing is driven automatically; the Drive button picks', async () => {
    const f = field({ slot2: '1234-Comp', slot5: '1234-Practice' });
    f.ds.heard('10.55.2.2', 1234);
    await f.settle();
    expect(f.dnat.size).toBe(0);

    f.ds.drive('10.55.2.2', 'slot5');
    await f.settle();
    expect(f.ds.laptopOn('slot5')).toBe('10.55.2.2');
    expect(f.ds.stationDrivenBy('10.55.2.2', 1234)).toBe('slot5');

    f.ds.drive('10.55.2.2', 'slot2'); // switch robots
    await f.settle();
    expect(f.ds.laptopOn('slot5')).toBeUndefined();
    expect(f.ds.laptopOn('slot2')).toBe('10.55.2.2');
    expect([...f.dnat.keys()]).toEqual(['slot2|1234|10.55.2.2']);

    f.ds.drive('10.55.2.2', null);
    await f.settle();
    expect(f.dnat.size).toBe(0);
    expect(f.routes.size).toBe(0);
  });
});

describe('sessions end', () => {
  test('when the laptop goes quiet', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();
    f.advance(DS_STALE_TIMEOUT_MS + 1);
    f.ds.sweep();
    await f.settle();
    expect(f.ds.laptopOn('slot4')).toBeUndefined();
    expect(f.dnat.size).toBe(0);
    expect(f.engine.size).toBe(0);
  });

  test('when the laptop’s DS is switched to another team', async () => {
    const f = field({ slot4: '840-FuriousG', slot1: '751-robotRadio' });
    f.ds.heard(LAPTOP_840, 840);
    f.ds.heard(LAPTOP_840, 751);
    await f.settle();
    expect(f.ds.laptopOn('slot4')).toBeUndefined();
    expect(f.ds.laptopOn('slot1')).toBe(LAPTOP_840);
  });

  test('telemetry-only messages keep a session alive but never start one', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard('10.84.0.2'); // a robot-network device we never heard a team from
    await f.settle();
    expect(f.dnat.size).toBe(0);

    f.ds.heard(LAPTOP_840, 840);
    f.advance(DS_STALE_TIMEOUT_MS - 1);
    f.ds.heard(LAPTOP_840);
    f.advance(DS_STALE_TIMEOUT_MS - 1);
    f.ds.sweep();
    expect(f.ds.laptopOn('slot4')).toBe(LAPTOP_840);
  });
});

describe('the kernel is reconciled, not edited in place', () => {
  test('a failed removal is retried on the next sync', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();
    f.failRemove.times = 5; // fails on every pass until the kernel recovers
    f.apply({ slot4: null });
    await f.settle();
    expect(f.dnat.size).toBe(1); // still in the kernel
    f.failRemove.times = 0;
    f.ds.sweep();
    await f.settle();
    expect(f.dnat.size).toBe(0);
  });

  test('a route preference dropped behind our back is put back', async () => {
    const f = field({ slot4: '840-FuriousG' });
    f.ds.heard(LAPTOP_840, 840);
    await f.settle();
    f.routes.delete(LAPTOP_840);
    f.ds.sweep();
    await f.settle();
    expect(f.routes.get(LAPTOP_840)).toBe('slot4');
  });
});

describe('after a graceful restart', () => {
  test('a rule that still matches the robot on its slot becomes its session again', async () => {
    const f = field({ slot4: '840-FuriousG' });
    const rule: DnatRule = { station: 'slot4', team: 840, dsIp: LAPTOP_840 };
    f.dnat.set(`slot4|840|${LAPTOP_840}`, 1);
    f.routes.set(LAPTOP_840, 'slot4');
    f.ds.restore([rule], []);
    await f.settle();
    expect(f.ds.laptopOn('slot4')).toBe(LAPTOP_840);
    expect(f.calls.addDnat).toBe(0);
    expect(f.calls.removeDnat).toBe(0);
  });

  test('duplicate copies left by the old race are all removed once the robot has left', async () => {
    const f = field({ slot4: '751-robotRadio' });
    const rule: DnatRule = { station: 'slot4', team: 840, dsIp: LAPTOP_840 };
    f.dnat.set(`slot4|840|${LAPTOP_840}`, 4);
    f.ds.restore([rule, rule, rule, rule], []);
    await f.settle();
    expect(f.dnat.size).toBe(0);
    expect(f.ds.laptopOn('slot4')).toBeUndefined();
  });

  test('leftover duplicate-DS blocks are lifted', async () => {
    const f = field({ slot4: '4159' });
    const block: BlockRule = { station: 'slot4', dsIp: LAPTOP_4159 };
    f.blocks.add(`slot4|${LAPTOP_4159}`);
    f.ds.restore([], [block]);
    await f.settle();
    expect(f.blocks.size).toBe(0);
  });
});
