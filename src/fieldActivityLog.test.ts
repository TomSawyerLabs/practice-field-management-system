import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldActivityLog } from './fieldActivityLog.js';
import type { MatchHistoryEntry, StationName, TelemetryUpdate } from './types.js';

const T0 = new Date(2026, 8, 30, 18, 0, 0).getTime();

describe('FieldActivityLog', () => {
  let dir: string;
  let now: number;
  let teams: Partial<Record<StationName, number>>;
  let log: FieldActivityLog;

  const make = () =>
    new FieldActivityLog({ directory: dir, getTeamForStation: s => teams[s], now: () => now, tickMs: 0 });
  const telemetry = (station: StationName, enabled?: boolean): TelemetryUpdate => ({
    type: 'telemetry',
    station,
    timestamp: now,
    ...(enabled === undefined
      ? {}
      : {
          dsStatus: {
            eStop: false,
            aStop: false,
            robotComms: true,
            radioPing: true,
            rioPing: true,
            enabled,
            mode: 'teleOp' as const,
          },
        }),
  });
  /** Advance the clock in 5 s ticks, the way the real timer would. */
  const advance = (ms: number, each?: () => void) => {
    const until = now + ms;
    while (now < until) {
      now = Math.min(until, now + 5000);
      each?.();
      log.tick();
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pfms-activity-'));
    now = T0;
    teams = { slot1: 5940, slot2: 6036 };
    log = make();
    log.start();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a linked robot is one span; a link flap shorter than the hold does not split it', () => {
    log.onLinkState('slot1', true);
    advance(60_000);
    log.onLinkState('slot1', false);
    advance(20_000);
    log.onLinkState('slot1', true);
    advance(60_000);
    log.onLinkState('slot1', false);
    advance(60_000);
    const { robots } = log.spans(T0 - 1, now);
    expect(robots.map(r => [r.team, r.start - T0, r.end - T0, !!r.open])).toEqual([[5940, 0, 140_000, false]]);
  });

  test('telemetry alone is presence, and ends 15 s after it stops', () => {
    advance(30_000, () => log.onTelemetry(telemetry('slot2')));
    advance(60_000);
    const { robots } = log.spans(T0 - 1, now);
    expect(robots).toHaveLength(1);
    expect(robots[0].team).toBe(6036);
    expect(robots[0].end - T0).toBe(30_000);
  });

  test('enables are spans, and a DS that goes silent while enabled ends its enable', () => {
    log.onTelemetry(telemetry('slot1', true));
    advance(10_000, () => log.onTelemetry(telemetry('slot1', true)));
    log.onTelemetry(telemetry('slot1', false));
    advance(5_000, () => log.onTelemetry(telemetry('slot1', false)));
    log.onTelemetry(telemetry('slot1', true));
    advance(5_000, () => log.onTelemetry(telemetry('slot1', true)));
    // Silence.
    advance(30_000);
    const { enables } = log.spans(T0 - 1, now);
    expect(enables.map(e => [e.start - T0, e.end - T0])).toEqual([
      [0, 10_000],
      [15_000, 20_000],
    ]);
  });

  test('open spans are reported as open, ending now', () => {
    log.onTelemetry(telemetry('slot1', true));
    advance(10_000, () => log.onTelemetry(telemetry('slot1', true)));
    const { enables, robots } = log.spans(T0 - 1, now);
    expect(enables).toEqual([{ kind: 'enable', team: 5940, station: 'slot1', start: T0, end: now, open: true }]);
    expect(robots[0].open).toBe(true);
  });

  test('a station changing team closes the old team’s span', () => {
    log.onLinkState('slot1', true);
    advance(30_000);
    teams.slot1 = 971;
    log.onConfigChanged();
    advance(30_000);
    const { robots } = log.spans(T0 - 1, now);
    expect(robots.map(r => [r.team, r.start - T0, !!r.open])).toEqual([
      [5940, 0, false],
      [971, 30_000, true],
    ]);
  });

  test('after a restart, what was open ends where its evidence ended — not across the downtime', () => {
    log.onLinkState('slot1', true);
    log.onTelemetry(telemetry('slot1', true));
    advance(40_000, () => log.onTelemetry(telemetry('slot1', true)));
    expect(existsSync(join(dir, 'open.json'))).toBe(true);
    // The process dies here; an hour later a new one starts.
    now += 60 * 60_000;
    log = make();
    log.start();
    expect(existsSync(join(dir, 'open.json'))).toBe(false);
    const { robots, enables } = log.spans(T0 - 1, now);
    // As fresh as the last checkpoint (every 10 s).
    for (const span of [...robots, ...enables]) {
      expect(span.start).toBe(T0);
      expect(span.end - T0).toBeGreaterThanOrEqual(30_000);
      expect(span.end - T0).toBeLessThanOrEqual(40_000);
    }
    expect(robots).toHaveLength(1);
    expect(enables).toHaveLength(1);
    // And the log knows it started before this run.
    expect(log.loggedSince()).toBe(T0);
  });

  test('matches are logged once, re-logged when their scores change, and survive a restart', () => {
    const entry = (red: number): MatchHistoryEntry => ({
      matchNumber: 12,
      matchId: 'm-12',
      startedAt: T0,
      endedAt: T0 + 150_000,
      durationSeconds: 150,
      endReason: 'normal',
      autoWinner: null,
      teams: [{ station: 'slot1', teamNumber: 5940, alliance: 'red', matchSlot: null }],
      redScore: red,
      blueScore: 0,
    });
    log.onMatchHistory([entry(3)]);
    log.onMatchHistory([entry(3)]);
    log.onMatchHistory([entry(5)]);
    const file = readdirSync(dir).find(n => n.endsWith('.jsonl'))!;
    expect(readFileSync(join(dir, file), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(log.matches(T0 - 1, now + 1e6)).toEqual([
      {
        id: 'm-12',
        matchNumber: 12,
        start: T0,
        end: T0 + 150_000,
        teams: [{ team: 5940, alliance: 'red' }],
        red: 5,
        blue: 0,
      },
    ]);
    log = make();
    log.start();
    log.onMatchHistory([entry(5)]);
    expect(readFileSync(join(dir, file), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('a span is found from the day after it started (filed by its start day)', () => {
    now = new Date(2026, 8, 30, 23, 59, 0).getTime();
    const start = now;
    log.onLinkState('slot1', true);
    advance(5 * 60_000);
    log.onLinkState('slot1', false);
    advance(60_000);
    const morning = new Date(2026, 9, 1, 0, 1, 0).getTime();
    expect(log.spans(morning, morning + 1000).robots.map(r => r.start)).toEqual([start]);
  });
});
