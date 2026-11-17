/**
 * Words for the CSA page's robot Wi-Fi panel: what the scan and
 * auto-connect are doing right now (src/robotWifiScan.ts,
 * src/autoConnectBatch.ts). What they did lately comes from the server
 * already worded (RobotWifiScanState.activity). Pure.
 */
import type { RobotWifiScanState } from '../../../src/types';

/** "2:14:05 PM", in the viewer's zone */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** "21:14:05Z" */
export function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

function inSecs(at: number, now: number): string {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`;
}

/** One line per thing under way, most urgent first. */
export function robotWifiUnderWay(scan: RobotWifiScanState | null, now: number): string[] {
  if (!scan) return [];
  const lines: string[] = [];
  const up = scan.upcoming;
  if (up) {
    const robots = up.robots.join(', ');
    lines.push(
      up.at > now
        ? `Field Wi-Fi reconfiguration in ${inSecs(up.at, now)} to add ${robots}, once robots are disabled`
        : `Field Wi-Fi reconfiguration to add ${robots}, once robots are disabled`,
    );
    if (up.waitingFor.length > 0) lines.push(`Waiting for ${up.waitingFor.join(', ')} to finish its check, to join it`);
  }
  for (const ssid of scan.awaiting ?? [])
    lines.push(`${ssid}: the team asked to connect it; waiting for its passphrase to check out on the robot`);
  for (const b of scan.broadcasts) {
    const name = b.robotSsid;
    if (b.keySearch === 'searching') lines.push(`${name}: trying the team's other passphrases`);
    else if (b.keyCheck?.result === 'checking') lines.push(`${name}: checking its passphrase on the robot`);
    else if (b.keyCheck?.result === 'unreachable' && b.keyCheck.retryAt)
      lines.push(
        b.keyCheck.retryAt > now
          ? `${name}: didn't answer its passphrase check; trying again in ${inSecs(b.keyCheck.retryAt, now)}`
          : `${name}: didn't answer its passphrase check; trying again next`,
      );
  }
  return lines;
}
