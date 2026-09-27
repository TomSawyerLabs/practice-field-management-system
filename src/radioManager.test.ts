import { afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
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

describe('who a station is for', () => {
  test('the projected team follows a held request; the active team does not', async () => {
    const rm = manager();
    await rm.configure('slot1', robot); // 1234 on the radio
    rm.setShouldHold(() => 'match');

    await rm.configure('slot1', other); // 5678 held for the same slot
    expect(rm.getTeamForStation('slot1')).toBe(1234);
    expect(rm.getProjectedTeamForStation('slot1')).toBe(5678);

    await rm.configure('slot1', { ssid: '', wpaKey: '' }); // now a held release
    expect(rm.getTeamForStation('slot1')).toBe(1234);
    expect(rm.getProjectedTeamForStation('slot1')).toBeNull();

    rm.cancelStagedChange('slot1');
    expect(rm.getProjectedTeamForStation('slot1')).toBe(1234);
  });
});

// ── Radio self-repair ───────────────────────────────────────────────
//
// The status poll compares what the radio reports with activeConfig and
// re-pushes when they stay apart. Drive the check directly with fake status
// updates and a stubbed commit, stepping the clock, so the policy is tested
// without a radio: first repair after the debounce, then backing off until
// the radio agrees.

type Sync = {
  checkRadioConfigSync(update: unknown): void;
  commitConfiguration(): Promise<void>;
};

/** A radio status report naming these SSIDs (slot order), rest empty. */
function radioReports(...ssids: (string | null)[]) {
  const stationStatuses: Record<string, { ssid: string } | null> = {};
  ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6'].forEach((slot, i) => {
    stationStatuses[slot] = ssids[i] ? { ssid: ssids[i]! } : null;
  });
  return { status: 'ACTIVE', stationStatuses };
}

describe('radio self-repair', () => {
  let now: number;
  let commits: number;
  let rm: RadioManager;
  let sync: Sync;

  const tick = (ms: number) => {
    now += ms;
    setSystemTime(new Date(now));
  };

  beforeEach(async () => {
    now = Date.parse('2026-09-27T22:28:00Z');
    setSystemTime(new Date(now));
    commits = 0;
    rm = manager();
    sync = rm as unknown as Sync;
    sync.commitConfiguration = async () => {
      commits++;
    };
    await rm.configure('slot1', robot);
    commits = 0; // configure() committed once itself
  });
  afterEach(() => {
    setSystemTime();
  });

  test('a radio that agrees is left alone', () => {
    for (let i = 0; i < 10; i++) {
      sync.checkRadioConfigSync(radioReports('1234-Comp'));
      tick(5_000);
    }
    expect(commits).toBe(0);
  });

  test('the first repair comes after the debounce', () => {
    sync.checkRadioConfigSync(radioReports(null)); // radio empty
    tick(10_000);
    sync.checkRadioConfigSync(radioReports(null));
    expect(commits).toBe(0);
    tick(6_000); // 16 s in: past the 15 s debounce
    sync.checkRadioConfigSync(radioReports(null));
    expect(commits).toBe(1);
  });

  test('repeats back off while the radio keeps disagreeing', () => {
    const disagree = () => sync.checkRadioConfigSync(radioReports('9999-stale'));
    // First repair at the debounce.
    disagree();
    tick(16_000);
    disagree();
    expect(commits).toBe(1);
    // Still wrong straight after: nothing for a minute…
    disagree();
    tick(30_000);
    disagree();
    expect(commits).toBe(1);
    tick(31_000);
    disagree();
    expect(commits).toBe(2);
    // …then two minutes…
    disagree();
    tick(61_000);
    disagree();
    expect(commits).toBe(2);
    tick(60_000);
    disagree();
    expect(commits).toBe(3);
    // …then four.
    disagree();
    tick(3 * 60_000 + 59_000);
    disagree();
    expect(commits).toBe(3);
    tick(2_000);
    disagree();
    expect(commits).toBe(4);
  });

  test('the wait is capped', () => {
    const disagree = () => sync.checkRadioConfigSync(radioReports(null));
    // Burn through 15 s, 1, 2, 4, 8 min of waits.
    for (const wait of [15_000, 60_000, 120_000, 240_000, 480_000]) {
      disagree();
      tick(wait + 1_000);
      disagree();
    }
    expect(commits).toBe(5);
    // Next would be 16 min uncapped; the cap is 10.
    disagree();
    tick(10 * 60_000 + 1_000);
    disagree();
    expect(commits).toBe(6);
  });

  test('agreement resets the backoff', () => {
    const disagree = () => sync.checkRadioConfigSync(radioReports(null));
    disagree();
    tick(16_000);
    disagree();
    expect(commits).toBe(1);
    disagree();
    tick(61_000);
    disagree();
    expect(commits).toBe(2);
    // The radio catches up.
    sync.checkRadioConfigSync(radioReports('1234-Comp'));
    // A fresh wipe is repaired after the plain debounce again.
    disagree();
    tick(16_000);
    disagree();
    expect(commits).toBe(3);
  });

  test('an unsettled radio restarts the clock but keeps the backoff', () => {
    const disagree = () => sync.checkRadioConfigSync(radioReports(null));
    disagree();
    tick(16_000);
    disagree();
    expect(commits).toBe(1);
    // Our push puts the radio into CONFIGURING for a while.
    sync.checkRadioConfigSync({ status: 'CONFIGURING', stationStatuses: {} });
    tick(40_000);
    // Back, still wrong: the minute starts now, not from before the push.
    disagree();
    tick(59_000);
    disagree();
    expect(commits).toBe(1);
    tick(2_000);
    disagree();
    expect(commits).toBe(2);
  });
});
