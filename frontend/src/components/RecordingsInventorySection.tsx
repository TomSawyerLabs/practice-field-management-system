import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import VideocamOffIcon from '@mui/icons-material/VideocamOff';
import type { RecordingInventoryEntry, RecordingInventoryFile } from '../../../src/types';
import {
  matchSummaryUrl,
  sendDeleteRecording,
  sendDeleteRecordingsBefore,
  useMatchHistory,
  useMatchRecordingState,
  usePublicUrl,
  useRecordingsInventory,
} from '../hooks/useBackend';
import { formatBytes, recordingSidecarUrl, recordingThumbUrl, recordingUrl } from './MatchVideoCard';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every time on this page is the local time of whoever is reading it —
 *  `toLocaleString` with no timezone override. Recordings are talked about
 *  on the field ("the 7:40 run"), never in UTC. */
function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The same instant with its date, seconds and zone spelled out, for the
 *  expanded detail where there is room to be unambiguous. */
function formatWhenFull(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The files worth offering a player for: a failed capture wrote nothing. */
function playable(entry: RecordingInventoryEntry): RecordingInventoryFile[] {
  return (entry.files ?? []).filter(f => f.status !== 'failed');
}

/**
 * Admin → Recordings on disk: every match and practice run that is still
 * stored, how much space they take, how much is left, and a way to watch or
 * evict them. The retention sweep is the automatic policy (Match Video
 * Recording section); this is the eyes and the manual lever while that
 * policy is being worked out.
 *
 * Every row opens into the videos themselves, because deciding whether a
 * directory is worth keeping — or noticing a stream that has been pointed at
 * the wrong camera all evening — takes seeing it, not just its size.
 */
export function RecordingsInventorySection() {
  const [inv, refresh] = useRecordingsInventory();
  const live = useMatchRecordingState();
  const history = useMatchHistory();
  const publicUrl = usePublicUrl();
  const [showAll, setShowAll] = useState(false);
  const [olderThanDays, setOlderThanDays] = useState('30');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  /** Share tokens for the matches we have history for, so a row can link to
   *  the public summary page it already has. */
  const shareTokens = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of history?.matches ?? []) if (m.matchId && m.shareToken) map.set(m.matchId, m.shareToken);
    return map;
  }, [history]);

  const stats = useMemo(() => {
    if (!inv) return null;
    const entries = inv.entries;
    const total = entries.reduce((n, e) => n + e.bytes, 0);
    const now = inv.scannedAt;
    const last7 = entries.filter(e => e.startedAt && now - e.startedAt < 7 * DAY_MS).reduce((n, e) => n + e.bytes, 0);
    const perDay = last7 / 7;
    const daysLeft = inv.diskFreeBytes !== undefined && perDay > 0 ? inv.diskFreeBytes / perDay : undefined;
    const oldest = entries.reduce<number | undefined>(
      (o, e) => (e.startedAt && (o === undefined || e.startedAt < o) ? e.startedAt : o),
      undefined,
    );
    const byTeam = new Map<number, { bytes: number; count: number }>();
    for (const e of entries) {
      for (const t of e.teams.length ? e.teams : [0]) {
        const cur = byTeam.get(t) ?? { bytes: 0, count: 0 };
        cur.bytes += e.bytes / Math.max(1, e.teams.length);
        cur.count++;
        byTeam.set(t, cur);
      }
    }
    return {
      total,
      count: entries.length,
      matches: entries.filter(e => e.kind === 'match').length,
      runs: entries.filter(e => e.kind === 'practice').length,
      perDay,
      daysLeft,
      oldest,
      byTeam: [...byTeam.entries()].sort((a, b) => b[1].bytes - a[1].bytes),
    };
  }, [inv]);

  const olderDays = Number.parseInt(olderThanDays, 10);
  const olderCutoff = Number.isInteger(olderDays) && olderDays >= 0 ? Date.now() - olderDays * DAY_MS : null;
  const olderCount = inv && olderCutoff !== null ? inv.entries.filter(e => (e.startedAt ?? 0) < olderCutoff).length : 0;
  const olderBytes =
    inv && olderCutoff !== null
      ? inv.entries.filter(e => (e.startedAt ?? 0) < olderCutoff).reduce((n, e) => n + e.bytes, 0)
      : 0;

  const rows = inv ? (showAll ? inv.entries : inv.entries.slice(0, 25)) : [];

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h5">Recordings on Disk</Typography>
          <Button size="small" onClick={refresh}>
            Refresh
          </Button>
        </Box>

        {!inv || !stats ? (
          <Typography variant="body2" color="text.secondary">
            Scanning…
          </Typography>
        ) : (
          <>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
              {stats.count} recording{stats.count === 1 ? '' : 's'} ({stats.matches} match
              {stats.matches === 1 ? '' : 'es'}, {stats.runs} practice run{stats.runs === 1 ? '' : 's'}) using{' '}
              <strong>{formatBytes(stats.total)}</strong> in <code>{inv.directory}</code>.{' '}
              {inv.diskFreeBytes !== undefined && (
                <>
                  <strong>{formatBytes(inv.diskFreeBytes)}</strong> free on that volume.{' '}
                </>
              )}
              Last 7 days added {formatBytes(stats.perDay)}/day
              {stats.daysLeft !== undefined && (
                <>
                  {' '}
                  — at that rate the disk fills in about <strong>{Math.round(stats.daysLeft)} days</strong>
                </>
              )}
              . Oldest: {stats.oldest ? new Date(stats.oldest).toLocaleDateString() : 'none'}. The daily sweep deletes
              anything older than {inv.retentionDays} days (set above).
              {live?.activeMatchId && ' A match is being recorded right now.'}
            </Typography>

            {stats.byTeam.length > 0 && (
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 2 }}>
                {stats.byTeam.map(([team, v]) => (
                  <Chip
                    key={team}
                    size="small"
                    variant="outlined"
                    label={`${team === 0 ? 'no team' : team}: ${formatBytes(v.bytes)} · ${v.count}`}
                  />
                ))}
              </Box>
            )}

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 2 }}>
              <TextField
                size="small"
                label="Older than (days)"
                value={olderThanDays}
                onChange={e => setOlderThanDays(e.target.value.replace(/\D/g, ''))}
                sx={{ width: 150 }}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
              {confirm === 'older' ? (
                <>
                  <Button
                    size="small"
                    color="error"
                    variant="contained"
                    disabled={olderCutoff === null}
                    onClick={() => {
                      if (olderCutoff !== null) sendDeleteRecordingsBefore(olderCutoff);
                      setConfirm(null);
                    }}
                  >
                    Really delete {olderCount} ({formatBytes(olderBytes)})
                  </Button>
                  <Button size="small" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  disabled={olderCutoff === null || olderCount === 0}
                  onClick={() => setConfirm('older')}
                >
                  Delete {olderCount} recording{olderCount === 1 ? '' : 's'} ({formatBytes(olderBytes)})
                </Button>
              )}
            </Box>

            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
              Tap a recording to watch it here. Times are this device&apos;s local time.
            </Typography>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 96 }} />
                  <TableCell>When</TableCell>
                  <TableCell>What</TableCell>
                  <TableCell>Teams</TableCell>
                  <TableCell align="right">Length</TableCell>
                  <TableCell align="right">Size</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(e => (
                  <InventoryRow
                    key={e.id}
                    entry={e}
                    open={open === e.id}
                    onToggle={() => setOpen(cur => (cur === e.id ? null : e.id))}
                    summaryUrl={shareTokens.has(e.id) ? matchSummaryUrl(publicUrl, shareTokens.get(e.id)!) : undefined}
                    confirming={confirm === e.id}
                    onConfirm={() => setConfirm(e.id)}
                    onCancel={() => setConfirm(null)}
                    onDelete={() => {
                      sendDeleteRecording(e.id);
                      setConfirm(null);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
            {inv.entries.length > 25 && (
              <Button size="small" sx={{ mt: 1 }} onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show the latest 25' : `Show all ${inv.entries.length}`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function InventoryRow({
  entry: e,
  open,
  onToggle,
  summaryUrl,
  confirming,
  onConfirm,
  onCancel,
  onDelete,
}: {
  entry: RecordingInventoryEntry;
  open: boolean;
  onToggle: () => void;
  summaryUrl?: string;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const when = e.startedAt ? formatWhen(e.startedAt) : '—';
  const length =
    e.startedAt && e.endedAt ? `${Math.round((e.endedAt - e.startedAt) / 1000)} s` : e.startedAt ? 'in progress' : '—';
  const what = e.kind === 'match' ? `Match ${e.matchNumber ?? '?'}` : e.kind === 'practice' ? 'Practice run' : e.id;
  const videos = playable(e);

  return (
    <>
      <TableRow hover sx={{ '& > td': { borderBottom: open ? 'none' : undefined } }}>
        <TableCell sx={{ p: 0.5 }}>
          <Thumbnail entry={e} onClick={onToggle} />
        </TableCell>
        <TableCell>{when}</TableCell>
        <TableCell>
          <ButtonBase onClick={onToggle} sx={{ textAlign: 'left', fontSize: 'inherit', fontWeight: open ? 600 : 400 }}>
            {what}
          </ButtonBase>
          {e.videos === 0 && <Chip size="small" color="warning" variant="outlined" label="no video" sx={{ ml: 1 }} />}
        </TableCell>
        <TableCell>{e.teams.join(', ') || '—'}</TableCell>
        <TableCell align="right">{length}</TableCell>
        <TableCell align="right">{formatBytes(e.bytes)}</TableCell>
        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
          {confirming ? (
            <>
              <Button size="small" color="error" variant="contained" onClick={onDelete}>
                Really delete
              </Button>
              <Button size="small" onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="small" onClick={onToggle} disabled={videos.length === 0}>
                {open ? 'Close' : 'Watch'}
              </Button>
              <Button size="small" color="error" onClick={onConfirm}>
                Delete
              </Button>
            </>
          )}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell sx={{ py: 0, borderBottom: open ? undefined : 'none' }} colSpan={7}>
          <Collapse in={open} unmountOnExit>
            <RecordingDetail entry={e} summaryUrl={summaryUrl} />
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

/**
 * The poster frame, which doubles as the row's open/close control. The
 * backend makes the image the first time it is asked for and 404s when it
 * cannot, so a broken image is expected and falls back to an icon rather
 * than the browser's broken-image glyph.
 */
function Thumbnail({ entry, onClick }: { entry: RecordingInventoryEntry; onClick: () => void }) {
  const [failed, setFailed] = useState(false);
  const first = playable(entry)[0];
  const box = { width: 88, height: 50, borderRadius: 1, display: 'grid', placeItems: 'center' } as const;

  if (!first || failed) {
    return (
      <Box sx={{ ...box, bgcolor: 'action.hover', color: 'text.disabled' }}>
        <VideocamOffIcon fontSize="small" />
      </Box>
    );
  }
  return (
    <ButtonBase onClick={onClick} sx={{ ...box, overflow: 'hidden', position: 'relative', bgcolor: 'common.black' }}>
      <Box
        component="img"
        src={recordingThumbUrl(entry.id, first.file)}
        alt={`First look at ${entry.id}`}
        loading="lazy"
        onError={() => setFailed(true)}
        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <PlayArrowIcon
        fontSize="small"
        sx={{ position: 'absolute', color: 'common.white', filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.9))' }}
      />
    </ButtonBase>
  );
}

/** One opened row: a player per stream, the downloads, the sidecars, and
 *  the directory the whole lot lives in. */
function RecordingDetail({ entry: e, summaryUrl }: { entry: RecordingInventoryEntry; summaryUrl?: string }) {
  const files = e.files ?? [];
  const videos = files.filter(f => f.status !== 'failed');

  return (
    <Box sx={{ py: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          {e.startedAt ? formatWhenFull(e.startedAt) : 'No manifest — this directory was never finished'} ·{' '}
          <code>{e.id}</code>
        </Typography>
        {summaryUrl && (
          <Button size="small" variant="outlined" href={summaryUrl} target="_blank" rel="noopener">
            Match summary page
          </Button>
        )}
      </Box>

      {videos.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No usable video was captured
          {files.find(f => f.error) ? `: ${files.find(f => f.error)!.error}` : '.'}
        </Typography>
      ) : (
        videos.map(f => (
          <Box key={f.file}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.75 }}>
              <Typography sx={{ fontWeight: 600 }}>{f.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {formatBytes(f.bytes)}
                {f.durationSeconds ? ` · ${formatDuration(f.durationSeconds)}` : ''}
              </Typography>
              {f.status === 'partial' && (
                <Chip size="small" color="warning" variant="outlined" label={f.error ?? 'video has a gap'} />
              )}
              <Button size="small" variant="contained" href={recordingUrl(e.id, f)} download>
                Download
              </Button>
            </Box>
            <Box
              component="video"
              controls
              // metadata, not none: a player that knows its duration can be
              // scrubbed straight away, and the poster is already on disk.
              preload="metadata"
              poster={recordingThumbUrl(e.id, f.file)}
              src={recordingUrl(e.id, f, false)}
              sx={{ width: '100%', maxWidth: 720, borderRadius: 1, bgcolor: 'common.black' }}
            />
          </Box>
        ))
      )}

      {files.some(f => f.status === 'failed') && (
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          {files
            .filter(f => f.status === 'failed')
            .map(f => (
              <Chip
                key={f.file}
                size="small"
                color="warning"
                variant="outlined"
                label={`${f.name}: ${f.error ?? 'nothing captured'}`}
              />
            ))}
        </Box>
      )}

      {(e.sidecars ?? []).length > 0 && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            Data recorded alongside:
          </Typography>
          {(e.sidecars ?? []).map(file => (
            <Button key={file} size="small" variant="outlined" href={recordingSidecarUrl(e.id, file)}>
              {file}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
}
