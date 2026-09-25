/**
 * Display helpers for the match format.
 *
 * A speed challenge runs through the same phases as a match, but calling the
 * enabled window "Teleoperated" in front of a crowd at a field event is
 * nonsense. Every page that labels a phase goes through here so the wording
 * stays consistent, and so "no format means official" is stated once.
 */
import { isChallengeConfig, type MatchConfig, type MatchPhase, type MatchState } from '../../../src/types';

export { isChallengeConfig };

const OFFICIAL_PHASE_LABELS: Record<MatchPhase, string> = {
  idle: 'Idle',
  created: 'Match Created',
  countdown: 'Countdown',
  auto: 'Autonomous',
  autoPause: 'Pause',
  paused: 'Paused',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
  postMatch: 'Post-Match',
};

/** A challenge has no auto, no shifts and no endgame, so those phases never
 *  appear; the ones that do are named for what the audience sees. */
const CHALLENGE_PHASE_LABELS: Record<MatchPhase, string> = {
  ...OFFICIAL_PHASE_LABELS,
  created: 'Challenge Ready',
  teleop: 'Run',
  endgame: 'Run',
  postMatch: 'Run Complete',
};

export function phaseLabel(phase: MatchPhase, config?: Pick<MatchConfig, 'format'>): string {
  return (isChallengeConfig(config) ? CHALLENGE_PHASE_LABELS : OFFICIAL_PHASE_LABELS)[phase];
}

/** "Speed Challenge" / "Stopwatch Challenge" / "Relay Race" / "Match" — for
 *  chips and headings. */
export function formatName(config?: Pick<MatchConfig, 'format' | 'challengeTiming'>): string {
  if (!isChallengeConfig(config)) return 'Match';
  switch (config?.challengeTiming) {
    case 'stopwatch':
      return 'Stopwatch Challenge';
    case 'relay':
      return 'Relay Race';
    default:
      return 'Speed Challenge';
  }
}

/** The colour that marks challenge UI apart from match UI. */
export const CHALLENGE_COLOR = '#7e57c2';

/** Seconds elapsed in the run itself (countdown excluded), for count-up
 *  displays. The engine stamps the run start, so this is the same number
 *  the finish times and splits are measured against. */
export function challengeElapsed(state: Pick<MatchState, 'runElapsed'>): number {
  return state.runElapsed ?? 0;
}
