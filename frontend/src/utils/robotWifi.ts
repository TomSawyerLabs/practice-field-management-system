/**
 * Words for what the robot Wi-Fi scan hears (src/robotWifiScan.ts), shared by
 * the team page and the CSA page so both say the same thing. Pure.
 *
 * Background every message leans on: the field joins a robot on 6 GHz as
 * `<team>[-suffix]`; the robot also broadcasts `FRC-<team>[-suffix]` on
 * 2.4 GHz, which is what pFMS hears. Same name either side of `FRC-`, so a
 * difference in capitals here is a difference the field will trip on.
 */
import type { RobotWifiBroadcast, RobotWifiScanState, RobotWifiStall } from '../../../src/types';

export type RobotWifiSeverity = 'error' | 'warning' | 'info' | 'success';

export interface RobotWifiLine {
  severity: RobotWifiSeverity;
  text: string;
}

/** The suffix a team should type to save the robot as broadcast
 *  (`1234-Comp` → `Comp`; `1234` → empty). */
export function suffixOf(robotSsid: string): string {
  const dash = robotSsid.indexOf('-');
  return dash < 0 ? '' : robotSsid.slice(dash + 1);
}

/** What the name tells the team, in their words. */
export function describeNameForTeam(b: RobotWifiBroadcast): RobotWifiLine {
  if (b.match.kind === 'exact')
    return { severity: 'success', text: `We can hear ${b.ssid} — it matches your saved robot ${b.match.savedSsid}.` };
  if (b.match.kind === 'caseOnly')
    return {
      severity: 'error',
      text:
        `Your robot is broadcasting ${b.ssid}, but it is saved here as ${b.match.savedSsid}. ` +
        `Capitals must match exactly, so the field will never connect to it. ` +
        `Add it again as ${b.robotSsid}.`,
    };
  return {
    severity: 'info',
    text: `We can hear ${b.ssid}, which is not one of your saved robots. If it is yours, add it as ${b.robotSsid}.`,
  };
}

/** How long a stalled robot has been trying, for a sentence. */
export function stalledFor(st: RobotWifiStall, now: number): string {
  const min = Math.max(1, Math.floor((now - st.since) / 60_000));
  return `${min} min`;
}

const WORSE = { error: 0, warning: 1, info: 2, success: 3 } as const;

/** Whether the 6 GHz watch can see other access points right now. When it
 *  can't, a robot that has the right name and passphrase but still won't
 *  join gets a hint that a team's own AP may have it. */
export interface StallContext {
  sixGhzWatching?: boolean;
}

/** A team's own AP, left on with the field's network name, takes the robot
 *  instead of the field. Said only when the 6 GHz watch can't see for itself. */
const OWN_AP_HINT =
  'If you brought your own access point or a spare radio set up with this network, switch it off — your robot ' +
  'may have joined it instead of the field.';

/** What a robot that is taking too long to join tells its team: what we
 *  can hear, and what trying the field's passphrase on it found. */
export function describeStallForTeam(
  st: RobotWifiStall,
  now: number,
  ctx: StallContext = {},
): { severity: RobotWifiSeverity; lines: string[] } {
  const b = st.broadcast;
  const waited = `Your robot hasn't joined the field after ${stalledFor(st, now)}.`;
  const lines: string[] = [];
  let severity: RobotWifiSeverity = 'warning';
  if (b.match === 'exact') {
    lines.push(`${waited} We can hear it as ${b.ssid}, so it is on.`);
  } else if (b.match === 'caseOnly') {
    severity = 'error';
    lines.push(
      `${waited} The field is set up for ${st.fieldSsid}, but your robot is ${b.robotSsid} (we can hear ${b.ssid}). ` +
        `Capitals must match exactly, so it never will. Add it again as ${b.robotSsid}.`,
    );
  } else {
    lines.push(
      `${waited} The field is set up for ${st.fieldSsid}, but the robot we can hear is ${b.ssid}. ` +
        `If that is the one you're connecting, add it as ${b.robotSsid}.`,
    );
  }

  const k = st.keyCheck;
  const bump = (s: RobotWifiSeverity) => {
    if (WORSE[s] < WORSE[severity]) severity = s;
  };
  switch (k?.result) {
    case undefined:
      lines.push(
        b.match === 'otherName'
          ? `Test connection tries the field's passphrase for ${st.fieldSsid} on ${b.ssid}.`
          : "We'll check the passphrase the field is using in a moment.",
      );
      break;
    case 'checking':
      lines.push('Checking the passphrase the field is using…');
      break;
    case 'ok':
      lines.push(
        'The passphrase the field is using is correct. The radio may still be starting, or be too far from ' +
          'the field — power-cycling the robot radio usually helps.',
      );
      if (!ctx.sixGhzWatching) lines.push(OWN_AP_HINT);
      break;
    case 'wrongKey':
      bump('error');
      lines.push(
        `The passphrase the field is using is wrong for ${b.ssid}. Add the robot again with its passphrase, ` +
          `capitals included. (This checks the robot's 2.4 GHz network. If you gave that network its own ` +
          `passphrase, the field's may still be right.)`,
      );
      break;
    case 'unreachable':
      lines.push("We couldn't finish checking the passphrase. The robot may be too far away or busy.");
      break;
    case 'open':
      lines.push(`${b.ssid} has no passphrase, so we couldn't check the field's.`);
      break;
  }
  return { severity, lines };
}

