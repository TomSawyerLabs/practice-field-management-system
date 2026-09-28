import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchQueue } from './matchQueue.js';
import { setupNextMatch, type MatchSetupDeps, type StageOutcome } from './matchSetup.js';
import type { Alliance, MatchState, StationName } from './types.js';

let dir: string;
let now: number;
/** A fresh queue with the line open (it starts closed by default). */
const queue = () => {
  const q = new MatchQueue(join(dir, 'queue.json'), { now: () => now });
  q.updateSettings({ lineOpen: true });
  return q;
};
/** The same file reopened, as after a restart. */
const reopen = () => new MatchQueue(join(dir, 'queue.json'), { now: () => now });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pfms-queue-'));
  now = 1_000_000;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the fill line', () => {
  test('teams join in order and can leave', () => {
    const q = queue();
    expect(q.joinLine(1)).toBe('joined');
    expect(q.joinLine(2, 'blue')).toBe('joined');
    expect(q.joinLine(1)).toBe('already');
    expect(q.linePosition(2)).toBe(2);
    expect(q.leaveLine(1)).toBe(true);
    expect(q.linePosition(2)).toBe(1);
    expect(q.getState().line.map(l => l.team)).toEqual([2]);
  });

  test('the line can be closed', () => {
    const q = queue();
    q.updateSettings({ lineOpen: false });
    expect(q.joinLine(1)).toBe('closed');
  });

  test('a team already in an upcoming match does not join the line', () => {
    const q = queue();
    q.add({ red: [1], blue: [2] });
    expect(q.joinLine(1)).toBe('queued');
  });

  test('forming a match takes the front of the line, honouring alliance preferences', () => {
    const q = queue();
    for (const [team, alliance] of [[1], [2, 'blue'], [3], [4, 'blue'], [5], [6], [7]] as [number, Alliance?][]) {
      q.joinLine(team, alliance);
    }
    const entry = q.formFromLine({ red: 3, blue: 3 })!;
    expect(entry.red).toEqual([1, 3, 5]);
    expect(entry.blue).toEqual([2, 4, 6]);
    expect(entry.source).toBe('line');
    expect(entry.status).toBe('queued');
    expect(q.getState().line.map(l => l.team)).toEqual([7]);
  });

  test('the shape is per match: 1v1 leaves the rest in line', () => {
    const q = queue();
    [1, 2, 3, 4].forEach(t => q.joinLine(t));
    const entry = q.formFromLine({ red: 1, blue: 1 })!;
    expect(entry.red).toEqual([1]);
    expect(entry.blue).toEqual([2]);
    expect(q.getState().line.map(l => l.team)).toEqual([3, 4]);
  });

  test('a short line forms a short match only when allowed', () => {
    const q = queue();
    q.joinLine(1);
    q.joinLine(2);
    expect(q.formFromLine({ red: 2, blue: 2 }, false)).toBeNull();
    expect(q.getState().line).toHaveLength(2);
    const entry = q.formFromLine({ red: 2, blue: 2 }, true)!;
    expect(entry.red).toEqual([1]);
    expect(entry.blue).toEqual([2]);
  });

  test('an empty line forms nothing', () => {
    expect(queue().formFromLine()).toBeNull();
  });
});

