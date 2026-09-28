import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import CloseIcon from '@mui/icons-material/Close';
import { TeamAvatar } from './TeamAvatar';
import type { Alliance, QueueEntry, QueueShape } from '../../../src/types';
import { useQueueState, sendQueueAdmin } from '../hooks/useBackend';
import { AllianceTeams, QueueNextUp, entryStatusLabel, formatQueueTime } from './QueueNextUp';
import { generateSchedule, parseSchedule, type ScheduleMatch } from '../../../src/scheduleGenerator';

/** "1234 5678, 9012" → [1234, 5678, 9012], at most three. */
function parseTeams(text: string): number[] {
  return Array.from(
    new Set(
      text
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map(Number)
        .filter(n => n > 0),
    ),
  ).slice(0, 3);
}

/** "14:05" today → epoch ms, or undefined. */
function parseTimeToday(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

function ShapePicker({ value, onChange }: { value: QueueShape; onChange: (s: QueueShape) => void }) {
  const options = [0, 1, 2, 3];
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <TextField
        select
        size="small"
        label="Red"
        value={value.red}
        onChange={e => onChange({ ...value, red: Number(e.target.value) })}
        sx={{ width: 80 }}
      >
        {options.map(n => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>
      <Typography variant="body2">v</Typography>
      <TextField
        select
        size="small"
        label="Blue"
        value={value.blue}
        onChange={e => onChange({ ...value, blue: Number(e.target.value) })}
        sx={{ width: 80 }}
      >
        {options.map(n => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

/** The knobs the match manager turns during the day. */
function SettingsCard() {
  const queue = useQueueState();
  const [noShowText, setNoShowText] = useState<string | null>(null);
  if (!queue) return null;
  const s = queue.settings;
  const noShowValue = noShowText ?? (s.noShowMinutes === null ? '' : String(s.noShowMinutes));
  const commitNoShow = () => {
    const n = Number(noShowValue);
    sendQueueAdmin({
      type: 'queueSettings',
      settings: { noShowMinutes: noShowValue.trim() === '' || !(n > 0) ? null : n },
    });
    setNoShowText(null);
  };
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Settings
        </Typography>
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={s.lineOpen}
                onChange={e => sendQueueAdmin({ type: 'queueSettings', settings: { lineOpen: e.target.checked } })}
              />
            }
            label="Teams may join the line from their page"
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2">Default shape</Typography>
            <ShapePicker
              value={s.shape}
              onChange={shape => sendQueueAdmin({ type: 'queueSettings', settings: { shape } })}
            />
          </Box>
          <FormControlLabel
            control={
              <Checkbox
                checked={s.allowShort}
                onChange={e => sendQueueAdmin({ type: 'queueSettings', settings: { allowShort: e.target.checked } })}
              />
            }
            label="Form short matches when the line is short"
          />
          <TextField
            size="small"
            label="No-show after (min)"
            placeholder="never"
            value={noShowValue}
            onChange={e => setNoShowText(e.target.value)}
            onBlur={commitNoShow}
            onKeyDown={e => e.key === 'Enter' && commitNoShow()}
            sx={{ width: 160 }}
          />
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          The no-show clock starts when a match is set up (on deck). A team with no robot on the field and no join by
          then is flagged on the Next up card, where you can swap in the next team from the line.
        </Typography>
      </CardContent>
    </Card>
  );
}

/** The fill line, and forming the next match from it. */
function LineCard() {
  const queue = useQueueState();
  const [shape, setShape] = useState<QueueShape | null>(null);
  const [allowShort, setAllowShort] = useState<boolean | null>(null);
  if (!queue) return null;
  const line = queue.line;
  const effectiveShape = shape ?? queue.settings.shape;
  const effectiveShort = allowShort ?? queue.settings.allowShort;
  const wanted = effectiveShape.red + effectiveShape.blue;
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6">The line</Typography>
          <Chip
            label={queue.settings.lineOpen ? 'open' : 'closed'}
            size="small"
            color={queue.settings.lineOpen ? 'success' : 'default'}
          />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {line.length === 0 ? 'nobody waiting' : `${line.length} waiting`}
          </Typography>
        </Box>
        {line.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1.5 }}>
            {line.map((l, i) => (
              <Box key={l.team} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ width: 24, color: 'text.secondary', textAlign: 'right' }}>
                  {i + 1}.
                </Typography>
                <TeamAvatar teamNumber={l.team} size={24} />
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 56 }}>
                  {l.team}
                </Typography>
                {l.alliance && (
                  <Chip
                    label={`wants ${l.alliance}`}
                    size="small"
                    variant="outlined"
                    sx={{ height: 20, borderColor: l.alliance === 'red' ? '#d32f2f' : '#1565c0' }}
                  />
                )}
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  since {formatQueueTime(l.joinedAt)}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <IconButton
                  size="small"
                  disabled={i === 0}
                  onClick={() => sendQueueAdmin({ type: 'queueLineMove', team: l.team, index: i - 1 })}
                  aria-label="move up"
                >
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  disabled={i === line.length - 1}
                  onClick={() => sendQueueAdmin({ type: 'queueLineMove', team: l.team, index: i + 1 })}
                  aria-label="move down"
                >
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
                <Tooltip title="Remove from the line">
                  <IconButton
                    size="small"
                    onClick={() => sendQueueAdmin({ type: 'queueLineRemove', team: l.team })}
                    aria-label="remove"
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <ShapePicker value={effectiveShape} onChange={setShape} />
          <FormControlLabel
            control={<Checkbox checked={effectiveShort} onChange={e => setAllowShort(e.target.checked)} />}
            label="allow short"
          />
          <Button
            variant="contained"
            size="small"
            disabled={line.length === 0 || (!effectiveShort && line.length < wanted)}
            onClick={() => sendQueueAdmin({ type: 'queueForm', shape: effectiveShape, allowShort: effectiveShort })}
          >
            Form the next match from the line
          </Button>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Takes the first {wanted} in line, honouring alliance wishes where it can, and puts the match ahead of the
            schedule.
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

/** One entry in the list, with inline editing of its teams and notes. */
function EntryRow({
  entry,
  canUp,
  canDown,
  onMove,
  noShows,
}: {
  entry: QueueEntry;
  canUp: boolean;
  canDown: boolean;
  onMove: (dir: -1 | 1) => void;
  noShows: number[];
}) {
  const [editing, setEditing] = useState(false);
  const [red, setRed] = useState(entry.red.join(' '));
  const [blue, setBlue] = useState(entry.blue.join(' '));
  const [time, setTime] = useState(entry.scheduledAt ? new Date(entry.scheduledAt).toTimeString().slice(0, 5) : '');
  const [notes, setNotes] = useState(entry.notes ?? '');
  const done = entry.status === 'played' || entry.status === 'playing';
  const movable = entry.status === 'queued' || entry.status === 'skipped' || entry.status === 'onDeck';
  const save = () => {
    const t = time.trim();
    sendQueueAdmin({
      type: 'queueUpdate',
      id: entry.id,
      red: parseTeams(red),
      blue: parseTeams(blue),
      scheduledAt: t === '' ? null : (parseTimeToday(t) ?? null),
      notes,
    });
    setEditing(false);
  };
  const statusColor =
    entry.status === 'onDeck'
      ? 'success'
      : entry.status === 'playing'
        ? 'info'
        : entry.status === 'skipped'
          ? 'warning'
          : 'default';
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        py: 1,
        px: 1,
        borderRadius: 1,
        opacity: entry.status === 'played' || entry.status === 'skipped' ? 0.6 : 1,
        backgroundColor: entry.status === 'onDeck' ? 'action.selected' : 'transparent',
      }}
    >
      <Box sx={{ minWidth: 88 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
          Match {entry.number}
        </Typography>
        <Chip label={entryStatusLabel(entry.status)} size="small" color={statusColor} sx={{ height: 20, mt: 0.5 }} />
        {formatQueueTime(entry.scheduledAt) && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
            {formatQueueTime(entry.scheduledAt)}
          </Typography>
        )}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.disabled' }}>
          {entry.source === 'line' ? 'from the line' : entry.source === 'schedule' ? 'scheduled' : 'added by hand'}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <TextField
                size="small"
                label="Red teams"
                value={red}
                onChange={e => setRed(e.target.value)}
                sx={{ width: 180 }}
              />
              <TextField
                size="small"
                label="Blue teams"
                value={blue}
                onChange={e => setBlue(e.target.value)}
                sx={{ width: 180 }}
              />
              <TextField
                size="small"
                label="Time (HH:MM)"
                value={time}
                onChange={e => setTime(e.target.value)}
                sx={{ width: 120 }}
              />
            </Box>
            <TextField size="small" label="Notes" value={notes} onChange={e => setNotes(e.target.value)} fullWidth />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button size="small" variant="contained" onClick={save}>
                Save
              </Button>
              <Button size="small" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <AllianceTeams
              teams={entry.red}
              alliance="red"
              noShows={entry.status === 'onDeck' ? noShows : undefined}
              onSwap={team => sendQueueAdmin({ type: 'queueReplaceTeam', id: entry.id, team })}
            />
            <AllianceTeams
              teams={entry.blue}
              alliance="blue"
              noShows={entry.status === 'onDeck' ? noShows : undefined}
              onSwap={team => sendQueueAdmin({ type: 'queueReplaceTeam', id: entry.id, team })}
            />
            {entry.notes && (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {entry.notes}
              </Typography>
            )}
          </Box>
        )}
      </Box>
      {!done && !editing && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {entry.status !== 'skipped' && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => sendQueueAdmin({ type: 'queueSetupNext', id: entry.id, mode: 'all' })}
            >
              Set up
            </Button>
          )}
          <Button size="small" onClick={() => setEditing(true)}>
            Edit
          </Button>
          {entry.status === 'skipped' ? (
            <Button size="small" onClick={() => sendQueueAdmin({ type: 'queueRequeue', id: entry.id })}>
              Requeue
            </Button>
          ) : (
            <Button size="small" color="warning" onClick={() => sendQueueAdmin({ type: 'queueSkip', id: entry.id })}>
              Skip
            </Button>
          )}
          <IconButton size="small" disabled={!movable || !canUp} onClick={() => onMove(-1)} aria-label="move up">
            <ArrowUpwardIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" disabled={!movable || !canDown} onClick={() => onMove(1)} aria-label="move down">
            <ArrowDownwardIcon fontSize="small" />
          </IconButton>
          <Tooltip title="Remove from the queue">
            <IconButton
              size="small"
              onClick={() => sendQueueAdmin({ type: 'queueRemove', id: entry.id })}
              aria-label="remove"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}

