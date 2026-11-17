import { describe, expect, test } from 'bun:test';
import type { PendingChangeView, RobotWifiScanState } from '../../../src/types';
import { fieldWifiNotice } from './fieldWifiNotice';

const scan = (upcoming?: RobotWifiScanState['upcoming']): RobotWifiScanState => ({
  type: 'robotWifiScan',
  status: 'running',
  interfaces: [],
  broadcasts: [],
  stalls: [],
  ...(upcoming && { upcoming }),
});
const change: PendingChangeView = {
  id: 'a',
  kind: 'enable',
  ssid: '1234-Comp',
  station: 'slot1',
  secured: true,
};

describe('the scoreboard note on field Wi-Fi', () => {
  test('nothing coming up, nothing said', () => {
    expect(fieldWifiNotice(scan(), {}, 0)).toBeNull();
    expect(fieldWifiNotice(null, null, 0)).toBeNull();
  });

  test('counts down to a reconfiguration for robots that connected by themselves, then waits for disable', () => {
    const s = scan({ at: 5_000, robots: ['1234-Comp', '5678'], waitingFor: [] });
    const n = fieldWifiNotice(s, {}, 600);
    expect(n?.text).toBe('Field Wi-Fi reconfiguration in 5 s, once robots are disabled');
    expect(n?.details[0]).toContain('1234-Comp and 5678');
    expect(fieldWifiNotice(s, {}, 4_200)?.text).toContain('in 1 s');
    expect(fieldWifiNotice(s, {}, 5_000)?.text).toBe('Field Wi-Fi reconfiguration once robots are disabled');
  });

  test('says when it waits for another robot still being checked', () => {
    const n = fieldWifiNotice(scan({ at: 5_000, robots: ['1234-Comp'], waitingFor: ['254'] }), {}, 0);
    expect(n?.details[1]).toContain('254');
  });

  test('an applied change waiting for robots to be disabled', () => {
    const n = fieldWifiNotice(
      scan(),
      { deferred: true, deferredChanges: { slot1: { ssid: '1234-Comp', secured: true }, slot2: null } },
      0,
    );
    expect(n?.text).toBe('Field Wi-Fi reconfiguration once robots are disabled');
    expect(n?.details[0]).toContain('Connecting 1234-Comp.');
  });

  test('an admin hold, on its own or on robots that connected by themselves', () => {
    expect(fieldWifiNotice(scan(), { hold: 'admin', changes: [change] }, 0)).toEqual({
      text: 'Wi-Fi changes held by the field admin',
      details: ['1 change waiting for Apply now on the match page.'],
    });
    const n = fieldWifiNotice(
      scan({ at: 5_000, robots: ['1234-Comp'], waitingFor: [] }),
      { hold: 'admin', changes: [change] },
      0,
    );
    expect(n?.details.at(-1)).toContain('held by the field admin');
  });

  test('a full field with robots in line is not a reconfiguration', () => {
    expect(fieldWifiNotice(scan(), { hold: 'full', changes: [change] }, 0)).toBeNull();
  });
});
