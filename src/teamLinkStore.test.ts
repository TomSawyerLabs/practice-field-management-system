import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamLinkStore, autoLinkTarget } from './teamLinkStore.js';
import { isStandInTeam, robotLabel } from './types.js';

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-links-'));
  dirs.push(dir);
  return join(dir, 'team-links.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Noon local on a date, so the 04:00 rollover never interferes. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('isStandInTeam', () => {
  test('9900 to 9999 only', () => {
    expect(isStandInTeam(9899)).toBe(false);
    expect(isStandInTeam(9900)).toBe(true);
    expect(isStandInTeam(9940)).toBe(true);
    expect(isStandInTeam(9999)).toBe(true);
    expect(isStandInTeam(10000)).toBe(false);
    expect(isStandInTeam(5940)).toBe(false);
  });
});

describe('TeamLinkStore', () => {
  test('a link files the stand-in under its team for that day only', () => {
    let now = at(2026, 11, 16);
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => now });
    store.link(9940, 5940, 'open');
    expect(store.teamFor(9940)).toBe(5940);
    expect(store.standInsFor(5940)).toEqual([9940]);
    expect(store.teamsFiledUnder(5940)).toEqual([5940, 9940]);
    expect(store.teamFor(5940)).toBe(5940);

    now = at(2026, 11, 17);
    expect(store.teamFor(9940)).toBe(9940);
    expect(store.teamFor(9940, '2026-11-16')).toBe(5940);
    expect(store.standInsFor(5940)).toEqual([]);
  });

  test('the day rolls over at 04:00, not midnight', () => {
    let now = at(2026, 11, 16, 23);
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => now });
    store.link(9940, 5940, 'open');
    now = at(2026, 11, 17, 2);
    expect(store.teamFor(9940)).toBe(5940);
    now = at(2026, 11, 17, 5);
    expect(store.teamFor(9940)).toBe(9940);
  });

  test('relinking replaces the day’s link', () => {
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => at(2026, 11, 16) });
    store.link(9940, 5940, 'open');
    store.link(9940, 254, 'staff');
    expect(store.teamFor(9940)).toBe(254);
    expect(store.standInsFor(5940)).toEqual([]);
    expect(store.getState().links).toHaveLength(1);
  });

  test('unlinking leaves a tombstone that the state leaves out', () => {
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => at(2026, 11, 16) });
    store.link(9940, 5940, 'auto');
    store.unlink(9940);
    expect(store.teamFor(9940)).toBe(9940);
    expect(store.entryFor(9940)?.via).toBe('unlinked');
    expect(store.getState().links).toEqual([]);
  });

  test('refuses numbers outside the stand-in range, and linking to a stand-in', () => {
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => at(2026, 11, 16) });
    expect(() => store.link(5940, 254, 'open')).toThrow();
    expect(() => store.link(9940, 9941, 'open')).toThrow();
  });

  test('persists across restarts', () => {
    const file = tempFile();
    const now = () => at(2026, 11, 16);
    new TeamLinkStore({ filePath: file, now }).link(9940, 5940, 'login');
    const reloaded = new TeamLinkStore({ filePath: file, now });
    expect(reloaded.teamFor(9940)).toBe(5940);
    expect(reloaded.entryFor(9940)?.via).toBe('login');
  });

  test('tells listeners', () => {
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => at(2026, 11, 16) });
    const seen: number[] = [];
    store.addListener(s => seen.push(s.links.length));
    store.link(9940, 5940, 'open');
    store.unlink(9940);
    expect(seen).toEqual([1, 0]);
  });
});

describe('autoLinkTarget', () => {
  test('the one real team saved with the stand-in’s passphrase', () => {
    const saved = [
      { ssid: '5940', wpaKey: 'secret-5940' },
      { ssid: '254-b', wpaKey: 'other' },
      { ssid: '9940', wpaKey: 'secret-5940' },
    ];
    expect(autoLinkTarget(9940, saved)).toBe(5940);
  });

  test('nothing when the stand-in has no saved passphrase, or no team matches', () => {
    expect(autoLinkTarget(9940, [{ ssid: '5940', wpaKey: 'secret-5940' }])).toBeUndefined();
    expect(
      autoLinkTarget(9940, [
        { ssid: '5940', wpaKey: 'secret-5940' },
        { ssid: '9940', wpaKey: 'different' },
      ]),
    ).toBeUndefined();
  });

  test('a passphrase two teams share decides nothing', () => {
    const saved = [
      { ssid: '5940', wpaKey: 'password' },
      { ssid: '254', wpaKey: 'password' },
      { ssid: '9940', wpaKey: 'password' },
    ];
    expect(autoLinkTarget(9940, saved)).toBeUndefined();
  });

  test('other stand-ins sharing it don’t count as a team', () => {
    const saved = [
      { ssid: '5940-a', wpaKey: 'secret' },
      { ssid: '9940', wpaKey: 'secret' },
      { ssid: '9941', wpaKey: 'secret' },
    ];
    expect(autoLinkTarget(9940, saved)).toBe(5940);
  });
});

