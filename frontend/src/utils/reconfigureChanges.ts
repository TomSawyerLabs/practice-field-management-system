import type { ReconfigureStationChange } from '../../../src/types';
import { teamOfSsid } from '../../../src/utils';

export type ReconfigureLineKind = 'join' | 'leave' | 'move';

export interface ReconfigureLine {
  kind: ReconfigureLineKind;
  ssid: string;
  team: number | null;
  /** In the teams' words, named by robot — never by slot. */
  text: string;
}

const ORDER: Record<ReconfigureLineKind, number> = { join: 0, move: 1, leave: 2 };

/** One line per robot a reconfigure affects. A station that swaps robots is
 *  two lines (one leaves, one joins); a robot that only changes station is
 *  one "move" line. Joins first: that is who is waiting on it. */
export function describeReconfigureChanges(changes: ReconfigureStationChange[]): ReconfigureLine[] {
  const joining = new Set(changes.flatMap(c => (c.to ? [c.to] : [])));
  const leaving = new Set(changes.flatMap(c => (c.from ? [c.from] : [])));
  const line = (kind: ReconfigureLineKind, ssid: string): ReconfigureLine => ({
    kind,
    ssid,
    team: teamOfSsid(ssid),
    text:
      kind === 'join'
        ? `${ssid} joins the field`
        : kind === 'leave'
          ? `${ssid} leaves the field`
          : `${ssid} changes station`,
  });
  const lines: ReconfigureLine[] = [];
  for (const ssid of joining) lines.push(line(leaving.has(ssid) ? 'move' : 'join', ssid));
  for (const ssid of leaving) if (!joining.has(ssid)) lines.push(line('leave', ssid));
  return lines.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}
