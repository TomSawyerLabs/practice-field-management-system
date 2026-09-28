import { describe, expect, test } from 'bun:test';
import {
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

  test('battery: 12 V is the line, and a stale reading is unknown', () => {
    expect(evaluate({ battery: { at: NOW, volts: 12 } }).battery).toBe('ok');
    const low = evaluate({ battery: { at: NOW, volts: 11.94 } });
    expect(low.battery).toBe('bad');
    expect(low.batteryVoltage).toBe(11.9);
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
