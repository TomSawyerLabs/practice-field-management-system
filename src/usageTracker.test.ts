import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type RadioManager from './radioManager.js';
import type { StationName, StatusEntry } from './types.js';
import { UsageTracker } from './usageTracker.js';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

/** A radio with one robot of team 1234 on slot1. */
function fakeRadio() {
  let listener: (entry: StatusEntry) => void = () => {};
  const manager = {
    getTeamForStation: (station: StationName) => (station === 'slot1' ? 1234 : null),
    addStatusListener: (fn: (entry: StatusEntry) => void) => (listener = fn),
    addConfigChangeListener: () => {},
  } as unknown as RadioManager;
  const report = (timestamp: number, isLinked: boolean) =>
    listener({ timestamp, radioUpdate: { stationStatuses: { slot1: { isLinked } } } } as unknown as StatusEntry);
  return { manager, report };
}

describe('UsageTracker', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a linked robot is on the field until its link drops', () => {
    const tracker = new UsageTracker(join(dir, 'usage.json'));
    const { manager, report } = fakeRadio();
    tracker.attach(manager);

    report(T0, true);
    report(T0 + 5 * MINUTE, true);
    report(T0 + 10 * MINUTE, false);
    report(T0 + 60 * MINUTE, false);

    expect(tracker.getState().sessions).toMatchObject([{ team: 1234, startedAt: T0, lastSeenAt: T0 + 10 * MINUTE }]);
  });

  test('a parked robot adds nothing, however long it stays linked', () => {
    const tracker = new UsageTracker(join(dir, 'usage.json'));
    const { manager, report } = fakeRadio();
    tracker.attach(manager, () => true);

    report(T0, true);
    report(T0 + 8 * 60 * MINUTE, true);

    expect(tracker.getState().sessions).toEqual([]);
  });

  test('hours stop when a robot is parked and resume when it is driven again', () => {
    const tracker = new UsageTracker(join(dir, 'usage.json'));
    const { manager, report } = fakeRadio();
    let parked = false;
    tracker.attach(manager, (team, station) => {
      expect([team, station]).toEqual([1234, 'slot1']);
      return parked;
    });

    report(T0, true);
    report(T0 + 10 * MINUTE, true);
    parked = true;
    report(T0 + 20 * MINUTE, true);
    report(T0 + 90 * MINUTE, true);
    expect(tracker.getState().sessions[0].lastSeenAt).toBe(T0 + 20 * MINUTE);

    parked = false;
    report(T0 + 100 * MINUTE, true);
    expect(tracker.getState().sessions).toHaveLength(1);
    expect(tracker.getState().sessions[0].lastSeenAt).toBe(T0 + 100 * MINUTE);
  });
});
