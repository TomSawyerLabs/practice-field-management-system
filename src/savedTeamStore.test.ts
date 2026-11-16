import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SavedTeamStore } from './savedTeamStore.js';

const dir = mkdtempSync(join(tmpdir(), 'saved-teams-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const paths = () => {
  n++;
  return [join(dir, `saved-${n}.json`), join(dir, `history-${n}.json`)] as const;
};
const fresh = () => new SavedTeamStore(...paths());

describe("a team's passphrases", () => {
  test("its robots' own first, then every one it has used, newest first, distinct", () => {
    const store = fresh();
    for (const key of ['key00001', 'key00002', 'key00003', 'key00002', 'key00004']) store.saveTeam('1234-Comp', key);
    store.saveTeam('1234', 'robotkey');
    store.saveTeam('12345', 'otherteam');
    expect(store.keysForTeam(1234)).toEqual(['robotkey', 'key00004', 'key00002', 'key00003', 'key00001']);
    expect(store.keysForTeam(5678)).toEqual([]);
  });

  test('are kept for good: removing a robot forgets none, and they survive a restart', () => {
    const [file, history] = paths();
    const store = new SavedTeamStore(file, history);
    for (let i = 0; i < 20; i++) store.saveTeam('1234-Comp', `key${String(i).padStart(5, '0')}`);
    store.removeTeam('1234-Comp');
    expect(store.keysForTeam(1234)).toHaveLength(20);
    expect(new SavedTeamStore(file, history).keysForTeam(1234)[0]).toBe('key00019');
  });

  test('the history starts from the robots already saved', () => {
    const [file, history] = paths();
    writeFileSync(
      file,
      JSON.stringify([
        { ssid: '1234-Comp', wpaKey: 'compkey1', createdAt: 1, lastUsedAt: 2 },
        { ssid: '1234', wpaKey: 'oldkey12', createdAt: 1, lastUsedAt: 1 },
      ]),
    );
    new SavedTeamStore(file, history);
    expect(JSON.parse(readFileSync(history, 'utf8'))).toEqual({ '1234': ['compkey1', 'oldkey12'] });
  });

  test('never reach clients', () => {
    const store = fresh();
    store.saveTeam('1234-Comp', 'compkey1');
    store.saveTeam('1234-Comp', 'compkey2');
    expect(JSON.stringify(store.getState())).not.toContain('compkey');
  });
});

describe('auto-connect', () => {
  test('is on unless turned off, and survives saving a new passphrase and a restart', () => {
    const [file, history] = paths();
    const store = new SavedTeamStore(file, history);
    store.saveTeam('1234-Comp', 'compkey1');
    expect(store.getTeam('1234-Comp')!.autoConnect).toBeUndefined();
    expect(store.setAutoConnect('1234-Comp', false)).toBe(true);
    store.saveTeam('1234-Comp', 'compkey2');
    expect(store.getTeam('1234-Comp')!.autoConnect).toBe(false);
    expect(store.getState().teams[0].autoConnect).toBe(false);
    expect(new SavedTeamStore(file, history).getTeam('1234-Comp')!.autoConnect).toBe(false);
    store.setAutoConnect('1234-Comp', true);
    expect(store.getTeam('1234-Comp')!.autoConnect).toBeUndefined();
    expect(store.setAutoConnect('9999', false)).toBe(false);
  });
});
