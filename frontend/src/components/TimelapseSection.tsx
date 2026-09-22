import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
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
  type TimelapseLightEntity,
  type TimelapseLights,
  type TimelapseListing,
  type TimelapseSource,
} from '../../../src/types';
import { CopyToClipboard } from './CopyToClipboard';
import {
  fetchTimelapseListing,
  probeTimelapseLights,
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

/** One call in a slot. The parent owns the list; this owns one entry. */
function ActionEditor({
  action,
  position,
  onChange,
}: {
  action: TimelapseAction;
  position: string;
  onChange: (action: TimelapseAction | null) => void;
}) {
  // Seeded once; the parent remounts these editors (via `key`) when the saved
  // config replaces what is being edited, so there is nothing to sync.
  const [headerText, setHeaderText] = useState(headersToText(action.headers));
  const parsed = textToHeaders(headerText);

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', gap: 1, pl: 1, borderLeft: '2px solid', borderColor: 'divider' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {position}
        </Typography>
        <Button size="small" color="inherit" sx={{ opacity: 0.7 }} onClick={() => onChange(null)}>
          Remove
        </Button>
      </Box>
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
        placeholder='{"entity_id":"light.all_lights"}'
        multiline
        minRows={2}
        value={action.body ?? ''}
        onChange={e => onChange({ ...action, body: e.target.value || undefined })}
      />
    </Box>
  );
}

/** All the calls in one slot, run in order. Home Assistant needs two before
 *  the shutter (snapshot, then turn on), which is why this is a list. */
function ActionListEditor({
  label,
  help,
  actions,
  resetKey,
  onChange,
}: {
  label: string;
  help: string;
  actions: TimelapseAction[] | undefined;
  resetKey: number;
  onChange: (actions: TimelapseAction[] | undefined) => void;
}) {
  const list = actions ?? [];
  const set = (next: TimelapseAction[]) => onChange(next.length > 0 ? next : undefined);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">{label}</Typography>
        <Button
          size="small"
          variant="outlined"
          disabled={list.length >= 4}
          onClick={() => set([...list, { method: 'POST', url: 'http://' }])}
        >
          Add a call
        </Button>
        {list.length === 0 && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            none
          </Typography>
        )}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {help}
      </Typography>
      {list.map((a, i) => (
        <ActionEditor
          key={`${resetKey}-${i}`}
          action={a}
          position={`Call ${i + 1} of ${list.length}`}
          onChange={next => set(next ? list.map((x, j) => (j === i ? next : x)) : list.filter((_, j) => j !== i))}
        />
      ))}
    </Box>
  );
}

/** 22 random characters: a webhook id is a capability, so make it unguessable. */
function newWebhookId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const rand = [...bytes]
    .map(b => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20);
  return `${prefix}_${rand}`;
}

/**
 * The no-credential way in: Home Assistant owns the lights and tells pFMS
 * when they are actually on, so there is no token here and no guessed delay.
 *
 * The admin page generates the webhook ids and writes the YAML, because both
 * are easy to get subtly wrong by hand.
 */
