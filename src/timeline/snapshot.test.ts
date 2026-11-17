import { describe, expect, test } from 'bun:test';
import type { StationDetails, StationName, StatusEntry, TelemetryUpdate } from '../types.js';
import { filterForTeams } from '../topicSubscriptions.js';
import { EventSeries, NumericSeries, StateSeries } from './series.js';
import { FieldTimeline, isTimelineSnapshot } from './store.js';

const T = 1_700_000_000_000;

function details(ssid: string, over: Partial<StationDetails> = {}): StationDetails {
  return {
    ssid,
    hashedWpaKey: '',
    wpaKeySalt: '',
    isLinked: true,
    macAddress: '',
    dataAgeMs: 12,
    signalDbm: -52,
    noiseDbm: -95,
    signalNoiseRatio: 43,
    rxRateMbps: 144,
    rxPackets: 1_000,
    rxBytes: 0,
    txRateMbps: 130,
    txPackets: 2_000,
    txBytes: 0,
    bandwidthUsedMbps: 1.2,
    connectionQuality: 'excellent',
    ...over,
  };
}

function status(t: number, stations: Partial<Record<StationName, StationDetails | null>>): StatusEntry {
  return {
    timestamp: t,
    radioUpdate: {
      channel: 5,
      channelBandwidth: '20MHz',
      redVlans: '10_20_30',
      blueVlans: '40_50_60',
      status: 'ACTIVE',
      stationStatuses: { slot1: null, slot2: null, slot3: null, slot4: null, slot5: null, slot6: null, ...stations },
      syslogIpAddress: '10.0.100.40',
      version: 'test',
    },
  };
}

const ds = (over: Partial<NonNullable<TelemetryUpdate['dsStatus']>> = {}) => ({
  eStop: false,
  aStop: false,
  robotComms: true,
  radioPing: true,
  rioPing: true,
  enabled: false,
  mode: 'teleOp' as const,
  ...over,
});

function telemetry(station: StationName, t: number, over: Partial<TelemetryUpdate> = {}): TelemetryUpdate {
  return { type: 'telemetry', station, timestamp: t, ...over };
}

/** A server's worth of history: two robots of 1967, one of 254. */
function server(): FieldTimeline {
  const tl = new FieldTimeline();
  const stations = { slot1: details('1967-Elsa'), slot2: details('1967-Lupe'), slot4: details('254') };
  for (let i = 0; i < 40; i++) {
    const t = T + i * 250;
    if (i % 4 === 0) tl.ingestMessage(status(t, stations), t);
    for (const station of ['slot1', 'slot2', 'slot4'] as const) {
      const enabled = station === 'slot1' && i >= 20;
      tl.ingestMessage(
        telemetry(station, t, {
          batteryVoltage: 12.3,
          batteryVoltageMin: enabled ? 9.1 : undefined,
          batteryVoltageMax: enabled ? 12.6 : undefined,
          batteryVoltageAvg: enabled ? 11.8 : undefined,
          dsStatus: ds({ enabled }),
        }),
        t,
      );
    }
  }
  return tl;
}

