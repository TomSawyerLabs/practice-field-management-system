import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import VideocamIcon from '@mui/icons-material/Videocam';
import VideocamOffIcon from '@mui/icons-material/VideocamOff';
import Typography from '@mui/material/Typography';
import type { MatchHistoryEntry, MatchRecording, PracticeRunEntry } from '../../../src/types';
import {
  practiceDayUrl,
  sendSetPracticeRecording,
  useMatchHistory,
  useMatchRecordingState,
  usePracticeDayLink,
  usePracticeRecordingState,
  usePublicUrl,
} from '../hooks/useBackend';
import { CopyToClipboard } from './CopyToClipboard';

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

/** Icon-only variant for dense lists: one 🎥 per recorded stream. */
export function RecordingIconButtons({ match }: { match: Pick<MatchHistoryEntry, 'matchId' | 'recordings'> }) {
  if (!match.matchId || !match.recordings?.length) return null;
  return (
    <>
      {match.recordings.map(rec =>
        rec.status === 'failed' ? (
          <Tooltip key={rec.name} title={`${rec.name}: no video was captured`}>
            <span>
              <IconButton size="small" disabled>
                <VideocamOffIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Tooltip
            key={rec.name}
            title={`Download ${rec.name} video · ${formatBytes(rec.bytes)}${rec.status === 'partial' ? ' (has gaps)' : ''}`}
          >
            <IconButton
              size="small"
              color={rec.status === 'partial' ? 'warning' : 'primary'}
              href={recordingUrl(match.matchId!, rec)}
              download
            >
              <VideocamIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ),
      )}
    </>
  );
}

/** A match or a practice run, as one row in the station card's list. */
interface VideoRow {
  key: string;
  label: string;
  startedAt: number;
  match: Pick<MatchHistoryEntry, 'matchId' | 'recordings'>;
}

/**
 * Station page card: "record while enabled" for this team, today's practice
 * link, and this team's recent videos (matches and practice runs) with
 * their downloads. Rendered whenever the field can record at all, so the
 * checkbox is there to find before the first recording exists; on a field
 * without streams it only appears once there is something to download.
 *
 * Matches are picked by team number only. The slot a team sits in is reused
 * by whoever comes next, so matching on it showed the previous team's
 * videos to the new one (seen 2026-09-18: a team practicing alone the
 * night before had left 16 matches on slot 1).
 */
export function MatchVideoCard({ teamNumber }: { teamNumber: number | null }) {
  const history = useMatchHistory();
  const recording = useMatchRecordingState();
  const practice = usePracticeRecordingState();
  const dayLink = usePracticeDayLink(teamNumber);
  const publicUrl = usePublicUrl();

  const canRecord = !!recording?.available && recording.streams.some(s => s.enabled);
  const optedIn = teamNumber !== null && !!practice?.optIn.includes(teamNumber);

  const rows: VideoRow[] = [];
  if (teamNumber !== null) {
    for (const m of history?.matches ?? []) {
      if (!m.recordings?.length || !m.teams.some(t => t.teamNumber === teamNumber)) continue;
      rows.push({
        key: m.matchId ?? String(m.startedAt),
        label: `Match ${m.matchNumber}`,
        startedAt: m.startedAt,
        match: m,
      });
    }
    for (const r of practice?.runs ?? []) {
      if (r.teamNumber !== teamNumber) continue;
      rows.push({ key: r.id, label: 'Practice run', startedAt: r.startedAt, match: runAsMatch(r) });
    }
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  const recent = rows.slice(0, 8);

  const matchInProgress =
    recording?.activeMatchId && recording.streams.some(s => s.status === 'recording' || s.status === 'finalizing');
  const runInProgress = teamNumber !== null && !!practice?.activeRuns.some(r => r.teamNumber === teamNumber);

  if (!canRecord && recent.length === 0 && !matchInProgress) return null;

  const status = !canRecord
    ? (practice?.unavailableReason ?? 'Recording is not set up on this field')
    : runInProgress
      ? 'Recording now — the clip ends 3 s after you disable, and coming back within 6 s keeps it one video.'
      : optedIn
        ? practice?.buffering
          ? 'Ready: enabling your robot starts a clip (with 3 s before and after).'
          : 'Recording starts as soon as your Driver Station connects and you enable.'
        : 'Tick to get a video of every time you enable your robot outside a match.';

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          Video
        </Typography>

        {teamNumber !== null && (
          <Box sx={{ mb: 1.5 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={optedIn}
                  disabled={!canRecord}
                  onChange={e => sendSetPracticeRecording(teamNumber, e.target.checked)}
                />
              }
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <span>Record while enabled</span>
                  {runInProgress && <Chip size="small" color="error" label="● Recording" />}
                </Box>
              }
            />
            <Typography variant="body2" sx={{ color: 'text.secondary', ml: 4 }}>
              {status}
            </Typography>
          </Box>
        )}

        {matchInProgress && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
            Recording this match — downloads appear here a few seconds after it ends.
          </Typography>
        )}

        {dayLink?.token && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
            <Typography variant="body2">
              Today&apos;s videos ({dayLink.count}), for downloading later or from home:
            </Typography>
            <Button
              size="small"
              variant="contained"
              href={practiceDayUrl(publicUrl, dayLink.token)}
              target="_blank"
              rel="noopener"
            >
              Open
            </Button>
            <CopyToClipboard text={practiceDayUrl(publicUrl, dayLink.token)} tooltipText="Copy the link">
              <Button size="small" variant="outlined">
                Copy link
              </Button>
            </CopyToClipboard>
          </Box>
        )}

        {recent.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {recent.map(row => (
              <Box key={row.key} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ minWidth: 190 }}>
                  {row.label} · {formatWhen(row.startedAt)}
                </Typography>
                <RecordingButtons match={row.match} />
              </Box>
            ))}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/** A practice run's files are served by the same route as a match's. */
function runAsMatch(run: PracticeRunEntry): Pick<MatchHistoryEntry, 'matchId' | 'recordings'> {
  return { matchId: run.id, recordings: run.recordings };
}
