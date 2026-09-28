import { describe, expect, test } from 'bun:test';
import {
  batteryCheckLevel,
  CHECK_FRESH_MS,
  evaluateStationChecks,
  StationChecksTracker,
  type StationCheckInputs,
} from './stationChecks.js';
import type { MatchState, RadioUpdate, StationControlState } from './types.js';

const NOW = 1_000_000;

/** A robot that has passed every check. */
function allGreen(over: Partial<StationCheckInputs> = {}): StationCheckInputs {
  return {
    team: 5940,
    alliance: 'red',
    joined: true,
    ready: true,
    readyRequested: true,
    dsAttached: true,
    dsConnected: true,
    radioLinked: true,
    captureActive: true,
    dsStatus: { at: NOW, robotComms: true },
    robotPacketAt: NOW,
    joysticks: { at: NOW, count: 2 },
    battery: { at: NOW, volts: 12.63 },
    ...over,
  };
}

const evaluate = (over: Partial<StationCheckInputs>) => evaluateStationChecks('slot1', allGreen(over), NOW)!;

describe('evaluateStationChecks', () => {
  test('an empty station has no column', () => {
    expect(evaluateStationChecks('slot1', allGreen({ team: null }), NOW)).toBeNull();
  });

  test('a fully set-up robot is green across the board', () => {
    expect(evaluate({})).toEqual({
      station: 'slot1',
      team: 5940,
      alliance: 'red',
      ds: 'ok',
      radio: 'ok',
      robotComms: 'ok',
      joysticks: 'ok',
      joystickCount: 2,
      battery: 'ok',
      batteryVoltage: 12.6,
      ready: 'ok',
    });
  });

  test('DS link: status heartbeats are full, a TCP-only link is partial', () => {
    expect(evaluate({ dsAttached: true }).ds).toBe('ok');
    expect(evaluate({ dsAttached: false, dsConnected: true }).ds).toBe('partial');
    expect(evaluate({ dsAttached: false, dsConnected: false }).ds).toBe('bad');
  });

  test('radio link is unknown without a current radio status', () => {
    expect(evaluate({ radioLinked: false }).radio).toBe('bad');
    expect(evaluate({ radioLinked: null }).radio).toBe('unknown');
  });

  test("robot comms: the DS's own report wins over sniffed robot packets", () => {
    expect(evaluate({ dsStatus: { at: NOW, robotComms: false }, robotPacketAt: NOW }).robotComms).toBe('bad');
  });

  test('robot comms: robot replies prove comms when the DS sends no status', () => {
    expect(evaluate({ dsStatus: undefined, robotPacketAt: NOW - 500 }).robotComms).toBe('ok');
  });

  test('robot comms: silence is a failure only when pFMS would have seen the robot', () => {
    const silent = { dsStatus: undefined, robotPacketAt: undefined };
    expect(evaluate({ ...silent, captureActive: true }).robotComms).toBe('bad');
    expect(evaluate({ ...silent, captureActive: false, radioLinked: false }).robotComms).toBe('bad');
    expect(evaluate({ ...silent, captureActive: false, radioLinked: true }).robotComms).toBe('unknown');
  });

  test('robot comms: a stale DS report falls back to robot packets', () => {
    const stale = NOW - CHECK_FRESH_MS.dsStatus - 1;
    expect(evaluate({ dsStatus: { at: stale, robotComms: false }, robotPacketAt: NOW }).robotComms).toBe('ok');
  });

  test('joysticks: unknown unless DS→robot packets were seen', () => {
    expect(evaluate({ joysticks: { at: NOW, count: 0 } }).joysticks).toBe('bad');
    const none = evaluate({ joysticks: undefined });
    expect(none.joysticks).toBe('unknown');
    expect(none.joystickCount).toBeUndefined();
    const stale = evaluate({ joysticks: { at: NOW - CHECK_FRESH_MS.joysticks - 1, count: 3 } });
    expect(stale.joysticks).toBe('unknown');
  });

  test('battery: green from 12.2 V, yellow down to 11.8 V, red below; a stale reading is unknown', () => {
    expect(evaluate({ battery: { at: NOW, volts: 12.2 } }).battery).toBe('ok');
    expect(evaluate({ battery: { at: NOW, volts: 12.0 } }).battery).toBe('partial');
    const low = evaluate({ battery: { at: NOW, volts: 11.74 } });
    expect(low.battery).toBe('bad');
    expect(low.batteryVoltage).toBe(11.7);
    const stale = evaluate({ battery: { at: NOW - CHECK_FRESH_MS.battery - 1, volts: 12.5 } });
    expect(stale.battery).toBe('unknown');
    expect(stale.batteryVoltage).toBeUndefined();
  });

  test('ready waits for the ready check and for the station to join', () => {
    expect(evaluate({ readyRequested: false, ready: false }).ready).toBe('waiting');
    expect(evaluate({ joined: false, ready: false }).ready).toBe('waiting');
    expect(evaluate({ ready: false }).ready).toBe('bad');
  });
});

