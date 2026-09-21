/**
 * The scorekeeping surface for a speed challenge: one lap button per
 * alliance on the field, a penalty button beside it, and undo for both.
 *
 * Whoever is counting laps is standing at the field holding a phone, so the
 * lap button is the biggest thing on the page and the corrections are small
 * and out of the way. Counts are sent as deltas, so two people tallying the
 * same run can't overwrite each other.
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import UndoIcon from '@mui/icons-material/Undo';
import FlagIcon from '@mui/icons-material/Flag';
import {
  Alliance,
  ChallengeTally,
  MatchState,
  StationControlState,
  StationName,
  challengePenalties,
} from '../../../src/types';
import { sendMatchChallengeAdjust, sendMatchChallengeFinish } from '../hooks/useBackend';
import { formatName } from '../utils/matchFormat';

const ALLIANCE_COLOR: Record<Alliance, string> = { red: '#d32f2f', blue: '#1565c0' };

/** Which alliances have a robot on the field, and the teams in them. */
function participants(stationStates: MatchState['stationStates']): Record<Alliance, number[]> {
  const teams: Record<Alliance, number[]> = { red: [], blue: [] };
  for (const [, state] of Object.entries(stationStates) as [StationName, StationControlState | undefined][]) {
    if (!state?.joined || !state.alliance) continue;
    if (state.teamNumber) teams[state.alliance].push(state.teamNumber);
  }
  return teams;
}

export function ChallengeTallyPanel({ matchState }: { matchState: MatchState }) {
  const { challenge, config, phase, stationStates } = matchState;
  if (!challenge) return null;

  const stopwatch = config.challengeTiming === 'stopwatch';
  const { penaltyLaps, penaltySeconds } = challengePenalties({
    penaltyLaps: config.challengePenaltyLaps,
    penaltySeconds: config.challengePenaltySeconds,
  });
  const penaltyCost = stopwatch ? penaltySeconds : penaltyLaps;
  const teams = participants(stationStates);
  const onField = (['red', 'blue'] as Alliance[]).filter(a => teams[a].length > 0);
  if (onField.length === 0) return null;

  // Finish is only meaningful while the robot is actually driving — the
  // engine refuses it while paused, so the button follows.
  const running = phase === 'teleop' || phase === 'endgame';

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          {formatName(config)} — {stopwatch ? 'laps and finishes' : 'lap count'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {onField.map(alliance => (
            <AllianceTally
              key={alliance}
              alliance={alliance}
              teams={teams[alliance]}
              tally={challenge[alliance]}
              stopwatch={stopwatch}
              penaltyCost={penaltyCost}
              running={running}
            />
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}

function AllianceTally({
  alliance,
  teams,
  tally,
  stopwatch,
  penaltyCost,
  running,
}: {
  alliance: Alliance;
  teams: number[];
  tally: ChallengeTally;
  stopwatch: boolean;
  /** What one penalty costs, in this run's own unit. */
  penaltyCost: number;
  running: boolean;
}) {
  const color = ALLIANCE_COLOR[alliance];
  const finished = tally.finishedAt !== undefined;

  return (
    <Box
      sx={{
        flex: '1 1 260px',
        minWidth: 240,
        border: 2,
        borderColor: color,
        borderRadius: 2,
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography sx={{ color, fontWeight: 700 }}>{teams.join(', ') || alliance}</Typography>
        {finished && (
          <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{tally.finishedAt!.toFixed(1)}s</Typography>
        )}
      </Box>

      <Button
        variant="contained"
        onClick={() => sendMatchChallengeAdjust(alliance, { laps: 1 })}
        sx={{
          backgroundColor: color,
          '&:hover': { backgroundColor: color, filter: 'brightness(0.85)' },
          py: 2.5,
          fontSize: '1.4rem',
          fontWeight: 800,
        }}
      >
        Lap — {tally.laps}
      </Button>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<UndoIcon />}
          disabled={tally.laps === 0}
          onClick={() => sendMatchChallengeAdjust(alliance, { laps: -1 })}
          sx={{ flex: 1 }}
        >
          Undo lap
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="warning"
          onClick={() => sendMatchChallengeAdjust(alliance, { penalties: 1 })}
          sx={{ flex: 1 }}
        >
          Penalty — {tally.penalties}
        </Button>
        {tally.penalties > 0 && (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            onClick={() => sendMatchChallengeAdjust(alliance, { penalties: -1 })}
            sx={{ minWidth: 44 }}
          >
            <UndoIcon fontSize="small" />
          </Button>
        )}
      </Box>

      <Typography variant="caption" color="text.secondary">
        {penaltyCost === 0
          ? 'Penalties are tallied but cost nothing this run.'
          : stopwatch
            ? `Each penalty adds ${penaltyCost}s to the finishing time.`
            : `Each penalty takes away ${penaltyCost === 1 ? 'a lap' : `${penaltyCost} laps`}.`}
      </Typography>

      {stopwatch && (
        <Button
          variant="contained"
          color="success"
          startIcon={<FlagIcon />}
          disabled={!running || finished}
          onClick={() => sendMatchChallengeFinish(alliance)}
          sx={{ py: 1.5, fontWeight: 700 }}
        >
          {finished ? 'Finished' : 'Finish — stop the clock'}
        </Button>
      )}
    </Box>
  );
}
