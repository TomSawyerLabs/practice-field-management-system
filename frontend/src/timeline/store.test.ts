import { describe, expect, test } from 'bun:test';
import type { RadioUpdate, StationDetails, StationName, StatusEntry, TelemetryUpdate } from '../../../src/types';
import { FieldTimeline } from './store';

const T = 1_700_000_000_000;

function details(over: Partial<StationDetails> = {}): StationDetails {
  return {
    ssid: '1967-Elsa',
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

function status(
  t: number,
  stations: Partial<Record<StationName, StationDetails | null>>,
  radioStatus: RadioUpdate['status'] = 'ACTIVE',
): StatusEntry {
  return {
    timestamp: t,
    radioUpdate: {
      channel: 5,
      channelBandwidth: '20MHz',
      redVlans: '10_20_30',
      blueVlans: '40_50_60',
      status: radioStatus,
      stationStatuses: { slot1: null, slot2: null, slot3: null, slot4: null, slot5: null, slot6: null, ...stations },
      syslogIpAddress: '10.0.100.40',
      version: 'test',
    },
  };
}

function telemetry(t: number, over: Partial<TelemetryUpdate> = {}): TelemetryUpdate {
  return { type: 'telemetry', station: 'slot1', timestamp: t, ...over };
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

const labels = (tl: FieldTimeline, station: StationName = 'slot1') =>
  tl.stations[station].events.inRange(0, Infinity, Infinity).map(e => e.label);

describe('radio status', () => {
  test('ten polls a second of an unchanged register are one step', () => {
    const tl = new FieldTimeline();
    for (let i = 0; i < 30; i++) tl.ingestStatus(status(T + i * 100, { slot1: details({ dataAgeMs: i }) }));
    tl.ingestStatus(status(T + 3_000, { slot1: details({ signalDbm: -60 }) }));
    const { signalDbm, dataAgeMs } = tl.stations.slot1.numeric;
    expect(signalDbm.length).toBe(2);
    expect(dataAgeMs.length).toBe(31);
    expect(signalDbm.sampleAt(T + 2_900)?.v).toBe(-52);
    expect(signalDbm.sampleAt(T + 3_000)?.v).toBe(-60);
  });

  test('link quality is a state, and losing the link ends the readings', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, { slot1: details() }));
    tl.ingestStatus(status(T + 1_000, { slot1: details({ connectionQuality: 'caution' }) }));
    tl.ingestStatus(status(T + 2_000, { slot1: details({ isLinked: false, connectionQuality: '' }) }));
    tl.ingestStatus(status(T + 5_000, { slot1: details({ connectionQuality: '' }) }));
    const { wifi, numeric } = tl.stations.slot1;
    expect(wifi.valueAt(T + 500)).toBe('excellent');
    expect(wifi.valueAt(T + 1_500)).toBe('caution');
    expect(wifi.valueAt(T + 3_000)).toBe('unlinked');
    expect(wifi.valueAt(T + 5_000)).toBe('linked');
    expect(numeric.signalDbm.sampleAt(T + 3_000)).toBeNull();
    expect(numeric.signalDbm.sampleAt(T + 5_500)?.v).toBe(-52);
    expect(labels(tl)).toEqual(['Wi-Fi dropped', 'Wi-Fi linked']);
  });

  test('packet counters become a rate between the reports that moved them', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, { slot1: details({ rxPackets: 1_000 }) }));
    tl.ingestStatus(status(T + 100, { slot1: details({ rxPackets: 1_000 }) }));
    tl.ingestStatus(status(T + 1_000, { slot1: details({ rxPackets: 1_050 }) }));
    tl.ingestStatus(status(T + 2_000, { slot1: details({ rxPackets: 10 }) })); // radio restarted
    tl.ingestStatus(status(T + 3_000, { slot1: details({ rxPackets: 110 }) }));
    const rate = tl.stations.slot1.numeric.rxPacketsPerSec;
    expect(rate.sampleAt(T + 1_500)?.v).toBe(50);
    expect(rate.sampleAt(T + 3_000)?.v).toBe(100);
    expect(rate.length).toBe(2);
  });

  test('a replayed history changes nothing', () => {
    const tl = new FieldTimeline();
    const history = [status(T + 1_000, { slot1: details({ signalDbm: -60 }) }), status(T, { slot1: details() })];
    tl.ingestHistory(history);
    const before = tl.stations.slot1.numeric.signalDbm.length;
    for (const entry of history) tl.ingestStatus(entry);
    tl.ingestHistory(history);
    expect(tl.stations.slot1.numeric.signalDbm.length).toBe(before);
    expect(before).toBe(2);
  });

  test('another robot taking the station starts a clean sheet; a blank in between does not', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, { slot1: details() }));
    tl.ingestTelemetry(telemetry(T + 100, { batteryVoltage: 12.5 }));
    tl.ingestStatus(status(T + 1_000, { slot1: null }, 'CONFIGURING'));
    tl.ingestStatus(status(T + 2_000, { slot1: details() }));
    expect(tl.stations.slot1.numeric.battery.length).toBe(1);
    tl.ingestStatus(status(T + 3_000, { slot1: details({ ssid: '254' }) }));
    expect(tl.stations.slot1.numeric.battery.length).toBe(0);
    expect(tl.stations.slot1.ssid).toBe('254');
  });

  test('a radio that stops answering leaves every link unknown', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, { slot1: details() }));
    tl.ingestStatus({ timestamp: T + 1_000 });
    expect(tl.stations.slot1.wifi.valueAt(T + 1_500)).toBeNull();
    expect(tl.field.inRange(T, T + 2_000, T + 2_000)[0]).toMatchObject({
      label: 'Field radio not answering',
      open: true,
    });
    tl.ingestStatus(status(T + 4_000, { slot1: details() }));
    expect(tl.field.inRange(T, T + 5_000, T + 5_000)[0]).toMatchObject({ end: T + 4_000, open: false });
  });
});

