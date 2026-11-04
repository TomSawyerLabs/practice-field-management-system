import { describe, expect, test } from 'bun:test';
import { ENABLED_REPORT_STALE_MS, TelemetryManager } from './telemetryManager.js';
import type { UdpMessage } from './fmsServer.js';
import type { TelemetryUpdate } from './types.js';

/** A DS UDP status packet from team 5940, reporting enabled or not. */
function status(enabled: boolean): UdpMessage {
  return {
    sequence: 1,
    commVersion: 0,
    status: { enabled } as UdpMessage['status'],
    rawStatus: 0,
    teamNumber: 5940,
    BatteryVoltage: 12.5,
    tags: [],
  };
}

function manager() {
  let clock = 1_700_000_000_000;
  const telemetry = new TelemetryManager(
    () => ({ 5940: 'slot1' }),
    () => {},
    undefined,
    () => clock,
  );
  const report = (enabled: boolean) =>
    telemetry.processFmsEvent({ address: '10.59.40.5', port: 1160, data: status(enabled) });
  return { telemetry, report, advance: (ms: number) => (clock += ms) };
}

describe('whether any robot is enabled, for deferring radio commits', () => {
  test('follows the DS reports', () => {
    const { telemetry, report } = manager();
    expect(telemetry.anyRobotEnabled()).toBe(false);
    report(true);
    expect(telemetry.anyRobotEnabled()).toBe(true);
    report(false);
    expect(telemetry.anyRobotEnabled()).toBe(false);
  });

  test('a DS that went quiet while enabled stops counting', () => {
    const { telemetry, report, advance } = manager();
    report(true);
    advance(ENABLED_REPORT_STALE_MS);
    expect(telemetry.anyRobotEnabled()).toBe(true);
    advance(1);
    expect(telemetry.anyRobotEnabled()).toBe(false);
    // ...and counts again as soon as it speaks up
    report(true);
    expect(telemetry.anyRobotEnabled()).toBe(true);
  });
});

describe('a 2027 (SystemCore) Driver Station', () => {
  test('its status says nothing about enable or mode; its robot’s own replies do', () => {
    const updates: TelemetryUpdate[] = [];
    const telemetry = new TelemetryManager(
      () => ({ 5940: 'slot1' }),
      u => updates.push(u),
      undefined,
      undefined,
      address => address === '10.59.40.5',
    );
    // A robot driven in a match: the 2027 DS's status never sets enabled.
    telemetry.processFmsEvent({ address: '10.59.40.5', port: 1160, data: status(false) });
    expect(updates).toHaveLength(1);
    expect(updates[0].dsStatus).toBeUndefined();
    expect(updates[0].batteryVoltage).toBe(12.5);
    expect(telemetry.anyRobotEnabled()).toBe(false);
    // A legacy DS is unchanged.
    telemetry.processFmsEvent({ address: '10.59.40.6', port: 1160, data: status(true) });
    expect(updates[1].dsStatus?.enabled).toBe(true);
    expect(telemetry.anyRobotEnabled()).toBe(true);
  });
});