function HaWebhookEditor({
  lights,
  onChange,
}: {
  lights: Extract<TimelapseLights, { mode: 'haWebhook' }>;
  onChange: (lights: Extract<TimelapseLights, { mode: 'haWebhook' }>) => void;
}) {
  const [entities, setEntities] = useState('light.all_lights');
  /** How long Home Assistant waits for pFMS's "done" before restoring anyway. */
  const [doneTimeout, setDoneTimeout] = useState('10');
  // Kept here so the YAML survives a save: once saved, the server masks the
  // ids and the page can never see them again.
  const [shown, setShown] = useState<{ start: string; done: string } | null>(null);

  const generate = () => {
    const ids = { start: newWebhookId('pfms_lights_start'), done: newWebhookId('pfms_lights_done') };
    setShown(ids);
    onChange({ ...lights, startWebhookId: ids.start, doneWebhookId: ids.done });
  };

  const callback = (lights.callbackUrl || window.location.origin).replace(/\/+$/, '');
  const doneSeconds = Math.max(1, Math.min(599, Number(doneTimeout) || 10));
  // pFMS waits `readyTimeoutSeconds` for the lights, then still has to open
  // the stream and grab a frame. If Home Assistant gives up before that, it
  // restores the lights out from under the shutter.
  const tooTight = doneSeconds < lights.readyTimeoutSeconds + 10;
  const entityList = entities
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);
  const target = entityList.length === 1 ? entityList[0] : `[${entityList.join(', ')}]`;
  const snapshot = entityList.map(e => `expand('${e}')`).join(' + ');
  const yaml = shown
    ? `# 1. configuration.yaml — lets Home Assistant call pFMS back.
#    Afterwards run rest_command.reload (Developer tools > Actions); no
#    restart needed.
rest_command:
  pfms_lights_ready:
    url: "${callback}/api/timelapse/lights-ready"
    method: post
    content_type: "application/json"
    payload: '{"nonce": "{{ nonce }}"}'
    timeout: 10

# 2. A script that does nothing but make that call.
#    Settings > Automations & scenes > Scripts > new > Edit in YAML.
#    It exists so that it CANNOT kill its caller: the automation starts it
#    with script.turn_on and moves on, so a missing service, a typo or a
#    pFMS that is down can never skip the restore below. Calling the
#    rest_command straight from the automation looks tidier and is a trap —
#    continue_on_error does not suppress a missing-service error, the run
#    aborts, and every light stays on.
alias: pFMS lights ready
mode: parallel
max: 10
fields:
  nonce:
    description: One-shot token from pFMS
    required: true
    selector:
      text:
sequence:
  - action: rest_command.pfms_lights_ready
    data:
      nonce: "{{ nonce }}"

# 3. The automation itself.
#    Settings > Automations & scenes > new automation > Edit in YAML.
alias: pFMS timelapse lights
mode: single
triggers:
  - trigger: webhook
    webhook_id: ${shown.start}
    allowed_methods: [POST]
    local_only: true
actions:
  # record what is on right now — the fixtures, not the group, so the ones
  # that are normally off go back to off
  - action: scene.create
    data:
      scene_id: pfms_timelapse_restore
      snapshot_entities: "{{ (${snapshot}) | map(attribute='entity_id') | list }}"
  - action: light.turn_on
    target:
      entity_id: ${target}
  # proceed as soon as they are on — wait_template, not wait_for_trigger,
  # so it also passes when they were already on
  - wait_template: "{{ ${entityList.map(e => `is_state('${e}', 'on')`).join(' and ')} }}"
    timeout: "00:00:10"
    continue_on_timeout: true
  - action: script.turn_on
    target:
      entity_id: script.pfms_lights_ready
    data:
      variables:
        nonce: "{{ trigger.json.nonce }}"
  # wait for pFMS to say it has the frame — or give up after ${doneSeconds}s
  - wait_for_trigger:
      - trigger: webhook
        webhook_id: ${shown.done}
        allowed_methods: [POST]
        local_only: true
    timeout: "00:0${Math.floor(doneSeconds / 60)}:${String(doneSeconds % 60).padStart(2, '0')}"
    continue_on_timeout: true
  - action: scene.turn_on
    target:
      entity_id: scene.pfms_timelapse_restore
`
    : '';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        Home Assistant does the work and calls pFMS back when the lights are actually on, so pFMS stores no token and
        shoots the moment they are lit rather than after a guessed delay. If the call back never comes, the frame is
        still taken and the lights are recorded as failed. Give the URL as an IPv4 address or a name that resolves to
        one: the webhooks are local-only, and Home Assistant judges that by the source address — a global IPv6 address
        is rejected as remote even from the next rack over.
      </Typography>

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Home Assistant URL"
          placeholder="http://homeassistant.local:8123"
          value={lights.baseUrl}
          onChange={e => onChange({ ...lights, baseUrl: e.target.value })}
          sx={{ flex: 1, minWidth: 260 }}
        />
        <TextField
          size="small"
          label="Where Home Assistant reaches pFMS"
          value={lights.callbackUrl ?? ''}
          placeholder={window.location.origin}
          onChange={e => onChange({ ...lights, callbackUrl: e.target.value || undefined })}
          sx={{ flex: 1, minWidth: 260 }}
          helperText="Only used to write the YAML below"
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button variant="outlined" onClick={generate}>
          {lights.startWebhookId ? 'Generate new ids' : 'Generate webhook ids'}
        </Button>
        <TextField
          size="small"
          type="number"
          label="Wait for lights (s)"
          value={lights.readyTimeoutSeconds}
          onChange={e =>
            onChange({ ...lights, readyTimeoutSeconds: Math.max(1, Math.min(120, Number(e.target.value) || 20)) })
          }
          sx={{ width: 170 }}
        />
        <TextField
          size="small"
          label="Lights"
          value={entities}
          onChange={e => setEntities(e.target.value)}
          sx={{ width: 240 }}
          helperText="For the YAML; comma separated"
        />
        <TextField
          size="small"
          type="number"
          label="HA waits for pFMS (s)"
          value={doneTimeout}
          onChange={e => setDoneTimeout(e.target.value)}
          sx={{ width: 200 }}
          error={tooTight}
          helperText={
            tooTight
              ? `Shorter than pFMS needs — it may restore mid-shutter. Try ${lights.readyTimeoutSeconds + 10}s.`
              : 'Then it restores the lights regardless'
          }
        />
      </Box>

      {lights.startWebhookId && !shown && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Webhook ids are saved and hidden — they are secrets, so the server never sends them back to a browser.
          Generate new ones if you need the YAML again (remember to update the automation).
        </Typography>
      )}

      {shown && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2">Paste this into Home Assistant</Typography>
            <CopyToClipboard text={yaml}>
              <Button size="small" variant="outlined">
                Copy YAML
              </Button>
            </CopyToClipboard>
            <Typography variant="caption" sx={{ color: 'warning.main' }}>
              Copy it before you leave this page — the ids are hidden once saved.
            </Typography>
          </Box>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1,
              maxHeight: 320,
              overflow: 'auto',
              fontSize: 12,
              bgcolor: 'action.hover',
              borderRadius: 1,
              whiteSpace: 'pre',
            }}
          >
            {yaml}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * The managed way in: point pFMS at Home Assistant, prove the token, and tick
 * the lights. pFMS works out the calls — including expanding a group to its
 * members so the restore puts each fixture back the way it was.
 */
