import { describe, expect, test } from 'bun:test';
import { LINK_GRACE_MS, RobotLinkWatch } from './robotLinkWatch.js';
import type { StationName } from './types.js';

const DS = '10.55.132.86';
const GW = '10.8.40.254';
const RIO = '10.8.40.2';

/** A watch over one station, with a clock the test moves and the log it wrote. */
function field() {
  let clock = 1_000_000;
  const laptops = new Map<StationName, string>([['slot2', DS]]);
  const legacy = new Set([DS]);
  const log: string[] = [];
  const watch = new RobotLinkWatch({
    laptopOn: s => laptops.get(s),
    isLegacyDs: ip => legacy.has(ip),
    capturing: () => true,
    info: m => log.push(`info: ${m}`),
    warn: m => log.push(`warn: ${m}`),
    now: () => clock,
  });
  /** One second of traffic: what the laptop sends, and whether the robot
   *  answers and its answers reach the laptop. */
  const traffic = (opts: { to?: string; answer?: boolean; deliver?: boolean } = {}) => {
    const { to = RIO, answer = true, deliver = true } = opts;
    for (let i = 0; i < 50; i++) {
      clock += 20;
      watch.hop({ station: 'slot2', kind: 'control', src: DS, dst: to, at: clock });
      watch.hop({ station: 'slot2', kind: 'control', src: GW, dst: to, at: clock });
      if (!answer) continue;
      watch.hop({ station: 'slot2', kind: 'reply', src: to, dst: GW, at: clock });
      if (deliver) watch.hop({ station: 'slot2', kind: 'reply', src: to, dst: DS, at: clock });
    }
  };
  const wait = (ms: number) => (clock += ms);
  return { watch, log, laptops, legacy, traffic, wait };
}

describe('RobotLinkWatch', () => {
  test('a working link logs one line when it comes up', () => {
    const f = field();
    f.watch.check(); // starts watching the session
    f.traffic();
    f.watch.check();
    f.traffic();
    f.watch.check();
    expect(f.log).toEqual([`info: Robot link up for ${DS} on slot2 after 1s: DS → ${RIO}`]);
  });

  test('a new session gets a grace period before it is called down', () => {
    const f = field();
    f.watch.check();
    f.wait(LINK_GRACE_MS - 1_000);
    f.watch.check();
    expect(f.log).toEqual([]);
    f.wait(2_000);
    f.watch.check();
    expect(f.log).toEqual([
      `warn: Robot link down for ${DS} on slot2: the DS sends the robot nothing (no control packets from the laptop)`,
    ]);
  });

  test('a DS sending to an address no robot answers from names that address', () => {
    const f = field();
    f.watch.check();
    f.wait(LINK_GRACE_MS);
    f.traffic({ to: '10.8.40.200', answer: false });
    f.watch.check();
    expect(f.log).toEqual([
      `warn: Robot link down for ${DS} on slot2: the DS sends to 10.8.40.200, but no robot answers`,
    ]);
  });

  test('replies that reach the gateway but not the laptop point at forwarding', () => {
    const f = field();
    f.watch.check();
    f.wait(LINK_GRACE_MS);
    f.traffic({ deliver: false });
    f.watch.check();
    expect(f.log).toEqual([
      `warn: Robot link down for ${DS} on slot2: the robot answers from ${RIO}, but its replies aren't reaching the laptop`,
    ]);
  });

  test('a link that comes back says how long it was down, and repeats nothing', () => {
    const f = field();
    f.watch.check();
    f.wait(LINK_GRACE_MS);
    f.watch.check(); // down: DS silent
    f.wait(5_000);
    f.watch.check(); // still down: no new line
    f.wait(5_000);
    f.traffic(); // e.g. after a DS restart
    f.watch.check();
    expect(f.log).toHaveLength(2);
    expect(f.log[1]).toBe(`info: Robot link back for ${DS} on slot2 after 11s: DS → ${RIO}`);
  });

  test('a new laptop on the station is watched from scratch', () => {
    const f = field();
    f.watch.check();
    f.traffic();
    f.watch.check();
    const other = '10.55.65.16';
    f.laptops.set('slot2', other);
    f.legacy.add(other);
    f.watch.check();
    f.wait(LINK_GRACE_MS + 1_000);
    f.watch.check();
    expect(f.log.at(-1)).toBe(
      `warn: Robot link down for ${other} on slot2: the DS sends the robot nothing (no control packets from the laptop)`,
    );
  });

  test('a 2027 DS is not judged: its replies are not on the captured port', () => {
    const f = field();
    f.legacy.delete(DS);
    f.watch.check();
    f.wait(LINK_GRACE_MS + 1_000);
    f.watch.check();
    expect(f.log).toEqual([]);
  });
});
