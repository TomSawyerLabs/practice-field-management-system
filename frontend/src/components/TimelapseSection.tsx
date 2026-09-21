import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  SECRET_KEPT,
  TIMELAPSE_DEFAULTS,
  type TimelapseAction,
  type TimelapseConfig,
  type TimelapseListing,
  type TimelapseSource,
} from '../../../src/types';
import {
  fetchTimelapseListing,
  sendCaptureTimelapseFrame,
  sendDeleteTimelapseRender,
  sendRenderTimelapse,
  sendUpdateSetupSettings,
  useSetupConfig,
  useTimelapseState,
} from '../hooks/useBackend';
import { formatBytes } from './MatchVideoCard';

/** `Name: value` per line — the shape people already paste from curl. */
function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function textToHeaders(text: string): { headers?: Record<string, string>; error?: string } {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) return { error: `Not a header: "${line}" — write it as "Name: value"` };
    const name = line.slice(0, i).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return { error: `"${name}" is not a valid header name` };
    out[name] = line.slice(i + 1).trim();
  }
  return { headers: Object.keys(out).length > 0 ? out : undefined };
}

const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One pre- or post-capture HTTP call. */
function ActionEditor({
  label,
  help,
  action,
  onChange,
}: {
  label: string;
  help: string;
  action: TimelapseAction | undefined;
  onChange: (action: TimelapseAction | undefined) => void;
}) {
  // Seeded once; the parent remounts this editor (via `key`) when the saved
  // config replaces what is being edited, so there is nothing to sync.
  const [headerText, setHeaderText] = useState(headersToText(action?.headers));
  const parsed = textToHeaders(headerText);

  if (!action) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          <strong>{label}:</strong> none. {help}
        </Typography>
        <Button size="small" variant="outlined" onClick={() => onChange({ method: 'POST', url: 'http://' })}>
          Add
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">{label}</Typography>
        <Button size="small" color="inherit" sx={{ opacity: 0.7 }} onClick={() => onChange(undefined)}>
          Remove
        </Button>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {help}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <TextField
          select
          size="small"
          label="Method"
          value={action.method}
          onChange={e => onChange({ ...action, method: e.target.value as TimelapseAction['method'] })}
          sx={{ width: 110 }}
        >
          {['GET', 'POST', 'PUT'].map(m => (
            <MenuItem key={m} value={m}>
              {m}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="URL"
          value={action.url}
          onChange={e => onChange({ ...action, url: e.target.value })}
          sx={{ flex: 1, minWidth: 280 }}
        />
      </Box>
      <TextField
        size="small"
        label="Headers (one per line)"
        placeholder="Authorization: Bearer …"
        multiline
        minRows={2}
        value={headerText}
        error={parsed.error !== undefined}
        helperText={
          parsed.error ??
          (headerText.includes(SECRET_KEPT)
            ? 'Saved header values are never sent back to a browser. Type over one to replace it.'
            : undefined)
        }
        onChange={e => {
          setHeaderText(e.target.value);
          const next = textToHeaders(e.target.value);
          if (!next.error) onChange({ ...action, headers: next.headers });
        }}
      />
      <TextField
        size="small"
        label="Body (JSON)"
        placeholder='{"entity_id":"light.bay_1_2_lights","brightness_pct":100}'
        multiline
        minRows={2}
        value={action.body ?? ''}
        onChange={e => onChange({ ...action, body: e.target.value || undefined })}
      />
    </Box>
  );
}

/**
 * Admin → Field timelapse. Two things behind one switch: a few archival
 * frames a day (optionally with the shop lights driven to a known level), and
 * a fast timelapse of every stretch when robots are on the field.
 */
export function TimelapseSection() {
  const setupConfig = useSetupConfig();
  const state = useTimelapseState();
  const saved = setupConfig?.config.settings.timelapse;
  const [draft, setDraft] = useState<TimelapseConfig>(saved ?? TIMELAPSE_DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [newTime, setNewTime] = useState('');
  /** Bumped whenever the draft is replaced wholesale, to remount the action
   *  editors on top of their new values. */
  const [resetKey, setResetKey] = useState(0);
  const [build, setBuild] = useState<{
    source: TimelapseSource;
    from: string;
    to: string;
    fps: string;
    height: string;
  }>({ source: 'frames', from: '', to: '', fps: '12', height: '1080' });
  /** What the player is showing: a built film, a practice clip, or one frame. */
  const [playing, setPlaying] = useState<{ kind: 'video' | 'image'; url: string; label: string } | null>(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [listing, setListing] = useState<TimelapseListing | null>(null);
  const [loading, setLoading] = useState(false);

  const loadListing = async () => {
    setLoading(true);
    setListing(await fetchTimelapseListing(range.from || undefined, range.to || undefined));
    setLoading(false);
  };

  // Show the most recent days as soon as the section is open, and again when
  // a capture or a build changes what is on disk.
  useEffect(() => {
    void loadListing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.frameCount, state?.sessionBytes]);

  // Follow the server until the operator starts editing.
  useEffect(() => {
    if (dirty) return;
    setDraft(saved ?? TIMELAPSE_DEFAULTS);
    setResetKey(k => k + 1);
  }, [saved, dirty]);

  const edit = (patch: Partial<TimelapseConfig>) => {
    setDirty(true);
    setDraft(prev => ({ ...prev, ...patch }));
  };
  const save = () => {
    sendUpdateSetupSettings({ timelapse: draft });
    setDirty(false);
  };

  const addTime = () => {
    const t = newTime.trim();
    if (!timeOfDay.test(t) || draft.dailyTimes.includes(t)) return;
    edit({ dailyTimes: [...draft.dailyTimes, t].sort() });
    setNewTime('');
  };

  const next = state?.nextDailyAt ? new Date(state.nextDailyAt).toLocaleString() : null;

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h5">Field Timelapse</Typography>
          <Chip
            size="small"
            color={state?.enabled ? 'success' : 'default'}
            label={state?.enabled ? 'Enabled' : 'Disabled'}
          />
          {state?.capturing && <Chip size="small" color="error" label="● Capturing" />}
          {state?.robotsPresent && !state.capturing && <Chip size="small" color="info" label="Robots here" />}
          {state?.unavailableReason && <Chip size="small" color="error" label={state.unavailableReason} />}
        </Box>

        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          A long-term record of the field: a few full-resolution frames a day, plus a fast timelapse of every stretch
          when robots are here. The daily frames are kept as stills so a film can be re-rendered at any size later; they
          cost about 3 MB each. The fast timelapse costs roughly 20 MB per hour on the field.
          {next && ` Next frame ${next}.`}
        </Typography>

        {/* ── the switch and the schedule ─────────────────────────── */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
          <Button
            variant="outlined"
            color={draft.enabled ? 'warning' : 'success'}
            onClick={() => edit({ enabled: !draft.enabled })}
          >
            {draft.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          <Button
            variant="outlined"
            color={draft.captureWhileRobotsPresent ? 'warning' : 'success'}
            onClick={() => edit({ captureWhileRobotsPresent: !draft.captureWhileRobotsPresent })}
          >
            {draft.captureWhileRobotsPresent ? 'Stop filming practice' : 'Film practice too'}
          </Button>
        </Box>

        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Archival frames each day
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
          {draft.dailyTimes.map(t => (
            <Chip
              key={t}
              label={t}
              onDelete={() => edit({ dailyTimes: draft.dailyTimes.filter(x => x !== t) })}
              size="small"
            />
          ))}
          <TextField
            size="small"
            label="Add a time"
            placeholder="14:30"
            value={newTime}
            onChange={e => setNewTime(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTime()}
            error={newTime !== '' && !timeOfDay.test(newTime.trim())}
            sx={{ width: 130 }}
          />
          <Button size="small" variant="outlined" onClick={addTime} disabled={!timeOfDay.test(newTime.trim())}>
            Add
          </Button>
        </Box>

        {/* ── lights ──────────────────────────────────────────────── */}
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Lights around each archival frame
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Two optional HTTP calls, so every frame is lit the same way. They are skipped — the frame is still taken —
          whenever a match is running or a robot is enabled. For Home Assistant, snapshot the lights into a scene in the
          first call and turn that scene back on in the second, so they end up exactly as they were.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <ActionEditor
            key={`pre-${resetKey}`}
            label="Before the shutter"
            help="Drive the lights to a known level."
            action={draft.preAction}
            onChange={a => edit({ preAction: a })}
          />
          <ActionEditor
            key={`post-${resetKey}`}
            label="After the shutter"
            help="Put the lights back the way they were."
            action={draft.postAction}
            onChange={a => edit({ postAction: a })}
          />
          <TextField
            size="small"
            type="number"
            label="Settle (seconds)"
            value={draft.settleSeconds}
            onChange={e => edit({ settleSeconds: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })}
            sx={{ width: 160 }}
          />
        </Box>

        {/* ── quality and retention ───────────────────────────────── */}
        <Divider sx={{ my: 2 }} />
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField
            select
            size="small"
            label="Practice sampling"
            value={draft.activeMode}
            onChange={e => edit({ activeMode: e.target.value as TimelapseConfig['activeMode'] })}
            sx={{ width: 260 }}
          >
            <MenuItem value="keyframes">Keyframes only — cheap (60× speed)</MenuItem>
            <MenuItem value="everySecond">Every second — smoother (30× speed)</MenuItem>
          </TextField>
          <TextField
            size="small"
            type="number"
            label="Quality (crf)"
            value={draft.activeCrf}
            onChange={e => edit({ activeCrf: Math.max(14, Math.min(40, Number(e.target.value) || 30)) })}
            sx={{ width: 130 }}
          />
          <TextField
            size="small"
            type="number"
            label="Width (px)"
            value={draft.activeWidth}
            onChange={e => edit({ activeWidth: Math.max(320, Math.min(3840, Number(e.target.value) || 1920)) })}
            sx={{ width: 130 }}
          />
          <TextField
            size="small"
            type="number"
            label="Keep practice films (days)"
            value={draft.activeRetentionDays}
            onChange={e => edit({ activeRetentionDays: Math.max(1, Math.min(3650, Number(e.target.value) || 60)) })}
            sx={{ width: 220 }}
          />
          <TextField
            size="small"
            type="number"
            label="Keep frames (days, 0 = forever)"
            value={draft.frameRetentionDays}
            onChange={e => edit({ frameRetentionDays: Math.max(0, Math.min(3650, Number(e.target.value) || 0)) })}
            sx={{ width: 260 }}
          />
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          Keyframes only decodes ~a fifth of the CPU of every-second sampling and costs about the same on disk; the
          difference is how fast the finished film runs. Lower crf is better quality and bigger: 26 is generous, 34 is
          thrifty.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="contained" onClick={save} disabled={!dirty}>
            Save
          </Button>
          <Button
            variant="outlined"
            color="inherit"
            disabled={!dirty}
            onClick={() => {
              setDraft(saved ?? TIMELAPSE_DEFAULTS);
              setResetKey(k => k + 1);
              setDirty(false);
            }}
          >
            Revert
          </Button>
          <Button variant="outlined" onClick={() => sendCaptureTimelapseFrame(true)} disabled={!state?.enabled}>
            Capture now (with lights)
          </Button>
          <Button variant="outlined" onClick={() => sendCaptureTimelapseFrame(false)} disabled={!state?.enabled}>
            Capture now (no lights)
          </Button>
          {dirty && <Chip size="small" color="warning" variant="outlined" label="Unsaved changes" />}
        </Box>

        {/* ── watch what is there ─────────────────────────────────── */}
        {state && (
          <>
            <Divider sx={{ my: 2 }} />
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {state.frameCount} archival frame{state.frameCount === 1 ? '' : 's'} ({formatBytes(state.frameBytes)}),{' '}
              {formatBytes(state.sessionBytes)} of practice film, {formatBytes(state.renderBytes)} of built films, in{' '}
              <code>{state.directory}</code>.
            </Typography>

            {playing && (
              <Box sx={{ mt: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
                  <Typography variant="subtitle2">{playing.label}</Typography>
                  <Link
                    href={`${playing.url}${playing.kind === 'video' ? '?download=1' : ''}`}
                    download
                    variant="body2"
                  >
                    Download
                  </Link>
                  <Button size="small" color="inherit" sx={{ opacity: 0.7 }} onClick={() => setPlaying(null)}>
                    Close
                  </Button>
                </Box>
                {playing.kind === 'video' ? (
                  <video
                    key={playing.url}
                    src={playing.url}
                    controls
                    autoPlay
                    style={{ width: '100%', maxHeight: 520, background: '#000', borderRadius: 4 }}
                  />
                ) : (
                  <Box
                    component="img"
                    key={playing.url}
                    src={playing.url}
                    alt={playing.label}
                    sx={{ width: '100%', maxHeight: 520, objectFit: 'contain', background: '#000', borderRadius: 1 }}
                  />
                )}
              </Box>
            )}

            {state.renders.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="subtitle2">Films built</Typography>
                {state.renders.map(r => (
                  <Box key={r.file} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', py: 0.25 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() =>
                        setPlaying({ kind: 'video', url: `/api/timelapse/render/${r.file}`, label: r.file })
                      }
                    >
                      Play
                    </Button>
                    <Typography variant="body2">{r.file}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {formatBytes(r.bytes)} · {new Date(r.at).toLocaleString()}
                    </Typography>
                    <Link href={`/api/timelapse/render/${r.file}?download=1`} download variant="body2">
                      Download
                    </Link>
                    <Button
                      size="small"
                      color="inherit"
                      sx={{ opacity: 0.6 }}
                      onClick={() => {
                        if (playing?.url.endsWith(r.file)) setPlaying(null);
                        sendDeleteTimelapseRender(r.file);
                      }}
                    >
                      Delete
                    </Button>
                  </Box>
                ))}
              </Box>
            )}

            {/* ── browse the archive ────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
              <Typography variant="subtitle2" sx={{ mr: 1 }}>
                Browse
              </Typography>
              <TextField
                size="small"
                label="From"
                type="date"
                value={range.from}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
              />
              <TextField
                size="small"
                label="To"
                type="date"
                value={range.to}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
              />
              <Button size="small" variant="outlined" onClick={() => void loadListing()} disabled={loading}>
                {loading ? 'Loading…' : 'Show'}
              </Button>
              {listing && (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {listing.days.length} day{listing.days.length === 1 ? '' : 's'}
                </Typography>
              )}
            </Box>

            {listing?.days.length === 0 && (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Nothing captured in that range yet.
              </Typography>
            )}

            {listing?.days.slice(0, 30).map(day => (
              <Box key={day.day} sx={{ mb: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {day.day}
                  <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 1 }}>
                    {day.frames.length} frame{day.frames.length === 1 ? '' : 's'}
                    {day.practice.length > 0 &&
                      `, ${day.practice.length} practice film${day.practice.length === 1 ? '' : 's'}`}
                  </Typography>
                </Typography>
                {day.frames.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
                    {day.frames.map(f => (
                      <Box
                        key={f.file}
                        onClick={() =>
                          setPlaying({
                            kind: 'image',
                            url: `/api/timelapse/frame/${f.file}`,
                            label: `${day.day} ${f.slot} · ${f.stream} (${formatBytes(f.bytes)})`,
                          })
                        }
                        sx={{ cursor: 'pointer', textAlign: 'center' }}
                      >
                        {/* The thumbnail written beside each frame — the full
                            one is ~3 MB and only loads when clicked. */}
                        <Box
                          component="img"
                          src={`/api/timelapse/frame/${f.thumb ?? f.file}`}
                          alt={`${day.day} ${f.slot}`}
                          loading="lazy"
                          sx={{
                            width: 150,
                            height: 100,
                            objectFit: 'cover',
                            borderRadius: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                          }}
                        />
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                          {f.slot}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                {day.practice.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
                    {day.practice.map(c => (
                      <Button
                        key={c.file}
                        size="small"
                        variant="outlined"
                        onClick={() =>
                          setPlaying({
                            kind: 'video',
                            url: `/api/timelapse/active/${c.file}`,
                            label: `${day.day} practice · ${c.stream} (${formatBytes(c.bytes)})`,
                          })
                        }
                      >
                        ▶ {new Date(c.at).toLocaleTimeString()} ({formatBytes(c.bytes)})
                      </Button>
                    ))}
                  </Box>
                )}
              </Box>
            ))}

            {/* ── build a film ──────────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Build one film for a date range
            </Typography>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                select
                size="small"
                label="From what"
                value={build.source}
                onChange={e => setBuild(b => ({ ...b, source: e.target.value as TimelapseSource }))}
                sx={{ width: 230 }}
              >
                <MenuItem value="frames">Daily frames — the season film</MenuItem>
                <MenuItem value="practice">Practice footage — joined</MenuItem>
              </TextField>
              <TextField
                size="small"
                label="From"
                type="date"
                value={build.from}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={e => setBuild(b => ({ ...b, from: e.target.value }))}
              />
              <TextField
                size="small"
                label="To"
                type="date"
                value={build.to}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={e => setBuild(b => ({ ...b, to: e.target.value }))}
              />
              {build.source === 'frames' && (
                <TextField
                  size="small"
                  type="number"
                  label="fps"
                  value={build.fps}
                  onChange={e => setBuild(b => ({ ...b, fps: e.target.value }))}
                  sx={{ width: 90 }}
                />
              )}
              <TextField
                size="small"
                type="number"
                label="Height"
                value={build.height}
                onChange={e => setBuild(b => ({ ...b, height: e.target.value }))}
                sx={{ width: 110 }}
              />
              <Button
                variant="outlined"
                disabled={state.render?.status === 'running'}
                onClick={() =>
                  sendRenderTimelapse({
                    source: build.source,
                    from: build.from || undefined,
                    to: build.to || undefined,
                    fps: Math.max(1, Math.min(60, Number(build.fps) || 12)),
                    height: Math.max(240, Math.min(2160, Number(build.height) || 1080)),
                  })
                }
              >
                {state.render?.status === 'running' ? 'Building…' : 'Build'}
              </Button>
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
              {build.source === 'frames'
                ? 'The archival stills, one after another — a year of three a day at 12 fps is about 90 seconds.'
                : 'Every practice film in the range, joined end to end. Copied as-is, so this is quick.'}{' '}
              Finished films appear under “Films built” above, and can be played or downloaded there.
            </Typography>
            {state.render?.status === 'failed' && (
              <Typography variant="body2" sx={{ color: 'error.main', mt: 0.5 }}>
                Failed: {state.render.error}
              </Typography>
            )}
            {state.render?.status === 'running' && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                Building from {state.render.frames} {state.render.source === 'frames' ? 'frames' : 'clips'}…
              </Typography>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