/** Build the day's schedule: generate one from the team list, or paste one
 *  in; preview it; add it to the queue as scheduled matches. */
function ScheduleCard() {
  const queue = useQueueState();
  const [teamsText, setTeamsText] = useState('');
  const [perTeam, setPerTeam] = useState('3');
  const [shape, setShape] = useState<QueueShape | null>(null);
  const [start, setStart] = useState('');
  const [interval, setInterval] = useState('8');
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<ScheduleMatch[] | null>(null);
  const [bad, setBad] = useState<string[]>([]);
  if (!queue) return null;
  const effectiveShape = shape ?? queue.settings.shape;

  const generate = () => {
    const teams = teamsText
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number);
    const startAt = parseTimeToday(start);
    setPreview(
      generateSchedule({
        teams,
        matchesPerTeam: Math.max(1, Number(perTeam) || 1),
        shape: effectiveShape,
        startAt,
        intervalMinutes: startAt !== undefined ? Number(interval) || undefined : undefined,
      }),
    );
    setBad([]);
  };
  const read = () => {
    const r = parseSchedule(pasted, effectiveShape);
    setPreview(r.matches);
    setBad(r.bad);
  };
  const send = (replace: boolean) => {
    if (!preview?.length) return;
    sendQueueAdmin({ type: 'queueImport', entries: preview, replace });
    setPreview(null);
    setBad([]);
  };

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6">Schedule</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Generate one from the teams here today, or paste one in. It lands in the queue as scheduled matches; the line
          can still cut in ahead of it.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 1.5 }}>
          <TextField
            size="small"
            label="Teams"
            placeholder="1234 5678 9012 …"
            value={teamsText}
            onChange={e => setTeamsText(e.target.value)}
            multiline
            minRows={2}
            sx={{ width: 260 }}
          />
          <TextField
            size="small"
            label="Matches per team"
            value={perTeam}
            onChange={e => setPerTeam(e.target.value)}
            sx={{ width: 130 }}
          />
          <ShapePicker value={effectiveShape} onChange={setShape} />
          <TextField
            size="small"
            label="First match (HH:MM)"
            value={start}
            onChange={e => setStart(e.target.value)}
            sx={{ width: 150 }}
          />
          <TextField
            size="small"
            label="Minutes apart"
            value={interval}
            onChange={e => setInterval(e.target.value)}
            sx={{ width: 120 }}
          />
          <Button variant="outlined" size="small" onClick={generate} disabled={!teamsText.trim()}>
            Generate
          </Button>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 1.5 }}>
          <TextField
            size="small"
            label="Or paste a schedule"
            placeholder={
              '14:05 1234 5678 9012 v 2468 1357 8642\n14:15 red: 1 2 | blue: 3 4\n# one match per line, time optional'
            }
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            multiline
            minRows={3}
            sx={{ width: 420, maxWidth: '100%' }}
          />
          <Button variant="outlined" size="small" onClick={read} disabled={!pasted.trim()}>
            Read it
          </Button>
        </Box>
        {bad.length > 0 && (
          <Typography variant="body2" sx={{ color: 'warning.main', mb: 1 }}>
            Could not read: {bad.join(' · ')}
          </Typography>
        )}
        {preview && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {preview.length === 0 ? 'Nothing to add.' : `${preview.length} match${preview.length === 1 ? '' : 'es'}:`}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mb: 1, maxHeight: 240, overflow: 'auto' }}>
              {preview.map((m, i) => (
                <Typography key={i} variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {String(i + 1).padStart(2, ' ')}. {formatQueueTime(m.scheduledAt) ?? '     '} {m.red.join(' ')} v{' '}
                  {m.blue.join(' ')}
                </Typography>
              ))}
            </Box>
            {preview.length > 0 && (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button variant="contained" size="small" onClick={() => send(false)}>
                  Add to the queue
                </Button>
                <Button variant="outlined" size="small" color="warning" onClick={() => send(true)}>
                  Replace the queue
                </Button>
                <Button size="small" onClick={() => setPreview(null)}>
                  Discard
                </Button>
              </Box>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function AddMatchCard() {
  const [red, setRed] = useState('');
  const [blue, setBlue] = useState('');
  const [time, setTime] = useState('');
  const [notes, setNotes] = useState('');
  const add = (atFront: boolean) => {
    const r = parseTeams(red);
    const b = parseTeams(blue);
    if (r.length + b.length === 0) return;
    sendQueueAdmin({
      type: 'queueAdd',
      red: r,
      blue: b,
      scheduledAt: parseTimeToday(time),
      notes: notes || undefined,
      atFront,
    });
    setRed('');
    setBlue('');
    setTime('');
    setNotes('');
  };
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Add a match
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            label="Red teams"
            placeholder="1234 5678"
            value={red}
            onChange={e => setRed(e.target.value)}
            sx={{ width: 180 }}
          />
          <TextField
            size="small"
            label="Blue teams"
            placeholder="9012"
            value={blue}
            onChange={e => setBlue(e.target.value)}
            sx={{ width: 180 }}
          />
          <TextField
            size="small"
            label="Time (HH:MM)"
            value={time}
            onChange={e => setTime(e.target.value)}
            sx={{ width: 120 }}
          />
          <TextField
            size="small"
            label="Notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            sx={{ width: 220 }}
          />
          <Button variant="contained" size="small" onClick={() => add(false)}>
            Add to the end
          </Button>
          <Button variant="outlined" size="small" onClick={() => add(true)}>
            Add as next
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}

function QueueListCard() {
  const queue = useQueueState();
  if (!queue) return null;
  const entries = queue.entries;
  const movable = entries.filter(e => e.status === 'queued' || e.status === 'skipped' || e.status === 'onDeck');
  const move = (id: string, dir: -1 | 1) => {
    const ids = movable.map(e => e.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    sendQueueAdmin({ type: 'queueReorder', ids });
  };
  const played = entries.filter(e => e.status === 'played' || e.status === 'skipped').length;
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="h6">Queue</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {entries.length === 0 ? 'empty' : `${entries.length} match${entries.length === 1 ? '' : 'es'}`}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {played > 0 && (
            <Button size="small" onClick={() => sendQueueAdmin({ type: 'queueClear', played: true })}>
              Clear played &amp; skipped
            </Button>
          )}
        </Box>
        {entries.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Add matches below, or form them from the line as teams show up.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {entries.map(entry => {
              const mi = movable.findIndex(e => e.id === entry.id);
              return (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  canUp={mi > 0}
                  canDown={mi >= 0 && mi < movable.length - 1}
                  onMove={dir => move(entry.id, dir)}
                  noShows={queue.noShows ?? []}
                />
              );
            })}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/** The queue manager's page: what is next, the line, the whole queue, and
 *  the day's knobs. Admin-gated like the rest of the staff pages. */
export function QueuePage() {
  const queue = useQueueState();
  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          Match queue
        </Typography>
        <Link href="/match" underline="hover" variant="body2">
          Match control
        </Link>
        <Link href="/admin" underline="hover" variant="body2">
          Admin
        </Link>
      </Box>
      {!queue ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Connecting…
        </Typography>
      ) : (
        <>
          <QueueNextUp />
          <LineCard />
          <QueueListCard />
          <AddMatchCard />
          <ScheduleCard />
          <SettingsCard />
        </>
      )}
    </Container>
  );
}

export type { Alliance };
