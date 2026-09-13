import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import BoltIcon from '@mui/icons-material/Bolt';
import type { Alliance, PublicMatchSummary } from '../../../src/types';
import { formatBytes } from './MatchVideoCard';

/**
 * What a drive team lands on after scanning the post-match QR code:
 * the match result and this match's video, addressed by share token.
 * Works without any pFMS login — the token is the credential.
 */
export function MatchSummaryPage({ token }: { token: string }) {
  const [summary, setSummary] = useState<PublicMatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This page shares the scoreboard bundle, whose scores.html sets
  // `body { overflow: hidden }` for the full-screen TV display. The summary is
  // a normal scrolling page (especially on a phone), so allow scrolling here.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/match/${encodeURIComponent(token)}`)
      .then(async res => {
        if (!res.ok)
          throw new Error(res.status === 404 ? 'This match link is not valid.' : `Server error (${res.status})`);
        return (await res.json()) as PublicMatchSummary;
      })
      .then(s => {
        if (!cancelled) setSummary(s);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Typography variant="h5" gutterBottom>
          Match not found
        </Typography>
        <Typography color="text.secondary">{error}</Typography>
      </Container>
    );
  }
  if (!summary) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Typography color="text.secondary">Loading match…</Typography>
      </Container>
    );
  }

  const redWon = summary.redScore > summary.blueScore;
  const blueWon = summary.blueScore > summary.redScore;
  const when = new Date(summary.startedAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const endLabels: Record<string, string> = {
    normal: 'Completed',
    completed: 'Completed',
    stopped: 'Stopped early',
    estop: 'Emergency stopped',
    abandoned: 'Abandoned',
    empty: 'All teams left',
  };

  return (
    <Container maxWidth="sm" sx={{ py: 3 }}>
      <Typography variant="h4" sx={{ fontWeight: 700 }}>
        Match {summary.matchNumber}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        {when} · {formatDuration(summary.durationSeconds)} · {endLabels[summary.endReason] ?? summary.endReason}
      </Typography>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 2 }}>
            <AllianceColumn summary={summary} alliance="red" won={redWon} />
            <Typography variant="h4" sx={{ alignSelf: 'center', color: 'text.disabled' }}>
              —
            </Typography>
            <AllianceColumn summary={summary} alliance="blue" won={blueWon} />
          </Box>
        </CardContent>
      </Card>

      {(summary.periodBreakdown || (summary.scoreTimeline && summary.scoreTimeline.length > 1)) && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Scoring breakdown
            </Typography>
            {summary.periodBreakdown && <PeriodTable breakdown={summary.periodBreakdown} />}
            {summary.scoreTimeline && summary.scoreTimeline.length > 1 && (
              <Box sx={{ mt: 2 }}>
                <ScoreChart data={summary.scoreTimeline} />
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Match video
          </Typography>
          {summary.recordings.length === 0 ? (
            <Typography color="text.secondary">No video was recorded for this match.</Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {summary.recordings.map(rec => (
                <Box key={rec.file}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                    <Typography sx={{ fontWeight: 600 }}>{rec.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {formatBytes(rec.bytes)}
                      {rec.durationSeconds ? ` · ${formatDuration(Math.round(rec.durationSeconds))}` : ''}
                    </Typography>
                    {rec.status === 'partial' && (
                      <Chip size="small" color="warning" variant="outlined" label="video has a gap" />
                    )}
                    <Button variant="contained" size="small" href={rec.downloadUrl} download>
                      Download
                    </Button>
                  </Box>
                  <video
                    controls
                    preload="none"
                    src={rec.url}
                    style={{ width: '100%', borderRadius: 4, background: '#000' }}
                  />
                </Box>
              ))}
            </Box>
          )}
          {summary.reviewUrl && (
            <Button
              sx={{ mt: 2 }}
              variant="outlined"
              size="small"
              href={summary.reviewUrl}
              target="_blank"
              rel="noopener"
            >
              Open score review
            </Button>
          )}
        </CardContent>
      </Card>
    </Container>
  );
}

/** Final points per period (auto/teleop/endgame or shift periods). */
function PeriodTable({ breakdown }: { breakdown: Record<string, { red: number; blue: number }> }) {
  const rows = Object.entries(breakdown);
  if (rows.length === 0) return null;
  const pretty = (k: string) =>
    k
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]/g, ' ')
      .replace(/^\w/, c => c.toUpperCase());
  return (
    <Box
      component="table"
      sx={{
        width: '100%',
        borderCollapse: 'collapse',
        '& td, & th': { py: 0.5, px: 1, textAlign: 'right', fontSize: '0.85rem' },
        '& th:first-of-type, & td:first-of-type': { textAlign: 'left', color: 'text.secondary' },
      }}
    >
      <thead>
        <tr>
          <th />
          <th style={{ color: '#ef5350' }}>Red</th>
          <th style={{ color: '#42a5f5' }}>Blue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{pretty(k)}</td>
            <td>{v.red}</td>
            <td>{v.blue}</td>
          </tr>
        ))}
      </tbody>
    </Box>
  );
}

