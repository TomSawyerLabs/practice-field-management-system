import { describe, expect, test } from 'bun:test';
import type { RobotDropout, StationDropouts } from '../../../src/types';
import { describeDropoutRow, describeDropoutsForTeam, dropoutStaffIssues, RECENT_DROPOUT_MS } from './robotDropouts';

const NOW = 10_000_000;

function dropout(over: Partial<RobotDropout> = {}): RobotDropout {
  const endedAt = over.endedAt ?? NOW - 60_000;
  const durationMs = over.durationMs ?? 1_200;
  return { kind: 'robot', cause: 'unknown', startedAt: endedAt - durationMs, endedAt, durationMs, ...over };
}

function station(dropouts: RobotDropout[], brownouts: StationDropouts['brownouts'] = { count: 0 }): StationDropouts {
  return { team: 114, since: NOW - 3_600_000, dropouts, brownouts };
}

describe('describeDropoutsForTeam', () => {
  test('nothing to say', () => {
    expect(describeDropoutsForTeam(undefined, NOW)).toBeNull();
    expect(describeDropoutsForTeam(station([]), NOW)).toBeNull();
  });

  test('brownout dropouts point at the battery', () => {
    const a = describeDropoutsForTeam(
      station(
        [
          dropout({ cause: 'brownout', minBatteryVoltage: 6.9, endedAt: NOW - 120_000 }),
          dropout({ cause: 'brownout', minBatteryVoltage: 6.61, durationMs: 1_620 }),
        ],
        { count: 2, minVoltage: 6.61 },
      ),
      NOW,
    )!;
    expect(a.severity).toBe('warning');
    expect(a.title).toBe(
      'Your robot lost its connection twice in the last 15 minutes, each during a brownout (longest 1.6 s).',
    );
    expect(a.lines[0]).toContain('sagged to 6.6 V');
    expect(a.lines[1]).toContain('fully charged battery');
    // Newest first.
    expect(a.recent.map(d => d.minBatteryVoltage)).toEqual([6.61, 6.9]);
  });

  test('three or more, or a long one, is an error', () => {
    const three = [1, 2, 3].map(i => dropout({ endedAt: NOW - i * 60_000 }));
    expect(describeDropoutsForTeam(station(three), NOW)!.severity).toBe('error');
    expect(describeDropoutsForTeam(station([dropout({ durationMs: 2_500 })]), NOW)!.severity).toBe('error');
  });

  test('laptop-only dropouts point at the laptop', () => {
    const a = describeDropoutsForTeam(station([dropout({ kind: 'laptop' })]), NOW)!;
    expect(a.title).toBe('Your Driver Station laptop dropped out once in the last 15 minutes (longest 1.2 s).');
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toContain('Wi-Fi power saving');
  });

  test('mixed causes get a line each', () => {
    const a = describeDropoutsForTeam(
      station([dropout({ cause: 'brownout', minBatteryVoltage: 6.7 }), dropout(), dropout({ kind: 'laptop' })]),
      NOW,
    )!;
    expect(a.title).toBe('Your robot lost its connection 3 times in the last 15 minutes (longest 1.2 s).');
    expect(a.lines).toHaveLength(4);
    expect(a.lines[2]).toContain('Other times');
  });

  test('old dropouts and brownouts become a quiet summary', () => {
    const old = dropout({ endedAt: NOW - RECENT_DROPOUT_MS - 1 });
    const a = describeDropoutsForTeam(station([old], { count: 3, minVoltage: 6.72 }), NOW)!;
    expect(a.severity).toBe('info');
    expect(a.title).toBe(
      'Earlier this visit your robot browned out 3 times (lowest 6.7 V) and lost its connection once.',
    );
    expect(a.recent).toEqual([]);
  });

  test('recent dropouts mention how many were earlier', () => {
    const a = describeDropoutsForTeam(station([dropout({ endedAt: NOW - RECENT_DROPOUT_MS - 1 }), dropout()]), NOW)!;
    expect(a.earlier).toBe(1);
    expect(a.recent).toHaveLength(1);
  });
});

describe('describeDropoutRow', () => {
  test('brownout with voltage', () => {
    expect(describeDropoutRow(dropout({ cause: 'brownout', minBatteryVoltage: 6.61, durationMs: 1_420 }))).toBe(
      '1.4 s — robot silent, brownout, 6.6 V',
    );
  });
  test('laptop', () => {
    expect(describeDropoutRow(dropout({ kind: 'laptop', durationMs: 800 }))).toBe('0.8 s — laptop stopped sending');
  });
});

describe('dropoutStaffIssues', () => {
  test('one issue per station with recent dropouts', () => {
    const issues = dropoutStaffIssues(
      {
        slot1: station([dropout({ cause: 'brownout', minBatteryVoltage: 6.6 })]),
        slot2: station([dropout({ endedAt: NOW - RECENT_DROPOUT_MS - 1 })]),
      },
      NOW,
      (_s, team) => `${team}`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'dropouts-slot1',
      severity: 'info',
      title: '114 lost its connection once in the last 15 minutes',
      detail: 'longest 1.2 s, 1 with a brownout (down to 6.6 V)',
    });
    expect(issues[0].fix).toContain('Battery');
  });
});
