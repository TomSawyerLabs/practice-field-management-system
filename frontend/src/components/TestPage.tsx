import { useState, useEffect, useRef } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import GlobalStyles from '@mui/material/GlobalStyles';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Step from '@mui/material/Step';
import StepContent from '@mui/material/StepContent';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { CheckResult, RobotTestPhase } from '../../../src/types';
import {
  useRobotTestState,
  useFirmwareUpdateProgress,
  useFirmwareStore,
  sendFirmwareUpdateRequest,
  useRadioConfigureProgress,
  sendRadioConfigureRequest,
} from '../hooks/useBackend';
import { StatusIcon } from './TeamChecksPanel';
import {
  CheckResultRow,
  RobotAddresses,
  SettlingBanner,
  controllerFromChecks,
  teamSubnet as subnetOf,
} from './SharedTestComponents';

const PULSE_STYLES = {
  '@keyframes test-pulse': {
    '0%': { transform: 'scale(1.8)', opacity: 1 },
    '100%': { transform: 'scale(1)', opacity: 0.4 },
  },
} as const;

/** Map phase to which stepper step is active (0-indexed). */
function activeStep(phase: RobotTestPhase, isVlan: boolean): number {
  const offset = isVlan ? -1 : 0; // VLAN hides the link step
  switch (phase) {
    case 'disabled':
    case 'link_down':
      return 0;
    case 'link_up':
    case 'dhcp_requesting':
      return 1 + offset;
    case 'ready':
    case 'checking':
    case 'complete':
      return 2 + offset;
  }
}

function PulseDot({ lastUpdate }: { lastUpdate: number }) {
  return (
    <Box
      key={lastUpdate}
      component="span"
      sx={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: 'success.main',
        animation: 'test-pulse 2s ease-out forwards',
        verticalAlign: 'middle',
        mr: 1,
      }}
    />
  );
}

const STARTUP_TIMER_SECONDS = 180; // 3 minutes

function StartupTimer() {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [deadline]);

  if (!deadline) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          Waiting for robot...
        </Typography>
        <Button
          size="small"
          onClick={() => setDeadline(Date.now() + STARTUP_TIMER_SECONDS * 1000)}
          sx={{ textTransform: 'none', fontSize: '0.7rem', py: 0, px: 0.5, minHeight: 0, lineHeight: 1.4 }}
        >
          Just powered on
        </Button>
      </Box>
    );
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const expired = remaining === 0;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant="caption" color={expired ? 'warning.main' : 'text.secondary'}>
        {expired
          ? 'Startup time exceeded — robot should be ready'
          : `Startup: ${mins}:${secs.toString().padStart(2, '0')} remaining`}
      </Typography>
      {expired && (
        <Button
          size="small"
          onClick={() => setDeadline(Date.now() + STARTUP_TIMER_SECONDS * 1000)}
          sx={{ textTransform: 'none', fontSize: '0.7rem', py: 0, px: 0.5, minHeight: 0, lineHeight: 1.4 }}
        >
          Restart
        </Button>
      )}
    </Box>
  );
}

