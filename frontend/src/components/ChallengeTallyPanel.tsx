/**
 * The scorekeeping surface for a speed challenge: one lap button per
 * alliance on the field, a penalty button beside it, and undo for both.
 *
 * Whoever is counting laps is standing at the field holding a phone, so the
 * lap button is the biggest thing on the page and the corrections are small
 * and out of the way. Counts are sent as deltas, so two people tallying the
 * same run can't overwrite each other.
 *
 * In a relay the lap button gives way to the line ref's hand-off button:
 * the robots run one at a time, and pressing it sends the next one.
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import UndoIcon from '@mui/icons-material/Undo';
import FlagIcon from '@mui/icons-material/Flag';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import {
  Alliance,
  ChallengeTally,
  MatchState,
  StationControlState,
  StationName,
  challengePenalties,
  isCountUpTiming,
  isFmsHandoff,
} from '../../../src/types';
import { sendMatchChallengeAdjust, sendMatchChallengeFinish, sendMatchRelayAdvance } from '../hooks/useBackend';
import { formatName } from '../utils/matchFormat';

const ALLIANCE_COLOR: Record<Alliance, string> = { red: '#d32f2f', blue: '#1565c0' };

type Participant = { station: StationName; team: number | null; state: StationControlState };

/** Which alliances have a robot on the field, and who, in match-slot order —
 *  which is the relay running order. */
function participants(stationStates: MatchState['stationStates']): Record<Alliance, Participant[]> {
  const sides: Record<Alliance, Participant[]> = { red: [], blue: [] };
  for (const [station, state] of Object.entries(stationStates) as [StationName, StationControlState | undefined][]) {
    if (!state?.joined || !state.alliance) continue;
    sides[state.alliance].push({ station, team: state.teamNumber, state });
  }
  for (const side of Object.values(sides)) {
    side.sort((a, b) => (a.state.matchSlot ?? '').localeCompare(b.state.matchSlot ?? ''));
  }
  return sides;
}

export function ChallengeTallyPanel({
  matchState,
  alliance: only,
}: {
  matchState: MatchState;
  /** Show one side only — a line ref's phone at that end of the field. */
  alliance?: Alliance;
}) {
  const { challenge, config, phase, stationStates } = matchState;
  if (!challenge) return null;

  const countUp = isCountUpTiming(config.challengeTiming);
  const relay = config.challengeTiming === 'relay';
  const { penaltyLaps, penaltySeconds } = challengePenalties({
    penaltyLaps: config.challengePenaltyLaps,
    penaltySeconds: config.challengePenaltySeconds,
  });
  const penaltyCost = countUp ? penaltySeconds : penaltyLaps;
  const sides = participants(stationStates);
  const onField = (['red', 'blue'] as Alliance[]).filter(a => sides[a].length > 0 && (!only || a === only));
  if (onField.length === 0) return null;

  // Finish is only meaningful while the robot is actually driving — the
  // engine refuses it while paused, so the button follows.
  const running = phase === 'teleop' || phase === 'endgame';

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          {formatName(config)} — {relay ? 'hand-offs' : countUp ? 'laps and finishes' : 'lap count'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {onField.map(alliance => (
            <AllianceTally
              key={alliance}
              alliance={alliance}
              side={sides[alliance]}
              tally={challenge[alliance]}
              config={config}
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
  side,
  tally,
  config,
  penaltyCost,
  running,
}: {
  alliance: Alliance;
  side: Participant[];
  tally: ChallengeTally;
  config: MatchState['config'];
  /** What one penalty costs, in this run's own unit. */
  penaltyCost: number;
  running: boolean;
}) {
  const color = ALLIANCE_COLOR[alliance];
  const countUp = isCountUpTiming(config.challengeTiming);
  const relay = config.challengeTiming === 'relay';
  const fmsHandoff = isFmsHandoff(config);
  const finished = tally.finishedAt !== undefined;
  const teams = side.map(p => p.team).filter((t): t is number => t !== null);
  const legsDone = tally.splits?.length ?? 0;
  const lastLeg = legsDone >= side.length - 1;

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

      {relay && fmsHandoff && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {side.map((p, i) => {
            const done = i < legsDone;
            const current = !finished && i === legsDone;
            return (
              <Box
                key={p.station}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: current ? color : 'divider',
                  backgroundColor: current ? `${color}22` : 'transparent',
                  opacity: done ? 0.6 : 1,
                }}
              >
                <Typography sx={{ minWidth: 48, color: 'text.secondary', fontSize: '0.8rem' }}>Leg {i + 1}</Typography>
                <Typography sx={{ flex: 1, fontWeight: current ? 800 : 500 }}>{p.team ?? p.station}</Typography>
                <Typography sx={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'text.secondary' }}>
                  {done
                    ? `${tally.splits![i].toFixed(1)}s`
                    : current
                      ? p.state.enabled
                        ? 'RUNNING'
                        : 'UP — not enabled'
                      : 'waiting'}
                </Typography>
              </Box>
            );
          })}
        </Box>
      )}

      {relay && fmsHandoff ? (
        <Button
          variant="contained"
          color={lastLeg ? 'success' : undefined}
          startIcon={lastLeg ? <FlagIcon /> : <SkipNextIcon />}
          disabled={!running || finished}
          onClick={() => sendMatchRelayAdvance(alliance)}
          sx={{
            ...(!lastLeg && {
              backgroundColor: color,
              '&:hover': { backgroundColor: color, filter: 'brightness(0.85)' },
            }),
            py: 2.5,
            fontSize: '1.3rem',
            fontWeight: 800,
          }}
        >
          {finished
            ? 'Finished'
            : lastLeg
              ? 'Home — stop the clock'
              : `Home — send robot ${Math.min(legsDone + 2, side.length)}`}
        </Button>
      ) : (
        !relay && (
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
        )
      )}
      {relay && config.relayHandoff === 'ds' && !finished && (
        <Typography variant="caption" color="text.secondary">
          The running robot's own Disable is the hand-off; this button is the backup.
        </Typography>
      )}

      <Box sx={{ display: 'flex', gap: 1 }}>
        {!relay && (
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
        )}
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
          : countUp
            ? `Each penalty adds ${penaltyCost}s to the finishing time.`
            : `Each penalty takes away ${penaltyCost === 1 ? 'a lap' : `${penaltyCost} laps`}.`}
      </Typography>

      {countUp && !fmsHandoff && (
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
