import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { AutoUpdatePolicy, SelfUpdateStatus } from '../../../src/types';
import {
  sendSelfUpdateApply,
  sendSelfUpdateCheck,
  sendUpdateSetupSettings,
  useMatchState,
  useSetupConfig,
  useSelfUpdate,
} from '../hooks/useBackend';

const RELEASES_URL = 'https://github.com/TomSawyerLabs/practice-field-management-system/releases';

const MODES: { value: AutoUpdatePolicy['mode']; label: string; help: string }[] = [
  { value: 'off', label: 'Off', help: 'Only when you press Update. Checks only when you press Check.' },
  {
    value: 'notify',
    label: 'Tell me',
    help: 'Checks every hour and shows new builds here. Never installs on its own.',
  },
  {
    value: 'window',
    label: 'Install during a quiet window',
    help: 'Installs new builds inside the daily window, once the field has been idle (no match set up or running).',
  },
  {
    value: 'idle',
    label: 'Install whenever idle',
    help: 'Installs new builds as soon as the field has been idle long enough, any time of day.',
  },
];

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');

/** Release notes are markdown from CI (scripts/release-notes.ts): headings,
 *  bullets and a folded internal list. Shown as plain lines. */
function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes
    .replace(/<\/?details>|<\/?summary>/g, '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l && !l.startsWith('Changes: '));
  return (
    <Box sx={{ pl: 1, borderLeft: 2, borderColor: 'divider', my: 1 }}>
      {lines.map((line, i) =>
        line.startsWith('### ') ? (
          <Typography key={i} variant="subtitle2" sx={{ mt: i ? 1 : 0 }}>
            {line.slice(4)}
          </Typography>
        ) : (
          <Typography key={i} variant="body2" sx={{ color: line.startsWith('- ') ? 'text.primary' : 'text.secondary' }}>
            {line.startsWith('- ') ? `• ${line.slice(2)}` : line}
          </Typography>
        ),
      )}
    </Box>
  );
}

function Activity({ activity }: { activity: SelfUpdateStatus['activity'] }) {
  if (activity.stage === 'idle') return null;
  if (activity.stage === 'downloading') {
    const pct = activity.total ? Math.round((activity.received / activity.total) * 100) : 0;
    return (
      <Box sx={{ my: 1 }}>
        <Typography variant="body2">
          Downloading… {pct}% ({Math.round(activity.received / 1e6)} of {Math.round(activity.total / 1e6)} MB)
        </Typography>
        <LinearProgress variant="determinate" value={pct} />
      </Box>
    );
  }
  const label: Record<string, string> = {
    checking: 'Checking for a new build…',
    verifying: 'Checking the release signature…',
    testing: 'Test-running the download…',
    installing: 'Installing…',
    restarting: 'Restarting into the new build — this page reconnects in a few seconds…',
  };
  return (
    <Box sx={{ my: 1 }}>
      <Typography variant="body2">{label[activity.stage]}</Typography>
      <LinearProgress />
    </Box>
  );
}

function PolicyEditor({ policy }: { policy: AutoUpdatePolicy }) {
  const [start, setStart] = useState(policy.windowStart ?? '03:00');
  const [end, setEnd] = useState(policy.windowEnd ?? '05:00');
  const [idle, setIdle] = useState(String(policy.idleMinutes ?? 30));
  useEffect(() => {
    setStart(policy.windowStart ?? '03:00');
    setEnd(policy.windowEnd ?? '05:00');
    setIdle(String(policy.idleMinutes ?? 30));
  }, [policy.windowStart, policy.windowEnd, policy.idleMinutes]);

  const save = (patch: Partial<AutoUpdatePolicy>) => sendUpdateSetupSettings({ autoUpdate: { ...policy, ...patch } });
  const idleMinutes = Number(idle);
  const idleValid = Number.isInteger(idleMinutes) && idleMinutes >= 0 && idleMinutes <= 1440;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 2 }}>
      <TextField
        select
        size="small"
        label="Automatic updates"
        value={policy.mode}
        onChange={e => save({ mode: e.target.value as AutoUpdatePolicy['mode'] })}
        helperText={MODES.find(m => m.value === policy.mode)?.help}
        sx={{ maxWidth: 420 }}
      >
        {MODES.map(m => (
          <MenuItem key={m.value} value={m.value}>
            {m.label}
          </MenuItem>
        ))}
      </TextField>
      {(policy.mode === 'window' || policy.mode === 'idle') && (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          {policy.mode === 'window' && (
            <>
              <TextField
                size="small"
                type="time"
                label="From"
                value={start}
                onChange={e => setStart(e.target.value)}
                onBlur={() => start !== policy.windowStart && /^\d\d:\d\d$/.test(start) && save({ windowStart: start })}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                size="small"
                type="time"
                label="Until"
                value={end}
                onChange={e => setEnd(e.target.value)}
                onBlur={() => end !== policy.windowEnd && /^\d\d:\d\d$/.test(end) && save({ windowEnd: end })}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </>
          )}
          <TextField
            size="small"
            type="number"
            label="Field idle for (minutes)"
            value={idle}
            error={!idleValid}
            onChange={e => setIdle(e.target.value)}
            onBlur={() => idleValid && idleMinutes !== policy.idleMinutes && save({ idleMinutes })}
            sx={{ width: 200 }}
          />
        </Box>
      )}
    </Box>
  );
}