describe('dump and load', () => {
  test('a numeric series comes back the same, gaps and spread included', () => {
    const a = new NumericSeries({ mode: 'linear', staleAfterMs: 1_500 });
    a.push(T, 12.4);
    a.push(T + 250, 11.8, 9.1, 12.6);
    a.gap(T + 500);
    a.push(T + 750, 12.3);
    const wire = JSON.parse(JSON.stringify(a.dump()));
    // Times travel as the first one and then the gaps between them.
    expect(wire.t).toEqual([T, 250, 250, 250]);
    expect(wire.v).toEqual([12.4, 11.8, null, 12.3]);

    const b = new NumericSeries({ mode: 'linear', staleAfterMs: 1_500 });
    b.push(T - 5_000, 1); // replaced, not merged
    b.load(wire);
    expect(b.length).toBe(4);
    expect(b.sampleAt(T + 300)).toEqual({
      t: T + 250,
      v: expect.closeTo(11.8, 5),
      lo: expect.closeTo(9.1, 5),
      hi: expect.closeTo(12.6, 5),
    });
    expect(b.sampleAt(T + 600)).toBeNull();
    expect(b.seenAt).toBe(T + 750);
    // …and carries on from where the dump ended.
    b.push(T + 700, 99);
    expect(b.length).toBe(4);
    b.push(T + 1_000, 12.2);
    expect(b.length).toBe(5);
  });

  test('a series with no spread leaves lo and hi off the wire', () => {
    const a = new NumericSeries({ mode: 'hold', staleAfterMs: 20_000 });
    a.push(T, -52);
    a.push(T + 1_000, -55);
    expect(Object.keys(a.dump()).sort()).toEqual(['seen', 't', 'v']);
  });

  test('a state series keeps its unknown stretches and when it was last heard', () => {
    const a = new StateSeries<'robot' | 'none'>({ staleAfterMs: 3_000 });
    a.set(T, 'robot');
    a.set(T + 10_000, 'none');
    a.set(T + 11_000, 'none');
    const b = new StateSeries<'robot' | 'none'>({ staleAfterMs: 3_000 });
    b.load(JSON.parse(JSON.stringify(a.dump())));
    expect(b.valueAt(T + 1_000)).toBe('robot');
    expect(b.valueAt(T + 5_000)).toBeNull();
    expect(b.valueAt(T + 12_000)).toBe('none');
    expect(b.seenAt).toBe(T + 11_000);
    // The same report again is still not a change.
    expect(b.set(T + 11_500, 'none')).toBeUndefined();
  });

  test('events come back by id, so one sent twice is still one', () => {
    const a = new EventSeries();
    a.upsert({ id: 'x', t: T, label: 'Enabled', tone: 'good', rule: true });
    const b = new EventSeries();
    b.load(a.dump());
    b.upsert({ id: 'x', t: T, label: 'Enabled', tone: 'good', rule: true });
    expect(b.length).toBe(1);
  });
});

describe('the server keeps a copy from what it broadcasts', () => {
  test('only the messages a chart is made of are taken in', () => {
    const tl = new FieldTimeline();
    tl.ingestMessage({ type: 'serverInfo', now: T }, T);
    tl.ingestMessage({ type: 'networkStats', timestamp: T }, T);
    tl.ingestMessage(null, T);
    tl.ingestMessage('hello', T);
    expect(tl.snapshot(T).stations).toEqual({});

    tl.ingestMessage(status(T, { slot1: details('1967-Elsa') }), T);
    tl.ingestMessage(telemetry('slot1', T, { batteryVoltage: 12.4 }), T);
    tl.ingestMessage(
      { type: 'radioReconfigure', active: true, since: T + 100, expectedMs: 38_000, changes: [] },
      T + 100,
    );
    const snap = tl.snapshot(T + 200);
    expect(isTimelineSnapshot(snap)).toBe(true);
    expect(Object.keys(snap.stations)).toEqual(['slot1']);
    expect(snap.stations.slot1!.numeric.battery!.v).toEqual([12.4]);
    expect(snap.field).toEqual([expect.objectContaining({ label: 'Field Wi-Fi update', open: true })]);
  });

  test('the battery line is the average of the window, the band its extremes', () => {
    const tl = server();
    expect(tl.stations.slot1.numeric.battery.sampleAt(T + 9_750)).toEqual({
      t: T + 9_750,
      v: expect.closeTo(11.8, 5),
      lo: expect.closeTo(9.1, 5),
      hi: expect.closeTo(12.6, 5),
    });
    // With one reading in the window it is just that reading.
    expect(tl.stations.slot2.numeric.battery.sampleAt(T + 9_750)).toMatchObject({
      v: expect.closeTo(12.3, 5),
      lo: expect.closeTo(12.3, 5),
    });
  });

  test('a team is sent only its own stations, and the field events', () => {
    const snap = server().snapshot(T + 10_000);
    expect(Object.keys(snap.stations)).toEqual(['slot1', 'slot2', 'slot4']);
    expect(Object.keys(filterForTeams('timeline', snap, [1967]).stations)).toEqual(['slot1', 'slot2']);
    expect(Object.keys(filterForTeams('timeline', snap, [254]).stations)).toEqual(['slot4']);
    expect(Object.keys(filterForTeams('timeline', snap, [9999]).stations)).toEqual([]);
    expect(Object.keys(filterForTeams('timeline', snap, null).stations)).toHaveLength(3);
    expect(filterForTeams('timeline', snap, [254]).field).toBe(snap.field);
  });
});

