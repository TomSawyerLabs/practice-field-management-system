/**
 * Words for what the robot Wi-Fi scan hears (src/robotWifiScan.ts), shared by
 * the team page and the CSA page so both say the same thing. Pure.
 *
 * Background every message leans on: the field joins a robot on 6 GHz as
 * `<team>[-suffix]`; the robot also broadcasts `FRC-<team>[-suffix]` on
 * 2.4 GHz, which is what pFMS hears. Same name either side of `FRC-`, so a
 * difference in capitals here is a difference the field will trip on.
 */
import type { RobotWifiBroadcast, RobotWifiScanState } from '../../../src/types';

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

/** What the passphrase check found, for the team. Null when there is none. */
export function describeKeyForTeam(b: RobotWifiBroadcast): RobotWifiLine | null {
  const k = b.keyCheck;
  if (!k) return null;
  switch (k.result) {
    case 'checking':
      return { severity: 'info', text: 'Checking your saved passphrase against it…' };
    case 'ok':
      return { severity: 'success', text: 'Your saved passphrase works.' };
    case 'open':
      return { severity: 'warning', text: `${b.ssid} has no passphrase at all, so we could not check yours.` };
    case 'unreachable':
      return {
        severity: 'warning',
        text: 'We could not finish checking your passphrase. The robot may be too far away or busy. Try again in a moment.',
      };
    case 'wrongKey':
      return {
        severity: 'error',
        text:
          `Your saved passphrase did not open ${b.ssid}. Check it on the radio, capitals included. ` +
          `(This checks the robot's 2.4 GHz network. If you gave that network its own passphrase, ` +
          `the field's 6 GHz passphrase may still be right.)`,
      };
  }
}

/** Broadcasts for one team. */
export function broadcastsForTeam(scan: RobotWifiScanState | null, team: number): RobotWifiBroadcast[] {
  return scan?.broadcasts.filter(b => b.team === team) ?? [];
}

/** A problem worth a CSA's attention, per heard robot network. Healthy
 *  networks (exact name, passphrase fine or not yet known) give nothing. */
export interface RobotWifiStaffIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  team: number;
  title: string;
  detail: string;
  fix?: string;
}

export function robotWifiStaffIssues(scan: RobotWifiScanState | null | undefined): RobotWifiStaffIssue[] {
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
  for (const b of scan.broadcasts) {
    const heard = `Heard ${b.ssid} at ${b.signal} dBm.`;
    if (b.match.kind === 'caseOnly') {
      issues.push({
        id: `robotWifi-case-${b.ssid}`,
        severity: 'critical',
        team: b.team,
        title: `Team ${b.team}'s robot name differs only in capitals from what they saved`,
        detail: `${heard} Saved as ${b.match.savedSsid}; the field will never connect.`,
        fix: `Have the team add the robot again as ${b.robotSsid} (their page offers it).`,
      });
    } else if (b.keyCheck?.result === 'wrongKey') {
      issues.push({
        id: `robotWifi-key-${b.ssid}`,
        severity: 'warning',
        team: b.team,
        title: `Team ${b.team}'s saved passphrase did not open ${b.ssid}`,
        detail: `${heard} Checked against the robot's 2.4 GHz network, which can have its own passphrase.`,
        fix: 'Ask whether the 2.4 GHz passphrase was set separately; if not, re-enter the passphrase with the team.',
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