export function TestPage() {
  const state = useRobotTestState();

  if (!state || state.phase === 'disabled') {
    return (
      <Container maxWidth="sm" sx={{ py: 4 }}>
        <Typography variant="h4" gutterBottom>
          Robot Network Tester
        </Typography>
        <Alert severity="info">
          <Typography variant="body2">
            The robot network tester is not configured. Set the <code>TEST_INTERFACE</code> environment variable to a
            dedicated network interface (e.g., <code>eth1</code>) and restart the backend.
          </Typography>
        </Alert>
      </Container>
    );
  }

  const step = activeStep(state.phase, !!state.isVlan);
  const radioChecks = state.checks.filter(
    c => c.name.startsWith('Radio') && c.name !== 'Radio Detected' && c.name !== 'Radio Not Configured',
  );
  // Column 2 holds whichever controller answered: roboRIO checks are named
  // "roboRIO …", a SystemCore's are "Robot Controller" / "SystemCore …".
  const rioChecks = state.checks.filter(
    c => c.name.startsWith('roboRIO') || c.name === 'Robot Controller' || c.name.startsWith('SystemCore'),
  );
  const controller = controllerFromChecks(state.checks);
  const controllerLabel =
    controller === 'systemcore' ? 'SystemCore' : controller === 'roboRIO' ? 'roboRIO' : 'Controller';
  const networkChecks = state.checks.filter(
    c => c.name === 'Radio Detected' || c.name === 'Radio Not Configured' || c.name === 'Team Consistency',
  );
  const firmwareOutdated = radioChecks.some(c => c.name === 'Radio Firmware' && c.status === 'fail');
  const teamSubnet = state.teamNumber ? subnetOf(state.teamNumber) : null;
  const radioTeam = radioChecks.find(c => c.name === 'Radio Team')?.actual;
  const rioTeam = rioChecks.find(c => c.name === 'roboRIO Team')?.actual;
  const dhcpTeamStr = String(state.teamNumber);
  // Only report mismatch when we have sources that actively disagree.
  // Missing sources (radio/RIO unreachable) should not trigger a mismatch.
  const teamsToCompare = [dhcpTeamStr, radioTeam, rioTeam].filter(Boolean) as string[];
  const allTeamsMatch = teamsToCompare.length >= 2 && teamsToCompare.every(t => t === dhcpTeamStr);
  const hasMismatch = teamsToCompare.length >= 2 && !allTeamsMatch;

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <GlobalStyles styles={PULSE_STYLES} />
      <Typography variant="h4" gutterBottom>
        Robot Network Tester
      </Typography>
      {/* Only show interface details for dedicated NICs, not VLANs */}
      {!state.isVlan && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Interface: <code>{state.interfaceName}</code>
          {state.macAddress && (
            <>
              {' — '}
              <code>{state.macAddress}</code>
            </>
          )}
        </Typography>
      )}

      <Stepper activeStep={step} orientation="vertical">
        {/* Step 0: Link — skip entirely for VLANs */}
        {!state.isVlan && (
          <Step completed={state.linkUp}>
            <StepLabel
              error={!state.linkUp}
              optional={
                !state.linkUp ? (
                  <Typography variant="caption" color="text.secondary">
                    No cable detected
                  </Typography>
                ) : undefined
              }
            >
              {state.linkUp ? (
                <>
                  <PulseDot lastUpdate={state.lastUpdate} />
                  Link Connected
                </>
              ) : (
                'Link Status'
              )}
            </StepLabel>
          </Step>
        )}

        {/* Step 1: DHCP */}
        <Step completed={!!state.teamNumber}>
          <StepLabel
            optional={
              state.phase === 'dhcp_requesting' ? (
                <StartupTimer />
              ) : state.teamNumber ? (
                <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                  Team {state.teamNumber} — {state.leasedIp}
                </Typography>
              ) : undefined
            }
          >
            {state.teamNumber ? 'Robot Detected' : 'Waiting for Robot'}
          </StepLabel>
        </Step>

        {/* Step 2: Checks — always render content area to prevent layout shift */}
        <Step completed={state.phase === 'complete'}>
          <StepLabel>
            Robot Checks
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ ml: 1, visibility: state.phase === 'checking' ? 'visible' : 'hidden' }}
            >
              checking...
            </Typography>
          </StepLabel>
          <StepContent TransitionProps={{ unmountOnExit: false }}>
            {state.reconfiguredAt != null && state.reconfigureTimeoutMs != null && (
              <SettlingBanner
                reconfiguredAt={state.reconfiguredAt}
                timeoutMs={state.reconfigureTimeoutMs}
                type={state.reconfigureType}
              />
            )}
            {/* 3-column check layout */}
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1.5, mb: 1 }}>
              {/* Column 1: Radio */}
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}
                >
                  Radio{' '}
                  {teamSubnet && (
                    <Link href={`http://${teamSubnet}.1`} target="_blank" rel="noopener">
                      <code style={{ fontWeight: 400 }}>{teamSubnet}.1</code>
                    </Link>
                  )}
                </Typography>
                {radioChecks
                  .filter(c => c.name !== 'Radio Team')
                  .map((c, i) => (
                    <CheckResultRow key={`radio-${i}`} check={c} />
                  ))}
                {firmwareOutdated && <FirmwareUpdateSection />}
                {radioTeam && (
                  <Box sx={{ mt: 0.5, pt: 0.5, borderTop: 1, borderColor: 'divider' }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: 'monospace',
                        color: radioTeam === String(state.teamNumber) ? 'success.main' : 'error.main',
                      }}
                    >
                      Team: {radioTeam}
                    </Typography>
                  </Box>
                )}
              </Box>

              {/* Column 2: roboRIO */}
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}
                >
                  {controllerLabel}{' '}
                  {teamSubnet && (
                    <Link href={`http://${teamSubnet}.2`} target="_blank" rel="noopener">
                      <code style={{ fontWeight: 400 }}>{teamSubnet}.2</code>
                    </Link>
                  )}
                </Typography>
                {rioChecks
                  .filter(c => c.name !== 'roboRIO Team')
                  .map((c, i) => (
                    <CheckResultRow key={`rio-${i}`} check={c} />
                  ))}
                {rioTeam && (
                  <Box sx={{ mt: 0.5, pt: 0.5, borderTop: 1, borderColor: 'divider' }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: 'monospace',
                        color: rioTeam === String(state.teamNumber) ? 'success.main' : 'error.main',
                      }}
                    >
                      Team: {rioTeam}
                    </Typography>
                  </Box>
                )}
              </Box>

              {/* Column 3: Network */}
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}
                >
                  Network
                </Typography>
                {networkChecks.map((c, i) => (
                  <CheckResultRow key={`net-${i}`} check={c} />
                ))}
                {networkChecks.length === 0 && (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.75rem' }}>
                    No issues
                  </Typography>
                )}
                <Box sx={{ mt: 0.5, pt: 0.5, borderTop: 1, borderColor: 'divider' }}>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'success.main' }}>
                    DHCP: {state.teamNumber}
                  </Typography>
                </Box>
              </Box>
            </Box>

            {state.teamNumber && <RobotAddresses team={state.teamNumber} controller={controller} />}

            {/* Team consistency summary */}
            {(radioTeam || rioTeam) && (
              <Box
                sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pt: 1, borderTop: 1, borderColor: 'divider' }}
              >
                <StatusIcon status={hasMismatch ? 'fail' : 'pass'} />
                <Typography variant="caption">
                  {!hasMismatch ? (
                    <>
                      Team <strong>{state.teamNumber}</strong> — consistent across all devices
                    </>
                  ) : (
                    <>
                      Team mismatch — DHCP: <strong>{state.teamNumber}</strong>
                      {radioTeam && (
                        <>
                          , Radio: <strong>{radioTeam}</strong>
                        </>
                      )}
                      {rioTeam && (
                        <>
                          , roboRIO: <strong>{rioTeam}</strong>
                        </>
                      )}
                    </>
                  )}
                </Typography>
              </Box>
            )}
          </StepContent>
        </Step>
      </Stepper>

      {/* Show settling banner outside the stepper too, in case we're back on the DHCP step */}
      {state.reconfiguredAt != null && state.reconfigureTimeoutMs != null && step < 2 + (state.isVlan ? -1 : 0) && (
        <SettlingBanner
          reconfiguredAt={state.reconfiguredAt}
          timeoutMs={state.reconfigureTimeoutMs}
          type={state.reconfigureType}
        />
      )}

      {state.linkUp && <RadioConfigureSection teamNumber={state.teamNumber} />}

      <FirmwareStatus />
    </Container>
  );
}

