import { describe, expect, test } from 'bun:test';
import { generateSchedule, parseSchedule } from './scheduleGenerator.js';

describe('generating a schedule', () => {
  test('every team plays the asked number of matches, never against itself, rarely back to back', () => {
    const teams = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const matches = generateSchedule({ teams, matchesPerTeam: 3, shape: { red: 2, blue: 2 }, seed: 7 });
    // 10 teams × 3 = 30 slots ÷ 4 per match = 8 matches (rounded up).
    expect(matches).toHaveLength(8);
    const count = new Map<number, number>();
    let backToBack = 0;
    let previous = new Set<number>();
    for (const m of matches) {
      const all = [...m.red, ...m.blue];
      expect(new Set(all).size).toBe(all.length);
      expect(m.red).toHaveLength(2);
      expect(m.blue).toHaveLength(2);
      for (const t of all) {
        count.set(t, (count.get(t) ?? 0) + 1);
        if (previous.has(t)) backToBack++;
      }
      previous = new Set(all);
    }
    for (const t of teams) expect(count.get(t)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...count.values()) - Math.min(...count.values())).toBeLessThanOrEqual(1);
    expect(backToBack).toBe(0);
  });

  test('fewer teams than the shape needs still forms matches, and times step by the interval', () => {
    const start = Date.parse('2026-09-28T16:00:00Z');
    const matches = generateSchedule({
      teams: [1, 2, 3],
      matchesPerTeam: 2,
      shape: { red: 3, blue: 3 },
      startAt: start,
      intervalMinutes: 10,
      seed: 1,
    });
    expect(matches).toHaveLength(2);
    expect(matches[0].red.length + matches[0].blue.length).toBe(3);
    expect(matches.map(m => m.scheduledAt)).toEqual([start, start + 10 * 60_000]);
  });

  test('the same seed gives the same schedule; nothing to schedule gives nothing', () => {
    const a = generateSchedule({ teams: [1, 2, 3, 4], matchesPerTeam: 2, shape: { red: 1, blue: 1 }, seed: 42 });
    const b = generateSchedule({ teams: [1, 2, 3, 4], matchesPerTeam: 2, shape: { red: 1, blue: 1 }, seed: 42 });
    expect(a).toEqual(b);
    expect(generateSchedule({ teams: [], matchesPerTeam: 2, shape: { red: 1, blue: 1 } })).toEqual([]);
    expect(generateSchedule({ teams: [1], matchesPerTeam: 0, shape: { red: 1, blue: 1 } })).toEqual([]);
  });
});

describe('parsing a pasted schedule', () => {
  const day = new Date('2026-09-28T12:00:00');
  test('reads times, "v", labels and plain lists, and reports bad lines', () => {
    const { matches, bad } = parseSchedule(
      [
        '# morning',
        '14:05 1234 5678 9012 v 2468 1357 8642',
        '14:15, 1, 2, 3, 4',
        'red: 10 20 | blue: 30',
        '5 5 6 v 7',
        '',
        'nothing here',
      ].join('\n'),
      { red: 2, blue: 2 },
      day,
    );
    expect(matches).toHaveLength(3);
    expect(matches[0].red).toEqual([1234, 5678, 9012]);
    expect(matches[0].blue).toEqual([2468, 1357, 8642]);
    expect(new Date(matches[0].scheduledAt!).getHours()).toBe(14);
    expect(new Date(matches[0].scheduledAt!).getMinutes()).toBe(5);
    expect(matches[1]).toMatchObject({ red: [1, 2], blue: [3, 4] });
    expect(matches[2]).toMatchObject({ red: [10, 20], blue: [30], scheduledAt: undefined });
    expect(bad).toEqual(['5 5 6 v 7', 'nothing here']);
  });
});
