import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createTelemetryCoalescer } from './telemetryThrottle.js';
import type { TelemetryUpdate } from './types.js';

const T = 1_700_000_000_000;

const ds = (enabled: boolean) => ({
  eStop: false,
  aStop: false,
  robotComms: true,
  radioPing: true,
  rioPing: true,
  enabled,
  mode: 'teleOp' as const,
});

function update(batteryVoltage: number, over: Partial<TelemetryUpdate> = {}): TelemetryUpdate {
  return { type: 'telemetry', station: 'slot1', timestamp: Date.now(), batteryVoltage, ...over };
}

describe('createTelemetryCoalescer', () => {
  let sent: TelemetryUpdate[];
  let feed: (u: TelemetryUpdate) => void;

  beforeEach(() => {
    setSystemTime(new Date(T));
    sent = [];
    feed = createTelemetryCoalescer(u => sent.push(u), 250);
  });
  afterEach(() => setSystemTime());

  test('the first reading goes straight out, as it is', () => {
    feed(update(12.4));
    expect(sent).toEqual([expect.objectContaining({ batteryVoltage: 12.4 })]);
    expect(sent[0]).not.toHaveProperty('batteryVoltageMin');
    expect(sent[0]).not.toHaveProperty('batteryVoltageMax');
    expect(sent[0]).not.toHaveProperty('batteryVoltageAvg');
  });

  test('a window of readings goes out as its latest with the lowest, highest and mean', () => {
    feed(update(12.4));
    // 20 ms apart, as a robot sends them; a sag and a spike in between.
    for (const v of [12.0, 8.5, 11.0, 13.1, 12.2]) {
      setSystemTime(new Date(Date.now() + 20));
      feed(update(v));
    }
    expect(sent).toHaveLength(1);
    setSystemTime(new Date(T + 250));
    feed(update(12.3));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      batteryVoltage: 12.3,
      batteryVoltageMin: 8.5,
      batteryVoltageMax: 13.1,
      batteryVoltageAvg: 11.517,
    });
  });

  test('a steady voltage adds nothing but its mean', () => {
    feed(update(12.4));
    setSystemTime(new Date(T + 100));
    feed(update(12.4));
    setSystemTime(new Date(T + 250));
    feed(update(12.4));
    expect(sent[1]).toMatchObject({ batteryVoltage: 12.4, batteryVoltageAvg: 12.4 });
    expect(sent[1]).not.toHaveProperty('batteryVoltageMin');
    expect(sent[1]).not.toHaveProperty('batteryVoltageMax');
  });

  test('a status change flushes at once and still carries the window so far', () => {
    feed(update(12.4, { dsStatus: ds(false) }));
    setSystemTime(new Date(T + 40));
    feed(update(9.0, { dsStatus: ds(false) }));
    setSystemTime(new Date(T + 60));
    feed(update(11.5, { dsStatus: ds(true) }));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ batteryVoltage: 11.5, batteryVoltageMin: 9.0, batteryVoltageAvg: 10.25 });
    expect(sent[1].dsStatus?.enabled).toBe(true);
    // The next window starts clean.
    setSystemTime(new Date(T + 320));
    feed(update(12.0, { dsStatus: ds(true) }));
    expect(sent[2]).not.toHaveProperty('batteryVoltageMin');
  });

  test('each station keeps its own window', () => {
    feed(update(12.4));
    feed({ ...update(7.0), station: 'slot2' });
    setSystemTime(new Date(T + 100));
    feed(update(12.0));
    setSystemTime(new Date(T + 250));
    feed(update(12.2));
    expect(sent[2]).toMatchObject({ station: 'slot1', batteryVoltageMin: 12.0 });
  });
});
