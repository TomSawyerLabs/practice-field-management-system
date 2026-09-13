import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import type { SetupCheck, SetupCheckStatus, SetupStep, SetupStepId } from '../../../src/types';
import {
  useSetupProbe,
  useSetupConfig,
  useAudioDeviceState,
  sendRequestSetupProbe,
  sendUpdateSetupSettings,
  sendMarkSetupStep,
  sendSaveAudioDeviceConfig,
  sendTestAudioDevice,
  useServerVersion,
} from '../hooks/useBackend';
import { buildBugReportUrl } from '../utils/githubIssue';

const statusColor: Record<SetupCheckStatus, 'success' | 'warning' | 'error'> = {
  pass: 'success',
  warn: 'warning',
  fail: 'error',
};

function StatusIcon({ status }: { status: SetupCheckStatus }) {
  const sx = { fontSize: 20, color: `${statusColor[status]}.main` };
  if (status === 'pass') return <CheckCircleIcon sx={sx} />;
  if (status === 'warn') return <WarningIcon sx={sx} />;
  return <ErrorIcon sx={sx} />;
}

/** One observation, with the fix shown as a copyable command when there is one. */
function CheckRow({ check }: { check: SetupCheck }) {
  return (
    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', py: 0.75 }}>
      <Box sx={{ pt: '2px' }}>
        <StatusIcon status={check.status} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {check.label}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {check.detail}
        </Typography>
        {check.fix && (
          <Box
            component="pre"
            sx={{
              mt: 0.5,
              mb: 0,
              px: 1,
              py: 0.5,
              borderRadius: 1,
              bgcolor: 'action.hover',
              fontSize: '0.8rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {check.fix}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** Per-step controls. Everything here writes through to the server immediately. */
function StepActions({ step }: { step: SetupStepId }) {
  const config = useSetupConfig();
  const audio = useAudioDeviceState();
  const settings = config?.config.settings;

  const [radioUrl, setRadioUrl] = useState('');
  const [videoTarget, setVideoTarget] = useState('');
  const [publicUrl, setPublicUrl] = useState('');

  // Keep local fields in step with the server, but don't fight the user's typing.
  useEffect(() => setRadioUrl(settings?.radioUrl ?? ''), [settings?.radioUrl]);
  useEffect(() => setVideoTarget(settings?.videoProxyTarget ?? ''), [settings?.videoProxyTarget]);
  useEffect(() => setPublicUrl(settings?.publicUrl ?? ''), [settings?.publicUrl]);

  if (step === 'interfaces') {
    return (
      <TextField
        size="small"
        label="Trunk interface"
        placeholder="eno1"
        defaultValue={settings?.vlanInterface ?? ''}
        onBlur={e => sendUpdateSetupSettings({ vlanInterface: e.target.value || undefined })}
        helperText="The NIC carrying VLANs 10–60. Saved when you click away; restart pFMS for it to take effect."
        sx={{ maxWidth: 360 }}
      />
    );
  }

  if (step === 'radio') {
    return (
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          label="Radio URL"
          placeholder="http://10.0.100.2"
          value={radioUrl}
          onChange={e => setRadioUrl(e.target.value)}
          sx={{ minWidth: 280 }}
        />
        <Button
          variant="outlined"
          onClick={() => sendUpdateSetupSettings({ radioUrl: radioUrl || undefined })}
          sx={{ mt: 0.25 }}
        >
          Save &amp; re-check
        </Button>
      </Stack>
    );
  }

  if (step === 'audio') {
    return (
      <Stack spacing={1.5}>
        <TextField
          select
          size="small"
          label="Output device"
          value={audio?.selectedDeviceName ?? ''}
          onChange={e => sendSaveAudioDeviceConfig(e.target.value || null)}
          helperText="Where match sounds play at the field"
          sx={{ maxWidth: 420 }}
        >
          <MenuItem value="">
            <em>None — sounds off</em>
          </MenuItem>
          {(audio?.available ?? []).map(device => (
            <MenuItem key={device.name} value={device.name}>
              {device.name}
            </MenuItem>
          ))}
        </TextField>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={sendTestAudioDevice} disabled={!audio?.selectedDeviceName}>
            Play test sound
          </Button>
          <Button
            variant={settings?.audioVerified ? 'outlined' : 'contained'}
            color="success"
            onClick={() => sendUpdateSetupSettings({ audioVerified: !settings?.audioVerified })}
          >
            {settings?.audioVerified ? 'Heard it ✓ (undo)' : 'I heard it'}
          </Button>
        </Stack>
      </Stack>
    );
  }

  if (step === 'scoreboard') {
    const secure = typeof window !== 'undefined' && window.isSecureContext;
    return (
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ pt: '2px' }}>
            <StatusIcon status={secure ? 'pass' : 'warn'} />
          </Box>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              This page&apos;s origin
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {secure
                ? 'Secure — Google Cast will offer your receiver.'
                : 'Not a secure context. Cast needs HTTPS from a real hostname; open the scoreboard over HTTPS to cast it.'}
            </Typography>
          </Box>
        </Box>
        {/* Casting needs a receiver app registered against your own HTTPS URL.
            Plenty of fields won't do that, so the always-works path — type the
            URL into the TV's browser — is offered right here rather than
            buried in docs. */}
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            No Chromecast? Open this on the TV instead
          </Typography>
          <Box
            component="pre"
            sx={{ mt: 0.5, mb: 0.5, px: 1, py: 0.5, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.85rem' }}
          >
            {typeof window !== 'undefined' ? `${window.location.origin}/scores` : '/scores'}
          </Box>
          <Typography variant="caption" color="text.secondary">
            Any smart TV or browser on the field network can display the scoreboard from that address — no casting setup
            required.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" component="a" href="/scores" target="_blank" rel="noopener">
            Open scoreboard
          </Button>
          <Button
            variant={settings?.castVerified ? 'outlined' : 'contained'}
            color="success"
            onClick={() => sendUpdateSetupSettings({ castVerified: !settings?.castVerified })}
          >
            {settings?.castVerified ? 'Cast works ✓ (undo)' : 'Casting works'}
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            size="small"
            label="Video stream (optional)"
            placeholder="http://10.0.0.5:8889"
            value={videoTarget}
            onChange={e => setVideoTarget(e.target.value)}
            sx={{ minWidth: 320 }}
          />
          <Button
            variant="outlined"
            onClick={() => sendUpdateSetupSettings({ videoProxyTarget: videoTarget || undefined })}
            sx={{ mt: 0.25 }}
          >
            Save
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            size="small"
            label="Public address (for the post-match QR code)"
            placeholder="https://pfms.example.org"
            helperText="Where this field is reachable from the internet. Share links and the scoreboard's post-match QR code use it; blank = each screen's own address."
            value={publicUrl}
            onChange={e => setPublicUrl(e.target.value)}
            sx={{ minWidth: 320 }}
          />
          <Button
            variant="outlined"
            onClick={() => sendUpdateSetupSettings({ publicUrl: publicUrl.trim().replace(/\/+$/, '') || undefined })}
            sx={{ mt: 0.25 }}
          >
            Save
          </Button>
        </Stack>
      </Stack>
    );
  }

  if (step === 'deployment') {
    return (
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1}>
          {(['systemd', 'docker'] as const).map(mode => (
            <Button
              key={mode}
              variant={settings?.deploymentMode === mode ? 'contained' : 'outlined'}
              onClick={() => sendUpdateSetupSettings({ deploymentMode: mode })}
            >
              {mode === 'systemd' ? 'systemd service' : 'Docker'}
            </Button>
          ))}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {settings?.deploymentMode === 'docker'
            ? 'Use the Dockerfile and docker-compose.yml in the repo. Both need host networking and NET_ADMIN.'
            : settings?.deploymentMode === 'systemd'
              ? 'Install the unit file, then: sudo systemctl enable --now practice-field-management-system'
              : 'systemd is recommended on a dedicated field host — it is the only mode supporting the graceful reload that keeps robots connected across an update.'}
        </Typography>
        <Button
          variant="text"
          component="a"
          href="https://github.com/TomSawyerLabs/practice-field-management-system/blob/master/docs/deployment.md"
          target="_blank"
          rel="noopener"
        >
          Full instructions: docs/deployment.md
        </Button>
      </Stack>
    );
  }

  return null;
}

function StepCard({ step, isCurrent }: { step: SetupStep; isCurrent: boolean }) {
  const config = useSetupConfig();
  const progress = config?.config.steps[step.id]?.status ?? 'pending';

  return (
    <Card
      sx={{
        mb: 2,
        borderLeft: 4,
        borderColor: `${statusColor[step.status]}.main`,
        opacity: progress === 'skipped' ? 0.65 : 1,
        outline: isCurrent ? 2 : 0,
        outlineColor: 'primary.main',
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
          <StatusIcon status={step.status} />
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            {step.label}
          </Typography>
          {progress === 'done' && <Chip size="small" color="success" label="Done" />}
          {progress === 'skipped' && <Chip size="small" label="Skipped" />}
          {isCurrent && progress === 'pending' && <Chip size="small" color="primary" label="Current" />}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {step.blurb}
        </Typography>

        <Divider sx={{ my: 1 }} />
        {step.checks.map(check => (
          <CheckRow key={check.id} check={check} />
        ))}

        <Box sx={{ mt: 1.5 }}>
          <StepActions step={step.id} />
        </Box>

        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button
            size="small"
            variant="contained"
            onClick={() => sendMarkSetupStep(step.id, progress === 'done' ? 'pending' : 'done')}
          >
            {progress === 'done' ? 'Re-open' : 'Mark done'}
          </Button>
          {progress !== 'skipped' && (
            <Button size="small" onClick={() => sendMarkSetupStep(step.id, 'skipped')}>
              Skip
            </Button>
          )}
          {progress === 'skipped' && (
            <Button size="small" onClick={() => sendMarkSetupStep(step.id, 'pending')}>
              Un-skip
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function SetupPage() {
  const probe = useSetupProbe();
  const config = useSetupConfig();
  const version = useServerVersion();

  if (!probe) {
    return (
      <Box sx={{ maxWidth: 900, mx: 'auto', p: 3 }}>
        <Typography variant="h4" gutterBottom>
          Field Setup
        </Typography>
        <Typography color="text.secondary" gutterBottom>
          Checking this host…
        </Typography>
        <LinearProgress />
      </Box>
    );
  }

  const nextStep = config?.nextStep ?? null;
  const done = probe.steps.filter(s => {
    const status = config?.config.steps[s.id]?.status;
    return status === 'done' || status === 'skipped';
  }).length;

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Field Setup
      </Typography>
      <Typography color="text.secondary">
        Work down the list. Checks re-run every few seconds, so a step turns green as soon as you fix it. Your answers
        are saved — you can stop here and come back.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        pFMS configures the host&apos;s VLAN interfaces, bridges and addresses itself, so most steps are about telling
        it what it&apos;s working with rather than running commands. The trunk interface and radio URL are read at
        startup — restart pFMS after changing them.
      </Typography>

      <Box sx={{ my: 2 }}>
        <LinearProgress variant="determinate" value={(done / probe.steps.length) * 100} />
        <Typography variant="caption" color="text.secondary">
          {done} of {probe.steps.length} steps finished
          {nextStep === null && ' — setup complete'}
        </Typography>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Button variant="outlined" size="small" onClick={sendRequestSetupProbe}>
          Re-check now
        </Button>
        <Button
          variant="text"
          size="small"
          component="a"
          href={buildBugReportUrl({ version, probe })}
          target="_blank"
          rel="noopener"
        >
          Report a pFMS bug
        </Button>
        {probe.dryRun && <Chip size="small" color="warning" label="DRY_RUN — no network changes are being made" />}
        <Chip
          size="small"
          variant="outlined"
          label={`Last checked ${new Date(probe.checkedAt).toLocaleTimeString()}`}
        />
      </Stack>

      {probe.steps.map(step => (
        <StepCard key={step.id} step={step} isCurrent={step.id === nextStep} />
      ))}

      {nextStep === null && (
        <Card sx={{ borderLeft: 4, borderColor: 'success.main' }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Setup complete
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Assign teams to stations from the home page, then run a match from the match control page.
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button variant="contained" component="a" href="/">
                Go to the field
              </Button>
              <Button variant="outlined" component="a" href="/admin">
                Admin
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
