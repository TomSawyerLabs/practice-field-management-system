import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import type { StationName, CheckResult } from '../../../src/types';
import { useTeamCheckResults, sendRunTeamChecks } from '../hooks/useBackend';
import { StatusIcon } from './TeamChecksPanel';

function CheckRow({ check }: { check: CheckResult }) {
  const failed = check.status === 'fail' || check.status === 'error' || check.status === 'warn';
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        py: 1,
        px: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <StatusIcon status={check.status} size={24} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body1" sx={{ fontWeight: 500 }}>
          {check.name}
        </Typography>
        {check.status === 'pass' && check.actual && (
          <Typography variant="body2" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
            {check.actual}
          </Typography>
        )}
        {failed && (
          <Box>
            {check.expected && check.actual && (
              <Typography variant="body2" sx={{ display: 'block' }}>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  expected{' '}
                </Box>
                <Box component="span" sx={{ fontFamily: 'monospace' }}>
                  {check.expected}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  , got{' '}
                </Box>
                <Box component="span" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                  {check.actual}
                </Box>
              </Typography>
            )}
            {check.message && !check.expected && (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {check.message}
              </Typography>
            )}
            {check.helpUrl && (
              <Link
                href={check.helpUrl}
                target="_blank"
                rel="noopener"
                sx={{ fontSize: '0.9rem', display: 'inline-block', mt: 0.5 }}
              >
                How to fix
              </Link>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function TeamChecksModal({ station }: { station: StationName }) {
  const results = useTeamCheckResults(station);
  const [dismissed, setDismissed] = useState(false);
  // Track which result set was dismissed so new results re-open the modal
  const [dismissedTimestamp, setDismissedTimestamp] = useState<number | null>(null);

  const hasIssues =
    results != null && results.checks.some(c => c.status === 'fail' || c.status === 'warn' || c.status === 'error');
  const allPassed = results != null && results.checks.every(c => c.status === 'pass');

  // Re-open when new results arrive (different timestamp)
  useEffect(() => {
    if (results && results.timestamp !== dismissedTimestamp) {
      setDismissed(false);
    }
  }, [results?.timestamp, dismissedTimestamp]);

  const open = results != null && !dismissed && hasIssues;

  function handleDismiss() {
    setDismissed(true);
    if (results) setDismissedTimestamp(results.timestamp);
  }

  // Nothing to show
  if (!results) return null;

  // All passed — show a brief inline confirmation, not a modal
  if (allPassed) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CheckCircleIcon sx={{ color: 'success.main' }} />
        <Typography variant="body2" sx={{ color: 'success.main' }}>
          All equipment checks passed
        </Typography>
      </Box>
    );
  }

  // Issues found — modal (auto-opened, dismissible)
  return (
    <>
      {/* Collapsed banner when modal is dismissed — click to reopen */}
      {dismissed && hasIssues && (
        <Box
          onClick={() => setDismissed(false)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1,
            py: 0.5,
            cursor: 'pointer',
            borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <WarningIcon sx={{ color: 'warning.main' }} />
          <Typography variant="body2" sx={{ color: 'warning.main' }}>
            Equipment issues detected — tap to review
          </Typography>
        </Box>
      )}

      <Dialog open={open} onClose={handleDismiss} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <WarningIcon sx={{ color: 'warning.main' }} />
            Equipment Check Results
          </Box>
          <Tooltip title="Re-run checks">
            <IconButton onClick={() => sendRunTeamChecks(station)} size="small">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
            Some of your equipment may not be configured correctly for competition use. Please review the issues below.
            You can dismiss this and practice anyway.
          </Typography>
          {results.checks.map((check, i) => (
            <CheckRow key={i} check={check} />
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDismiss} variant="contained">
            Dismiss
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
