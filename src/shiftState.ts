import type { Alliance } from './types.js';

/**
 * REBUILT alliance shift timing.
 * After auto period ends, teleop begins with a 10-second Transition where both
 * hubs are active. The auto loser scores first: their hub is active (winner's
 * hub INACTIVE) in Shifts 1 & 3. The winner scores in Shifts 2 & 4.
 *
 * Teleop timeline (from teleop start, total 140s including endgame):
 * - Transition: 0-10s     (both active)
 * - Shift 1:    10-35s    (auto winner's hub INACTIVE -> loser scores)
 * - Shift 2:    35-60s    (auto loser's hub INACTIVE -> winner scores)
 * - Shift 3:    60-85s    (auto winner's hub INACTIVE -> loser scores)
 * - Shift 4:    85-110s   (auto loser's hub INACTIVE -> winner scores)
 * - Endgame:    110-140s  (both active, climbing emphasis)
 *
 * Returns which alliance's goal is currently inactive, or null if both are active.
 */

export const TRANSITION_DURATION = 10;
export const SHIFT_DURATION = 25;

/** Sub-periods within a match for fine-grained score breakdown. */
export type MatchSubPeriod = 'auto' | 'transition' | 'shift1' | 'shift2' | 'shift3' | 'shift4' | 'endgame';

/**
 * Given the current match phase and teleop remaining time, return which
 * sub-period we're in.
 */
export function getMatchSubPeriod(
  phase: string | undefined,
  remainingTime: number,
  totalTeleopDuration: number,
): MatchSubPeriod | null {
  if (phase === 'auto' || phase === 'autoPause') return 'auto';
  if (phase === 'endgame' || phase === 'postMatch') return 'endgame';
  if (phase !== 'teleop') return null;

  const teleopElapsed = totalTeleopDuration - remainingTime;
  if (teleopElapsed < TRANSITION_DURATION) return 'transition';

  const shiftElapsed = teleopElapsed - TRANSITION_DURATION;
  if (shiftElapsed < SHIFT_DURATION) return 'shift1';
  if (shiftElapsed < SHIFT_DURATION * 2) return 'shift2';
  if (shiftElapsed < SHIFT_DURATION * 3) return 'shift3';
  if (shiftElapsed < SHIFT_DURATION * 4) return 'shift4';
  return 'endgame';
}

/**
 * Map absolute shift numbers to per-alliance "scoring period" indices.
 * Returns the two shifts where the given alliance's goal IS ACTIVE
 * (i.e., when they can score), ordered chronologically.
 */
export function getAllianceScoringShifts(
  alliance: Alliance,
  autoWinner: Alliance | null,
): [MatchSubPeriod, MatchSubPeriod] {
  if (!autoWinner) return ['shift1', 'shift2']; // fallback
  // Winner's goal is INACTIVE during shifts 1,3 → winner scores during 2,4
  // Loser's goal is INACTIVE during shifts 2,4 → loser scores during 1,3
  if (alliance === autoWinner) return ['shift2', 'shift4'];
  return ['shift1', 'shift3'];
}

export function getAllianceShiftState(
  phase: string | undefined,
  remainingTime: number,
  totalTeleopDuration: number,
  _endgameDuration: number,
  autoWinnerAlliance: Alliance | null | undefined,
): Alliance | null {
  // Null means both goals stay active for the whole match, i.e. no shift
  // scoring at all — which is the off-goal-scoring bug this was written to
  // fix. A tie must resolve to an alliance rather than stay null.
  if (!autoWinnerAlliance) return null;

  // Only apply shift logic during teleop
  if (phase !== 'teleop') return null;

  // Calculate elapsed time in teleop
  const teleopElapsed = totalTeleopDuration - remainingTime;

  // Transition period: both hubs active
  if (teleopElapsed < TRANSITION_DURATION) {
    return null;
  }

  const shiftElapsed = teleopElapsed - TRANSITION_DURATION;

  if (shiftElapsed < SHIFT_DURATION) {
    // Shift 1: auto winner's goal inactive
    return autoWinnerAlliance;
  } else if (shiftElapsed < SHIFT_DURATION * 2) {
    // Shift 2: auto winner's goal active -> loser's goal inactive
    return autoWinnerAlliance === 'red' ? 'blue' : 'red';
  } else if (shiftElapsed < SHIFT_DURATION * 3) {
    // Shift 3: auto winner's goal inactive
    return autoWinnerAlliance;
  } else if (shiftElapsed < SHIFT_DURATION * 4) {
    // Shift 4: auto winner's goal active -> loser's goal inactive
    return autoWinnerAlliance === 'red' ? 'blue' : 'red';
  }

  // After shift 4 (endgame territory): both active
  return null;
}