describe('practice runs follow the link', () => {
  // Imported here so the store tests above don't need the recorder's deps.
  const run = (id: string, teamNumber: number, startedAt: number) => ({
    id,
    station: 'slot1' as const,
    teamNumber,
    startedAt,
    endedAt: startedAt + 30_000,
    recordings: [],
  });

  test('a stand-in’s runs are filed under its team’s day, before and after linking', async () => {
    const { PracticeStore } = await import('./practiceStore.js');
    const now = at(2026, 11, 16);
    const links = new TeamLinkStore({ filePath: tempFile(), now: () => now });
    const practice = new PracticeStore(tempFile());
    practice.setTeamResolver((team, day) => links.teamFor(team, day));
    links.addListener(s => practice.refile(s.day));

    practice.addRun(run('practice-a', 9940, now - 60_000));
    practice.addRun(run('practice-b', 5940, now - 30_000));
    expect(practice.runsFor(5940, '2026-11-16').map(r => r.id)).toEqual(['practice-b']);
    expect(practice.runsFor(9940, '2026-11-16').map(r => r.id)).toEqual(['practice-a']);

    links.link(9940, 5940, 'open');
    expect(practice.runsFor(5940, '2026-11-16').map(r => r.id)).toEqual(['practice-a', 'practice-b']);
    expect(practice.runsFor(9940, '2026-11-16')).toEqual([]);

    // A later run goes straight to 5940's day.
    practice.addRun(run('practice-c', 9940, now));
    expect(practice.runsFor(5940, '2026-11-16')).toHaveLength(3);

    links.unlink(9940);
    expect(practice.runsFor(5940, '2026-11-16').map(r => r.id)).toEqual(['practice-b']);
  });

  test('linking gives the real team a day link when only the stand-in had recorded', async () => {
    const { PracticeStore } = await import('./practiceStore.js');
    const now = at(2026, 11, 16);
    const links = new TeamLinkStore({ filePath: tempFile(), now: () => now });
    const practice = new PracticeStore(tempFile());
    practice.setTeamResolver((team, day) => links.teamFor(team, day));
    links.addListener(s => practice.refile(s.day));

    practice.addRun(run('practice-a', 9940, now));
    expect(practice.findDay(5940, '2026-11-16')).toBeUndefined();
    links.link(9940, 5940, 'open');
    expect(practice.findDay(5940, '2026-11-16')).toBeDefined();
  });

  test('a stand-in stops recording when its team turned recording off', async () => {
    const { PracticeStore } = await import('./practiceStore.js');
    const links = new TeamLinkStore({ filePath: tempFile() });
    const practice = new PracticeStore(tempFile());
    practice.setTeamResolver((team, day) => links.teamFor(team, day));
    practice.setOptIn(5940, false);
    expect(practice.isOptedIn(9940)).toBe(true);
    links.link(9940, 5940, 'open');
    expect(practice.isOptedIn(9940)).toBe(false);
  });
});

describe('robotLabel', () => {
  test('a linked spare reads as its team with a letter, on the day it was linked', () => {
    const now = at(2026, 11, 16);
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => now });
    store.link(9941, 5940, 'open');
    store.link(9940, 5940, 'open');
    const state = store.getState();
    expect(robotLabel(9940, now, state)).toBe('5940 B');
    expect(robotLabel(9941, now, state)).toBe('5940 C');
    expect(robotLabel(5940, now, state)).toBe('5940');
    expect(robotLabel(9940, at(2026, 11, 15), state)).toBe('9940');
  });

  test('earlier days keep their labels', () => {
    let now = at(2026, 11, 15);
    const store = new TeamLinkStore({ filePath: tempFile(), now: () => now });
    store.link(9940, 5940, 'open');
    now = at(2026, 11, 16);
    expect(robotLabel(9940, at(2026, 11, 15), store.getState())).toBe('5940 B');
    expect(robotLabel(9940, now, store.getState())).toBe('9940');
  });
});
