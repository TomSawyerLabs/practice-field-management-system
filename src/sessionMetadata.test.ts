import { describe, expect, test } from 'bun:test';
import { activityFor, summarizeMetadata } from './sessionMetadata.js';
import type { ProcessedScoreEvent, RecordingMetadata, TelemetrySample } from './types.js';

const T0 = 1_760_000_000_000;

/** A counted ball for `alliance`, `atSeconds` into the recording. */
function ball(
  atSeconds: number,
  alliance: 'red' | 'blue',
  extra: Partial<ProcessedScoreEvent> = {},
): ProcessedScoreEvent {
  return {
    id: `evt-${atSeconds}-${alliance}`,
    source: 'test',
    alliance,
    element: 'ball',
    count: 1,
    pointValue: 1,
    awardedTo: alliance,
    timestamp: T0 + atSeconds * 1000,
    occurredAt: T0 + atSeconds * 1000,
    lagMs: 0,
    timing: 'age',
    deduplicated: false,
    ...extra,
  };
}

function sample(atSeconds: number, enabled: boolean, teamNumber = 5940): TelemetrySample {
  return { t: T0 + atSeconds * 1000, station: 'slot1', teamNumber, enabled, batteryVoltage: 12.3 };
}

function meta(
  scoreEvents: ProcessedScoreEvent[],
  telemetry: TelemetrySample[],
  durationSeconds = 20,
): RecordingMetadata {
  return {
    version: 1,
    kind: 'practice',
    id: 'practice-test',
    startedAt: T0,
    endedAt: T0 + durationSeconds * 1000,
    teams: [{ station: 'slot1', teamNumber: 5940, alliance: null }],
    scoreEvents,
    telemetry,
  };
}

describe('activityFor', () => {
  test('bins balls onto the video timeline, per alliance', () => {
    const a = activityFor(meta([ball(1, 'red'), ball(1.4, 'red'), ball(9, 'blue')], []));
    expect(a.binSeconds).toBe(0.5);
    expect(a.red.length).toBe(40); // 20 s of video at half-second bins
    expect(a.blue.length).toBe(a.red.length);
    // 1.0 s and 1.4 s land in the same half-second bin; 9 s is the blue one.
    expect(a.red[2]).toBe(2);
    expect(a.blue[18]).toBe(1);
    expect(a.red.reduce((x, y) => x + y, 0)).toBe(2);
    expect(a.blue.reduce((x, y) => x + y, 0)).toBe(1);
  });

  test('a ball that did not count is not on the map', () => {
    const events = [
      ball(2, 'red', { deduplicated: true }),
      ball(3, 'red', { goalInactive: true }),
      ball(4, 'red', { outsideMatch: true }),
      ball(5, 'red', { phaseRestricted: true }),
      ball(6, 'red'),
    ];
    const a = activityFor(meta(events, []));
    expect(a.red.reduce((x, y) => x + y, 0)).toBe(1);
    // The score chips and the strip agree on what counted.
    expect(summarizeMetadata(meta(events, [])).scored.red).toBe(1);
  });

  test('balls outside the recording window are dropped, not clamped in', () => {
    const a = activityFor(meta([ball(-2, 'red'), ball(25, 'blue'), ball(10, 'red')], []));
    expect(a.red.reduce((x, y) => x + y, 0)).toBe(1);
    expect(a.blue.reduce((x, y) => x + y, 0)).toBe(0);
  });

  test('bins get coarser so a long recording stays a small payload', () => {
    const hour = activityFor(meta([], [], 3600));
    expect(hour.red.length).toBeLessThanOrEqual(120);
    expect(hour.binSeconds).toBeGreaterThan(0.5);
    const short = activityFor(meta([], [], 12));
    expect(short.binSeconds).toBe(0.5);
  });

  test('enabled spans come from the DS status, including a gap the clip kept', () => {
    // Enabled 3–5, stopped, enabled again 10–14: the shape of a merged clip.
    const a = activityFor(
      meta(
        [],
        [sample(1, false), sample(3, true), sample(5, false), sample(10, true), sample(14, false), sample(16, false)],
      ),
    );
    expect(a.enabled).toEqual([
      { from: 3, to: 5 },
      { from: 10, to: 14 },
    ]);
  });

  test('a one-sample blink does not split a span', () => {
    const a = activityFor(meta([], [sample(3, true), sample(5, false), sample(5.2, true), sample(9, false)]));
    expect(a.enabled).toEqual([{ from: 3, to: 9 }]);
  });

  test('still enabled at the end closes at the end of the video', () => {
    const a = activityFor(meta([], [sample(2, true)], 20));
    expect(a.enabled).toEqual([{ from: 2, to: 20 }]);
  });

  test('only this team is on the strip', () => {
    const a = activityFor(
      meta([], [sample(2, true, 5940), sample(3, true, 6036), sample(8, false, 5940), sample(9, false, 6036)]),
      5940,
    );
    expect(a.enabled).toEqual([{ from: 2, to: 8 }]);
  });

  test('a recording with nothing in it still has a well-formed map', () => {
    const a = activityFor(meta([], [], 0));
    expect(a.red.length).toBe(1);
    expect(a.enabled).toEqual([]);
  });
});
