import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import { MatchTimeline } from './MatchTimeline';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';

import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';

import type { MatchPhase, StationName } from '../../../src/types';
import { StationNameList } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';

import type { ApiKeyCreated, ExternalAccessTokenCreated, PendingDevice } from '../../../src/types';
import type { RecordingStreamConfig, RecordingStreamTestResult } from '../../../src/types';
import {
  useMatchState,
  useLatest,
  useScoreState,
  useApiKeyState,
  useApiKeyCreatedEvent,
  useSlackConfigState,
  useSlackTestResult,
  sendAdminStopMatch,
  sendAdminGlobalEStop,
  sendAdminStationEStop,
  sendAdminStationDisable,
  sendAdminStationEnable,
  sendAdminClearEStop,
  sendStopCast,
  useCastReceivers,
  sendCastReceiverSwap,
  sendCastReceiverMute,
  useFirmwareStore,
  sendCreateApiKey,
  sendRevokeApiKey,
  sendReactivateApiKey,
  sendDeleteApiKey,
  sendApprovePendingDevice,
  sendDismissPendingDevice,
  sendScoreReset,
  sendSaveSlackConfig,
  sendTestSlackConnection,
  useExternalAccessState,
  useExternalAccessTokenCreatedEvent,
  sendCreateExternalAccessToken,
  sendRevokeExternalAccessToken,
  useAudioDeviceState,
  sendSaveAudioDeviceConfig,
  sendTestAudioDevice,
  sendRefreshAudioDevices,
  useSetupConfig,
  useMatchRecordingState,
  sendUpdateSetupSettings,
  testRecordingStream,
} from '../hooks/useBackend';

import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';

const phaseColors: Record<MatchPhase, string> = {
  idle: 'text.secondary',
  created: 'info.main',
  countdown: 'warning.main',
  auto: 'info.main',
  autoPause: 'text.disabled',
  paused: 'warning.main',
  teleop: 'success.main',
  endgame: 'warning.main',
  postMatch: 'text.secondary',
};

const phaseLabels: Record<MatchPhase, string> = {
  idle: 'Idle',
  created: 'Match Created',
  countdown: 'Countdown',
  auto: 'Autonomous',
  autoPause: 'Pause',
  paused: 'Paused',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
  postMatch: 'Post-Match',
};

// ── Global E-Stop ───────────────────────────────────────────────────

function GlobalEStopSection() {
  return (
    <Button
      variant="contained"
      color="error"
      fullWidth
      sx={{ fontSize: '1.5rem', py: 2.5, mb: 3, fontWeight: 'bold' }}
      onClick={() => sendAdminGlobalEStop()}
    >
      EMERGENCY STOP ALL
    </Button>
  );
}

// ── Per-Station Controls ────────────────────────────────────────────