/** Stalled connections for one team. */
export function stallsForTeam(scan: RobotWifiScanState | null, team: number): RobotWifiStall[] {
  return scan?.stalls?.filter(st => st.team === team) ?? [];
}

/** Broadcasts for one team. */
export function broadcastsForTeam(scan: RobotWifiScanState | null, team: number): RobotWifiBroadcast[] {
  return scan?.broadcasts.filter(b => b.team === team) ?? [];
}

/** A problem worth a CSA's attention: a robot taking too long to join, or
 *  a heard robot network whose name is off. Healthy ones give nothing. */
export interface RobotWifiStaffIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  team: number;
  title: string;
  detail: string;
  fix?: string;
}

export function robotWifiStaffIssues(
  scan: RobotWifiScanState | null | undefined,
  now: number = Date.now(),
  ctx: StallContext = {},
): RobotWifiStaffIssue[] {
  if (!scan) return [];
  const issues: RobotWifiStaffIssue[] = [];
  if (scan.status === 'error') {
    issues.push({
      id: 'robotWifi-scan-error',
      severity: 'warning',
      team: 0,
      title: 'The robot Wi-Fi scan has stopped',
      detail: scan.error ?? 'No reason given.',
      fix: 'Check the interface picked on the admin page, then pick it again to restart the scan.',
    });
  }
  // A robot that is taking too long to join, with its network on the air:
  // what the field is set up for, and what its passphrase did on the robot.
  const stalls = scan.stalls ?? [];
  for (const st of stalls) {
    const b = st.broadcast;
    const k = st.keyCheck?.result;
    const critical = b.match === 'caseOnly' || k === 'wrongKey';
    const name =
      b.match === 'exact'
        ? `Heard ${b.ssid} at ${b.signal} dBm.`
        : `Set up for ${st.fieldSsid}, but heard ${b.ssid} at ${b.signal} dBm` +
          (b.match === 'caseOnly' ? ' — capitals differ, so it never will.' : '.');
    const key =
      k === 'ok'
        ? " The field's passphrase works on it."
        : k === 'wrongKey'
          ? " The field's passphrase does not open its 2.4 GHz network."
          : k === 'unreachable'
            ? ' The passphrase check could not finish.'
            : '';
    issues.push({
      id: `robotWifi-stall-${st.station}`,
      severity: critical ? 'critical' : 'warning',
      team: st.team,
      title: `Team ${st.team}'s robot hasn't joined the field after ${stalledFor(st, now)}`,
      detail: name + key,
      fix:
        b.match === 'caseOnly'
          ? `Have the team add the robot again as ${b.robotSsid} (their page offers it).`
          : k === 'wrongKey'
            ? 'Re-enter the passphrase with the team; ask whether the 2.4 GHz passphrase was set separately.'
            : k === 'ok'
              ? 'Name and passphrase are right: power-cycle the robot radio, and check it is within range of the field.' +
                (ctx.sixGhzWatching
                  ? ''
                  : ' Ask whether the team has its own access point or a spare radio on — the robot may have joined it.')
              : 'The team can press Test connection on their page.',
    });
  }

  for (const b of scan.broadcasts) {
    const heard = `Heard ${b.ssid} at ${b.signal} dBm.`;
    // A stall for this robot already says it
    if (stalls.some(st => st.broadcast.ssid === b.ssid)) continue;
    if (b.match.kind === 'caseOnly') {
      issues.push({
        id: `robotWifi-case-${b.ssid}`,
        severity: 'critical',
        team: b.team,
        title: `Team ${b.team}'s robot name differs only in capitals from what they saved`,
        detail: `${heard} Saved as ${b.match.savedSsid}; the field will never connect.`,
        fix: `Have the team add the robot again as ${b.robotSsid} (their page offers it).`,
      });
    } else if (b.match.kind === 'unknown') {
      issues.push({
        id: `robotWifi-unknown-${b.ssid}`,
        severity: 'info',
        team: b.team,
        title: `${b.ssid} is on the air but team ${b.team} has not saved it`,
        detail: heard,
        fix: `If the team is here to drive it, they add it as ${b.robotSsid}.`,
      });
    }
  }
  return issues;
}
