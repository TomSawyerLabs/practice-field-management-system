import { describe, expect, test } from 'bun:test';
import { AutoConnectBatch } from './autoConnectBatch.js';
import type { SavedRobot } from './robotWifiScan.js';

const comp: SavedRobot = { ssid: '1234-Comp', wpaKey: 'passphrase1' };
const other: SavedRobot = { ssid: '5678', wpaKey: 'passphrase2' };

function harness(checking: string[] = []) {
  let t = 0;
  let timer: { fn: () => void; at: number } | null = null;
  const applied: string[][] = [];
  const batch = new AutoConnectBatch({
    stillChecking: () => checking,
    apply: robots => applied.push(robots.map(r => r.ssid)),
    onChange: () => {},
    now: () => t,
    setTimer: (fn, ms) => (timer = { fn, at: t + ms }),
    clearTimer: () => (timer = null),
  });
  /** Move the clock on, firing the timer when it comes due */
  const advance = (ms: number) => {
    const end = t + ms;
    while (timer && timer.at <= end) {
      const due = timer;
      timer = null;
      t = due.at;
      due.fn();
    }
    t = end;
  };
  return { batch, applied, advance, checking };
}

describe('robots connecting by themselves', () => {
  test('wait 5 seconds, counted down, then go on together', () => {
    const { batch, applied, advance } = harness();
    batch.add(comp);
    expect(batch.upcoming()).toEqual({ at: 5_000, robots: ['1234-Comp'], waitingFor: [] });
    advance(2_000);
    batch.add(other); // joins, doesn't restart the countdown
    expect(batch.upcoming()?.at).toBe(5_000);
    advance(3_000);
    expect(applied).toEqual([['1234-Comp', '5678']]);
    expect(batch.upcoming()).toBeUndefined();
  });

  test('wait longer while another robot heard is still being checked', () => {
    const { batch, applied, advance, checking } = harness(['9999-B']);
    batch.add(comp);
    advance(5_000);
    expect(applied).toEqual([]);
    expect(batch.upcoming()).toEqual({ at: 10_000, robots: ['1234-Comp'], waitingFor: ['9999-B'] });
    checking.length = 0;
    advance(5_000);
    expect(applied).toEqual([['1234-Comp']]);
  });

  test('but not forever', () => {
    const { batch, applied, advance } = harness(['9999-B']);
    batch.add(comp);
    advance(59_999);
    expect(applied).toEqual([]);
    advance(1);
    expect(applied).toEqual([['1234-Comp']]);
  });

  test('a robot already gathered is not waited for', () => {
    const { batch, applied, advance } = harness(['1234-Comp']);
    batch.add(comp);
    advance(5_000);
    expect(applied).toEqual([['1234-Comp']]);
  });
});
