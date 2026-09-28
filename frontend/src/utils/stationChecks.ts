import {
  StationSetupCheckList,
  type MatchPhase,
  type SetupCheckLevel,
  type StationControlState,
  type StationSetupCheck,
  type StationSetupChecks,
} from '../../../src/types';

/** What the scoreboard calls each check, and how it words each verdict. */
export function checkRow(checks: StationSetupChecks, check: StationSetupCheck): { label: string; value: string } {
  const level = checks[check];
  switch (check) {
    case 'ds':
      return { label: 'DS link', value: level === 'ok' ? 'yes' : level === 'partial' ? 'partial' : 'no' };
    case 'radio':
      return { label: 'Radio link', value: level === 'ok' ? 'yes' : level === 'bad' ? 'no' : '?' };
    case 'robotComms':
      return { label: 'Comms', value: level === 'ok' ? 'yes' : level === 'bad' ? 'no' : '?' };
    case 'joysticks':
      return {
        label: 'Joysticks',
        value: level === 'ok' ? String(checks.joystickCount ?? '') : level === 'bad' ? '0' : '?',
      };
    case 'battery':
      return {
        label: 'Battery',
        value: checks.batteryVoltage !== undefined ? `${checks.batteryVoltage.toFixed(1)}V` : '?',
      };
    case 'ready':
      return { label: 'Ready', value: level === 'ok' ? 'yes' : level === 'bad' ? 'no' : '—' };
  }
}

/** The first failing check — the one to fix next. Later checks usually fail
 *  because of it (no radio link, no robot comms, no battery reading), so the
 *  scoreboard emphasises this one and quiets the rest. Partial is not a
 *  failure: an unjoined DS sits there until it joins a match. */
export function firstFailingCheck(checks: StationSetupChecks): StationSetupCheck | null {
  return StationSetupCheckList.find(c => checks[c] === 'bad') ?? null;
}

/** Overall verdict for a robot's column: red if anything fails, yellow if
 *  anything is partial, green otherwise (checks still waiting or unknown
 *  don't hold a robot back). */
export function checksTone(checks: StationSetupChecks): 'ok' | 'partial' | 'bad' {
  const levels: SetupCheckLevel[] = StationSetupCheckList.map(c => checks[c]);
  if (levels.includes('bad')) return 'bad';
  if (levels.includes('partial')) return 'partial';
  return 'ok';
}

export interface RobotAlert {
  label: string;
  /** bad = red, warn = amber, neutral = grey (expected, not a problem) */
  tone: 'bad' | 'warn' | 'neutral';
}

/** Phases where a robot in the match should be connected. */
const LIVE_PHASES = new Set<MatchPhase>(['countdown', 'auto', 'autoPause', 'teleop', 'endgame', 'paused']);
/** Phases where a robot in the match should be driving. */
const ENABLED_PHASES = new Set<MatchPhase>(['auto', 'teleop', 'endgame']);

/** What to show instead of a match robot's battery chart, if anything is
 *  wrong with it: stopped, off the field network, or not driving when it
 *  should be. Null when it is fine, or not in a running match. */
export function robotAlert(
  control: StationControlState | undefined,
  phase: MatchPhase | undefined,
  robotComms: SetupCheckLevel | undefined,
): RobotAlert | null {
  if (!control?.joined || !phase || !LIVE_PHASES.has(phase)) return null;
  if (control.eStop) return { label: 'E-STOPPED', tone: 'bad' };
  if (control.aStop) return { label: 'A-STOPPED', tone: 'warn' };
  if (control.dsAttached === false) return { label: 'NO DS', tone: 'bad' };
  if (robotComms === 'bad') return { label: 'NO ROBOT', tone: 'bad' };
  if (control.blockedReason) return { label: 'BLOCKED', tone: 'bad' };
  if (ENABLED_PHASES.has(phase) && !control.enabled) {
    // A relay robot whose leg is over is disabled on purpose.
    if (control.disabledBy === 'relay') return { label: 'LEG DONE', tone: 'neutral' };
    return { label: 'DISABLED', tone: 'warn' };
  }
  return null;
}
