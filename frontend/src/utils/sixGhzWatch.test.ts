import { describe, expect, test } from 'bun:test';
import type { SixGhzClash, SixGhzWatchState } from '../../../src/types';
import {
  clashesForTeam,
  describeClashForTeam,
  isSixGhzWatching,
  sixGhzChannelLabel,
  sixGhzStaffIssues,
} from './sixGhzWatch';

const other = (bssid: string, channel: number, signal = -60) => ({ bssid, frequency: 5950 + 5 * channel, signal });

function clash(over: Partial<SixGhzClash> = {}): SixGhzClash {
  return {
    ssid: '1234-Robot',
    team: 1234,
    kind: 'competing',
    station: 'slot1',
    others: [other('aa:00:00:00:00:01', 37)],
    ...over,
  };
}

function watch(over: Partial<SixGhzWatchState> = {}): SixGhzWatchState {
  return { type: 'sixGhzWatch', status: 'running', iface: 'wlx0', channels: 59, networks: [], clashes: [], ...over };
}

describe('6 GHz watch wording', () => {
  test('channel labels', () => {
    expect(sixGhzChannelLabel(5955)).toBe('6 GHz ch 1');
    expect(sixGhzChannelLabel(6015)).toBe('6 GHz ch 13');
  });

  test('a competing AP is an error for the team, and says what to do', () => {
    const d = describeClashForTeam(clash());
    expect(d.severity).toBe('error');
    expect(d.text).toContain('Another access point is broadcasting');
    expect(d.text).toContain('1234-Robot (6 GHz ch 37, -60 dBm)');
    expect(d.text).toContain('switch it off');
  });

  test('several competing APs are counted', () => {
    const d = describeClashForTeam(clash({ others: [other('aa:00:00:00:00:01', 37), other('aa:00:00:00:00:02', 5)] }));
    expect(d.text).toContain('2 other access points are broadcasting');
    expect(d.text).toContain('one of them');
  });

  test("a team AP while the field isn't serving the name is a warning", () => {
    const d = describeClashForTeam(clash({ kind: 'teamAp', station: undefined }));
    expect(d.severity).toBe('warning');
    expect(d.text).toContain('probably your own');
  });

  test("a team's clashes, only while the watch runs", () => {
    const state = watch({ clashes: [clash(), clash({ ssid: '254', team: 254 })] });
    expect(clashesForTeam(state, 1234).map(c => c.ssid)).toEqual(['1234-Robot']);
    expect(clashesForTeam({ ...state, status: 'error' }, 1234)).toEqual([]);
    expect(clashesForTeam(null, 1234)).toEqual([]);
  });
});

test('watching only while running and hearing 6 GHz', () => {
  expect(isSixGhzWatching(watch())).toBe(true);
  expect(isSixGhzWatching(watch({ status: 'off' }))).toBe(false);
  expect(isSixGhzWatching(watch({ status: 'error' }))).toBe(false);
  expect(isSixGhzWatching(watch({ problem: 'no 6 GHz channels' }))).toBe(false);
  expect(isSixGhzWatching(null)).toBe(false);
});

describe('6 GHz watch issues for staff', () => {
  test('competing is critical and names the station; a team AP is a warning', () => {
    const issues = sixGhzStaffIssues(watch({ clashes: [clash(), clash({ ssid: '254', team: 254, kind: 'teamAp' })] }));
    expect(issues.map(i => [i.severity, i.team, i.station])).toEqual([
      ['critical', 1234, 'slot1'],
      ['warning', 254, undefined],
    ]);
    expect(issues[0].detail).toContain('aa:00:00:00:00:01 (6 GHz ch 37, -60 dBm)');
  });

  test('a stopped watch, or one that hears no 6 GHz, says so', () => {
    expect(sixGhzStaffIssues(watch({ status: 'error', error: 'no card' }))[0]).toMatchObject({
      id: 'sixGhzWatch-error',
      detail: 'no card',
    });
    expect(sixGhzStaffIssues(watch({ problem: 'wlx0 offers no 6 GHz channels' }))[0].id).toBe('sixGhzWatch-problem');
  });

  test('off is quiet', () => {
    expect(sixGhzStaffIssues(watch({ status: 'off' }))).toEqual([]);
    expect(sixGhzStaffIssues(null)).toEqual([]);
  });
});
