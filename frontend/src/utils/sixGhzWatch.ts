/**
 * Words for what the 6 GHz watch hears (src/sixGhzWatch.ts), shared by the
 * team page and the CSA page so both say the same thing. Pure.
 *
 * Background every message leans on: a robot radio joins the first access
 * point it finds with its network name and passphrase. A team's own AP left
 * on, set up with the same name, competes with the field for the robot.
 */
import type { SixGhzClash, SixGhzWatchState } from '../../../src/types';

/** 5955 → `6 GHz ch 1`. */
export function sixGhzChannelLabel(mhz: number): string {
  return `6 GHz ch ${(mhz - 5950) / 5}`;
}

/** Where the other access points are: channel and signal of each. */
function whereHeard(c: SixGhzClash): string {
  return c.others.map(o => `${sixGhzChannelLabel(o.frequency)}, ${o.signal} dBm`).join('; ');
}

/** What a clash tells the team, in their words. */
export function describeClashForTeam(c: SixGhzClash): { severity: 'error' | 'warning'; text: string } {
  const n = c.others.length;
  if (c.kind === 'competing')
    return {
      severity: 'error',
      text:
        `${n === 1 ? 'Another access point is' : `${n} other access points are`} broadcasting your robot's ` +
        `network, ${c.ssid} (${whereHeard(c)}). Your robot may join ${n === 1 ? 'it' : 'one of them'} instead of ` +
        `the field. If you brought your own access point or a spare radio, switch it off.`,
    };
  return {
    severity: 'warning',
    text:
      `An access point near the field is broadcasting ${c.ssid} (${whereHeard(c)}) — probably your own. ` +
      `Switch it off before you connect to the field, or your robot may join it instead.`,
  };
}

/** Whether the watch can see other access points right now: running, and
 *  hearing 6 GHz. */
export function isSixGhzWatching(state: SixGhzWatchState | null | undefined): boolean {
  return state?.status === 'running' && !state.problem;
}

/** Clashes for one team. */
export function clashesForTeam(state: SixGhzWatchState | null, team: number): SixGhzClash[] {
  return state?.status === 'running' ? state.clashes.filter(c => c.team === team) : [];
}

/** A problem worth a CSA's attention. */
export interface SixGhzStaffIssue {
  id: string;
  severity: 'critical' | 'warning';
  team?: number;
  station?: SixGhzClash['station'];
  title: string;
  detail: string;
  fix?: string;
}

export function sixGhzStaffIssues(state: SixGhzWatchState | null | undefined): SixGhzStaffIssue[] {
  if (!state) return [];
  const issues: SixGhzStaffIssue[] = [];
  if (state.status === 'error') {
    issues.push({
      id: 'sixGhzWatch-error',
      severity: 'warning',
      title: 'The 6 GHz watch has stopped',
      detail: state.error ?? 'No reason given.',
      fix: 'Check the card picked on the admin page, then pick it again to restart the watch.',
    });
  } else if (state.problem) {
    issues.push({
      id: 'sixGhzWatch-problem',
      severity: 'warning',
      title: "The 6 GHz watch can't hear 6 GHz",
      detail: state.problem,
      fix: 'Pick a 6 GHz-capable card on the admin page, and check the Wi-Fi country there.',
    });
  }
  if (state.status !== 'running') return issues;

  for (const c of state.clashes) {
    const heard = `Heard from ${c.others.map(o => `${o.bssid} (${sixGhzChannelLabel(o.frequency)}, ${o.signal} dBm)`).join(', ')}.`;
    if (c.kind === 'competing') {
      issues.push({
        id: `sixGhzWatch-competing-${c.ssid}`,
        severity: 'critical',
        team: c.team || undefined,
        ...(c.station && { station: c.station }),
        title: `Another access point is broadcasting ${c.ssid}, which the field is serving`,
        detail: `${heard} The robot may join it instead of the field.`,
        fix: `Ask team ${c.team} to switch off their own access point or spare radio.`,
      });
    } else {
      issues.push({
        id: `sixGhzWatch-teamAp-${c.ssid}`,
        severity: 'warning',
        team: c.team || undefined,
        title: `An access point is broadcasting ${c.ssid}, a saved robot's network`,
        detail: `${heard} The field isn't serving it, so it is most likely the team's own.`,
        fix: `Ask team ${c.team} to switch it off before they connect to the field.`,
      });
    }
  }
  return issues;
}