describe('a page catching up from the snapshot', () => {
  test('it has what the server had, and no event twice', () => {
    const snap = JSON.parse(JSON.stringify(filterForTeams('timeline', server().snapshot(T + 10_000), [1967])));

    // The page opened a moment ago and has only heard the last second.
    const page = new FieldTimeline();
    page.ingestTelemetry(telemetry('slot1', T + 9_750, { batteryVoltage: 12.3, dsStatus: ds({ enabled: true }) }));
    page.ingestTelemetry(telemetry('slot4', T + 9_750, { batteryVoltage: 12.3, dsStatus: ds() }));
    page.hydrate(snap);

    const elsa = page.stations.slot1;
    expect(elsa.ssid).toBe('1967-Elsa');
    expect(elsa.numeric.battery.length).toBe(40);
    expect(elsa.wifi.valueAt(T + 5_000)).toBe('excellent');
    expect(elsa.robot.valueAt(T + 2_000)).toBe('disabled');
    expect(elsa.events.dump().map(e => [e.label, e.t - T])).toEqual([['Enabled', 5_000]]);
    // Another team's station is left as the page had it.
    expect(page.stations.slot4.numeric.battery.length).toBe(1);

    // Live messages carry on: older ones are already in, a repeat of the
    // current state raises nothing, a real change does.
    page.ingestStatus(status(T + 9_000, { slot1: details('1967-Elsa', { signalDbm: -80 }) }));
    expect(elsa.numeric.signalDbm.sampleAt(T + 9_900)?.v).toBe(-52);
    page.ingestTelemetry(telemetry('slot1', T + 10_000, { batteryVoltage: 12.2, dsStatus: ds({ enabled: true }) }));
    expect(elsa.numeric.battery.length).toBe(41);
    expect(elsa.events.length).toBe(1);
    page.ingestTelemetry(telemetry('slot1', T + 10_250, { batteryVoltage: 12.5, dsStatus: ds() }));
    expect(elsa.events.dump().map(e => e.label)).toEqual(['Enabled', 'Disabled']);
  });

  test('a Wi-Fi update running when the snapshot was taken is closed by the page', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, { slot1: details('1967-Elsa') }));
    tl.ingestReconfigure(
      { type: 'radioReconfigure', active: true, since: T + 1_000, expectedMs: 38_000, changes: [] },
      T + 1_000,
    );
    const page = new FieldTimeline();
    page.hydrate(JSON.parse(JSON.stringify(tl.snapshot(T + 5_000))));
    page.ingestReconfigure({ type: 'radioReconfigure', active: false, expectedMs: 38_000, changes: [] }, T + 39_000);
    expect(page.field.dump()).toEqual([expect.objectContaining({ t: T + 1_000, end: T + 39_000, open: false })]);
  });

  test('a second snapshot (a reconnect) replaces the first', () => {
    const tl = server();
    const page = new FieldTimeline();
    page.hydrate(JSON.parse(JSON.stringify(tl.snapshot(T + 10_000))));
    tl.ingestMessage(
      telemetry('slot1', T + 10_000, { batteryVoltage: 12.1, dsStatus: ds({ enabled: true }) }),
      T + 10_000,
    );
    page.hydrate(JSON.parse(JSON.stringify(tl.snapshot(T + 10_100))));
    expect(page.stations.slot1.numeric.battery.length).toBe(41);
    expect(page.stations.slot1.events.length).toBe(1);
  });
});
