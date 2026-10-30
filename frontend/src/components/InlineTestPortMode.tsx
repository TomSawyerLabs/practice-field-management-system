import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import CableIcon from '@mui/icons-material/Cable';
import StopIcon from '@mui/icons-material/Stop';
import BuildIcon from '@mui/icons-material/Build';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import type { StationTestState } from '../../../src/types';
import { FirmwareUpdateDialog } from './FirmwareUpdateDialog';
import { StatusIcon } from './TeamChecksPanel';
import { CheckResultRow, RobotAddresses, SettlingBanner, controllerFromChecks } from './SharedTestComponents';

interface InlineTestPortModeProps {
  testState: StationTestState;
  onStop: () => void;
  onConfigureRadio: (teamNumber: number, wpaKey6: string, wpaKey24?: string, ssidSuffix?: string) => void;
  onUpdateFirmware: (wpaKey: string | undefined, wpaKey24: string | undefined, skipReconfigure: boolean) => void;
}

const phaseLabels: Record<string, string> = {
  disabled: 'Disabled',
  link_down: 'Waiting for link...',
  link_up: 'Link detected',
  dhcp_requesting: 'Detecting robot...',
  ready: 'Robot detected',
  checking: 'Running checks...',
  complete: 'Checks complete',
};

export function InlineTestPortMode({ testState, onStop, onConfigureRadio, onUpdateFirmware }: InlineTestPortModeProps) {
  const [firmwareDialogOpen, setFirmwareDialogOpen] = useState(false);
  const { testState: inner, portName, wpaKeyChecks, progress, timeoutRemaining } = testState;
  const { phase, teamNumber, checks, reconfiguredAt, reconfigureTimeoutMs, reconfigureType } = inner;

  const hasMismatch = wpaKeyChecks?.some(c => c.status === 'mismatch');
  const operationRunning = !!progress && progress.step !== 'complete' && progress.step !== 'error';
  const firmwareOutdated = checks.some(c => c.name === 'Radio Firmware' && c.status === 'fail');

  return (
    <Box sx={{ px: 1, py: 1 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <CableIcon fontSize="small" color="warning" />
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            Test Port Mode
          </Typography>
          <Chip label={portName} size="small" variant="outlined" sx={{ ml: 0.5 }} />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {Math.ceil(timeoutRemaining / 60)}m left
          </Typography>
          <Button size="small" variant="outlined" color="error" startIcon={<StopIcon />} onClick={onStop}>
            Exit
          </Button>
        </Box>
      </Box>

      {/* Phase indicator */}
      <Box sx={{ mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {phaseLabels[phase] ?? phase}
          </Typography>
          {teamNumber && <Chip label={`Team ${teamNumber}`} size="small" color="info" variant="outlined" />}
        </Box>
        {(phase === 'dhcp_requesting' || phase === 'checking') && !operationRunning && (
          <LinearProgress sx={{ borderRadius: 1 }} />
        )}
      </Box>

      {/* Radio configure / firmware update progress */}
      {progress && <OperationProgress progress={progress} running={operationRunning} />}

      {/* Settling banner */}
      {reconfiguredAt && reconfigureTimeoutMs && (
        <SettlingBanner
          reconfiguredAt={reconfiguredAt}
          timeoutMs={reconfigureTimeoutMs}
          type={reconfigureType}
          compact
        />
      )}

      {/* WPA key mismatch alert + fix button */}
      {hasMismatch && (
        <WpaKeyMismatchAlert
          wpaKeyChecks={wpaKeyChecks!}
          teamNumber={teamNumber}
          fixDisabled={operationRunning}
          onFix={onConfigureRadio}
        />
      )}

      {/* Outdated firmware: same trigger as the button on /test */}
      {firmwareOutdated && (
        <Button
          size="small"
          variant="outlined"
          color="warning"
          startIcon={<SystemUpdateAltIcon />}
          disabled={operationRunning}
          onClick={() => setFirmwareDialogOpen(true)}
          sx={{ mb: 0.5 }}
        >
          Update Firmware
        </Button>
      )}
      <FirmwareUpdateDialog
        open={firmwareDialogOpen}
        onClose={() => setFirmwareDialogOpen(false)}
        onSubmit={onUpdateFirmware}
      />

      {/* Check results */}
      {checks.length > 0 && (
        <Box sx={{ mt: 0.5 }}>
          {checks.map((check, i) => (
            <CheckResultRow key={i} check={check} compact />
          ))}
        </Box>
      )}
      {teamNumber && <RobotAddresses team={teamNumber} controller={controllerFromChecks(checks)} compact />}

      {/* WPA key check results (when all pass) */}
      {wpaKeyChecks && !hasMismatch && wpaKeyChecks.some(c => c.status === 'pass') && (
        <Box sx={{ mt: 0.5 }}>
          {wpaKeyChecks.map((check, i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25 }}>
              <StatusIcon
                status={check.status === 'pass' ? 'pass' : check.status === 'unknown' ? 'pending' : 'fail'}
                size={16}
              />
              <Typography variant="caption" color="text.secondary">
                {check.message}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function OperationProgress({
  progress,
  running,
}: {
  progress: NonNullable<StationTestState['progress']>;
  running: boolean;
}) {
  const label = progress.type === 'firmwareUpdateProgress' ? 'Firmware update' : 'Radio configuration';

  if (!running) {
    const failed = progress.step === 'error';
    return (
      <Alert severity={failed ? 'error' : 'success'} sx={{ mb: 1, py: 0 }}>
        <Typography variant="caption">
          {failed ? `${label} failed: ${progress.error ?? progress.message}` : progress.message}
        </Typography>
      </Alert>
    );
  }

  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
        <Typography variant="caption">{progress.message}</Typography>
        <Typography variant="caption" color="text.secondary">
          {progress.progress}%
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={progress.progress}
        aria-label={label}
        sx={{ height: 6, borderRadius: 3 }}
      />
    </Box>
  );
}

function WpaKeyMismatchAlert({
  wpaKeyChecks,
  teamNumber,
  fixDisabled,
  onFix,
}: {
  wpaKeyChecks: NonNullable<StationTestState['wpaKeyChecks']>;
  teamNumber?: number;
  fixDisabled: boolean;
  onFix: (teamNumber: number, wpaKey6: string, wpaKey24?: string, ssidSuffix?: string) => void;
}) {
  const mismatched = wpaKeyChecks.filter(c => c.status === 'mismatch');

  return (
    <Alert
      severity="warning"
      sx={{ mb: 1, py: 0.5 }}
      action={
        teamNumber ? (
          <Button
            size="small"
            variant="contained"
            color="warning"
            startIcon={<BuildIcon />}
            disabled={fixDisabled}
            onClick={() => {
              // The fix is initiated by the backend using the station's known config.
              // We send the request with the station's team number — the backend
              // resolves the correct WPA key from the station configuration.
              onFix(teamNumber, '', undefined, undefined);
            }}
          >
            Fix
          </Button>
        ) : undefined
      }
    >
      <Typography variant="body2" sx={{ fontSize: '0.8rem', fontWeight: 500, mb: 0.5 }}>
        Radio configuration mismatch
      </Typography>
      {mismatched.map((check, i) => (
        <Typography key={i} variant="caption" sx={{ display: 'block' }}>
          {check.message}
        </Typography>
      ))}
    </Alert>
  );
}