/** Admin: which pFMS this is, the newest published build, installing it, and
 *  the automatic-update policy (src/updateManager.ts). */
export function SoftwareUpdateSection() {
  const status = useSelfUpdate();
  const setupConfig = useSetupConfig();
  const matchState = useMatchState();
  const [confirm, setConfirm] = useState(false);
  const policy: AutoUpdatePolicy = setupConfig?.config.settings.autoUpdate ?? { mode: 'off' };
  const fieldBusy = (matchState?.phase ?? 'idle') !== 'idle';

  if (!status) return null;
  const busy = status.activity.stage !== 'idle';
  const latest = status.latest;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6">Software update</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Running pFMS <strong>{status.current.version}</strong>
          {status.install === 'checkout'
            ? ' from a git checkout.'
            : status.current.builtAt
              ? `, built ${when(status.current.builtAt)}.`
              : '.'}
        </Typography>

        {status.install === 'checkout' && (
          <Alert severity="info">
            This pFMS runs from a git checkout, so it updates with <code>./update.sh</code> on the host. The single-file
            builds that update themselves are on the{' '}
            <Link href={RELEASES_URL} target="_blank" rel="noreferrer">
              releases page
            </Link>
            .
          </Alert>
        )}
        {status.install === 'unsupported' && (
          <Alert severity="info">No pFMS builds are published for this platform; replace the binary by hand.</Alert>
        )}

        {status.install === 'binary' && (
          <>
            {status.reverted && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                The update to {status.reverted.to} was rolled back to {status.reverted.from} ({when(status.reverted.at)}
                ) because {status.reverted.reason}. Automatic updates skip that build.
              </Alert>
            )}
            {status.lastError && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                The last update attempt ({when(status.lastError.at)}) stopped: {status.lastError.message}
              </Alert>
            )}
            {!status.supervised && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                pFMS isn't running as a service. It restarts itself after an update, but nothing brings it back after a
                crash or a reboot — install the service from the setup wizard's Deployment step.
              </Alert>
            )}

            {latest ? (
              <Box sx={{ mb: 1 }}>
                <Typography variant="body1">
                  pFMS <strong>{latest.version}</strong> is available{' '}
                  <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>
                    (published {when(latest.publishedAt)}
                    {latest.url && (
                      <>
                        ,{' '}
                        <Link href={latest.url} target="_blank" rel="noreferrer">
                          on GitHub
                        </Link>
                      </>
                    )}
                    )
                  </Typography>
                  {status.latestSkipped && (
                    <Chip size="small" color="warning" label="failed here before" sx={{ ml: 1 }} />
                  )}
                </Typography>
                {latest.notes && <ReleaseNotes notes={latest.notes} />}
                {status.autoNote && (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {status.autoNote}.
                  </Typography>
                )}
              </Box>
            ) : (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {status.checkedAt ? `Up to date (checked ${when(status.checkedAt)}).` : 'Not checked yet.'}
              </Typography>
            )}
            {status.checkError && (
              <Typography variant="body2" sx={{ color: 'warning.main', mb: 1 }}>
                Couldn't check for updates: {status.checkError}
              </Typography>
            )}

            <Activity activity={status.activity} />

            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
              <Button variant="outlined" disabled={busy} onClick={sendSelfUpdateCheck}>
                Check now
              </Button>
              <Button variant="contained" disabled={busy || !latest || fieldBusy} onClick={() => setConfirm(true)}>
                {latest ? `Update to ${latest.version}` : 'Update'}
              </Button>
            </Box>
            {latest && fieldBusy && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Updating waits until no match is set up or running.
              </Typography>
            )}
            {status.lastUpdate && (
              <Typography variant="caption" component="div" sx={{ color: 'text.secondary', mt: 1 }}>
                Last updated from {status.lastUpdate.from} to {status.lastUpdate.to} ({when(status.lastUpdate.at)}).
              </Typography>
            )}

            <PolicyEditor policy={policy} />
          </>
        )}
      </CardContent>

      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogTitle>Update pFMS to {latest?.version}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            pFMS downloads the new build, checks its signature, test-runs it, then restarts into it. Every page
            reconnects in a few seconds; network rules are kept, so robots stay on Wi-Fi. If the new build doesn't come
            up, pFMS goes back to {status.current.version} by itself.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              sendSelfUpdateApply();
              setConfirm(false);
            }}
          >
            Update
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
