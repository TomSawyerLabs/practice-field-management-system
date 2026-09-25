/**
 * The speed challenge leaderboard — a view over match history, not a store of
 * its own. Every challenge run leaves a history entry carrying its tally, so
 * ranking is a matter of reading them back.
 *
 * One row per set of teams, showing their best attempt. Window runs rank by
 * laps (penalties already deducted); stopwatch and relay runs rank by time
 * (penalties already added), and a run that never finished is a DNF and
 * sorts last. The three are never mixed in one table — they aren't
 * comparable.
 */
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import { ChallengeTiming, MatchHistoryEntry, isCountUpTiming } from '../../../src/types';
import { leaderboardRows } from '../../../src/challengeRanking';
import { CHALLENGE_COLOR } from '../utils/matchFormat';

const MEDALS = ['🥇', '🥈', '🥉'];

const TABLE_TITLES: Record<ChallengeTiming, string> = {
  window: 'Most laps',
  stopwatch: 'Fastest run',
  relay: 'Fastest relay',
};

export function ChallengeLeaderboard({
  matches,
  compact,
  limit,
}: {
  matches: MatchHistoryEntry[];
  /** TV styling: bigger type, no card chrome. */
  compact?: boolean;
  limit?: number;
}) {
  const tables = (['window', 'stopwatch', 'relay'] as ChallengeTiming[])
    .map(timing => ({ timing, rows: leaderboardRows(matches, timing) }))
    .filter(t => t.rows.length > 0);

  if (tables.length === 0) return null;

  const body = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 3 }}>
      {tables.map(({ timing, rows }) => (
        <Box key={timing}>
          <Typography
            sx={{
              color: compact ? 'rgba(255,255,255,0.55)' : 'text.secondary',
              textTransform: 'uppercase',
              letterSpacing: 2,
              fontWeight: 700,
              fontSize: compact ? '0.8rem' : '0.7rem',
              mb: 0.5,
            }}
          >
            {TABLE_TITLES[timing]}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: compact ? 0.75 : 0.5 }}>
            {rows.slice(0, limit ?? rows.length).map((row, i) => (
              <Box
                key={row.key}
                sx={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 1.5,
                  px: 1.5,
                  py: compact ? 1 : 0.75,
                  borderRadius: 1,
                  border: 1,
                  borderColor: i === 0 ? CHALLENGE_COLOR : 'divider',
                  backgroundColor: i === 0 ? 'rgba(126,87,194,0.12)' : 'transparent',
                }}
              >
                <Typography sx={{ minWidth: compact ? 44 : 32, fontSize: compact ? '1.4rem' : '1rem' }}>
                  {MEDALS[i] ?? `${i + 1}.`}
                </Typography>
                <Typography
                  sx={{
                    flex: 1,
                    fontWeight: 700,
                    fontSize: compact ? '1.6rem' : '1rem',
                    color: compact ? '#fff' : 'text.primary',
                  }}
                >
                  {row.teams.join(' + ')}
                </Typography>
                <Typography
                  sx={{
                    color: compact ? 'rgba(255,255,255,0.4)' : 'text.secondary',
                    fontSize: compact ? '0.9rem' : '0.75rem',
                  }}
                >
                  {row.attempts === 1 ? '1 run' : `${row.attempts} runs`}
                </Typography>
                <Typography
                  sx={{
                    fontFamily: 'monospace',
                    fontWeight: 800,
                    fontSize: compact ? '1.8rem' : '1.1rem',
                    color: compact ? '#fff' : 'text.primary',
                    minWidth: compact ? 110 : 80,
                    textAlign: 'right',
                  }}
                >
                  {isCountUpTiming(timing)
                    ? row.seconds === null
                      ? 'DNF'
                      : `${row.seconds.toFixed(1)}s`
                    : `${row.laps} ${row.laps === 1 ? 'lap' : 'laps'}`}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );

  if (compact) return body;

  return (
    <Card sx={{ mb: 2, borderLeft: `6px solid ${CHALLENGE_COLOR}` }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          Speed Challenge Leaderboard
        </Typography>
        {body}
      </CardContent>
    </Card>
  );
}
