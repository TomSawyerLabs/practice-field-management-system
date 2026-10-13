/**
 * The leaderboard view of /scores: the speed challenge leaderboard full
 * screen, for a TV set to it on a speed challenge day (?view=leaderboard,
 * the control chip, or the admin page's display list). Every table gets its
 * own column, and a strip across the top follows the run on the field so
 * the TV is still worth watching while one is going.
 *
 * Unlike the leaderboard the scoreboard shows between runs, this ignores
 * match control's "Show on the scoreboard TVs" switch: setting a TV to this
 * view is the opt-in.
 */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {
  challengeScore,
  isCountUpTiming,
  type Alliance,
  type ChallengeTiming,
  type MatchState,
} from '../../../src/types';
import { useChallengeLeaderboard, useMatchState } from '../hooks/useBackend';
import { useCastReceiverRegistration } from '../hooks/useCastReceiverRegistration';
import { CHALLENGE_COLOR, challengeElapsed, formatName, isChallengeConfig, phaseLabel } from '../utils/matchFormat';
import { switchScoreboardView } from '../utils/scoreboardView';
import { ChallengeLeaderboard } from './ChallengeLeaderboard';
import { ControlChip } from './ControlChip';

const TIMINGS: ChallengeTiming[] = ['window', 'stopwatch', 'relay'];
const ALLIANCE_COLOR: Record<Alliance, string> = { red: '#ef5350', blue: '#42a5f5' };

export function LeaderboardTvPage() {
  const leaderboard = useChallengeLeaderboard();
  const matchState = useMatchState();

  // The other display settings aren't used here, but the admin page's display
  // list shows them — report what the scoreboard would come back with.
  useCastReceiverRegistration({
    swapped: localStorage.getItem('scoreboard-swap') === '1',
    muted: localStorage.getItem('scoreboard-muted') === '1',
    checks: localStorage.getItem('scoreboard-checks') === '1',
    view: 'leaderboard',
  });

  const tables = TIMINGS.filter(timing => (leaderboard.tables[timing]?.length ?? 0) > 0);

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        backgroundColor: '#000',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        px: 4,
        py: 3,
        gap: 3,
      }}
    >
      <Typography
        sx={{
          color: CHALLENGE_COLOR,
          fontWeight: 800,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          textAlign: 'center',
          fontSize: 'clamp(1.4rem, 3.5vw, 3rem)',
        }}
      >
        Speed Challenge Leaderboard
      </Typography>

      {matchState && <RunStrip matchState={matchState} />}

      {tables.length === 0 ? (
        <Typography sx={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', fontSize: '1.6rem', mt: 6 }}>
          No speed challenge runs yet
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
          {tables.map(timing => (
            <Box key={timing} sx={{ flex: '1 1 0', minWidth: 420, maxWidth: 900 }}>
              <ChallengeLeaderboard tables={{ [timing]: leaderboard.tables[timing] }} compact limit={10} />
            </Box>
          ))}
        </Box>
      )}

      {/* Controls — hidden on a Chromecast receiver, faint until hovered */}
      {!window.__isCastReceiver && (
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            right: 16,
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            opacity: 0.2,
            transition: 'opacity 0.5s ease',
            '&:hover': { opacity: 1 },
          }}
        >
          <ControlChip icon="📊" label="scoreboard" onClick={() => switchScoreboardView('scoreboard')} />
          {window.__castReady && (
            <google-cast-launcher style={{ width: 24, height: 24, cursor: 'pointer', opacity: 0.5 }} />
          )}
        </Box>
      )}
    </Box>
  );
}

/** The run on the field: who's up, the clock, and each alliance's laps or
 *  time. Nothing when the field isn't set up for a challenge. */
function RunStrip({ matchState }: { matchState: MatchState }) {
  const { phase, config } = matchState;
  if (!isChallengeConfig(config) || phase === 'idle') return null;

  const timing = config.challengeTiming ?? 'window';
  const countUp = isCountUpTiming(timing);
  const clock = countUp ? Math.floor(challengeElapsed(matchState)) : Math.ceil(Math.max(0, matchState.remainingTime));
  const label = phase === 'created' ? 'Up next' : phaseLabel(phase, config);

  const alliances = (['red', 'blue'] as Alliance[])
    .map(alliance => ({
      alliance,
      teams: Object.values(matchState.stationStates)
        .filter(s => s?.joined && s.alliance === alliance && s.teamNumber)
        .map(s => s!.teamNumber!),
    }))
    .filter(a => a.teams.length > 0);

  const result = (alliance: Alliance): string => {
    const tally = matchState.challenge?.[alliance];
    if (timing === 'relay') return `${tally?.splits?.length ?? 0} home`;
    if (tally?.finishedAt !== undefined) return `${tally.finishedAt.toFixed(1)}s`;
    const { laps } = challengeScore(tally, timing, {
      penaltyLaps: config.challengePenaltyLaps,
      penaltySeconds: config.challengePenaltySeconds,
    });
    return `${laps} ${laps === 1 ? 'lap' : 'laps'}`;
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: 6,
        px: 3,
        py: 2,
        borderRadius: 2,
        border: `2px solid ${CHALLENGE_COLOR}`,
        backgroundColor: 'rgba(126,87,194,0.12)',
      }}
    >
      <Box sx={{ textAlign: 'center' }}>
        <Typography sx={{ color: CHALLENGE_COLOR, fontWeight: 800, letterSpacing: '0.12em', fontSize: '1rem' }}>
          {formatName(config).toUpperCase()} · {label.toUpperCase()}
        </Typography>
        {phase !== 'created' && phase !== 'postMatch' && (
          <Typography sx={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
            {Math.floor(clock / 60)}:{String(clock % 60).padStart(2, '0')}
          </Typography>
        )}
      </Box>
      {alliances.map(({ alliance, teams }) => (
        <Box key={alliance} sx={{ textAlign: 'center', minWidth: 220 }}>
          <Typography sx={{ color: ALLIANCE_COLOR[alliance], fontWeight: 800, fontSize: 'clamp(1.4rem, 3vw, 2.4rem)' }}>
            {teams.join(' + ')}
          </Typography>
          {phase !== 'created' && (
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 'clamp(1.8rem, 4vw, 3.2rem)' }}>
              {result(alliance)}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}
