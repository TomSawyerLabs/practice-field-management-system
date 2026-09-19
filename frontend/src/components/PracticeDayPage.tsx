import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import DownloadIcon from '@mui/icons-material/Download';
import type { PublicPracticeDay, PublicPracticeItem } from '../../../src/types';
import { formatBytes } from './MatchVideoCard';

/**
 * A team's practice day: every match and every "record while enabled" run
 * the team took part in, each with its video, the balls scored and the
 * robot's telemetry, plus one zip of the lot. Addressed by a per-team,
 * per-day token, so it works from home without a pFMS login.
 */
export function PracticeDayPage({ token }: { token: string }) {
  const [day, setDay] = useState<PublicPracticeDay | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The scores bundle's page is a fixed full-screen TV layout; this one scrolls.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/practice/${encodeURIComponent(token)}`)
      .then(async res => {
        if (!res.ok)
          throw new Error(res.status === 404 ? 'This practice link is not valid.' : `Server error (${res.status})`);
        return (await res.json()) as PublicPracticeDay;
      })
      .then(d => {
        if (!cancelled) setDay(d);
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
          Practice day not found
        </Typography>
        <Typography color="text.secondary">{error}</Typography>
      </Container>
    );
  }
  if (!day) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Typography color="text.secondary">Loading…</Typography>
      </Container>
    );
  }

  const matches = day.items.filter(i => i.kind === 'match').length;
  const runs = day.items.length - matches;

  return (
    <Container maxWidth="sm" sx={{ py: 3 }}>
      <Typography variant="h4" sx={{ fontWeight: 700 }}>
        Team {day.teamNumber} · {day.dayLabel}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        {describeCounts(matches, runs)}. Each recording comes with the balls scored while it ran and the robot&apos;s
        battery and connection telemetry. Kept for {day.retentionDays} days.
      </Typography>

      {day.items.length > 0 && (
        <Card sx={{ mb: 2 }}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Button variant="contained" size="large" startIcon={<DownloadIcon />} href={day.zipUrl}>
              Download everything
            </Button>
            <Typography variant="body2" color="text.secondary">
              One zip, about {formatBytes(day.zipBytes)}: videos, <code>metadata.json</code>, <code>scores.csv</code>{' '}
              and <code>telemetry.csv</code> per recording.
            </Typography>
          </CardContent>
        </Card>
      )}

      {day.items.length === 0 && (
        <Card>
          <CardContent>
            <Typography color="text.secondary">
              Nothing has been recorded for team {day.teamNumber} on this day yet. Recordings appear here a few seconds
              after each match or practice run ends.
            </Typography>
          </CardContent>
        </Card>
      )}

      {day.items
        .slice()
        .reverse()
        .map(item => (
          <ItemCard key={item.id} item={item} teamNumber={day.teamNumber} />
        ))}
    </Container>
  );
}

function describeCounts(matches: number, runs: number): string {
  const parts: string[] = [];
  if (matches) parts.push(`${matches} match${matches === 1 ? '' : 'es'}`);
  if (runs) parts.push(`${runs} practice run${runs === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' and ') : 'No recordings yet';
}

function ItemCard({ item, teamNumber }: { item: PublicPracticeItem; teamNumber: number }) {
  const when = new Date(item.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const others = item.teams.filter(t => t.teamNumber !== teamNumber).map(t => t.teamNumber);
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
          <Typography variant="h6">
            {item.kind === 'match' ? `Match ${item.number}` : `Practice run ${item.number}`}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {when} · {formatDuration(item.durationSeconds)}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1.5 }}>
          {item.kind === 'match' && item.redScore !== undefined && item.blueScore !== undefined && (
            <Chip
              size="small"
              variant="outlined"
              label={`Red ${item.redScore} – Blue ${item.blueScore}`}
              sx={{ fontWeight: 600 }}
            />
          )}
          {item.scored && item.kind === 'practice' && (
            <Chip size="small" variant="outlined" label={`Balls: red ${item.scored.red}, blue ${item.scored.blue}`} />
          )}
          {item.battery && (
            <Chip
              size="small"
              variant="outlined"
              label={`Battery ${item.battery.min.toFixed(1)}–${item.battery.max.toFixed(1)} V`}
            />
          )}
          {others.length > 0 && (
            <Chip size="small" variant="outlined" label={`Also on the field: ${others.join(', ')}`} />
          )}
          {item.summaryUrl && (
            <Button size="small" variant="text" href={item.summaryUrl} target="_blank" rel="noopener">
              Match summary
            </Button>
          )}
        </Box>

        {item.recordings.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No usable video was captured.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {item.recordings.map(rec => (
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

        {(item.metadataUrl || item.scoresCsvUrl || item.telemetryCsvUrl) && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1.5 }}>
            {item.scoresCsvUrl && (
              <Button size="small" variant="outlined" href={`${item.scoresCsvUrl}?download=1`}>
                Balls scored (CSV)
              </Button>
            )}
            {item.telemetryCsvUrl && (
              <Button size="small" variant="outlined" href={`${item.telemetryCsvUrl}?download=1`}>
                Telemetry (CSV)
              </Button>
            )}
            {item.metadataUrl && (
              <Button size="small" variant="outlined" href={`${item.metadataUrl}?download=1`}>
                Everything (JSON)
              </Button>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
