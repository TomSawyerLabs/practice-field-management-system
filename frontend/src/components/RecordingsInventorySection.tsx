import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { RecordingInventoryEntry } from '../../../src/types';
import {
  sendDeleteRecording,
  sendDeleteRecordingsBefore,
  useMatchRecordingState,
  useRecordingsInventory,
} from '../hooks/useBackend';
import { formatBytes } from './MatchVideoCard';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Admin → Recordings on disk: every match and practice run that is still
 * stored, how much space they take, how much is left, and a way to evict.
 * The retention sweep is the automatic policy (Match Video Recording
 * section); this is the eyes and the manual lever while that policy is
 * being worked out.
 */
export function RecordingsInventorySection() {
  const [inv, refresh] = useRecordingsInventory();
  const live = useMatchRecordingState();
  const [showAll, setShowAll] = useState(false);
  const [olderThanDays, setOlderThanDays] = useState('30');
  const [confirm, setConfirm] = useState<string | null>(null);

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

            <Table size="small">
              <TableHead>
                <TableRow>
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
  confirming,
  onConfirm,
  onCancel,
  onDelete,
}: {
  entry: RecordingInventoryEntry;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const when = e.startedAt
    ? new Date(e.startedAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
  const length =
    e.startedAt && e.endedAt ? `${Math.round((e.endedAt - e.startedAt) / 1000)} s` : e.startedAt ? 'in progress' : '—';
  const what = e.kind === 'match' ? `Match ${e.matchNumber ?? '?'}` : e.kind === 'practice' ? 'Practice run' : e.id;
  return (
    <TableRow>
      <TableCell>{when}</TableCell>
      <TableCell>
        {what}
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
          <Button size="small" color="error" onClick={onConfirm}>
            Delete
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