describe('the queue', () => {
  test('next is the first queued entry, or the one on deck', () => {
    const q = queue();
    const a = q.add({ red: [1], blue: [2] });
    const b = q.add({ red: [3], blue: [4] });
    expect(q.next()?.id).toBe(a.id);
    q.markOnDeck(b.id);
    expect(q.next()?.id).toBe(b.id);
    expect(q.get(b.id)?.onDeckAt).toBe(now);
  });

  test('numbers are given once and survive reordering; reorder, skip and requeue', () => {
    const q = queue();
    const a = q.add({ red: [1], blue: [2] });
    const b = q.add({ red: [3], blue: [4] });
    const c = q.add({ red: [5], blue: [6] });
    q.reorder([c.id, a.id]);
    expect(q.getState().entries.map(e => e.number)).toEqual([3, 1, 2]);
    expect(q.skip(c.id)).toBe(true);
    expect(q.next()?.id).toBe(a.id);
    expect(q.requeue(c.id)).toBe(true);
    expect(q.next()?.id).toBe(c.id);
    expect(q.remove(b.id)).toBe(true);
    expect(q.getState().entries).toHaveLength(2);
  });

  test('a match formed from the line goes ahead of the schedule', () => {
    const q = queue();
    q.add({ red: [1], blue: [2], source: 'schedule', scheduledAt: now + 60_000 });
    q.add({ red: [3], blue: [4], source: 'schedule', scheduledAt: now + 120_000 });
    q.joinLine(5);
    q.joinLine(6);
    const formed = q.formFromLine({ red: 1, blue: 1 })!;
    expect(q.getState().entries[0].id).toBe(formed.id);
    expect(q.next()?.id).toBe(formed.id);
  });

  test('replacing a no-show pulls the next team from the line and sends it to the back', () => {
    const q = queue();
    q.joinLine(1);
    q.joinLine(2);
    q.joinLine(3);
    const entry = q.formFromLine({ red: 1, blue: 1 })!; // 1 vs 2; 3 waits
    expect(q.replaceTeam(entry.id, 1)).toEqual({ replaced: true, withTeam: 3 });
    expect(q.get(entry.id)?.red).toEqual([3]);
    expect(q.getState().line.map(l => l.team)).toEqual([1]);
    // With nobody left in line, the no-show is simply dropped.
    q.leaveLine(1);
    expect(q.replaceTeam(entry.id, 3)).toEqual({ replaced: true, withTeam: undefined });
    expect(q.get(entry.id)?.red).toEqual([]);
  });

  test('a scheduled no-show is dropped, not sent to the line', () => {
    const q = queue();
    const entry = q.add({ red: [1], blue: [2], source: 'schedule' });
    q.replaceTeam(entry.id, 1);
    expect(q.getState().line).toEqual([]);
  });

  test('follows the engine: on deck → playing → played', () => {
    const q = queue();
    const entry = q.add({ red: [1], blue: [2] });
    q.markOnDeck(entry.id);
    const engine = fakeEngine('created');
    q.attach(engine);
    engine.set('countdown');
    expect(q.get(entry.id)?.status).toBe('playing');
    expect(q.get(entry.id)?.matchId).toBe('m1');
    engine.set('teleop');
    engine.set('postMatch');
    expect(q.get(entry.id)?.status).toBe('played');
    expect(q.next()).toBeUndefined();
  });

  test('no-shows are the on-deck teams that have not shown once the clock runs out', () => {
    const q = queue();
    const here = new Set<number>([2]);
    q.setPresenceResolver(team => here.has(team));
    q.updateSettings({ noShowMinutes: 5 });
    const entry = q.add({ red: [1], blue: [2] });
    q.markOnDeck(entry.id);
    expect(q.getState().noShows).toBeUndefined();
    now += 5 * 60_000;
    expect(q.getState().noShows).toEqual([1]);
    here.add(1);
    expect(q.getState().noShows).toBeUndefined();
  });

  test('survives a restart, and a match that was playing counts as played', () => {
    const q = queue();
    const a = q.add({ red: [1], blue: [2] });
    q.add({ red: [3], blue: [4] });
    q.joinLine(9);
    q.updateSettings({ shape: { red: 2, blue: 2 }, lineOpen: false });
    q.markOnDeck(a.id);
    const engine = fakeEngine('created');
    q.attach(engine);
    engine.set('auto');

    const again = reopen();
    const state = again.getState();
    expect(state.entries.map(e => e.status)).toEqual(['played', 'queued']);
    expect(state.line.map(l => l.team)).toEqual([9]);
    expect(state.settings).toMatchObject({ shape: { red: 2, blue: 2 }, lineOpen: false });
  });

  test('clear drops played entries, or everything but the match in play', () => {
    const q = queue();
    const a = q.add({ red: [1], blue: [2] });
    q.add({ red: [3], blue: [4] });
    q.markOnDeck(a.id);
    const engine = fakeEngine('created');
    q.attach(engine);
    engine.set('auto');
    engine.set('postMatch');
    q.clear(true);
    expect(q.getState().entries.map(e => e.red[0])).toEqual([3]);
    q.clear();
    expect(q.getState().entries).toEqual([]);
  });
});

