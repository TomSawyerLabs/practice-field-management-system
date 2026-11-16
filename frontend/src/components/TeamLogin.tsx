import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import LockIcon from '@mui/icons-material/Lock';
import { presentTeamToken, useTeamAuthRejected, useTeamAuthStatus } from '../hooks/useBackend';

/** What GET /api/team-auth/<team> answers (src/teamAuthApi.ts). */
export interface TeamLoginStatus {
  team: number;
  passwordSet: boolean;
  lock: boolean;
  minLength: number;
  lockAvailable: boolean;
  loggedIn: boolean;
  device?: TeamDeviceInfo;
  token?: string;
  devices?: TeamDeviceInfo[];
  address: string;
}

interface TeamDeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  address?: string;
  addressSeenAt?: number;
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function seenText(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return new Date(at).toLocaleDateString();
}

type Result = { ok: true; status: TeamLoginStatus } | { ok: false; error: string };

async function call(team: number, action: string, body: object = {}): Promise<Result> {
  try {
    const res = await fetch(`/api/team-auth/${team}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error ?? `Failed (${res.status})` };
    return { ok: true, status: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A team's login as this browser holds it. Reads the cookie through the API
 * on mount and whenever the team's public status changes, and keeps the
 * page's socket presenting the token so the team's settings work.
 */
export function useTeamLogin(team: number) {
  const [status, setStatus] = useState<TeamLoginStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const publicStatus = useTeamAuthStatus()[team];

  const apply = useCallback(
    (s: TeamLoginStatus) => {
      setStatus(s);
      presentTeamToken(team, s.loggedIn ? (s.token ?? null) : null);
    },
    [team],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/team-auth/${team}`, { credentials: 'same-origin', cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) {
        setLoadError(json.error ?? `Failed (${res.status})`);
        return;
      }
      setLoadError(null);
      apply(json);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [team, apply]);

  // Again whenever anything about the team's login changes anywhere: a
  // password set, a device signed out from /admin, the lock flipped.
  const publicKey = publicStatus ? `${publicStatus.passwordSet}/${publicStatus.lock}/${publicStatus.devices}` : '';
  useEffect(() => {
    void refresh();
  }, [refresh, publicKey]);
  useTeamAuthRejected(team, () => void refresh());

  const act = useCallback(
    async (action: string, body?: object): Promise<string | null> => {
      const r = await call(team, action, body);
      if (!r.ok) return r.error;
      apply(r.status);
      return null;
    },
    [team, apply],
  );

  return { status, loadError, refresh, act };
}

/** The password box, with "Forgot password". */
export function TeamLoginForm({
  team,
  onLogin,
  autoFocus,
}: {
  team: number;
  onLogin: (password: string) => Promise<string | null>;
  autoFocus?: boolean;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await onLogin(password));
    setBusy(false);
  };

  const askAdmin = async () => {
    setForgot('Asking…');
    try {
      const res = await fetch(`/api/team-auth/${team}/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = await res.json();
      if (!res.ok) setForgot(json.error ?? 'Could not reach the field admins');
      else if (json.already) setForgot('The field admins were already told. Find one if nobody has answered.');
      else if (json.slack || json.push > 0)
        setForgot('The field admins have been told. One of them can reset the password; then set a new one here.');
      else setForgot("The field can't message its admins. Find one in person to reset the password.");
    } catch {
      setForgot('Could not reach the field. Find a field admin in person.');
    }
  };

  return (
    <Box component="form" onSubmit={submit}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          type="password"
          label={`Team ${team} password`}
          size="small"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="current-password"
          error={!!error}
          helperText={error ?? ' '}
          sx={{ flexGrow: 1 }}
        />
        <Button type="submit" variant="contained" disabled={busy || !password}>
          Log in
        </Button>
        <Button onClick={askAdmin} disabled={forgot === 'Asking…'}>
          Forgot password
        </Button>
      </Stack>
      {forgot && forgot !== 'Asking…' && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {forgot}
        </Alert>
      )}
    </Box>
  );
}

/** A new password, typed twice. */
function NewPasswordForm({
  minLength,
  label,
  onSave,
}: {
  minLength: number;
  label: string;
  onSave: (password: string) => Promise<string | null>;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = password.length > 0 && password.length < minLength;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const err = await onSave(password);
    setBusy(false);
    setError(err);
    if (!err) {
      setPassword('');
      setConfirm('');
    }
  };

  return (
    <Box component="form" onSubmit={submit}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          type="password"
          label="New password"
          size="small"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="new-password"
          error={tooShort || !!error}
          helperText={tooShort ? `At least ${minLength} characters` : (error ?? ' ')}
          sx={{ flexGrow: 1 }}
        />
        <TextField
          type="password"
          label="Again"
          size="small"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="new-password"
          error={mismatch}
          helperText={mismatch ? "Doesn't match" : ' '}
          sx={{ flexGrow: 1 }}
        />
        <Button
          type="submit"
          variant="contained"
          disabled={busy || password.length < minLength || confirm !== password}
        >
          {label}
        </Button>
      </Stack>
    </Box>
  );
}

/**
 * Above the tabs on a team page whose team has a password, when this browser
 * isn't logged in: the settings won't work until it is. Stops still do.
 */
export function TeamLoginBanner({ team }: { team: number }) {
  const { status, act } = useTeamLogin(team);
  const [open, setOpen] = useState(false);
  if (!status?.passwordSet || status.loggedIn) return null;
  return (
    <Alert
      severity="info"
      icon={<LockIcon />}
      sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}
      action={
        !open && (
          <Button color="inherit" size="small" onClick={() => setOpen(true)}>
            Log in
          </Button>
        )
      }
    >
      Team {team} has a password. Log in on this device to change the team&apos;s Wi-Fi and settings
      {status.lock ? ', and to reach your robots' : ''}. Stop buttons work either way.
      <Collapse in={open}>
        <Box sx={{ mt: 1.5 }}>
          <TeamLoginForm team={team} autoFocus onLogin={password => act('login', { password })} />
        </Box>
      </Collapse>
    </Alert>
  );
}

/** A small "logged in" or "locked" mark beside the team's name. */
export function TeamLoginChip({ team }: { team: number }) {
  const s = useTeamAuthStatus()[team];
  if (!s?.passwordSet) return null;
  return (
    <Chip
      size="small"
      icon={<LockIcon />}
      label={s.lock ? 'Network locked' : 'Password'}
      color={s.lock ? 'primary' : 'default'}
      variant="outlined"
    />
  );
}

/**
 * The team's password, its logged-in devices, and the network lock. On the
 * team page's Network tab. Optional: most teams never set one.
 */
export function TeamPasswordCard({ team }: { team: number }) {
  const { status, loadError, act } = useTeamLogin(team);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);

  if (loadError) {
    return (
      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6">Team password</Typography>
          <Typography variant="body2" color="text.secondary">
            {loadError}
          </Typography>
        </CardContent>
      </Card>
    );
  }
  if (!status) return null;

  const run = async (action: string, body?: object) => {
    const err = await act(action, body);
    setError(err);
    return err;
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LockIcon fontSize="small" /> Team password
        </Typography>

        {!status.passwordSet && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Optional. With a password, only your team&apos;s logged-in devices can change your Wi-Fi and settings here
              {status.lockAvailable ? ", and you can lock your robots' network to your own laptops" : ''}. A device that
              logs in stays logged in for a year after its last visit. Stop buttons never need a password.
            </Typography>
            <NewPasswordForm
              minLength={status.minLength}
              label="Set password"
              onSave={password => run('password', { password })}
            />
          </>
        )}

        {status.passwordSet && !status.loggedIn && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Log in to change Team {team}&apos;s settings from this device
              {status.lock ? ' and reach its robots' : ''}.
            </Typography>
            <TeamLoginForm team={team} onLogin={password => run('login', { password })} />
          </>
        )}

        {status.passwordSet && status.loggedIn && (
          <Stack spacing={2}>
            <Typography variant="body2">
              This device is logged in as Team {team}
              {status.device ? ` (${status.device.name})` : ''}.
            </Typography>

            {(status.lockAvailable || status.lock) && (
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={status.lock}
                      disabled={lockBusy}
                      onChange={async (_, lock) => {
                        setLockBusy(true);
                        await run('lock', { lock });
                        setLockBusy(false);
                      }}
                    />
                  }
                  label="Only our logged-in devices can reach our robots"
                />
                <Typography variant="body2" color="text.secondary">
                  {status.lock
                    ? 'Other laptops are turned away. A laptop that opens a robot web page is sent here to log in first. '
                    : 'Off: anyone at the field can reach your robots, as usual. '}
                  A Driver Station laptop must be logged in too, or it can&apos;t drive, matches included. A logged-in
                  laptop on a new address gets back in by opening this page or any robot web page.
                </Typography>
              </Box>
            )}

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Logged-in devices
              </Typography>
              {(status.devices ?? []).map(d => (
                <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', py: 0.5 }}>
                  <Typography variant="body2" sx={{ flexGrow: 1 }}>
                    {d.name}
                    {d.id === status.device?.id && ' (this device)'}
                    <Typography component="span" variant="body2" color="text.secondary">
                      {' · '}
                      {d.address ?? 'no address'} · seen {seenText(d.lastSeenAt)}
                    </Typography>
                  </Typography>
                  <Button size="small" onClick={() => run('logout', { deviceId: d.id })}>
                    Log out
                  </Button>
                </Box>
              ))}
            </Box>

            <Box>
              {changing ? (
                <NewPasswordForm
                  minLength={status.minLength}
                  label="Change"
                  onSave={async password => {
                    const err = await run('password', { password });
                    if (!err) setChanging(false);
                    return err;
                  }}
                />
              ) : (
                <Button size="small" onClick={() => setChanging(true)}>
                  Change password
                </Button>
              )}
              {changing && (
                <Typography variant="body2" color="text.secondary">
                  Changing it logs out every other device.
                </Typography>
              )}
            </Box>
          </Stack>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
        {status.passwordSet && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            This device is at {status.address}. Forgot the password? A field admin can reset it.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
