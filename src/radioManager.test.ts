import { afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  test('the request waits, is not applied, and says why', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');

    const result = await rm.configure('slot1', robot);
    expect(result).toEqual({ result: 'waiting', reason: 'match' });
    expect(rm.getStationConfig('slot1')).toBeNull();
    const state = rm.getPendingState();
    expect(state.pending).toBe(true);
    expect(state.hold).toBe('match');
    expect(state.changes).toEqual([
      {
        id: expect.any(String),
        kind: 'enable',
        ssid: '1234-Comp',
        station: 'slot1',
        internetAccess: undefined,
        secured: true,
      },
    ]);
    expect(state.stagedChanges).toEqual({ slot1: { ssid: '1234-Comp', internetAccess: undefined, secured: true } });
    expect(state.deferred).toBeUndefined();
  });

  test('a release waits too', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'admin');

    await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp'); // still on the field
    const state = rm.getPendingState();
    expect(state.changes).toEqual([
      { id: expect.any(String), kind: 'release', ssid: '1234-Comp', station: 'slot1', reason: 'team' },
    ]);
    expect(state.stagedChanges).toEqual({ slot1: null });
    expect(state.hold).toBe('admin');
  });

  test('the hold lifting applies nothing by itself — staff do', async () => {
    const rm = manager();
    let hold: RadioHoldReason | null = 'match';
    rm.setShouldHold(() => hold);
    await rm.configure('slot1', robot);

    hold = null;
    rm.retryHeldChanges();
    await new Promise(r => setTimeout(r, 0));
    expect(rm.getStationConfig('slot1')).toBeNull();
    expect(rm.getPendingState().hold).toBe('pending');

    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('staff "Apply now" applies the whole list despite the hold', async () => {
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
    expect(state.changes).toBeUndefined();
    expect(state.stagedChanges).toBeUndefined();
    expect(state.hold).toBeUndefined();
  });

  test('a team can withdraw a waiting request', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    rm.cancelStagedChange('slot1');
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('releasing a robot that is not on the field only withdraws its request', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    const result = await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(result).toEqual({ result: 'noop' });
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('a robot already on the field never changes station', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'match');

    const result = await rm.configure('slot2', robot);
    expect(result).toEqual({ result: 'noop' });
    expect(rm.getPendingState()).toEqual({ pending: false });
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStationConfig('slot2')).toBeNull();
  });

  test('a new key for a robot on the field is a change in place', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'match');

    await rm.configure('slot3', { ssid: '1234-Comp', wpaKey: 'newkey123' });
    expect(rm.getPendingState().stagedChanges).toEqual({
      slot1: { ssid: '1234-Comp', internetAccess: undefined, secured: true },
    });
    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.wpaKey).toBe('newkey123');
    expect(rm.getStationConfig('slot3')).toBeNull();
  });

  test('waiting changes survive a restart', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    const restarted = manager();
    expect(restarted.getPendingState().changes).toEqual([
      {
        id: expect.any(String),
        kind: 'enable',
        ssid: '1234-Comp',
        station: 'slot1',
        internetAccess: undefined,
        secured: true,
      },
    ]);
  });

  test('the old per-station file is migrated', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    writeFileSync(
      process.env.STAGED_CONFIG_FILE!,
      JSON.stringify({ slot1: null, slot2: { ssid: '5678', wpaKey: 'passphrase2' } }),
    );

    const restarted = manager();
    expect(restarted.getPendingState().changes).toEqual([
      { id: expect.any(String), kind: 'release', ssid: '1234-Comp', station: 'slot1', reason: 'team' },
      {
        id: expect.any(String),
        kind: 'enable',
        ssid: '5678',
        station: 'slot2',
        internetAccess: undefined,
        secured: true,
      },
    ]);
  });
});

describe('the pending list simplifies itself', () => {
  test('asking again replaces the earlier request', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);
    await rm.configure('slot2', { ...robot, wpaKey: 'otherkey12' });

    const changes = rm.getPendingState().changes!;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'enable', ssid: '1234-Comp', station: 'slot2' });
  });

  test('released then re-enabled while waiting is a no-op: the robot is kept', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(rm.getPendingState().changes).toHaveLength(1);

    const result = await rm.configure('slot1', robot);
    expect(result).toEqual({ result: 'kept' });
    expect(rm.getPendingState()).toEqual({ pending: false });
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
  });

  test('enabled then released while waiting is a no-op', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);

    const result = await rm.configure('slot1', { ssid: '', wpaKey: '' });
    expect(result).toEqual({ result: 'noop' });
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('a request joins a batch that is already waiting, even with no hold', async () => {
    const rm = manager();
    let hold: RadioHoldReason | null = 'match';
    rm.setShouldHold(() => hold);
    await rm.configure('slot1', robot);

    hold = null;
    const result = await rm.configure('slot2', other);
    expect(result).toEqual({ result: 'waiting', reason: 'pending' });
    expect(rm.getStationConfig('slot2')).toBeNull();

    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStationConfig('slot2')?.ssid).toBe('5678');
  });
});

