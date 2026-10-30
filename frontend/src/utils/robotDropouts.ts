/**
 * What to tell a team about its robot's short connection dropouts and
 * brownouts (src/robotDropouts.ts), and what to tell staff on /csa.
 *
 * Pure: no hooks, no clock reads, no locale, so it can be unit tested. The
 * page formats the times.
 */
import type { RobotDropout, StationDropouts, StationName } from '../../../src/types';
import type { FieldIssue } from './fieldIssues';

/** Dropouts this recent are a live problem; older ones are a summary line. */
export const RECENT_DROPOUT_MS = 15 * 60_000;
/** Dropouts listed one by one on the team page. */
const LISTED = 5;

export type DropoutAdvice = {
  severity: 'error' | 'warning' | 'info';
  title: string;
  /** What it means and what to try, a sentence or two each. */
  lines: string[];
  /** Newest first, at most a handful, for a "when" list. */
  recent: RobotDropout[];
  /** Dropouts earlier this visit, not in `recent`'s window. */
  earlier: number;
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const volts = (v: number | undefined) => (v === undefined ? undefined : `${v.toFixed(1)} V`);
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** The team page's warning for one station, or null when there is nothing
 *  worth saying. */
export function describeDropoutsForTeam(st: StationDropouts | undefined, now: number): DropoutAdvice | null {
  if (!st) return null;
  const recent = st.dropouts.filter(d => now - d.endedAt <= RECENT_DROPOUT_MS);
  const earlier = st.dropouts.length - recent.length;
  const listed = [...recent].reverse().slice(0, LISTED);

  if (recent.length === 0) {
    if (earlier === 0 && st.brownouts.count === 0) return null;
    const lowest = volts(st.brownouts.minVoltage);
    const parts: string[] = [];
    if (st.brownouts.count > 0) {
      parts.push(`browned out ${times(st.brownouts.count)}${lowest ? ` (lowest ${lowest})` : ''}`);
    }
    if (earlier > 0) parts.push(`lost its connection ${times(earlier)}`);
    return {
      severity: 'info',
      title: `Earlier this visit your robot ${parts.join(' and ')}.`,
      lines:
        st.brownouts.count > 0
          ? ['A brownout turns the motors off for a moment; a deep one also cuts the robot’s connection.']
          : [],
      recent: [],
      earlier,
    };
  }

  const robot = recent.filter(d => d.kind === 'robot');
  const brownout = robot.filter(d => d.cause === 'brownout');
  const laptop = recent.filter(d => d.kind === 'laptop');
  const longest = Math.max(...recent.map(d => d.durationMs));
  const lowest = volts(minOf(recent.map(d => d.minBatteryVoltage)) ?? st.brownouts.minVoltage);
  const lines: string[] = [];

  if (brownout.length > 0) {
    lines.push(
      `Each time, its battery sagged${lowest ? ` to ${lowest}` : ''} and the robot stopped answering its Driver Station. ` +
        'A brownout this deep cuts the robot’s network: it disables, and NetworkTables and dashboards disconnect.',
      'Try a fresh, fully charged battery. Check that the battery leads, main breaker and power connections are tight, and lower your motor current limits.',
    );
  }
  if (robot.length > brownout.length) {
    lines.push(
      `${brownout.length > 0 ? 'Other times' : 'Each time'} the robot stopped answering with its battery fine. ` +
        'Check the radio’s power and the Ethernet cable between the radio and the roboRIO, and whether the robot code is overloading the roboRIO.',
    );
  }
  if (laptop.length > 0) {
    lines.push(
      `The Driver Station laptop itself stopped sending ${times(laptop.length)}. That’s the laptop’s side: its Wi-Fi, or the Driver Station pausing. ` +
        'Sit closer to the access point, close heavy programs, and turn off Wi-Fi power saving.',
    );
  }

  const title =
    brownout.length === recent.length
      ? `Your robot lost its connection ${times(recent.length)} in the last 15 minutes, each during a brownout (longest ${secs(longest)}).`
      : laptop.length === recent.length
        ? `Your Driver Station laptop dropped out ${times(recent.length)} in the last 15 minutes (longest ${secs(longest)}).`
        : `Your robot lost its connection ${times(recent.length)} in the last 15 minutes (longest ${secs(longest)}).`;

  return {
    severity: recent.length >= 3 || longest >= 2_000 ? 'error' : 'warning',
    title,
    lines,
    recent: listed,
    earlier,
  };
}

/** One "when" row: "1.4 s — robot silent, brownout, 6.6 V". */
export function describeDropoutRow(d: RobotDropout): string {
  const what = d.kind === 'laptop' ? 'laptop stopped sending' : 'robot silent';
  const parts = [secs(d.durationMs), what];
  if (d.cause === 'brownout') parts.push('brownout');
  const v = volts(d.minBatteryVoltage);
  if (v) parts.push(v);
  return `${parts[0]} — ${parts.slice(1).join(', ')}`;
}

/** /csa: a robot that dropped out recently, so staff can steer the team
 *  to its battery or laptop before it happens in a match. */
export function dropoutStaffIssues(
  stations: Partial<Record<StationName, StationDropouts>>,
  now: number,
  label: (station: StationName, team: number) => string,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const [station, st] of Object.entries(stations) as [StationName, StationDropouts][]) {
    const recent = st.dropouts.filter(d => now - d.endedAt <= RECENT_DROPOUT_MS);
    if (recent.length === 0) continue;
    const brownout = recent.filter(d => d.cause === 'brownout').length;
    const laptop = recent.filter(d => d.kind === 'laptop').length;
    const longest = Math.max(...recent.map(d => d.durationMs));
    const lowest = volts(minOf(recent.map(d => d.minBatteryVoltage)));
    const evidence = [
      `longest ${secs(longest)}`,
      brownout > 0 && `${brownout} with a brownout${lowest ? ` (down to ${lowest})` : ''}`,
      laptop > 0 && `${laptop} from the laptop’s side`,
    ]
      .filter(Boolean)
      .join(', ');
    issues.push({
      id: `dropouts-${station}`,
      severity: recent.length >= 3 ? 'warning' : 'info',
      station,
      team: st.team,
      title: `${label(station, st.team)} lost its connection ${times(recent.length)} in the last 15 minutes`,
      detail: evidence,
      evidence,
      fix:
        brownout > 0
          ? 'Battery: swap in a charged one, check leads and the main breaker, lower current limits.'
          : laptop > 0
            ? 'Laptop Wi-Fi: move closer, turn off power saving.'
            : 'Robot radio power and the radio–roboRIO Ethernet cable.',
    });
  }
  return issues;
}

function minOf(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}