describe('batteryCheckLevel', () => {
  test('without a previous verdict the lines are exact', () => {
    expect(batteryCheckLevel(12.2, undefined)).toBe('ok');
    expect(batteryCheckLevel(12.19, 'unknown')).toBe('partial');
    expect(batteryCheckLevel(11.8, undefined)).toBe('partial');
    expect(batteryCheckLevel(11.79, undefined)).toBe('bad');
  });

  test('a reading hovering on a line keeps its colour', () => {
    // Resting just either side of 12.2 V
    for (const volts of [12.18, 12.22, 12.16, 12.24]) {
      expect(batteryCheckLevel(volts, 'ok')).toBe('ok');
      expect(batteryCheckLevel(volts, 'partial')).toBe('partial');
    }
    // ...and of 11.8 V
    for (const volts of [11.78, 11.82, 11.76, 11.84]) {
      expect(batteryCheckLevel(volts, 'partial')).toBe('partial');
      expect(batteryCheckLevel(volts, 'bad')).toBe('bad');
    }
  });

  test('a real move across a line changes colour', () => {
    expect(batteryCheckLevel(12.14, 'ok')).toBe('partial');
    expect(batteryCheckLevel(12.26, 'partial')).toBe('ok');
    expect(batteryCheckLevel(11.74, 'partial')).toBe('bad');
    expect(batteryCheckLevel(11.86, 'bad')).toBe('partial');
    // A big jump skips the middle band
    expect(batteryCheckLevel(12.6, 'bad')).toBe('ok');
    expect(batteryCheckLevel(11.2, 'ok')).toBe('bad');
  });
});

describe('StationChecksTracker', () => {
  function control(over: Partial<StationControlState>): StationControlState {
    return {
      teamNumber: null,
      enabled: false,
      eStop: false,
      aStop: false,
      mode: 'teleOp',
      joined: false,
      ready: false,
      alliance: null,
      matchSlot: null,
      disabledBy: null,
      ...over,
    };
  }

  function tracker(state: Pick<MatchState, 'stationStates' | 'connectedStations' | 'readyRequested'>, capture = true) {
    return new StationChecksTracker({ getMatchState: () => state, captureActive: () => capture });
  }

  const radioUpdate = (linked: boolean) =>
    ({ stationStatuses: { slot2: { isLinked: linked } } }) as unknown as RadioUpdate;

  test('only stations with a robot get a column', () => {
    const t = tracker({
      stationStates: { slot1: control({}), slot2: control({ teamNumber: 254 }) },
      connectedStations: {},
      readyRequested: false,
    });
    expect(Object.keys(t.snapshot(NOW).stations)).toEqual(['slot2']);
  });

  test('combines match state, radio status and observations', () => {
    const t = tracker({
      stationStates: { slot2: control({ teamNumber: 254, joined: true, alliance: 'blue', dsAttached: false }) },
      connectedStations: { slot2: { ip: '10.55.0.9', lastSeen: NOW } },
      readyRequested: true,
    });
    t.noteRadioUpdate(radioUpdate(true), NOW);
    t.noteRobotPacket('slot2', 12.4, NOW);
    t.noteJoysticks('slot2', 1, NOW);
    expect(t.snapshot(NOW).stations.slot2).toEqual({
      station: 'slot2',
      team: 254,
      alliance: 'blue',
      ds: 'partial',
      radio: 'ok',
      robotComms: 'ok',
      joysticks: 'ok',
      joystickCount: 1,
      battery: 'ok',
      batteryVoltage: 12.4,
      ready: 'bad',
    });
  });

  test('a stale radio status reads unknown, not unlinked', () => {
    const t = tracker({
      stationStates: { slot2: control({ teamNumber: 254 }) },
      connectedStations: {},
      readyRequested: false,
    });
    t.noteRadioUpdate(radioUpdate(true), NOW - CHECK_FRESH_MS.radio - 1);
    expect(t.snapshot(NOW).stations.slot2?.radio).toBe('unknown');
  });

  test('carries the battery verdict between snapshots so it does not flap', () => {
    const t = tracker({
      stationStates: { slot2: control({ teamNumber: 254 }) },
      connectedStations: {},
      readyRequested: false,
    });
    const levels = [12.25, 12.18, 12.22, 12.16, 12.14, 12.18, 12.22].map((volts, i) => {
      t.noteRobotPacket('slot2', volts, NOW + i * 500);
      return t.snapshot(NOW + i * 500).stations.slot2?.battery;
    });
    expect(levels).toEqual(['ok', 'ok', 'ok', 'ok', 'partial', 'partial', 'partial']);
  });

  test("ignores the DS's battery voltage while it has no robot comms", () => {
    const t = tracker({
      stationStates: { slot2: control({ teamNumber: 254 }) },
      connectedStations: {},
      readyRequested: false,
    });
    t.noteDsStatus('slot2', false, 0.5, NOW);
    expect(t.snapshot(NOW).stations.slot2?.battery).toBe('unknown');
    t.noteDsStatus('slot2', true, 12.2, NOW);
    expect(t.snapshot(NOW).stations.slot2?.batteryVoltage).toBe(12.2);
  });
});