describe('telemetry', () => {
  test('battery keeps the sag between broadcasts', () => {
    const tl = new FieldTimeline();
    tl.ingestTelemetry(telemetry(T, { batteryVoltage: 12.4 }));
    tl.ingestTelemetry(telemetry(T + 250, { batteryVoltage: 12.2, batteryVoltageMin: 8.9 }));
    expect(tl.stations.slot1.numeric.battery.sampleAt(T + 250)).toEqual({
      t: T + 250,
      v: expect.closeTo(12.2, 5),
      lo: expect.closeTo(8.9, 5),
    });
  });

  test('enabling and disabling are moments; a mode change is only a flag', () => {
    const tl = new FieldTimeline();
    tl.ingestTelemetry(telemetry(T, { dsStatus: ds() }));
    tl.ingestTelemetry(telemetry(T + 1_000, { dsStatus: ds({ enabled: true, mode: 'auto' }) }));
    tl.ingestTelemetry(telemetry(T + 2_000, { dsStatus: ds({ enabled: true, mode: 'teleOp' }) }));
    tl.ingestTelemetry(telemetry(T + 3_000, { dsStatus: ds() }));
    const events = tl.stations.slot1.events.inRange(0, Infinity, Infinity);
    expect(events.map(e => [e.label, !!e.rule, e.t - T])).toEqual([
      ['Enabled', true, 1_000],
      ['Teleop', false, 2_000],
      ['Disabled', true, 3_000],
    ]);
    expect(tl.stations.slot1.robot.valueAt(T + 1_500)).toBe('auto');
  });

  test('a robot first seen already enabled raises no "Enabled"', () => {
    const tl = new FieldTimeline();
    tl.ingestTelemetry(telemetry(T, { dsStatus: ds({ enabled: true }) }));
    expect(labels(tl)).toEqual([]);
    expect(tl.stations.slot1.robot.valueAt(T)).toBe('teleop');
  });

  test('comms is how far the Driver Station reaches', () => {
    const tl = new FieldTimeline();
    tl.ingestTelemetry(telemetry(T, { dsStatus: ds() }));
    tl.ingestTelemetry(telemetry(T + 1_000, { dsStatus: ds({ robotComms: false }) }));
    tl.ingestTelemetry(telemetry(T + 2_000, { dsStatus: ds({ robotComms: false, rioPing: false }) }));
    tl.ingestTelemetry(telemetry(T + 3_000, { dsStatus: ds({ robotComms: false, rioPing: false, radioPing: false }) }));
    tl.ingestTelemetry(telemetry(T + 4_000, { dsStatus: ds() }));
    const { comms, robot } = tl.stations.slot1;
    expect([500, 1_500, 2_500, 3_500, 4_500].map(dt => comms.valueAt(T + dt))).toEqual([
      'robot',
      'rio',
      'radio',
      'none',
      'robot',
    ]);
    // What the robot is doing isn't known while it doesn't answer.
    expect(robot.valueAt(T + 1_500)).toBeNull();
    expect(labels(tl)).toEqual(['Comms lost', 'Comms back']);
  });

  test('an e-stop is known even with no robot answering', () => {
    const tl = new FieldTimeline();
    tl.ingestTelemetry(telemetry(T, { dsStatus: ds({ enabled: true }) }));
    tl.ingestTelemetry(telemetry(T + 500, { dsStatus: ds({ eStop: true, robotComms: false }) }));
    expect(tl.stations.slot1.robot.valueAt(T + 600)).toBe('estop');
    expect(labels(tl)).toEqual(['Comms lost', 'E-Stop']);
  });

  test('a brownout starting is flagged once', () => {
    const tl = new FieldTimeline();
    for (const [dt, brownout] of [
      [0, false],
      [250, true],
      [500, true],
      [750, false],
    ] as const) {
      tl.ingestTelemetry(telemetry(T + dt, { brownout }));
    }
    expect(labels(tl)).toEqual(['Brownout']);
    expect(tl.stations.slot1.brownout.segments(T, T + 1_000, T + 1_000).map(s => [s.start - T, s.value])).toEqual([
      [0, false],
      [250, true],
      [750, false],
    ]);
  });
});

