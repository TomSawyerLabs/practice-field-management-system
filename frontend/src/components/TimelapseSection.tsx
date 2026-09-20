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
  TIMELAPSE_DEFAULTS,
  type TimelapseAction,
  type TimelapseConfig,
  type TimelapseFrameEntry,
} from '../../../src/types';
import {
  sendCaptureTimelapseFrame,
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
        helperText={parsed.error}
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

function FrameRow({ frame }: { frame: TimelapseFrameEntry }) {
  const when = new Date(frame.at).toLocaleString();
  const bytes = frame.files.reduce((n, f) => n + f.bytes, 0);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', py: 0.25 }}>
      <Typography variant="body2" sx={{ minWidth: 190 }}>
        {when} · {frame.slot}
      </Typography>
      {frame.files.map(f => (
        <Link key={f.file} href={`/api/timelapse/frame/${f.file}`} target="_blank" rel="noopener" variant="body2">
          {f.stream} ({formatBytes(f.bytes)})
        </Link>
      ))}
      {frame.files.length === 0 && <Typography variant="body2">no frame</Typography>}
      {frame.lights !== 'none' && (
        <Chip
          size="small"
          variant="outlined"
          color={frame.lights === 'ran' ? 'success' : frame.lights === 'failed' ? 'error' : 'default'}
          label={
            frame.lights === 'ran'
              ? 'lights set'
              : frame.lights === 'skipped-field-in-use'
                ? 'lights left alone — field in use'
                : `lights failed: ${frame.lightsError ?? 'unknown'}`
          }
        />
      )}
      {frame.error && (
        <Typography variant="caption" sx={{ color: 'warning.main' }}>
          {frame.error}
        </Typography>
      )}
      {bytes > 0 && frame.files.length > 1 && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {formatBytes(bytes)} total
        </Typography>
      )}
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
  const [render, setRender] = useState({ from: '', to: '', fps: '12', height: '1080' });

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

        {/* ── what is on disk ─────────────────────────────────────── */}
        {state && (
          <>
            <Divider sx={{ my: 2 }} />
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {state.frameCount} archival frame{state.frameCount === 1 ? '' : 's'} ({formatBytes(state.frameBytes)}),{' '}
              {formatBytes(state.sessionBytes)} of practice film, {formatBytes(state.renderBytes)} of finished films, in{' '}
              <code>{state.directory}</code>.
            </Typography>

            {state.recentFrames.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="subtitle2">Recent frames</Typography>
                {state.recentFrames.slice(0, 8).map(f => (
                  <FrameRow key={`${f.day}-${f.slot}-${f.at}`} frame={f} />
                ))}
              </Box>
            )}

            {state.recentSessions.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="subtitle2">Recent practice films</Typography>
                {state.recentSessions.slice(0, 8).map(s => (
                  <Box key={s.file} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ minWidth: 190 }}>
                      {new Date(s.startedAt).toLocaleString()}
                    </Typography>
                    <Link href={`/api/timelapse/active/${s.file}`} target="_blank" rel="noopener" variant="body2">
                      {s.stream} ({formatBytes(s.bytes)})
                    </Link>
                    {s.coveredSeconds !== undefined && (
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {Math.round(s.coveredSeconds / 60)} min of field time
                      </Typography>
                    )}
                  </Box>
                ))}
              </Box>
            )}

            {/* ── build a film ──────────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Build a film from the archival frames
            </Typography>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                size="small"
                label="From"
                type="date"
                value={render.from}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={e => setRender(r => ({ ...r, from: e.target.value }))}
              />
              <TextField
                size="small"
                label="To"
                type="date"
                value={render.to}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={e => setRender(r => ({ ...r, to: e.target.value }))}
              />
              <TextField
                size="small"
                type="number"
                label="fps"
                value={render.fps}
                onChange={e => setRender(r => ({ ...r, fps: e.target.value }))}
                sx={{ width: 90 }}
              />
              <TextField
                size="small"
                type="number"
                label="Height"
                value={render.height}
                onChange={e => setRender(r => ({ ...r, height: e.target.value }))}
                sx={{ width: 110 }}
              />
              <Button
                variant="outlined"
                disabled={state.render?.status === 'running' || state.frameCount < 2}
                onClick={() =>
                  sendRenderTimelapse({
                    from: render.from || undefined,
                    to: render.to || undefined,
                    fps: Math.max(1, Math.min(60, Number(render.fps) || 12)),
                    height: Math.max(240, Math.min(2160, Number(render.height) || 1080)),
                  })
                }
              >
                {state.render?.status === 'running' ? 'Building…' : 'Build'}
              </Button>
            </Box>
            {state.render && (
              <Box sx={{ mt: 1, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                {state.render.status === 'running' && (
                  <Typography variant="body2">Building from {state.render.frames} frames…</Typography>
                )}
                {state.render.status === 'failed' && (
                  <Typography variant="body2" sx={{ color: 'error.main' }}>
                    Failed: {state.render.error}
                  </Typography>
                )}
                {state.render.status === 'done' && state.render.file && (
                  <>
                    <Link
                      href={`/api/timelapse/render/${state.render.file}?download=1`}
                      target="_blank"
                      rel="noopener"
                      variant="body2"
                    >
                      {state.render.file}
                    </Link>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {state.render.frames} frames, {formatBytes(state.render.bytes ?? 0)}
                    </Typography>
                  </>
                )}
              </Box>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
