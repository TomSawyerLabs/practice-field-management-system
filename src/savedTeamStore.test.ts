import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SavedTeamStore } from './savedTeamStore.js';

const dir = mkdtempSync(join(tmpdir(), 'saved-teams-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => new SavedTeamStore(join(dir, `saved-${n++}.json`));

describe('saved robots', () => {
  test('a replaced passphrase is kept to try later, newest first, a few', () => {
    const store = fresh();
    for (const key of ['key00001', 'key00002', 'key00003', 'key00002', 'key00004']) store.saveTeam('1234-Comp', key);
    expect(store.getTeam('1234-Comp')).toMatchObject({
      wpaKey: 'key00004',
      formerKeys: ['key00002', 'key00003', 'key00001'],
    });
    for (const key of ['key00005', 'key00006', 'key00007', 'key00008', 'key00009']) store.saveTeam('1234-Comp', key);
    expect(store.getTeam('1234-Comp')!.formerKeys).toHaveLength(5);
  });

  test("a team's passphrases: its robots' own first, then former ones, distinct", () => {
    const store = fresh();
    store.saveTeam('1234-Comp', 'compkey1');
    store.saveTeam('1234-Comp', 'compkey2');
    store.saveTeam('1234', 'compkey2');
    store.saveTeam('12345', 'otherteam');
    expect(store.keysForTeam(1234)).toEqual(['compkey2', 'compkey1']);
    expect(store.keysForTeam(5678)).toEqual([]);
  });

  test('auto-connect is on unless turned off, and survives saving a new passphrase', () => {
    const store = fresh();
    store.saveTeam('1234-Comp', 'compkey1');
    expect(store.getTeam('1234-Comp')!.autoConnect).toBeUndefined();
    expect(store.setAutoConnect('1234-Comp', false)).toBe(true);
    store.saveTeam('1234-Comp', 'compkey2');
    expect(store.getTeam('1234-Comp')!.autoConnect).toBe(false);
    store.setAutoConnect('1234-Comp', true);
    expect(store.getTeam('1234-Comp')!.autoConnect).toBeUndefined();
    expect(store.setAutoConnect('9999', false)).toBe(false);
  });

  test('passphrases never reach clients; everything survives a restart', () => {
    const file = join(dir, 'restart.json');
    const store = new SavedTeamStore(file);
    store.saveTeam('1234-Comp', 'compkey1');
    store.saveTeam('1234-Comp', 'compkey2');
    store.setAutoConnect('1234-Comp', false);
    const state = JSON.stringify(store.getState());
    expect(state).not.toContain('compkey');
    expect(store.getState().teams[0].autoConnect).toBe(false);

    expect(readFileSync(file, 'utf8')).toContain('formerKeys');
    expect(new SavedTeamStore(file).getTeam('1234-Comp')).toMatchObject({
      wpaKey: 'compkey2',
      formerKeys: ['compkey1'],
      autoConnect: false,
    });
  });
});