describe('field events', () => {
  const reconfigure = (active: boolean, since?: number) =>
    ({
      type: 'radioReconfigure',
      active,
      since,
      expectedMs: 38_000,
      changes: active ? [{ station: 'slot2' as const, to: '254' }] : [],
    }) as const;

  test('a Wi-Fi update is one span from when it was sent to when it finished', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, {}));
    tl.ingestReconfigure(reconfigure(true, T + 1_000), T + 1_050);
    // The radio still says ACTIVE for a moment; that must not end it.
    tl.ingestStatus(status(T + 1_100, {}));
    tl.ingestStatus(status(T + 1_500, {}, 'CONFIGURING'));
    tl.ingestStatus(status(T + 39_000, {}));
    tl.ingestReconfigure(reconfigure(false), T + 39_200);
    const spans = tl.field.inRange(0, Infinity, Infinity);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ t: T + 1_000, end: T + 39_000, open: false, detail: '1 station change' });
  });

  test('one the server never announced still shows, from the radio status', () => {
    const tl = new FieldTimeline();
    tl.ingestStatus(status(T, {}));
    tl.ingestStatus(status(T + 1_000, {}, 'CONFIGURING'));
    expect(tl.field.inRange(0, Infinity, T + 2_000)[0]).toMatchObject({ t: T + 1_000, open: true });
    // …and the server's word, arriving late, replaces the guess.
    tl.ingestReconfigure(reconfigure(true, T + 800), T + 1_200);
    tl.ingestStatus(status(T + 30_000, {}));
    const spans = tl.field.inRange(0, Infinity, Infinity);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ t: T + 800, end: T + 30_000 });
  });

  test('match phases are stamped when they are first seen', () => {
    const tl = new FieldTimeline();
    tl.ingestMatchPhase('teleop', T); // already running when the page opened
    tl.ingestMatchPhase('teleop', T + 250);
    tl.ingestMatchPhase('endgame', T + 5_000);
    tl.ingestMatchPhase('postMatch', T + 9_000);
    tl.ingestMatchPhase('idle', T + 20_000);
    expect(tl.field.inRange(0, Infinity, Infinity).map(e => [e.label, e.t - T])).toEqual([
      ['Endgame', 5_000],
      ['Match over', 9_000],
    ]);
  });

  test('dropouts land on the comms lane, once each however often they are re-sent', () => {
    const tl = new FieldTimeline();
    const state = {
      type: 'robotDropouts' as const,
      stations: {
        slot1: {
          team: 1967,
          since: T,
          brownouts: { count: 1 },
          dropouts: [
            {
              kind: 'robot' as const,
              cause: 'brownout' as const,
              startedAt: T + 1_000,
              endedAt: T + 2_600,
              durationMs: 1_600,
              minBatteryVoltage: 6.61,
            },
          ],
        },
      },
    };
    tl.ingestDropouts(state);
    tl.ingestDropouts(state);
    expect(tl.stations.slot1.events.inRange(0, Infinity, Infinity)).toEqual([
      expect.objectContaining({
        lane: 'comms',
        t: T + 1_000,
        end: T + 2_600,
        label: 'Robot stopped answering',
        detail: '1.6 s during a brownout, battery down to 6.6 V',
      }),
    ]);
  });

  test('trim forgets what scrolled out of reach', () => {
    const tl = new FieldTimeline();
    tl.ingestTelemetry(telemetry(T, { batteryVoltage: 12 }));
    tl.ingestTelemetry(telemetry(T + 250, { batteryVoltage: 12 }));
    tl.ingestMatchPhase('auto', T);
    tl.ingestMatchPhase('teleop', T + 100);
    tl.trim(T + 11 * 60_000);
    expect(tl.stations.slot1.numeric.battery.length).toBe(1);
    expect(tl.field.length).toBe(0);
  });
});
