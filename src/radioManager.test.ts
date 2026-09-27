import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type RadioManager from './radioManager.js';
import type { RadioHoldReason } from './types.js';

// The network manager reaches for Linux netlink the moment it loads. None of
// this touches a NIC — these tests are about what a request does to the
// active and held configs, and when — so stand in for it before importing.
let RadioManagerClass: typeof RadioManager;
beforeAll(async () => {
  mock.module('./networkManager.js', () => ({
    configureNetwork: async () => {},
    setInternetAccess: async () => {},
  }));
  // Under the CommonJS tsconfig the dynamic import types as the namespace;
  // at runtime (ESM under Bun) `.default` is the class.
  RadioManagerClass = (await import('./radioManager.js')).default as unknown as typeof RadioManager;
});

/** A radio manager with no radio and no trunk NIC: commits run through the
 *  queue but touch nothing. */
function manager(): RadioManager {
  const rm = new RadioManagerClass('http://127.0.0.1:1');
  rm.stopPolling();
  return rm;
}

const robot = { ssid: '1234-Comp', wpaKey: 'passphrase1' };
const other = { ssid: '5678', wpaKey: 'passphrase2' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pfms-radio-'));
  process.env.ACTIVE_CONFIG_FILE = join(dir, 'active.json');
  process.env.STAGED_CONFIG_FILE = join(dir, 'staged.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a request with nothing in the way', () => {
  test('is applied straight away', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStagedChanges()).toEqual({});
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('releasing an empty station is a no-op', async () => {
    const rm = manager();
    await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(rm.getStationConfig('slot1')).toBeNull();
    expect(rm.getPendingState()).toEqual({ pending: false });
  });
});

describe('while robots are enabled', () => {
  test('the change is applied but the radio waits, then goes as soon as they are disabled', async () => {
    const rm = manager();
    let robotsEnabled = true;
    rm.setShouldDefer(() => robotsEnabled);

    await rm.configure('slot1', robot);
    // Applied: the team owns the station from pFMS's point of view…
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    // …but the radio hasn't been told, and clients can see which station is waiting.
    const waiting = rm.getPendingState();
    expect(waiting.pending).toBe(true);
    expect(waiting.deferred).toBe(true);
    expect(waiting.deferredChanges).toEqual({ slot1: { ssid: '1234-Comp', internetAccess: undefined, secured: true } });
    expect(waiting.hold).toBeUndefined();

    robotsEnabled = false;
    rm.retryDeferredCommit();
    await new Promise(r => setTimeout(r, 0));
    expect(rm.getPendingState()).toEqual({ pending: false });
  });
});

describe('while a match exists (or an admin is holding changes)', () => {
  test('the request is held, not applied, and says why', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');

    await rm.configure('slot1', robot);
    expect(rm.getStationConfig('slot1')).toBeNull();
    const state = rm.getPendingState();
    expect(state.pending).toBe(true);
    expect(state.hold).toBe('match');
    expect(state.stagedChanges).toEqual({ slot1: { ssid: '1234-Comp', internetAccess: undefined, secured: true } });
    expect(state.deferred).toBeUndefined();
  });

  test('a release is held too', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'admin');

    await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp'); // still on the field
    expect(rm.getPendingState().stagedChanges).toEqual({ slot1: null });
    expect(rm.getPendingState().hold).toBe('admin');
  });

  test('held changes apply on their own once the hold lifts', async () => {
    const rm = manager();
    let hold: RadioHoldReason | null = 'match';
    rm.setShouldHold(() => hold);
    await rm.configure('slot1', robot);

    rm.retryHeldChanges(); // still held: nothing happens
    expect(rm.getStationConfig('slot1')).toBeNull();

    hold = null;
    rm.retryHeldChanges();
    await new Promise(r => setTimeout(r, 0));
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('staff "Apply now" applies held changes despite the hold', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);
    await rm.configure('slot2', other);

    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStationConfig('slot2')?.ssid).toBe('5678');
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('"Apply now" still waits for enabled robots', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    rm.setShouldDefer(() => true);
    await rm.configure('slot1', robot);

    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    const state = rm.getPendingState();
    expect(state.deferred).toBe(true);
    expect(state.stagedChanges).toBeUndefined();
    expect(state.hold).toBeUndefined();
  });

  test('a team can withdraw a held request', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    rm.cancelStagedChange('slot1');
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('releasing an empty station withdraws what was waiting for it', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('a robot moving to another station releases the old one with the same hold', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'match');

    await rm.configure('slot2', robot);
    // Nothing applied yet: the old station is untouched until the hold lifts…
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStationConfig('slot2')).toBeNull();
    expect(rm.getPendingState().stagedChanges).toEqual({
      slot1: null,
      slot2: { ssid: '1234-Comp', internetAccess: undefined, secured: true },
    });

    // …and then both happen together.
    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')).toBeNull();
    expect(rm.getStationConfig('slot2')?.ssid).toBe('1234-Comp');
  });

  test('held changes survive a restart', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    const restarted = manager();
    expect(restarted.getPendingState().stagedChanges).toEqual({
      slot1: { ssid: '1234-Comp', internetAccess: undefined, secured: true },
    });
  });
});
