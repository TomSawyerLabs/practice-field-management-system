import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import type { MatchHistoryEntry, MatchRecording, StationName } from '../../../src/types';
import { useMatchHistory, useMatchRecordingState } from '../hooks/useBackend';

/** Download URL for one recorded file. `download` forces an attachment with a
 *  friendly name; without it the browser can play/scrub the file inline. */
export function recordingUrl(matchId: string, rec: MatchRecording, download = true): string {
  const base = `/api/recordings/${encodeURIComponent(matchId)}/${encodeURIComponent(rec.file)}`;
  return download ? `${base}?download=1` : base;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** One download button per recorded stream of a match. */
export function RecordingButtons({
  match,
  size = 'small',
}: {
  match: Pick<MatchHistoryEntry, 'matchId' | 'recordings'>;
  size?: 'small' | 'medium';
}) {
  if (!match.matchId || !match.recordings?.length) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {match.recordings.map(rec =>
        rec.status === 'failed' ? (
          <Chip key={rec.name} size="small" color="warning" variant="outlined" label={`${rec.name}: no video`} />
        ) : (
          <Button
            key={rec.name}
            size={size}
            variant="outlined"
            color={rec.status === 'partial' ? 'warning' : 'primary'}
            href={recordingUrl(match.matchId!, rec)}
            download
          >
            🎥 {rec.name} · {formatBytes(rec.bytes)}
            {rec.status === 'partial' ? ' (gaps)' : ''}
          </Button>
        ),
      )}
    </Box>
  );
}

/**
 * Station page card: this team's recent matches with their video downloads.
 * Only renders when there is something to download or a recording is in
 * progress, so teams on fields without recording never see it.
 */
export function MatchVideoCard({ station, teamNumber }: { station: StationName; teamNumber: number | null }) {
  const history = useMatchHistory();
  const recording = useMatchRecordingState();

  const mine = (history?.matches ?? [])
    .filter(
      m =>
        m.recordings?.length &&
        m.teams.some(t => t.station === station || (teamNumber !== null && t.teamNumber === teamNumber)),
    )
    .slice(-5)
    .reverse();

  const inProgress =
    recording?.activeMatchId && recording.streams.some(s => s.status === 'recording' || s.status === 'finalizing');

  if (mine.length === 0 && !inProgress) return null;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Match Video
        </Typography>
        {inProgress && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
            Recording this match — downloads appear here a few seconds after it ends.
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {mine.map(m => (
            <Box
              key={m.matchId ?? m.startedAt}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
            >
              <Typography variant="body2" sx={{ minWidth: 150 }}>
                Match {m.matchNumber} · {formatWhen(m.startedAt)}
              </Typography>
              <RecordingButtons match={m} />
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}