function StationControlCard({ station }: { station: StationName }) {
  const matchState = useMatchState();
  const latest = useLatest();
  const stationState = matchState?.stationStates[station];
  const teamNumber = stationState?.teamNumber ?? null;
  const isRobotLinked = latest?.radioUpdate?.stationStatuses[station]?.isLinked ?? false;

  const title = teamNumber ? `Team ${teamNumber}` : prettyStationName(station);
  const subtitle = teamNumber ? prettyStationName(station) : null;

  return (
    <Card sx={{ mb: 1 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TeamAvatar teamNumber={teamNumber} size={28} />
            <Typography variant="subtitle1" fontWeight="bold">
              {title}
              {subtitle && (
                <Typography component="span" variant="body2" sx={{ ml: 1, color: 'text.secondary' }}>
                  {subtitle}
                </Typography>
              )}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
              {isRobotLinked ? (
                <Chip label="Robot Linked" size="small" color="success" variant="outlined" />
              ) : teamNumber ? (
                <Chip label="No Robot" size="small" variant="outlined" color="warning" />
              ) : (
                <Chip label="No Team" size="small" variant="outlined" />
              )}
              {stationState?.joined && <Chip label="Joined" size="small" color="primary" variant="outlined" />}
              {stationState?.eStop && <Chip label="E-STOP" size="small" color="error" />}
              {stationState?.aStop && <Chip label="A-STOP" size="small" color="warning" />}
              {stationState?.enabled && <Chip label="Enabled" size="small" color="success" />}
              {!stationState?.enabled && !stationState?.eStop && !stationState?.aStop && (
                <Chip label="Disabled" size="small" variant="outlined" />
              )}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            {stationState?.eStop ? (
              <Button size="small" variant="outlined" onClick={() => sendAdminClearEStop(station)}>
                Clear E-Stop
              </Button>
            ) : stationState?.enabled ? (
              <Button size="small" variant="contained" color="warning" onClick={() => sendAdminStationDisable(station)}>
                Disable
              </Button>
            ) : (
              // Recovery: put a stopped robot back in the match (works for team
              // disables and after a cleared e-stop; robots-running phases only)
              <Button
                size="small"
                variant="outlined"
                color="success"
                onClick={() => sendAdminStationEnable(station)}
                disabled={
                  !stationState?.joined ||
                  stationState?.aStop ||
                  !(matchState?.phase === 'auto' || matchState?.phase === 'teleop' || matchState?.phase === 'endgame')
                }
              >
                Enable
              </Button>
            )}
            {!stationState?.eStop && (
              <Tooltip title="Emergency stop — use only for safety" arrow>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  onClick={() => sendAdminStationEStop(station)}
                  sx={{ minWidth: 0, px: 1, fontSize: '0.7rem' }}
                >
                  E-STOP
                </Button>
              </Tooltip>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

function StationControlSection() {
  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          Teams & Controls
        </Typography>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            {StationNameList.slice(0, 3).map(s => (
              <StationControlCard key={s} station={s} />
            ))}
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            {StationNameList.slice(3).map(s => (
              <StationControlCard key={s} station={s} />
            ))}
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
}

// ── Match Timer ─────────────────────────────────────────────────────

function MatchTimer({ remainingTime, phase }: { remainingTime: number; phase: MatchPhase }) {
  const display = Math.ceil(Math.max(0, remainingTime));
  const minutes = Math.floor(display / 60);
  const seconds = display % 60;
  const text = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <Typography
      variant="h1"
      sx={{
        fontFamily: 'monospace',
        fontSize: '6rem',
        textAlign: 'center',
        color: phaseColors[phase],
        lineHeight: 1,
      }}
    >
      {text}
    </Typography>
  );
}

// ── Match Status (read-only, admin can force-stop) ───────────────────

function MatchStatusSection() {
  const matchState = useMatchState();
  if (!matchState) return null;

  const { phase, remainingTime, totalMatchTime, config } = matchState;
  const isActive = phase !== 'idle' && phase !== 'postMatch';

  const countdownDuration = 3;
  const barTotal = config.autoDuration + config.pauseDuration + config.teleopDuration;
  const elapsed = Math.max(0, totalMatchTime - countdownDuration);
  const skipOffset = config.skipAuto ? config.autoDuration + config.pauseDuration : 0;
  const progress = barTotal > 0 ? Math.min(1, (skipOffset + elapsed) / barTotal) : 0;

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ textAlign: 'center', mb: 2 }}>
          <Chip
            label={phaseLabels[phase]}
            sx={{
              fontSize: '1.2rem',
              py: 2.5,
              px: 2,
              fontWeight: 'bold',
              color: phaseColors[phase],
              borderColor: phaseColors[phase],
            }}
            variant="outlined"
          />
        </Box>

        <MatchTimer remainingTime={remainingTime} phase={phase} />

        <Box sx={{ my: 2 }}>
          <MatchTimeline
            config={config}
            progress={progress}
            autoWinnerAlliance={matchState.autoWinnerAlliance}
            phase={matchState.phase}
            remainingTime={matchState.remainingTime}
          />
        </Box>

        {isActive && (
          <Button
            variant="contained"
            color="error"
            size="large"
            fullWidth
            sx={{ fontWeight: 'bold', fontSize: '1.1rem' }}
            onClick={sendAdminStopMatch}
          >
            Force Stop Match
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Admin Page ──────────────────────────────────────────────────────

export function AdminPage() {
  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Field Admin
      </Typography>

      <GlobalEStopSection />
      <MatchStatusSection />
      <ScoringSection />
      <ApiKeySection />
      <ExternalAccessSection />
      <StationControlSection />
      <AudioDeviceSection />
      <SlackConfigSection />
      <MatchRecordingSection />
      <FirmwareSection />
    </Container>
  );
}

// ── Match Video Recording ───────────────────────────────────────────

function formatRecordingBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/**
 * Which video streams pFMS records for every match. Streams are saved as a
 * setup setting (admin-gated, persisted, env-seeded); the recorder picks them
 * up on the next match. A stream can be probed before it is saved.
 */
function MatchRecordingSection() {
  const setupConfig = useSetupConfig();
  const recording = useMatchRecordingState();
  const saved = setupConfig?.config.settings.recordingStreams;
  const [streams, setStreams] = useState<RecordingStreamConfig[]>([]);
  const [retention, setRetention] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState<Record<string, RecordingStreamTestResult | 'pending'>>({});

  // Follow the server until the operator starts editing.
  useEffect(() => {
    if (dirty) return;
    setStreams(saved ?? recording?.streams.map(s => ({ name: s.name, url: s.url, enabled: s.enabled })) ?? []);
    setRetention(String(setupConfig?.config.settings.recordingRetentionDays ?? recording?.retentionDays ?? 30));
  }, [saved, recording, setupConfig, dirty]);

  const edit = (i: number, patch: Partial<RecordingStreamConfig>) => {
    setDirty(true);
    setStreams(prev => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const remove = (i: number) => {
    setDirty(true);
    setStreams(prev => prev.filter((_, j) => j !== i));
  };
  const add = () => {
    setDirty(true);
    setStreams(prev => [...prev, { name: prev.length === 0 ? 'all-field' : '', url: 'rtsp://', enabled: true }]);
  };
  const save = () => {
    const days = Number.parseInt(retention, 10);
    sendUpdateSetupSettings({
      recordingStreams: streams.map(s => ({ ...s, name: s.name.trim(), url: s.url.trim() })),
      recordingRetentionDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : undefined,
    });
    setDirty(false);
  };
  const test = async (url: string) => {
    setTesting(prev => ({ ...prev, [url]: 'pending' }));
    const result = await testRecordingStream(url);
    setTesting(prev => ({ ...prev, [url]: result }));
  };

  const invalid = streams.some(s => !s.name.trim() || !/^(rtsps?|https?|rtmp|srt|udp):\/\/.+/.test(s.url.trim()));
  const statusFor = (name: string) => recording?.streams.find(s => s.name === name);

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h5">Match Video Recording</Typography>
          {recording && !recording.available && (
            <Chip size="small" color="error" label={recording.unavailableReason ?? 'ffmpeg not available'} />
          )}
          {recording?.activeMatchId && <Chip size="small" color="error" label="● Recording" />}
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Every match is captured from these streams (copied as-is, no transcoding) and offered for download on the
          station pages and in match history. Anything ffmpeg can read works — for stitchd/MediaMTX that is{' '}
          <code>rtsp://host:8554/&lt;stream&gt;</code>.
          {recording && (
            <>
              {' '}
              Files live in <code>{recording.directory}</code>: {formatRecordingBytes(recording.usedBytes)} used,{' '}
              {formatRecordingBytes(recording.diskFreeBytes)} free, kept {recording.retentionDays} days.
            </>
          )}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {streams.map((s, i) => {
            const live = statusFor(s.name);
            const t = testing[s.url];
            return (
              <Box key={i} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <TextField
                    size="small"
                    label="Name"
                    value={s.name}
                    onChange={e => edit(i, { name: e.target.value })}
                    sx={{ width: 160 }}
                  />
                  <TextField
                    size="small"
                    label="Stream URL"
                    value={s.url}
                    onChange={e => edit(i, { url: e.target.value })}
                    sx={{ flex: 1, minWidth: 260 }}
                  />
                  <Button
                    size="small"
                    variant={s.enabled ? 'contained' : 'outlined'}
                    color={s.enabled ? 'success' : 'inherit'}
                    onClick={() => edit(i, { enabled: !s.enabled })}
                  >
                    {s.enabled ? 'Enabled' : 'Disabled'}
                  </Button>
                  <Button size="small" variant="outlined" onClick={() => test(s.url)} disabled={t === 'pending'}>
                    {t === 'pending' ? 'Testing…' : 'Test'}
                  </Button>
                  <Button size="small" color="inherit" onClick={() => remove(i)} sx={{ opacity: 0.6 }}>
                    Remove
                  </Button>
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', pl: 0.5 }}>
                  {t && t !== 'pending' && (
                    <Chip
                      size="small"
                      color={t.ok ? 'success' : 'error'}
                      variant="outlined"
                      label={
                        t.ok
                          ? `OK: ${t.codec} ${t.width}×${t.height} @ ${t.fps ?? '?'} fps (${(t.ms / 1000).toFixed(1)} s to first frame)`
                          : `Failed: ${t.error}`
                      }
                    />
                  )}
                  {live && live.status !== 'idle' && (
                    <Chip
                      size="small"
                      color={live.status === 'error' ? 'error' : 'info'}
                      label={`${live.status}${live.bytes ? ` · ${formatRecordingBytes(live.bytes)}` : ''}${live.reconnects ? ` · ${live.reconnects} reconnect(s)` : ''}`}
                    />
                  )}
                  {live?.error && live.status !== 'recording' && (
                    <Typography variant="caption" sx={{ color: 'warning.main' }}>
                      Last error: {live.error}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          })}

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={add}>
              Add stream
            </Button>
            <TextField
              size="small"
              label="Keep recordings (days)"
              value={retention}
              onChange={e => {
                setDirty(true);
                setRetention(e.target.value.replace(/[^0-9]/g, ''));
              }}
              sx={{ width: 190 }}
            />
            <Button size="small" variant="contained" onClick={save} disabled={!dirty || invalid}>
              Save
            </Button>
            {dirty && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Unsaved changes — applies from the next match.
              </Typography>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Audio Device ────────────────────────────────────────────────────

function AudioDeviceSection() {
  const audioState = useAudioDeviceState();
  const [selected, setSelected] = useState('');

  useEffect(() => {
    if (audioState?.selectedDeviceName != null) {
      setSelected(audioState.selectedDeviceName);
    } else {
      setSelected('');
    }
  }, [audioState?.selectedDeviceName]);

  if (!audioState) return null;

  const handleSave = () => {
    sendSaveAudioDeviceConfig(selected || null);
  };

  const hasChanged = (selected || null) !== (audioState.selectedDeviceName || null);

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Match Audio</Typography>
          <Chip
            label={
              audioState.status === 'active'
                ? 'Active'
                : audioState.status === 'disconnected'
                  ? 'Disconnected'
                  : 'Disabled'
            }
            size="small"
            color={
              audioState.status === 'active' ? 'success' : audioState.status === 'disconnected' ? 'warning' : 'default'
            }
          />
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Select an audio output device for match phase sounds (start horn, end buzzer, etc.). The device is locked by
          name so it auto-recovers if the USB device moves to a different port.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
          <FormControl size="small" sx={{ minWidth: 250, flex: 1 }}>
            <InputLabel>Audio Device</InputLabel>
            <Select value={selected} label="Audio Device" onChange={e => setSelected(e.target.value)}>
              <MenuItem value="">
                <em>Disabled</em>
              </MenuItem>
              {audioState.available.map(d => (
                <MenuItem key={d.cardIndex} value={d.name}>
                  {d.name} ({d.driver})
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button variant="contained" size="small" onClick={handleSave} disabled={!hasChanged}>
            Save
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={sendTestAudioDevice}
            disabled={audioState.status !== 'active'}
          >
            Test
          </Button>
          <Button variant="text" size="small" onClick={sendRefreshAudioDevices}>
            Refresh
          </Button>
        </Box>

        {audioState.status === 'disconnected' && audioState.selectedDeviceName && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            Device "{audioState.selectedDeviceName}" is not connected. It will auto-reconnect when plugged in.
          </Alert>
        )}

        {audioState.status === 'active' && audioState.resolvedDevice && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            Resolved to {audioState.resolvedDevice}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── Slack Configuration ──────────────────────────────────────────────

function SlackConfigSection() {
  const slackConfig = useSlackConfigState();
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [channelId, setChannelId] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; channelName?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useSlackTestResult(
    useCallback((result: { ok: boolean; error?: string; channelName?: string }) => {
      setTestResult(result);
    }, []),
  );

  const handleSave = () => {
    if (!botToken || !appToken || !channelId) return;
    setSaving(true);
    sendSaveSlackConfig(botToken, appToken, channelId);
    // Reset saving state after a timeout (result comes via slackConfigState)
    setTimeout(() => setSaving(false), 3000);
  };

  const handleTest = () => {
    setTestResult(null);
    sendTestSlackConnection();
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Slack Integration</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            {slackConfig?.configured && (
              <Chip
                label={
                  slackConfig.connected
                    ? `Connected${slackConfig.channelName ? ` (#${slackConfig.channelName})` : ''}`
                    : 'Disconnected'
                }
                size="small"
                color={slackConfig.connected ? 'success' : 'error'}
              />
            )}
            {!slackConfig?.configured && <Chip label="Not Configured" size="small" color="default" />}
          </Box>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Connect to a Slack channel to receive support issue reports and enable real-time chat. Uses Socket Mode — no
          public URL or HTTPS required.
        </Typography>

        <Accordion
          disableGutters
          sx={{ mb: 2, backgroundColor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            sx={{ px: 0, minHeight: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}
          >
            <Typography variant="body2" color="primary">
              Setup wizard — create a Slack App and connect it
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Box
              component="ol"
              sx={{
                pl: 2.5,
                my: 0,
                '& > li': { mb: 2, fontSize: '0.875rem', color: 'text.secondary' },
                '& code': { backgroundColor: 'action.hover', px: 0.5, borderRadius: 0.5, fontSize: '0.8rem' },
                '& strong': { color: 'text.primary' },
              }}
            >
              <li>
                Go to{' '}
                <a href="https://api.slack.com/apps" target="_blank" rel="noopener" style={{ color: 'inherit' }}>
                  api.slack.com/apps
                </a>{' '}
                → <strong>Create New App</strong> → <strong>From scratch</strong>. Name it (e.g. "PFMS Support") and
                pick your workspace.
              </li>
              <li>
                <strong>Add Bot Token Scopes:</strong> Go to <em>OAuth & Permissions</em> → <em>Scopes</em> →{' '}
                <em>Bot Token Scopes</em> and add: <code>chat:write</code>, <code>channels:read</code>,{' '}
                <code>files:write</code>, <code>users:read</code>, <code>emoji:read</code>.
              </li>
              <li>
                <strong>Install to Workspace:</strong> Go to <em>OAuth & Permissions</em> →{' '}
                <em>Install to Workspace</em>. Copy the <strong>Bot User OAuth Token</strong> and paste it here:
                <TextField
                  size="small"
                  label="Bot Token (xoxb-...)"
                  type="password"
                  value={botToken}
                  onChange={e => setBotToken(e.target.value)}
                  placeholder="xoxb-..."
                  fullWidth
                  sx={{ mt: 1 }}
                />
              </li>
              <li>
                <strong>Enable Socket Mode:</strong> Go to <em>Settings</em> → <em>Socket Mode</em> → toggle on. A
                dialog will prompt you to create an <strong>App-Level Token</strong> — the{' '}
                <code>connections:write</code> scope is pre-selected. Give it a name (e.g. "websocket") and click{' '}
                <strong>Generate</strong>. If you missed the dialog, go to <em>Basic Information</em> →{' '}
                <em>App-Level Tokens</em> → <em>Generate Token and Scopes</em>. Paste the token here:
                <TextField
                  size="small"
                  label="App-Level Token (xapp-...)"
                  type="password"
                  value={appToken}
                  onChange={e => setAppToken(e.target.value)}
                  placeholder="xapp-..."
                  fullWidth
                  sx={{ mt: 1 }}
                />
              </li>
              <li>
                <strong>Subscribe to Events:</strong> Go to <em>Event Subscriptions</em> → toggle on →{' '}
                <em>Subscribe to bot events</em> → add <code>message.channels</code>.
              </li>
              <li>
                <strong>Invite the bot</strong> to your support channel: in Slack, type{' '}
                <code>/invite @PFMS Support</code> in the channel.
              </li>
              <li>
                <strong>Get the Channel ID:</strong> Right-click the channel → <em>View channel details</em> → scroll to
                the bottom. Paste the <strong>Channel ID</strong> here:
                <TextField
                  size="small"
                  label="Channel ID"
                  value={channelId}
                  onChange={e => setChannelId(e.target.value)}
                  placeholder="C0XXXXXXX"
                  fullWidth
                  sx={{ mt: 1 }}
                />
              </li>
            </Box>
          </AccordionDetails>
        </Accordion>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="contained"
              size="small"
              onClick={handleSave}
              disabled={saving || !botToken || !appToken || !channelId}
            >
              {saving ? 'Saving...' : 'Save & Connect'}
            </Button>
            {slackConfig?.configured && (
              <Button variant="outlined" size="small" onClick={handleTest}>
                Test Connection
              </Button>
            )}
          </Box>

          {slackConfig?.error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {slackConfig.error}
            </Alert>
          )}

          {testResult && (
            <Alert severity={testResult.ok ? 'success' : 'error'} sx={{ mt: 1 }}>
              {testResult.ok
                ? `Connection OK${testResult.channelName ? ` — posting to #${testResult.channelName}` : ''}`
                : `Connection failed: ${testResult.error}`}
            </Alert>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Scoring ─────────────────────────────────────────────────────────

function formatAge(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function ScoringSection() {
  const score = useScoreState();
  const castReceivers = useCastReceivers();
  const [, setTick] = useState(0);

  // Re-render every second to update sliding window / source ages
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!score) return null;

  const elements = Object.values(score.elements);
  const sources = Object.entries(score.sources);
  const hasScores = score.red.total > 0 || score.blue.total > 0;

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Scoring</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Chip
              label={
                score.mode === 'freePlay'
                  ? `Free Play (${score.batchTimeoutSeconds}s batch / ${score.windowSeconds}s window)`
                  : 'Match'
              }
              size="small"
              color={score.mode === 'match' ? 'primary' : 'default'}
            />
            {score.mode === 'freePlay' && (
              <>
                <Chip
                  label={`Red: ${score.redBatchActive ? 'active' : 'idle'}`}
                  size="small"
                  variant="outlined"
                  color={score.redBatchActive ? 'error' : 'default'}
                />
                <Chip
                  label={`Blue: ${score.blueBatchActive ? 'active' : 'idle'}`}
                  size="small"
                  variant="outlined"
                  color={score.blueBatchActive ? 'info' : 'default'}
                />
              </>
            )}
            {hasScores && (
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={() => sendScoreReset()}
                sx={{ textTransform: 'none', fontSize: '0.75rem' }}
              >
                Reset
              </Button>
            )}
          </Box>
        </Box>

        {/* Score totals */}
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <ScoreCard alliance="red" score={score.red} />
          <ScoreCard alliance="blue" score={score.blue} />
        </Box>

        {/* Element breakdown */}
        {elements.length > 0 && hasScores && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Element Breakdown
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Element</TableCell>
                  <TableCell sx={{ color: '#d32f2f' }} align="right">
                    Red
                  </TableCell>
                  <TableCell sx={{ color: '#1565c0' }} align="right">
                    Blue
                  </TableCell>
                  <TableCell align="right">Pts each</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {elements.map(el => {
                  const red = score.red.elements[el.id];
                  const blue = score.blue.elements[el.id];
                  if (!red && !blue) return null;
                  return (
                    <TableRow key={el.id}>
                      <TableCell sx={{ py: 0.5 }}>
                        {el.name}
                        {el.awardToOpponent && (
                          <Typography component="span" variant="caption" color="warning.main" sx={{ ml: 0.5 }}>
                            (foul)
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontFamily: 'monospace' }}>
                        {red?.count ?? 0}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontFamily: 'monospace' }}>
                        {blue?.count ?? 0}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontFamily: 'monospace', color: 'text.secondary' }}>
                        {el.pointValue}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}

        {/* Phase breakdown (match mode) */}
        {score.mode === 'match' && score.phaseBreakdown && Object.keys(score.phaseBreakdown).length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Phase Breakdown
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              {Object.entries(score.phaseBreakdown).map(([phase, scores]) => (
                <Chip
                  key={phase}
                  label={`${phase}: R${scores.red.total} / B${scores.blue.total}`}
                  size="small"
                  variant="outlined"
                />
              ))}
            </Box>
          </Box>
        )}

        {/* Sources */}
        {sources.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Sources
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {sources.map(([id, src]) => {
                const stale = Date.now() - src.lastSeen > 30_000;
                return (
                  <Chip
                    key={id}
                    label={`${id} (${src.eventCount})`}
                    size="small"
                    variant="outlined"
                    color={stale ? 'default' : 'success'}
                    title={`Last seen: ${formatAge(src.lastSeen)}${src.lastElement ? ` — ${src.lastAlliance} ${src.lastElement}` : ''}`}
                  />
                );
              })}
            </Box>
          </Box>
        )}

        {/* Cast Receivers */}
        {castReceivers.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Displays
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {castReceivers.map(r => (
                <Box key={r.id} sx={{ display: 'flex', gap: 0.25, alignItems: 'center' }}>
                  <Chip
                    label={`${r.name} (${r.swapped ? 'swapped' : 'normal'})`}
                    size="small"
                    variant="outlined"
                    color="success"
                    onClick={() => sendCastReceiverSwap(r.id, !r.swapped)}
                    onDelete={() => sendStopCast(r.id)}
                    deleteIcon={<Typography sx={{ fontSize: '0.7rem', cursor: 'pointer', px: 0.5 }}>✕</Typography>}
                  />
                  <Chip
                    label={r.muted ? '🔇 muted' : '🔊 sound'}
                    size="small"
                    variant={r.muted ? 'filled' : 'outlined'}
                    color={r.muted ? 'warning' : 'success'}
                    onClick={() => sendCastReceiverMute(r.id, !r.muted)}
                  />
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {!hasScores && sources.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No scoring devices connected. Send events to <code>POST /api/score</code>
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function ScoreCard({ alliance, score }: { alliance: 'red' | 'blue'; score: { total: number } }) {
  const color = alliance === 'red' ? '#d32f2f' : '#1565c0';
  return (
    <Box
      sx={{
        flex: 1,
        textAlign: 'center',
        py: 1.5,
        borderRadius: 1,
        border: 2,
        borderColor: color,
        backgroundColor: `${color}11`,
      }}
    >
      <Typography variant="h3" sx={{ fontWeight: 700, color, fontFamily: 'monospace' }}>
        {score.total}
      </Typography>
      <Typography variant="caption" sx={{ color, textTransform: 'uppercase', fontWeight: 600 }}>
        {alliance}
      </Typography>
    </Box>
  );
}

// ── API Key Management ──────────────────────────────────────────────

// ── External Access Tokens ──────────────────────────────────────────

function ExternalAccessSection() {
  const state = useExternalAccessState();
  const [newLabel, setNewLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<ExternalAccessTokenCreated | null>(null);
  const [, setTick] = useState(0);

  // Re-render every second to update relative timestamps
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Listen for token creation events (raw token shown once)
  useExternalAccessTokenCreatedEvent(useCallback((msg: ExternalAccessTokenCreated) => setCreatedToken(msg), []));

  // Dismiss the banner when the token is revoked
  useEffect(() => {
    if (createdToken && state && !state.tokens.some(t => t.id === createdToken.id)) {
      setCreatedToken(null);
    }
  }, [createdToken, state]);

  if (!state) return null;

  const handleCreate = () => {
    if (!newLabel.trim()) return;
    sendCreateExternalAccessToken(newLabel.trim());
    setNewLabel('');
  };

  const authUrl = createdToken ? `${window.location.origin}/admin/auth/${createdToken.token}` : '';

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h5" sx={{ mb: 1 }}>
          External Access
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Grant trusted users access to the internal UI from outside the local network. Each token generates a shareable
          URL — visiting it sets a browser cookie that Caddy checks on every request.
        </Typography>

        {/* Token creation form */}
        <Box sx={{ display: 'flex', gap: 1, my: 2, alignItems: 'flex-end' }}>
          <TextField
            size="small"
            label="Label"
            placeholder="e.g. Cameron's phone"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            sx={{ flex: 1 }}
          />
          <Button variant="contained" size="small" onClick={handleCreate} disabled={!newLabel.trim()}>
            Create Token
          </Button>
        </Box>

        {/* One-time auth URL display */}
        <Collapse in={!!createdToken} unmountOnExit>
          <Alert severity="success" onClose={() => setCreatedToken(null)} sx={{ mb: 2 }}>
            <Typography variant="subtitle2">Token created: {createdToken?.label}</Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all', my: 0.5 }}
            >
              {authUrl}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Share this URL — it will not be shown again.
            </Typography>
          </Alert>
        </Collapse>

        {/* Token list */}
        {state.tokens.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last Used</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.tokens.map(token => (
                <TableRow key={token.id}>
                  <TableCell>{token.label}</TableCell>
                  <TableCell>
                    <Tooltip title={new Date(token.createdAt).toLocaleString()}>
                      <span>{formatAge(token.createdAt)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {token.lastUsedAt ? (
                      <Tooltip title={new Date(token.lastUsedAt).toLocaleString()}>
                        <span>{formatAge(token.lastUsedAt)}</span>
                      </Tooltip>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Never
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="small" color="error" onClick={() => sendRevokeExternalAccessToken(token.id)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {state.tokens.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No external access tokens. External users see the public page only.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── API Keys ────────────────────────────────────────────────────────

function ApiKeySection() {
  const apiKeyState = useApiKeyState();
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [approveDevice, setApproveDevice] = useState<PendingDevice | null>(null);
  const [approveLabel, setApproveLabel] = useState('');
  const [, setTick] = useState(0);

  // Re-render every second to update relative timestamps
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Listen for key creation events (full key shown once)
  useApiKeyCreatedEvent(useCallback((msg: ApiKeyCreated) => setCreatedKey(msg), []));

  // Dismiss the new-key banner when the key is deleted
  useEffect(() => {
    if (createdKey && apiKeyState && !apiKeyState.keys.some(k => k.id === createdKey.id)) {
      setCreatedKey(null);
    }
  }, [createdKey, apiKeyState]);

  if (!apiKeyState) return null;

  const handleCreate = () => {
    if (!newKeyLabel.trim()) return;
    sendCreateApiKey(newKeyLabel.trim());
    setNewKeyLabel('');
  };

  const handleApprove = () => {
    if (!approveDevice) return;
    sendApprovePendingDevice(approveDevice.id, approveLabel.trim() || `Device ${approveDevice.sourceIp}`);
    setApproveDevice(null);
    setApproveLabel('');
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Scoring API Keys</Typography>
          <Chip
            label={apiKeyState.authRequired ? 'Auth Required' : 'Open Access'}
            size="small"
            color={apiKeyState.authRequired ? 'success' : 'warning'}
          />
        </Box>

        {/* Key creation form */}
        <Box sx={{ display: 'flex', gap: 1, my: 2, alignItems: 'flex-end' }}>
          <TextField
            size="small"
            label="New Key Label"
            placeholder="e.g. Speaker Sensor"
            value={newKeyLabel}
            onChange={e => setNewKeyLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            sx={{ flex: 1 }}
          />
          <Button variant="contained" size="small" onClick={handleCreate} disabled={!newKeyLabel.trim()}>
            Create Key
          </Button>
        </Box>

        {/* One-time key display */}
        <Collapse in={!!createdKey} unmountOnExit>
          <Alert severity="success" onClose={() => setCreatedKey(null)} sx={{ mb: 2 }}>
            <Typography variant="subtitle2">New key created: {createdKey?.label}</Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all', my: 0.5 }}
            >
              {createdKey?.key}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Copy this key now — it will not be shown again.
            </Typography>
          </Alert>
        </Collapse>

        {/* Registered keys table */}
        {apiKeyState.keys.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell>
                <TableCell>Key</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Requests</TableCell>
                <TableCell>Last Used</TableCell>
                <TableCell>Last IP</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {apiKeyState.keys.map(key => (
                <TableRow key={key.id}>
                  <TableCell>{key.label}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {key.keyPreview}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={key.status} size="small" color={key.status === 'active' ? 'success' : 'error'} />
                  </TableCell>
                  <TableCell align="right">{key.requestCount}</TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {key.lastUsedAt ? formatAge(key.lastUsedAt) : 'Never'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {key.lastSourceIp ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {key.status === 'active' ? (
                        <Button
                          size="small"
                          color="warning"
                          onClick={() => sendRevokeApiKey(key.id)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          color="success"
                          onClick={() => sendReactivateApiKey(key.id)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Reactivate
                        </Button>
                      )}
                      <Button
                        size="small"
                        color="error"
                        onClick={() => sendDeleteApiKey(key.id)}
                        sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                      >
                        Delete
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Pending devices section */}
        {apiKeyState.pendingDevices.length > 0 && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              Pending Devices ({apiKeyState.pendingDevices.length})
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>IP Address</TableCell>
                  <TableCell>User Agent</TableCell>
                  <TableCell align="right">Attempts</TableCell>
                  <TableCell>Last Seen</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {apiKeyState.pendingDevices.map(device => (
                  <TableRow key={device.id}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                        {device.sourceIp}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {device.userAgent ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{device.requestCount}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatAge(device.lastSeen)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <Button
                          size="small"
                          color="success"
                          onClick={() => {
                            setApproveDevice(device);
                            setApproveLabel('');
                          }}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          onClick={() => sendDismissPendingDevice(device.id)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Dismiss
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        {/* Approve device dialog */}
        <Dialog open={!!approveDevice} onClose={() => setApproveDevice(null)}>
          <DialogTitle>Approve Device</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Generate an API key for device at <strong>{approveDevice?.sourceIp}</strong>
              {approveDevice?.userAgent && (
                <>
                  <br />
                  <Typography component="span" variant="caption" color="text.secondary">
                    {approveDevice.userAgent}
                  </Typography>
                </>
              )}
            </Typography>
            <TextField
              label="Device Label"
              placeholder={`Device ${approveDevice?.sourceIp ?? ''}`}
              value={approveLabel}
              onChange={e => setApproveLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleApprove()}
              fullWidth
              autoFocus
              size="small"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setApproveDevice(null)}>Cancel</Button>
            <Button onClick={handleApprove} variant="contained" color="success">
              Approve & Generate Key
            </Button>
          </DialogActions>
        </Dialog>

        {/* Empty state */}
        {apiKeyState.keys.length === 0 && apiKeyState.pendingDevices.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No API keys configured. The scoring API is currently open to all devices on the network. Create a key to
            require authentication.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── Firmware Management ─────────────────────────────────────────────

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function FirmwareSection() {
  const entries = useFirmwareStore();
  const [uploading, setUploading] = useState(false);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadChecksum, setUploadChecksum] = useState('');
  const [uploadType, setUploadType] = useState<'from12x' | 'pre12x'>('from12x');
  const [message, setMessage] = useState('');

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file || !uploadVersion || !uploadChecksum) return;

    setUploading(true);
    setMessage('');
    try {
      const data = await file.arrayBuffer();
      const params = new URLSearchParams({ checksum: uploadChecksum, version: uploadVersion, upgradeFrom: uploadType });
      const res = await fetch(`/api/firmware/upload?${params}`, { method: 'POST', body: data });
      const json = await res.json();
      setMessage(res.ok ? `Uploaded: ${json.entry?.version ?? 'ok'}` : `Error: ${json.error}`);
    } catch (err) {
      setMessage(`Upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
    }
  };

  // Group entries by version
  type FwEntry = (typeof entries)[number];
  const versions = new Map<string, { pre12x?: FwEntry; from12x?: FwEntry }>();
  for (const e of entries) {
    const row = versions.get(e.version) ?? {};
    if (e.upgradeFrom === 'pre12x') row.pre12x = e;
    else row.from12x = e;
    versions.set(e.version, row);
  }

  const allCached = entries.length > 0 && entries.every(e => e.filePath);
  const anyDownloading = entries.some(e => e.downloading);

  const triggerDownload = () => {
    fetch('/api/firmware/download', { method: 'POST' });
  };

  const fwStatusCell = (entry?: FwEntry) => {
    if (!entry) {
      return (
        <Typography variant="caption" color="text.disabled">
          —
        </Typography>
      );
    }
    let label = 'missing';
    let color: string = 'warning.main';
    if (entry.filePath) {
      label = 'cached';
      color = 'success.main';
    } else if (entry.downloading) {
      color = 'info.main';
      if (entry.downloadedBytes !== undefined && entry.totalBytes) {
        label = `downloading ${Math.round((entry.downloadedBytes / entry.totalBytes) * 100)}%`;
      } else if (entry.downloadedBytes !== undefined) {
        label = `downloading ${formatBytes(entry.downloadedBytes)}`;
      } else {
        label = 'downloading...';
      }
    } else if (entry.downloadError) {
      label = `failed: ${entry.downloadError}`;
      color = 'error.main';
    }
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box
          component="span"
          sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }}
        />
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Box>
    );
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Radio Firmware</Typography>
          {!allCached && !anyDownloading && (
            <Button size="small" variant="outlined" onClick={triggerDownload} sx={{ textTransform: 'none' }}>
              Download from Internet
            </Button>
          )}
        </Box>

        {versions.size > 0 && (
          <Box
            sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '4px 16px', alignItems: 'center', mb: 2 }}
          >
            <Box />
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
              From 1.2.x+
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
              Pre-1.2
            </Typography>
            {[...versions].map(([ver, row]) => (
              <Box key={ver} sx={{ display: 'contents' }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  v{ver}
                </Typography>
                {fwStatusCell(row.from12x)}
                {fwStatusCell(row.pre12x)}
              </Box>
            ))}
          </Box>
        )}

        {!allCached && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Manual Upload
            </Typography>
            <form onSubmit={handleUpload}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <input type="file" accept=".enc,.bin,.img" required disabled={uploading} />
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <input
                    type="text"
                    placeholder="Version (e.g. 2.0.1)"
                    value={uploadVersion}
                    onChange={e => setUploadVersion(e.target.value)}
                    required
                    style={{ flex: 1, padding: '4px 8px' }}
                  />
                  <input
                    type="text"
                    placeholder="SHA-256 checksum"
                    value={uploadChecksum}
                    onChange={e => setUploadChecksum(e.target.value)}
                    required
                    style={{ flex: 2, padding: '4px 8px', fontFamily: 'monospace' }}
                  />
                  <select value={uploadType} onChange={e => setUploadType(e.target.value as 'from12x' | 'pre12x')}>
                    <option value="from12x">From 1.2.x+</option>
                    <option value="pre12x">Pre-1.2</option>
                  </select>
                </Box>
                <Button type="submit" size="small" variant="contained" disabled={uploading}>
                  {uploading ? 'Uploading...' : 'Upload Firmware'}
                </Button>
              </Box>
            </form>
          </>
        )}
        {message && (
          <Typography
            variant="body2"
            sx={{ mt: 1, color: message.startsWith('Error') ? 'error.main' : 'success.main' }}
          >
            {message}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