function HomeAssistantEditor({
  lights,
  onChange,
}: {
  lights: Extract<TimelapseLights, { mode: 'homeAssistant' }>;
  onChange: (lights: Extract<TimelapseLights, { mode: 'homeAssistant' }>) => void;
}) {
  const [entities, setEntities] = useState<TimelapseLightEntity[] | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setStatus(null);
    // An untouched token field means "use the saved one"; the page never has it.
    const probe = await probeTimelapseLights(lights.baseUrl, lights.token === SECRET_KEPT ? undefined : lights.token);
    setBusy(false);
    setEntities(probe.ok ? probe.lights : null);
    setStatus({
      ok: probe.ok,
      text: probe.ok
        ? `Home Assistant ${probe.version ?? ''} — ${probe.lights.length} lights`.trim()
        : (probe.error ?? 'could not reach Home Assistant'),
    });
  };

  const toggle = (entityId: string) => {
    const on = lights.entityIds.includes(entityId);
    onChange({
      ...lights,
      entityIds: on ? lights.entityIds.filter(e => e !== entityId) : [...lights.entityIds, entityId],
    });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          size="small"
          label="Home Assistant URL"
          placeholder="http://homeassistant.local:8123"
          value={lights.baseUrl}
          onChange={e => onChange({ ...lights, baseUrl: e.target.value })}
          sx={{ flex: 1, minWidth: 280 }}
        />
        <TextField
          size="small"
          label="Long-lived access token"
          type="password"
          value={lights.token ?? ''}
          onChange={e => onChange({ ...lights, token: e.target.value || undefined })}
          sx={{ flex: 1, minWidth: 240 }}
          helperText={
            lights.token === SECRET_KEPT
              ? 'A token is saved. Type over this to replace it.'
              : 'Home Assistant → your profile → Security → Long-lived access tokens'
          }
        />
        <Button variant="outlined" onClick={() => void connect()} disabled={busy || !lights.baseUrl}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </Box>
      {status && (
        <Chip
          size="small"
          color={status.ok ? 'success' : 'error'}
          variant="outlined"
          label={status.text}
          sx={{ alignSelf: 'flex-start' }}
        />
      )}

      {lights.entityIds.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Turning on:
          </Typography>
          {lights.entityIds.map(id => (
            <Chip key={id} size="small" label={id} onDelete={() => toggle(id)} />
          ))}
        </Box>
      )}

      {entities && (
        <Box
          sx={{ maxHeight: 260, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}
        >
          {entities.map(e => (
            <Box key={e.entityId} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Checkbox
                size="small"
                checked={lights.entityIds.includes(e.entityId)}
                onChange={() => toggle(e.entityId)}
              />
              <Typography variant="body2" sx={{ minWidth: 220 }}>
                {e.name}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 200 }}>
                {e.entityId}
              </Typography>
              <Chip size="small" variant="outlined" label={e.state} />
              {e.members && (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  group of {e.members.length}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      )}
      {!entities && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Connect to list the lights. Groups are fine to pick — pFMS snapshots the individual fixtures behind them, so
          the ones that are normally off stay off afterwards.
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
          Every frame looks the same only if the field is lit the same way. Point pFMS at Home Assistant and tick the
          lights, or write your own HTTP calls for anything else. Either way the lights are only touched when nobody is
          here — if a match is running, a robot is enabled, or any Driver Station has been heard from recently, the
          frame is still taken but the lights are left exactly as whoever is in the shop set them. Whatever was on
          before the frame is put back after it.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Control them with:
            </Typography>
            {(
              [
                ['none', 'Nothing'],
                ['haWebhook', 'Home Assistant webhooks'],
                ['homeAssistant', 'Home Assistant token'],
                ['http', 'My own HTTP calls'],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                size="small"
                variant={draft.lights.mode === mode ? 'contained' : 'outlined'}
                color={draft.lights.mode === mode ? 'primary' : 'inherit'}
                onClick={() =>
                  edit({
                    lights:
                      mode === 'none'
                        ? { mode: 'none' }
                        : mode === 'http'
                          ? { mode: 'http' }
                          : mode === 'haWebhook'
                            ? {
                                mode: 'haWebhook',
                                baseUrl: 'http://homeassistant.local:8123',
                                startWebhookId: '',
                                readyTimeoutSeconds: 20,
                              }
                            : { mode: 'homeAssistant', baseUrl: 'http://homeassistant.local:8123', entityIds: [] },
                  })
                }
              >
                {label}
              </Button>
            ))}
          </Box>

          {draft.lights.mode === 'haWebhook' && (
            <HaWebhookEditor key={`hook-${resetKey}`} lights={draft.lights} onChange={lights => edit({ lights })} />
          )}

          {draft.lights.mode === 'homeAssistant' && (
            <HomeAssistantEditor key={`ha-${resetKey}`} lights={draft.lights} onChange={lights => edit({ lights })} />
          )}

          {draft.lights.mode === 'http' && (
            <>
              <ActionListEditor
                label="Before the shutter"
                help="Run in order, then the shutter fires."
                actions={draft.lights.preActions}
                resetKey={resetKey}
                onChange={a =>
                  edit({ lights: { ...(draft.lights as Extract<TimelapseLights, { mode: 'http' }>), preActions: a } })
                }
              />
              <ActionListEditor
                label="After the shutter"
                help="Run in order, even if the capture failed — this is what puts the lights back."
                actions={draft.lights.postActions}
                resetKey={resetKey}
                onChange={a =>
                  edit({ lights: { ...(draft.lights as Extract<TimelapseLights, { mode: 'http' }>), postActions: a } })
                }
              />
            </>
          )}

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