describe('set up next match', () => {
  function deps(q: MatchQueue) {
    const staged: number[][] = [];
    let applied = 0;
    const stations = new Map<number, StationName>([
      [1, 'slot1'],
      [2, 'slot2'],
      [3, 'slot4'],
    ]);
    const joined = new Map<StationName, Alliance>();
    let phase = 'idle';
    const noCredentials = new Set<number>();
    const d: MatchSetupDeps = {
      queue: q,
      engine: {
        getPhase: () => phase,
        hasJoined: () => joined.size > 0,
        createMatch: () => {
          phase = 'created';
        },
        joinStationAlliance: (station, alliance) => {
          joined.set(station, alliance);
        },
        isJoined: station => joined.has(station),
      },
      radio: {
        stageRobots: async teams => {
          staged.push(teams);
          return new Map<number, StageOutcome>(teams.map(t => [t, noCredentials.has(t) ? 'noCredentials' : 'staged']));
        },
        apply: async () => {
          applied++;
        },
        stationForTeam: team => stations.get(team) ?? null,
      },
    };
    return {
      d,
      staged,
      applied: () => applied,
      joined,
      phase: () => phase,
      setPhase: (p: string) => {
        phase = p;
      },
      stations,
      noCredentials,
    };
  }

  test('stages every robot in one batch, applies once, creates the match and joins each robot', async () => {
    const q = queue();
    const entry = q.add({ red: [1, 2], blue: [3] });
    const t = deps(q);
    const result = await setupNextMatch(t.d, undefined, 'all');
    expect(result.problems).toEqual([]);
    expect(t.staged).toEqual([[1, 2, 3]]);
    expect(t.applied()).toBe(1);
    expect(t.phase()).toBe('created');
    expect([...t.joined]).toEqual([
      ['slot1', 'red'],
      ['slot2', 'red'],
      ['slot4', 'blue'],
    ]);
    expect(q.get(entry.id)?.status).toBe('onDeck');
  });

  test('a team with no saved Wi-Fi is reported and the rest is still set up', async () => {
    const q = queue();
    q.add({ red: [1], blue: [3] });
    const t = deps(q);
    t.noCredentials.add(3);
    t.stations.delete(3);
    const result = await setupNextMatch(t.d, undefined, 'all');
    expect(result.problems).toEqual([
      'Team 3 has no saved Wi-Fi — they need to enable it from their page once',
      'Team 3 has no robot on the field yet — it can join from its page when it does',
    ]);
    expect([...t.joined]).toEqual([['slot1', 'red']]);
  });

  test('wifi only leaves the match alone; match only leaves the radio alone', async () => {
    const q = queue();
    q.add({ red: [1], blue: [2] });
    const t = deps(q);
    await setupNextMatch(t.d, undefined, 'wifi');
    expect(t.applied()).toBe(1);
    expect(t.phase()).toBe('idle');
    await setupNextMatch(t.d, undefined, 'match');
    expect(t.applied()).toBe(1);
    expect(t.phase()).toBe('created');
    expect(t.joined.size).toBe(2);
  });

  test('refuses to create while a match is running, and with nothing queued', async () => {
    const q = queue();
    const t = deps(q);
    expect((await setupNextMatch(t.d, undefined, 'all')).problems).toEqual(['Nothing in the queue to set up']);
    q.add({ red: [1], blue: [2] });
    t.setPhase('teleop');
    const result = await setupNextMatch(t.d, undefined, 'match');
    expect(result.problems).toEqual(['A match is running — the next one can be created when it ends']);
    expect(t.joined.size).toBe(0);
  });
});

function fakeEngine(initial: MatchState['phase']) {
  const listeners: ((s: MatchState) => void)[] = [];
  let phase = initial;
  const getState = () => ({ phase, matchId: 'm1' }) as unknown as MatchState;
  return {
    addStateListener(fn: (s: MatchState) => void) {
      listeners.push(fn);
      return () => {};
    },
    getState,
    set(p: MatchState['phase']) {
      phase = p;
      for (const l of listeners) l(getState());
    },
  };
}
