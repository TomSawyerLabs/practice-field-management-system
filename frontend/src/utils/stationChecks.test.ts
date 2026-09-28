import { describe, expect, test } from 'bun:test';
import type { StationControlState, StationSetupChecks } from '../../../src/types';
import { checkRow, checksTone, firstFailingCheck, robotAlert } from './stationChecks';

function checks(over: Partial<StationSetupChecks> = {}): StationSetupChecks {
  return {
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
    ...over,
  };
}

function control(over: Partial<StationControlState> = {}): StationControlState {
  return {
    teamNumber: 5940,
    enabled: true,
    eStop: false,
    aStop: false,
    mode: 'teleOp',
    joined: true,
    ready: true,
    alliance: 'red',
    matchSlot: 'red1',
    dsAttached: true,
    disabledBy: null,
    ...over,
  };
}

describe('firstFailingCheck', () => {
  test('none when nothing fails', () => {
    expect(firstFailingCheck(checks({ ds: 'partial', joysticks: 'unknown', ready: 'waiting' }))).toBeNull();
  });

  test('the earliest failure in ladder order', () => {
    expect(firstFailingCheck(checks({ robotComms: 'bad', radio: 'bad', battery: 'bad' }))).toBe('radio');
  });
});

describe('checksTone', () => {
  test('green when everything passed, waiting or unknown', () => {
    expect(checksTone(checks({ joysticks: 'unknown', ready: 'waiting' }))).toBe('ok');
  });

  test('a failure outranks a partial', () => {
    expect(checksTone(checks({ ds: 'partial' }))).toBe('partial');
    expect(checksTone(checks({ ds: 'partial', battery: 'bad' }))).toBe('bad');
  });
});

describe('checkRow', () => {
  test('shows the live battery voltage and the joystick count', () => {
    expect(checkRow(checks({ batteryVoltage: 11.8, battery: 'bad' }), 'battery').value).toBe('11.8V');
    expect(checkRow(checks(), 'joysticks').value).toBe('2');
    expect(checkRow(checks({ joysticks: 'unknown', joystickCount: undefined }), 'joysticks').value).toBe('?');
  });
});

describe('robotAlert', () => {
  test('nothing for a healthy robot, or outside a running match', () => {
    expect(robotAlert(control(), 'teleop', 'ok')).toBeNull();
    expect(robotAlert(control({ enabled: false, dsAttached: false }), 'postMatch', 'bad')).toBeNull();
    expect(robotAlert(control({ joined: false, dsAttached: false }), 'teleop', 'bad')).toBeNull();
  });

  test('stops outrank lost comms', () => {
    expect(robotAlert(control({ eStop: true, dsAttached: false }), 'teleop', 'bad')?.label).toBe('E-STOPPED');
    expect(robotAlert(control({ aStop: true, enabled: false }), 'auto', 'ok')?.label).toBe('A-STOPPED');
  });

  test('lost comms show even while robots are held disabled', () => {
    expect(robotAlert(control({ dsAttached: false, enabled: false }), 'countdown', 'unknown')?.label).toBe('NO DS');
    expect(robotAlert(control({ enabled: false }), 'autoPause', 'bad')?.label).toBe('NO ROBOT');
  });

  test('disabled only counts while robots should be driving', () => {
    expect(robotAlert(control({ enabled: false }), 'countdown', 'ok')).toBeNull();
    expect(robotAlert(control({ enabled: false, disabledBy: 'ds' }), 'teleop', 'ok')).toEqual({
      label: 'DISABLED',
      tone: 'warn',
    });
  });

  test("a relay robot whose leg is over isn't a problem", () => {
    expect(robotAlert(control({ enabled: false, disabledBy: 'relay' }), 'teleop', 'ok')?.tone).toBe('neutral');
  });
});