/** Running score for each alliance across the match, as a small inline SVG
 *  line chart (no chart dependency). x = seconds into the match. */
function ScoreChart({ data }: { data: { t: number; red: number; blue: number }[] }) {
  if (data.length < 2) return null;
  const W = 320;
  const H = 140;
  const pad = 22;
  const maxT = Math.max(...data.map(d => d.t), 1);
  const maxS = Math.max(...data.map(d => Math.max(d.red, d.blue)), 1);
  const x = (t: number) => pad + (t / maxT) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / maxS) * (H - pad * 2);
  const poly = (key: 'red' | 'blue') => data.map(d => `${x(d.t).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  return (
    <Box sx={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Score over the match">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#444" strokeWidth="1" />
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#444" strokeWidth="1" />
        <polyline fill="none" stroke="#ef5350" strokeWidth="2" points={poly('red')} />
        <polyline fill="none" stroke="#42a5f5" strokeWidth="2" points={poly('blue')} />
        <text x={pad - 4} y={pad + 3} fill="#888" fontSize="9" textAnchor="end">
          {maxS}
        </text>
        <text x={W - pad} y={H - 6} fill="#888" fontSize="9" textAnchor="end">
          {maxT}s
        </text>
      </svg>
    </Box>
  );
}

function AllianceColumn({ summary, alliance, won }: { summary: PublicMatchSummary; alliance: Alliance; won: boolean }) {
  const color = alliance === 'red' ? 'error.main' : 'info.main';
  const teams = summary.teams.filter(t => t.alliance === alliance);
  const live = alliance === 'red' ? summary.redScore : summary.blueScore;
  const review = summary.review?.[alliance];
  const isAutoWinner = summary.autoWinner === alliance;
  return (
    <Box sx={{ flex: 1, textAlign: 'center' }}>
      <Typography variant="overline" sx={{ color, fontWeight: 700 }}>
        {alliance === 'red' ? 'Red' : 'Blue'} alliance
      </Typography>
      {/* Fixed-height badge row so the winner/auto icons never shift the score
          up or down — the trophy no longer rides on the big number. */}
      <Box sx={{ height: 30, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0.75 }}>
        {won && <EmojiEventsIcon sx={{ fontSize: 28, color }} />}
        {isAutoWinner && <BoltIcon sx={{ fontSize: 24, color }} />}
      </Box>
      <Typography variant="h2" sx={{ color, fontWeight: 800, lineHeight: 1 }}>
        {review ? review.score : live}
      </Typography>
      {review && review.score !== live && (
        <Typography variant="caption" color="text.secondary">
          sensors counted {live}; reviewed by {review.reviewer}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, mt: 1 }}>
        {teams.map(t => (
          <Box key={t.station} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <img
              src={t.avatarUrl}
              alt=""
              width={24}
              height={24}
              style={{ borderRadius: 4 }}
              onError={e => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
            />
            <Typography sx={{ fontWeight: 600 }}>{t.teamNumber}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
