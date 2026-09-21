import Typography from '@mui/material/Typography';
import type { MatchPhase, MatchState } from '../../../src/types';
import { getAllianceShiftState } from '../utils/shiftState';

// Concrete hex colours that match the MatchTimeline segment colours
export const PHASE_HEX: Record<MatchPhase, string> = {
  idle: '#9e9e9e',
  created: '#42a5f5',
  countdown: '#ffa726',
  auto: '#66bb6a',
  autoPause: '#9e9e9e',
  paused: '#ffa726',
  teleop: '#66bb6a',
  endgame: '#ffa726',
  postMatch: '#9e9e9e',
};

const RED_HEX = '#ef5350';
const BLUE_HEX = '#42a5f5';

/**
 * Compute the active colour for the timer/chip based on the current match phase
 * and which alliance's shift is active during teleop.
 */
export function getActiveColor(matchState: MatchState): string {
  const { phase } = matchState;

  // During teleop shifts, colour by which alliance is scoring
  if (phase === 'teleop' || phase === 'endgame') {
    const inactive = getAllianceShiftState(
      phase,
      matchState.remainingTime,
      matchState.config.teleopDuration,
      matchState.config.endgameDuration,
      matchState.autoWinnerAlliance,
    );
    if (inactive === 'red') return BLUE_HEX; // Blue is scoring
    if (inactive === 'blue') return RED_HEX; // Red is scoring
  }

  return PHASE_HEX[phase];
}

// ── Timer with ceil rounding ────────────────────────────────────────

export function MatchTimer({
  remainingTime,
  color,
  pulse,
  fontSize,
  countUp,
}: {
  remainingTime: number;
  color: string;
  pulse?: boolean;
  /** Override the default font size (MUI h1 ~6rem). */
  fontSize?: string;
  /** Count-up (stopwatch) reading. A clock counting down shows the second
   *  you are still inside, so it ceils; a stopwatch shows the second you
   *  have finished, so it floors — otherwise it reads 0:01 on press. */
  countUp?: boolean;
}) {
  const round = countUp ? Math.floor : Math.ceil;
  const display = round(Math.max(0, remainingTime));
  const minutes = Math.floor(display / 60);
  const seconds = display % 60;
  return (
    <Typography
      variant="h1"
      sx={{
        fontFamily: 'monospace',
        textAlign: 'center',
        color,
        lineHeight: 1,
        transition: 'color 1s ease',
        ...(fontSize != null && { fontSize }),
        '@keyframes timerPulse': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.4 },
        },
        animation: pulse ? 'timerPulse 1s ease-in-out infinite' : 'none',
      }}
    >
      {minutes}:{seconds.toString().padStart(2, '0')}
    </Typography>
  );
}
