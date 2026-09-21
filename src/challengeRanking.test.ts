import { describe, expect, test } from 'bun:test';
import { leaderboardRows } from './challengeRanking.js';
import type { Alliance, ChallengeTally, ChallengeTiming, MatchHistoryEntry } from './types.js';

let nextEnd = 1_700_000_000_000;

/** A finished challenge run, as match history records it. */
function run(
  timing: ChallengeTiming,
  alliances: Partial<Record<Alliance, { teams: number[]; tally: ChallengeTally }>>,
  costs?: { penaltyLaps?: number; penaltySeconds?: number },
): MatchHistoryEntry {
  const endedAt = (nextEnd += 60_000);
  const tally: Partial<Record<Alliance, ChallengeTally>> = {};
  const teams: MatchHistoryEntry['teams'] = [];
  for (const [alliance, side] of Object.entries(alliances) as [
    Alliance,
    { teams: number[]; tally: ChallengeTally },
  ][]) {
    tally[alliance] = side.tally;
    for (const teamNumber of side.teams) {
      teams.push({ station: 'slot1', teamNumber, alliance, matchSlot: null });
    }
  }
  return {
    matchNumber: 1,
    startedAt: endedAt - 60_000,
    endedAt,
    durationSeconds: 60,
    endReason: 'normal',
    autoWinner: null,
    teams,
    redScore: 0,
    blueScore: 0,
    challenge: { timing, ...costs, tally },
  };
}

describe('window runs rank by laps', () => {
  test('most laps first, penalties already deducted', () => {
    const rows = leaderboardRows(
      [
        run('window', { red: { teams: [5940], tally: { laps: 5, penalties: 0 } } }),
        run('window', { red: { teams: [254], tally: { laps: 8, penalties: 2 } } }),
        run('window', { red: { teams: [1678], tally: { laps: 7, penalties: 0 } } }),
      ],
      'window',
    );
    expect(rows.map(r => r.teams[0])).toEqual([1678, 254, 5940]);
    expect(rows[1].laps).toBe(6);
  });

  test('a team is ranked on its best attempt, with every run counted', () => {
    const rows = leaderboardRows(
      [
        run('window', { red: { teams: [5940], tally: { laps: 2, penalties: 0 } } }),
        run('window', { red: { teams: [5940], tally: { laps: 9, penalties: 0 } } }),
        run('window', { red: { teams: [5940], tally: { laps: 4, penalties: 0 } } }),
      ],
      'window',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ laps: 9, attempts: 3 });
  });

  test('a tie goes to whoever got there first', () => {
    const first = run('window', { red: { teams: [5940], tally: { laps: 4, penalties: 0 } } });
    const second = run('window', { red: { teams: [254], tally: { laps: 4, penalties: 0 } } });
    expect(leaderboardRows([first, second], 'window').map(r => r.teams[0])).toEqual([5940, 254]);
  });

  test('head-to-head runs put both alliances on the board', () => {
    const rows = leaderboardRows(
      [
        run('window', {
          red: { teams: [5940], tally: { laps: 3, penalties: 0 } },
          blue: { teams: [254, 1678], tally: { laps: 6, penalties: 0 } },
        }),
      ],
      'window',
    );
    expect(rows.map(r => r.key)).toEqual(['254+1678', '5940']);
  });
});

describe('stopwatch runs rank by time', () => {
  test('fastest first, penalties already added', () => {
    const rows = leaderboardRows(
      [
        run('stopwatch', { red: { teams: [5940], tally: { laps: 1, penalties: 0, finishedAt: 31 } } }),
        run('stopwatch', { red: { teams: [254], tally: { laps: 1, penalties: 2, finishedAt: 25 } } }),
      ],
      'stopwatch',
    );
    // 254 ran 25s but took two penalties: 35s, so 5940's clean 31s wins
    expect(rows.map(r => r.teams[0])).toEqual([5940, 254]);
    expect(rows[1].seconds).toBe(35);
  });

  test('a finish beats a DNF however many laps the DNF managed', () => {
    const rows = leaderboardRows(
      [
        run('stopwatch', { red: { teams: [5940], tally: { laps: 40, penalties: 0 } } }),
        run('stopwatch', { red: { teams: [254], tally: { laps: 1, penalties: 0, finishedAt: 99 } } }),
      ],
      'stopwatch',
    );
    expect(rows.map(r => r.teams[0])).toEqual([254, 5940]);
    expect(rows[1].seconds).toBeNull();
  });

  test('a DNF does not displace the same team an earlier finish', () => {
    const rows = leaderboardRows(
      [
        run('stopwatch', { red: { teams: [5940], tally: { laps: 1, penalties: 0, finishedAt: 42 } } }),
        run('stopwatch', { red: { teams: [5940], tally: { laps: 0, penalties: 0 } } }),
      ],
      'stopwatch',
    );
    expect(rows[0]).toMatchObject({ seconds: 42, attempts: 2 });
  });
});

describe('the two timings never mix', () => {
  test('each table only sees its own runs', () => {
    const matches = [
      run('window', { red: { teams: [5940], tally: { laps: 5, penalties: 0 } } }),
      run('stopwatch', { red: { teams: [254], tally: { laps: 1, penalties: 0, finishedAt: 20 } } }),
    ];
    expect(leaderboardRows(matches, 'window').map(r => r.teams[0])).toEqual([5940]);
    expect(leaderboardRows(matches, 'stopwatch').map(r => r.teams[0])).toEqual([254]);
  });

  test('official matches are not on the board at all', () => {
    const match = run('window', { red: { teams: [5940], tally: { laps: 5, penalties: 0 } } });
    delete match.challenge;
    expect(leaderboardRows([match], 'window')).toEqual([]);
  });
});

describe('each run is ranked by the penalty cost it was run under', () => {
  test('a run recorded with a heavier penalty keeps it', () => {
    const rows = leaderboardRows(
      [
        // Five laps, two penalties, but penalties cost 2 laps that run: 1
        run('window', { red: { teams: [5940], tally: { laps: 5, penalties: 2 } } }, { penaltyLaps: 2 }),
        // Four laps, one penalty at the default 1 lap: 3
        run('window', { red: { teams: [254], tally: { laps: 4, penalties: 1 } } }),
      ],
      'window',
    );
    expect(rows.map(r => r.teams[0])).toEqual([254, 5940]);
    expect(rows.map(r => r.laps)).toEqual([3, 1]);
  });

  test('a free penalty leaves a stopwatch time untouched', () => {
    const rows = leaderboardRows(
      [
        run(
          'stopwatch',
          { red: { teams: [5940], tally: { laps: 1, penalties: 4, finishedAt: 20 } } },
          { penaltySeconds: 0 },
        ),
      ],
      'stopwatch',
    );
    expect(rows[0].seconds).toBe(20);
  });
});
