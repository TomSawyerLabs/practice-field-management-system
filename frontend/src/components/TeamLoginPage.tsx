import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import LockIcon from '@mui/icons-material/Lock';
import { safeReturnUrl } from '../../../src/teamReturnUrl';
import { TeamLoginForm, useTeamLogin } from './TeamLogin';
import { TeamAvatar } from './TeamAvatar';

/**
 * /login?team=1234&return=<url>: where a locked team's robots send a laptop
 * that isn't let through yet. A laptop that logged in before (its cookie
 * lasts a year) goes straight back without typing anything: loading this page
 * is what lets its new address through.
 */
const BOUNCE_KEY = 'pfms-team-login-bounce';

export function TeamLoginPage() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = Number(params.get('team')) || null;
  const [team, setTeam] = useState<number | null>(fromQuery);

  if (!team) return <AskTeam onTeam={setTeam} />;
  return <LoginForTeam team={team} rawReturn={params.get('return')} />;
}

function AskTeam({ onTeam }: { onTeam: (team: number) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n < 100000) onTeam(n);
  };
  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Card>
        <CardContent>
          <Typography variant="h5" sx={{ mb: 2 }}>
            Team login
          </Typography>
          <Box component="form" onSubmit={submit} sx={{ display: 'flex', gap: 1 }}>
            <TextField
              label="Team number"
              size="small"
              value={value}
              onChange={e => setValue(e.target.value.replace(/\D/g, ''))}
              autoFocus
              inputProps={{ inputMode: 'numeric' }}
            />
            <Button type="submit" variant="contained" disabled={!value}>
              Next
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Container>
  );
}

function LoginForTeam({ team, rawReturn }: { team: number; rawReturn: string | null }) {
  const { status, loadError, act } = useTeamLogin(team);
  const back = useMemo(() => safeReturnUrl(team, rawReturn, window.location.origin), [team, rawReturn]);
  const teamPage = `/${team}`;

  // Logged in (just now, or by the cookie from an earlier visit), or nothing
  // to log in to: on to where the browser was going.
  const done = !!status && (status.loggedIn || !status.passwordSet);
  // If the robot sends this laptop straight back here, the field couldn't let
  // it through (an address it can't see, say). Stop rather than loop.
  const [bounced] = useState(() => {
    try {
      const last = Number(sessionStorage.getItem(BOUNCE_KEY));
      return Date.now() - last < 15_000;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!done || !back || bounced) return;
    try {
      sessionStorage.setItem(BOUNCE_KEY, String(Date.now()));
    } catch {
      // Private mode: no loop guard, but still go.
    }
    window.location.replace(back);
  }, [done, back, bounced]);

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
            <TeamAvatar teamNumber={team} size={40} />
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Team {team}
            </Typography>
            <LockIcon color="action" />
          </Box>

          {loadError && <Alert severity="error">{loadError}</Alert>}
          {!status && !loadError && <CircularProgress size={24} />}

          {status && done && bounced && back && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This laptop is logged in, but the field still isn&apos;t letting it through to {back}. The field sees it
              at {status.address}. Try again in a minute, or ask a field admin. <Link href={back}>Try again</Link>
            </Alert>
          )}

          {status && done && !bounced && (
            <Alert severity="success">
              {status.passwordSet ? 'Logged in.' : `Team ${team} has no password, so there's nothing to log in to.`}{' '}
              {back ? (
                <>
                  Taking you to <Link href={back}>{back}</Link>…
                </>
              ) : (
                <>
                  Go to the <Link href={teamPage}>Team {team} page</Link>.
                </>
              )}
            </Alert>
          )}

          {status && !done && (
            <>
              <Typography variant="body2" sx={{ mb: 2 }}>
                {status.lock
                  ? `Team ${team} only lets its own laptops reach its robots. Log in with the team's password to get through. This laptop stays logged in for a year.`
                  : `Log in with Team ${team}'s password. This device stays logged in for a year.`}
              </Typography>
              <TeamLoginForm team={team} autoFocus onLogin={password => act('login', { password })} />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                Not on Team {team}? This laptop can&apos;t reach Team {team}&apos;s robots. Wrong team?{' '}
                <Link href="/">Find yours</Link>.
              </Typography>
            </>
          )}
        </CardContent>
      </Card>
    </Container>
  );
}
