import type { QueueShape } from './types.js';

/**
 * A day's schedule from a team list: every team plays about the same
 * number of matches, no team twice in one match, and back-to-back
 * appearances are avoided as far as the numbers allow. Pure and shared
 * with the frontend (the queue page generates client-side and imports the
 * result), so no Node imports here.
 */

export type ScheduleInput = {
  teams: number[];
  matchesPerTeam: number;
  shape: QueueShape;
  /** Epoch ms of the first match; with `intervalMinutes`, each match gets a time. */
  startAt?: number;
  intervalMinutes?: number;
  /** Deterministic shuffles for tests. */
  seed?: number;
};

export type ScheduleMatch = { red: number[]; blue: number[]; scheduledAt?: number };

/** Small deterministic PRNG (mulberry32) so a seed gives the same schedule. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSchedule(input: ScheduleInput): ScheduleMatch[] {
  const teams = Array.from(new Set(input.teams.filter(t => Number.isInteger(t) && t > 0)));
  const perMatch = input.shape.red + input.shape.blue;
  if (teams.length === 0 || perMatch === 0 || input.matchesPerTeam <= 0) return [];
  const random = rng(input.seed ?? Date.now());
  const shuffle = <T>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const slotsPerMatch = Math.min(perMatch, teams.length);
  const totalMatches = Math.ceil((teams.length * input.matchesPerTeam) / slotsPerMatch);
  const played = new Map<number, number>(teams.map(t => [t, 0]));
  const lastMatch = new Map<number, number>(teams.map(t => [t, -Infinity]));
  const matches: ScheduleMatch[] = [];

  for (let m = 0; m < totalMatches; m++) {
    // Fewest appearances first, then longest since last played; ties in a
    // shuffled order so the same teams don't always land together.
    const order = shuffle(teams).sort((a, b) => {
      const byCount = played.get(a)! - played.get(b)!;
      if (byCount !== 0) return byCount;
      return lastMatch.get(a)! - lastMatch.get(b)!;
    });
    const picked = order.slice(0, slotsPerMatch);
    // Alliances: split the pick in the shape's proportions, shuffled so a
    // team is not always red.
    const assigned = shuffle(picked);
    const redCount = Math.min(input.shape.red, assigned.length);
    const red = assigned.slice(0, redCount);
    const blue = assigned.slice(redCount, redCount + input.shape.blue);
    for (const t of [...red, ...blue]) {
      played.set(t, played.get(t)! + 1);
      lastMatch.set(t, m);
    }
    const scheduledAt =
      input.startAt !== undefined && input.intervalMinutes
        ? input.startAt + m * input.intervalMinutes * 60_000
        : undefined;
    matches.push({ red, blue, scheduledAt });
  }
  return matches;
}

/**
 * Parse a pasted schedule. One match per line, in either form:
 *   14:05  1234 5678 9012 v 2468 1357 8642
 *   14:05, 1234, 5678, 9012, 2468, 1357, 8642      (red first, then blue; shape decides the split)
 *   red: 1234 5678 | blue: 2468 1357
 * The time is optional. Blank lines and lines starting with # are skipped.
 * Returns the matches and the lines it could not read.
 */
export function parseSchedule(
  text: string,
  shape: QueueShape,
  dayStart = new Date(),
): { matches: ScheduleMatch[]; bad: string[] } {
  const matches: ScheduleMatch[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let rest = line;
    let scheduledAt: number | undefined;
    const time = /^(\d{1,2}):(\d{2})\s*[,\s]?\s*/.exec(rest);
    if (time) {
      const d = new Date(dayStart);
      d.setHours(Number(time[1]), Number(time[2]), 0, 0);
      scheduledAt = d.getTime();
      rest = rest.slice(time[0].length);
    }
    let red: number[];
    let blue: number[];
    const labelled = /red:\s*([^|]*)\|\s*blue:\s*(.*)$/i.exec(rest);
    const versus = /^(.*?)\s+(?:v|vs|versus)\s+(.*)$/i.exec(rest);
    const nums = (s: string) =>
      s
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map(Number);
    if (labelled) {
      red = nums(labelled[1]);
      blue = nums(labelled[2]);
    } else if (versus) {
      red = nums(versus[1]);
      blue = nums(versus[2]);
    } else {
      const all = nums(rest);
      red = all.slice(0, shape.red);
      blue = all.slice(shape.red, shape.red + shape.blue);
    }
    red = red.slice(0, 3);
    blue = blue.slice(0, 3);
    const all = [...red, ...blue];
    if (all.length === 0 || new Set(all).size !== all.length) {
      bad.push(line);
      continue;
    }
    matches.push({ red, blue, scheduledAt });
  }
  return { matches, bad };
}
