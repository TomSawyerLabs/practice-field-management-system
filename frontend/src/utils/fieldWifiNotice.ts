/**
 * What the scoreboard says about a field Wi-Fi reconfiguration coming up —
 * every robot drops off for about 30 s, so people on the field should know.
 * In order: robots that connected by themselves, counting down to their
 * reconfiguration (src/autoConnectBatch.ts); one waiting for robots to be
 * disabled; changes held by staff, a match, or the admin. Pure.
 */
import type { PendingCommitState, RobotWifiScanState } from '../../../src/types';

export interface FieldWifiNotice {
  /** The headline */
  text: string;
  /** Smaller lines under it */
  details: string[];
}

const DROP = 'Every robot drops off Wi-Fi for about 30 seconds.';

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const HELD: Partial<Record<NonNullable<PendingCommitState['hold']>, string>> = {
  admin: 'held by the field admin',
  match: 'held while a match is on',
  pending: 'waiting for staff',
};

export function fieldWifiNotice(
  scan: RobotWifiScanState | null,
  pending: Pick<PendingCommitState, 'hold' | 'changes' | 'deferred' | 'deferredChanges'> | null,
  now: number,
): FieldWifiNotice | null {
  const held = pending?.changes?.length && pending.hold ? HELD[pending.hold] : undefined;
  const upcoming = scan?.upcoming;
  if (upcoming) {
    const secs = Math.ceil((upcoming.at - now) / 1000);
    const details = [`Connecting ${list(upcoming.robots)}. ${DROP}`];
    if (upcoming.waitingFor.length > 0)
      details.push(`Waiting a little for ${list(upcoming.waitingFor)} to finish its check, so it joins the same one.`);
    if (held) details.push(`Wi-Fi changes are ${held}, so these wait for Apply now on the match page.`);
    return {
      text:
        secs > 0
          ? `Field Wi-Fi reconfiguration in ${secs} s, once robots are disabled`
          : 'Field Wi-Fi reconfiguration once robots are disabled',
      details,
    };
  }
  if (pending?.deferred) {
    const robots = Object.values(pending.deferredChanges ?? {})
      .filter(c => !!c)
      .map(c => c!.ssid);
    return {
      text: 'Field Wi-Fi reconfiguration once robots are disabled',
      details: [(robots.length ? `Connecting ${list(robots)}. ` : '') + DROP],
    };
  }
  if (held) {
    const n = pending!.changes!.length;
    return {
      text: `Wi-Fi changes ${held}`,
      details: [`${n} change${n === 1 ? '' : 's'} waiting for Apply now on the match page.`],
    };
  }
  return null;
}
