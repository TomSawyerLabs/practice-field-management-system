/**
 * What to tell a team and staff about a robot e-stopped in the roboRIO itself
 * (src/robotEStopWatch.ts). Unlike the field's own stops, nothing in pFMS or
 * the Driver Station clears this: only rebooting the robot does.
 */
import type { RobotEStop, RobotEStopOrigin, StationName } from '../../../src/types';
import type { FieldIssue } from './fieldIssues';

const REBOOT =
  'An e-stop stays in the robot until it reboots. Turn the robot off and on again, or restart the roboRIO from the Driver Station. Clearing it on the field or restarting the Driver Station will not release it.';

/** Who sent it, in a sentence for the team. */
function originForTeam(o: RobotEStopOrigin): string {
  switch (o.kind) {
    case 'ds': {
      const who = o.hostname ? `the Driver Station on ${o.hostname}` : `the Driver Station at ${o.laptop}`;
      if (o.drivesThis) return `It came from ${who}, the laptop driving this robot. The space bar is the usual cause.`;
      if (o.drives) return `It came from ${who}, the laptop driving ${o.drivesRobot ?? 'another robot'}, not this one.`;
      return `It came from ${who}, which isn’t driving a robot here.`;
    }
    case 'ds-unknown':
      return 'It came from a Driver Station on the field’s network, but the field couldn’t tell which.';
    case 'unseen':
      return 'No Driver Station on the field’s network sent it, so check for one connected to the robot another way: tethered, or on the robot’s own Wi-Fi.';
    case 'already':
      return 'It was already e-stopped when the field first heard from it, so the field doesn’t know who sent it.';
  }
}

export function describeRobotEStop(e: RobotEStop): { title: string; subtitle: string; lines: string[] } {
  return {
    title: 'ROBOT E-STOPPED',
    subtitle: 'Power cycle the robot to clear it',
    lines: [REBOOT, originForTeam(e.origin)],
  };
}

/** /csa: staff can't clear this from any page, so say so. */
export function robotEStopStaffIssues(
  stations: Partial<Record<StationName, RobotEStop>>,
  label: (station: StationName) => string,
): FieldIssue[] {
  return (Object.entries(stations) as [StationName, RobotEStop][]).map(([station, e]) => ({
    id: `robot-estop-${station}`,
    severity: 'critical',
    station,
    team: e.team,
    title: `${label(station)} is e-stopped in the robot itself`,
    detail: originForTeam(e.origin),
    fix: 'Have the team power cycle the robot. Clearing e-stops here won’t release it.',
  }));
}