function RadioConfigureSection({ teamNumber }: { teamNumber?: number }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [team, setTeam] = useState('');
  const [wpaKey6, setWpaKey6] = useState('');
  const [wpaKey24, setWpaKey24] = useState('');
  const [ssidSuffix, setSsidSuffix] = useState('');
  const suffixRef = useRef<HTMLInputElement>(null);
  const progress = useRadioConfigureProgress();
  const configuring = progress && progress.step !== 'complete' && progress.step !== 'error';

  // Pre-fill team number from DHCP when available
  const openDialog = () => {
    if (teamNumber && !team) setTeam(String(teamNumber));
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    const teamNum = parseInt(team, 10);
    if (!teamNum || teamNum < 1 || teamNum > 25599) return;
    if (!wpaKey6 || wpaKey6.length < 8) return;
    sendRadioConfigureRequest(teamNum, wpaKey6, wpaKey24 || undefined, ssidSuffix || undefined);
    setDialogOpen(false);
  };

  const teamNum = parseInt(team, 10);
  const teamValid = teamNum > 0 && teamNum <= 25599;
  const keyValid = wpaKey6.length >= 8;

  return (
    <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        Radio Configuration
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: '0.8rem' }}>
        Program a radio connected to this interface with a team number and WPA key.
      </Typography>

      {progress && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
              {progress.message}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {Math.round(progress.elapsedMs / 1000)}s
            </Typography>
          </Box>
          <LinearProgress
            variant={configuring ? 'determinate' : undefined}
            value={progress.progress}
            color={progress.step === 'error' ? 'error' : progress.step === 'complete' ? 'success' : 'primary'}
            sx={{ height: 6, borderRadius: 3 }}
          />
          {progress.step === 'error' && (
            <Alert severity="error" sx={{ mt: 1, py: 0, fontSize: '0.8rem' }}>
              {progress.error}
            </Alert>
          )}
          {progress.step === 'complete' && (
            <Alert severity="success" sx={{ mt: 1, py: 0, fontSize: '0.8rem' }}>
              {progress.message}
            </Alert>
          )}
        </Box>
      )}

      <Button
        size="small"
        variant="outlined"
        disabled={!!configuring}
        onClick={openDialog}
        sx={{ textTransform: 'none', fontSize: '0.8rem' }}
      >
        Configure Radio
      </Button>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <form
          onSubmit={e => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <DialogTitle>Configure Team Radio</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Program the radio with a team number and WPA keys. The radio will reboot during configuration (1-2
              minutes).
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
              <TextField
                label="Team Number"
                value={team}
                onChange={e => {
                  const raw = e.target.value;
                  const digits = raw.replace(/\D/g, '');
                  setTeam(digits);
                  // If non-numeric was typed, jump to suffix field with those chars
                  if (digits !== raw) {
                    const nonDigits = raw.replace(/^\d*-?/, '');
                    if (nonDigits) {
                      setSsidSuffix(prev => prev + nonDigits);
                    }
                    suffixRef.current?.focus();
                  }
                }}
                required
                autoFocus
                error={!!team && !teamValid}
                helperText={team && !teamValid ? '1-25599' : undefined}
                margin="dense"
                sx={{ flex: '0 0 120px' }}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
              <Typography sx={{ mt: 2.5, color: 'text.secondary', fontSize: '1.2rem', flexShrink: 0 }}>–</Typography>
              <TextField
                label="Suffix (optional)"
                value={ssidSuffix}
                onChange={e => setSsidSuffix(e.target.value)}
                inputRef={suffixRef}
                margin="dense"
                sx={{ flex: 1 }}
                helperText={`SSID: ${teamValid ? team : '####'}${ssidSuffix ? '-' + ssidSuffix : ''}`}
              />
            </Box>
            <TextField
              label="6 GHz WPA Passphrase"
              value={wpaKey6}
              onChange={e => setWpaKey6(e.target.value)}
              fullWidth
              required
              error={!!wpaKey6 && !keyValid}
              helperText={wpaKey6 && !keyValid ? 'Minimum 8 characters' : undefined}
              margin="dense"
            />
            <TextField
              label="2.4 GHz WPA Passphrase (optional)"
              value={wpaKey24}
              onChange={e => setWpaKey24(e.target.value)}
              fullWidth
              helperText="Leave blank to use the same key as 6 GHz"
              margin="dense"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={!teamValid || !keyValid}>
              Configure Radio
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}

function FirmwareUpdateSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wpaKey, setWpaKey] = useState('');
  const [wpaKey24, setWpaKey24] = useState('');
  const [skipReconfigure, setSkipReconfigure] = useState(false);
  const progress = useFirmwareUpdateProgress();
  const updating = progress && progress.step !== 'complete' && progress.step !== 'error';

  const handleSubmit = () => {
    sendFirmwareUpdateRequest(wpaKey || undefined, wpaKey24 || undefined, skipReconfigure);
    setDialogOpen(false);
  };

  return (
    <Box sx={{ mt: 1 }}>
      {progress && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
              {progress.message}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {Math.round(progress.elapsedMs / 1000)}s
            </Typography>
          </Box>
          <LinearProgress
            variant={updating ? 'determinate' : undefined}
            value={progress.progress}
            color={progress.step === 'error' ? 'error' : progress.step === 'complete' ? 'success' : 'primary'}
            sx={{ height: 6, borderRadius: 3 }}
          />
          {progress.step === 'error' && (
            <Alert severity="error" sx={{ mt: 1, py: 0, fontSize: '0.8rem' }}>
              {progress.error}
            </Alert>
          )}
          {progress.step === 'complete' && (
            <Alert severity="success" sx={{ mt: 1, py: 0, fontSize: '0.8rem' }}>
              {progress.message}
            </Alert>
          )}
        </Box>
      )}
      <Button
        size="small"
        variant="outlined"
        color="warning"
        disabled={!!updating}
        onClick={() => setDialogOpen(true)}
        sx={{ textTransform: 'none', fontSize: '0.8rem' }}
      >
        Update Firmware
      </Button>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <form
          onSubmit={e => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <DialogTitle>Update Radio Firmware</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ mb: 2 }}>
              This will flash the latest firmware to the robot radio. The radio will reboot during the process (2-3
              minutes).
            </Typography>
            {!skipReconfigure && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  The current configuration (team number, SSID suffix) will be re-applied after the update. Enter the
                  WPA passphrase below, or leave blank to auto-detect from the station config.
                </Typography>
                <TextField
                  label="6 GHz WPA Passphrase (optional)"
                  value={wpaKey}
                  onChange={e => setWpaKey(e.target.value)}
                  fullWidth
                  autoFocus
                  helperText="Leave blank to auto-detect from station config"
                  margin="dense"
                />
                <TextField
                  label="2.4 GHz WPA Passphrase (optional)"
                  value={wpaKey24}
                  onChange={e => setWpaKey24(e.target.value)}
                  fullWidth
                  helperText="Leave blank to use the same key as 6 GHz"
                  margin="dense"
                />
              </>
            )}
            <FormControlLabel
              control={
                <Checkbox checked={skipReconfigure} onChange={e => setSkipReconfigure(e.target.checked)} size="small" />
              }
              label={
                <Typography variant="body2" color="text.secondary">
                  Flash firmware only — skip reconfiguration
                </Typography>
              }
              sx={{ mt: 1 }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" color="warning">
              {skipReconfigure ? 'Flash Firmware' : 'Update & Reconfigure'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}

// ── Firmware Status ─────────────────────────────────────────────────

function FirmwareStatus() {
  const entries = useFirmwareStore();
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
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
      setMessage(res.ok ? `Uploaded v${json.entry?.version ?? uploadVersion}` : `Error: ${json.error}`);
    } catch (err) {
      setMessage(`Upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
    }
  };

  // Group entries by version, with columns for pre-1.2 and 1.2.x+
  type FwEntry = (typeof entries)[number];
  const versions = new Map<string, { pre12x?: FwEntry; from12x?: FwEntry }>();
  for (const e of entries) {
    const row = versions.get(e.version) ?? {};
    if (e.upgradeFrom === 'pre12x') row.pre12x = e;
    else row.from12x = e;
    versions.set(e.version, row);
  }
  const allCached = entries.length > 0 && entries.every(e => e.filePath);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const statusDot = (entry?: FwEntry) => {
    if (!entry)
      return (
        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.7rem' }}>
          —
        </Typography>
      );
    const color = entry.filePath
      ? 'success.main'
      : entry.downloading
        ? 'info.main'
        : entry.downloadError
          ? 'error.main'
          : 'warning.main';
    let label = entry.filePath ? 'cached' : entry.downloading ? 'downloading' : 'missing';
    if (entry.downloading && entry.downloadedBytes !== undefined) {
      const progress = entry.totalBytes
        ? `${Math.round((entry.downloadedBytes / entry.totalBytes) * 100)}%`
        : formatBytes(entry.downloadedBytes);
      label = `downloading ${progress}`;
    }
    if (entry.downloadError) label = `failed: ${entry.downloadError}`;
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box
          component="span"
          sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
          {label}
        </Typography>
      </Box>
    );
  };

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        Firmware Store
      </Typography>
      {versions.size > 0 && (
        <Box
          sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '2px 12px', alignItems: 'center', mb: 0.5 }}
        >
          <Box />
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem', fontWeight: 600 }}>
            From 1.2.x+
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem', fontWeight: 600 }}>
            Pre-1.2
          </Typography>
          {[...versions].map(([ver, row]) => (
            <Box key={ver} sx={{ display: 'contents' }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                v{ver}
              </Typography>
              {statusDot(row.from12x)}
              {statusDot(row.pre12x)}
            </Box>
          ))}
        </Box>
      )}
      {!allCached && (
        <Button
          size="small"
          onClick={() => setShowUpload(v => !v)}
          sx={{ mt: 0.5, textTransform: 'none', fontSize: '0.75rem', p: 0 }}
        >
          {showUpload ? 'Hide upload' : 'Upload firmware manually'}
        </Button>
      )}
      {showUpload && (
        <Box
          component="form"
          onSubmit={handleUpload}
          sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}
        >
          <input type="file" accept=".enc,.bin,.img" required disabled={uploading} style={{ fontSize: '0.8rem' }} />
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
            <TextField
              size="small"
              label="Version"
              value={uploadVersion}
              onChange={e => setUploadVersion(e.target.value)}
              required
              sx={{ flex: 1 }}
              slotProps={{ htmlInput: { style: { fontSize: '0.8rem' } } }}
            />
            <TextField
              size="small"
              label="SHA-256"
              value={uploadChecksum}
              onChange={e => setUploadChecksum(e.target.value)}
              required
              sx={{ flex: 2 }}
              slotProps={{ htmlInput: { style: { fontSize: '0.8rem', fontFamily: 'monospace' } } }}
            />
            <select
              value={uploadType}
              onChange={e => setUploadType(e.target.value as 'from12x' | 'pre12x')}
              style={{ fontSize: '0.8rem', padding: '6px' }}
            >
              <option value="from12x">1.2.x+</option>
              <option value="pre12x">Pre-1.2</option>
            </select>
          </Box>
          <Button
            type="submit"
            size="small"
            variant="outlined"
            disabled={uploading}
            sx={{ textTransform: 'none', alignSelf: 'flex-start' }}
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </Button>
        </Box>
      )}
      {message && (
        <Typography
          variant="caption"
          sx={{ mt: 0.5, display: 'block', color: message.startsWith('Error') ? 'error.main' : 'success.main' }}
        >
          {message}
        </Typography>
      )}
    </Box>
  );
}