describe('applying reconciles the list with the field', () => {
  test('an enable whose station is spoken for lands on the next free one', async () => {
    const rm = manager();
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);
    await rm.configure('slot1', other); // both asked for slot1

    expect(rm.getPendingState().changes!.map(c => c.station)).toEqual(['slot1', 'slot2']);
    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStationConfig('slot2')?.ssid).toBe('5678');
  });

  test('a station being released is reused in the same apply', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', { ssid: '', wpaKey: '' });
    await rm.configure('slot1', other);

    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('5678');
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('with the field full an enable keeps waiting', async () => {
    const rm = manager();
    const slots = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6'] as const;
    for (const [i, slot] of slots.entries()) await rm.configure(slot, { ssid: `${1000 + i}-x`, wpaKey: 'passphrase' });
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', robot);
    expect(rm.getPendingState().changes![0].station).toBeNull();

    await rm.applyPendingChanges();
    expect(rm.getPendingState().changes).toHaveLength(1);
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1000-x');
  });
});

describe('when a set-up match is abandoned', () => {
  test('robots waiting to join go through, and robots queued to leave stay for staff', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.stageReleaseAll('postMatch');
    rm.setShouldHold(() => 'match');
    await rm.configure('slot2', other);

    await rm.applyPendingJoins();
    expect(rm.getStationConfig('slot2')?.ssid).toBe('5678');
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getPendingState().changes).toEqual([
      { id: expect.any(String), kind: 'release', ssid: '1234-Comp', station: 'slot1', reason: 'postMatch' },
    ]);
  });

  test('with no robot waiting to join, nothing changes', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.stageReleaseAll('postMatch');

    await rm.applyPendingJoins();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getPendingState().changes).toHaveLength(1);
  });
});

describe('after a match', () => {
  test('every robot on the field is queued to leave, and nothing leaves until staff apply', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    await rm.configure('slot2', other);

    expect(rm.stageReleaseAll('postMatch')).toBe(2);
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    const state = rm.getPendingState();
    expect(state.hold).toBe('pending');
    expect(state.changes).toEqual([
      { id: expect.any(String), kind: 'release', ssid: '1234-Comp', station: 'slot1', reason: 'postMatch' },
      { id: expect.any(String), kind: 'release', ssid: '5678', station: 'slot2', reason: 'postMatch' },
    ]);

    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')).toBeNull();
    expect(rm.getStationConfig('slot2')).toBeNull();
    expect(rm.getPendingState()).toEqual({ pending: false });
  });

  test('a robot that plays on stays: joining, or asking again, withdraws its release', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    await rm.configure('slot2', other);
    rm.stageReleaseAll('postMatch');

    expect(rm.keepRobot('1234-Comp')).toBe(true); // joined the next match
    expect(await rm.configure('slot2', other)).toEqual({ result: 'kept' }); // pressed Keep / Enable Wi-Fi
    expect(rm.getPendingState()).toEqual({ pending: false });
    expect(rm.getStationConfig('slot1')?.ssid).toBe('1234-Comp');
    expect(rm.getStationConfig('slot2')?.ssid).toBe('5678');
  });

  test("a team's own release is left alone by the match-end one", async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.setShouldHold(() => 'match');
    await rm.configure('slot1', { ssid: '', wpaKey: '' });

    expect(rm.stageReleaseAll('postMatch')).toBe(0);
    expect(rm.getPendingState().changes).toEqual([
      { id: expect.any(String), kind: 'release', ssid: '1234-Comp', station: 'slot1', reason: 'team' },
    ]);
  });

  test("a new robot takes a leaving robot's station in the same apply", async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.stageReleaseAll('postMatch');
    await rm.configure('slot1', other); // waits: the release is already waiting

    expect(rm.getPendingState().stagedChanges).toEqual({
      slot1: { ssid: '5678', internetAccess: undefined, secured: true },
    });
    await rm.applyPendingChanges();
    expect(rm.getStationConfig('slot1')?.ssid).toBe('5678');
  });

  test('staff can withdraw one change from the list', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    await rm.configure('slot2', other);
    rm.stageReleaseAll('postMatch');

    const [first] = rm.getPendingState().changes!;
    expect(rm.cancelPendingChange(first.id)).toBe(true);
    expect(rm.getPendingState().changes).toEqual([
      { id: expect.any(String), kind: 'release', ssid: '5678', station: 'slot2', reason: 'postMatch' },
    ]);
  });

  test('a field reset drops the list too', async () => {
    const rm = manager();
    await rm.configure('slot1', robot);
    rm.stageReleaseAll('postMatch');

    await rm.clearAllConfigurations();
    expect(rm.getStationConfig('slot1')).toBeNull();
    expect(rm.getPendingState()).toEqual({ pending: false });
  });
});

describe('who a station is for', () => {
  test('the projected team follows the list; the active team does not', async () => {
    const rm = manager();
    await rm.configure('slot1', robot); // 1234 on the radio
    rm.setShouldHold(() => 'match');

    await rm.configure('slot1', { ssid: '', wpaKey: '' }); // release waiting
    expect(rm.getTeamForStation('slot1')).toBe(1234);
    expect(rm.getProjectedTeamForStation('slot1')).toBeNull();

    await rm.configure('slot1', other); // 5678 wants slot1: free once 1234 leaves
    expect(rm.getProjectedTeamForStation('slot1')).toBe(5678);

    rm.cancelStagedChange('slot1'); // withdraws the enable landing there and the release of the robot there
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
