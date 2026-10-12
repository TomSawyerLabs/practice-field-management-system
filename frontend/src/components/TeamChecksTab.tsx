import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { StationName, CheckResult, TeamCheckResults } from '../../../src/types';
import { sendRunTeamChecks } from '../hooks/useBackend';
import { StatusIcon } from './TeamChecksPanel';

function isIssue(check: CheckResult) {
  return check.status === 'fail' || check.status === 'warn' || check.status === 'error';
}

/**
 * The colour of the Equipment tab's dot, so a problem shows from any tab:
 * red for a failed check, amber for a warning or a check that couldn't run,
 * green when everything passed. Grey while checks are still running.
 */
export function teamChecksDotColor(results: TeamCheckResults | null): string | null {
  if (!results || results.checks.length === 0) return null;
  if (results.checks.some(c => c.status === 'fail')) return 'error.main';
  if (results.checks.some(isIssue)) return 'warning.main';
  if (results.checks.some(c => c.status === 'pending')) return 'text.disabled';
  return 'success.main';
}

function CheckRow({ check }: { check: CheckResult }) {
  const failed = isIssue(check);
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

/** The Equipment tab: the selected robot's equipment check results, and a re-run button. */
export function TeamChecksTab({ station, results }: { station: StationName; results: TeamCheckResults | null }) {
  const hasIssues = results?.checks.some(isIssue) ?? false;
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="body2" sx={{ flex: 1, color: 'text.secondary' }}>
          {!results
            ? 'Equipment checks run once your Driver Station connects to the field.'
            : hasIssues
              ? 'Some of your equipment may not be configured correctly for competition use. You can still practice.'
              : 'All equipment checks passed.'}
        </Typography>
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => sendRunTeamChecks(station)}>
          Re-run
        </Button>
      </Box>
      {results?.checks.map((check, i) => (
        <CheckRow key={i} check={check} />
      ))}
    </Box>
  );
}
