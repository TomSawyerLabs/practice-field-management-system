import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import CableIcon from '@mui/icons-material/Cable';
import StopIcon from '@mui/icons-material/Stop';
import BuildIcon from '@mui/icons-material/Build';
import type { StationTestState } from '../../../src/types';
import { StatusIcon } from './TeamChecksPanel';
import { CheckResultRow, RobotAddresses, SettlingBanner, controllerFromChecks } from './SharedTestComponents';

interface InlineTestPortModeProps {
  testState: StationTestState;
  onStop: () => void;
  onConfigureRadio: (teamNumber: number, wpaKey6: string, wpaKey24?: string, ssidSuffix?: string) => void;
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

export function InlineTestPortMode({ testState, onStop, onConfigureRadio }: InlineTestPortModeProps) {
  const { testState: inner, portName, wpaKeyChecks, timeoutRemaining } = testState;
  const { phase, teamNumber, checks, reconfiguredAt, reconfigureTimeoutMs, reconfigureType } = inner;

  const hasMismatch = wpaKeyChecks?.some(c => c.status === 'mismatch');

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
        {(phase === 'dhcp_requesting' || phase === 'checking') && <LinearProgress sx={{ borderRadius: 1 }} />}
      </Box>

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
        <WpaKeyMismatchAlert wpaKeyChecks={wpaKeyChecks!} teamNumber={teamNumber} onFix={onConfigureRadio} />
      )}

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

function WpaKeyMismatchAlert({
  wpaKeyChecks,
  teamNumber,
  onFix,
}: {
  wpaKeyChecks: NonNullable<StationTestState['wpaKeyChecks']>;
  teamNumber?: number;
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
