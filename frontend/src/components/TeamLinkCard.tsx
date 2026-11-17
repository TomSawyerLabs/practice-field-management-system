import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { isLinkableTeam, isStandInTeam } from '../../../src/types';
import { sendLinkTeam, sendUnlinkTeam, useTeamAuthStatus, useTeamLinks } from '../hooks/useBackend';
import { TeamLoginForm, useTeamLogin } from './TeamLogin';

/**
 * Spare robots on 99xx team numbers: a team's extra robot set up as 9940 so
 * other software can tell its network from 5940's. On 9940's page this asks
 * which team the robot is for today; once linked, its videos and data go on
 * that team's practice day and match pages call it "5940 B". On the field it
 * stays 9940.
 *
 * On a real team's page, it says which spares are linked to it today.
 */
export function TeamLinkCard({ teamNumber }: { teamNumber: number }) {
  const links = useTeamLinks();
  if (!links) return null;
  if (isStandInTeam(teamNumber)) {
    const link = links.links.find(l => l.robotTeam === teamNumber);
    return link ? (
      <Alert
        severity="success"
        sx={{ mb: 2 }}
        action={
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button color="inherit" size="small" href={`/${link.team}`}>
              Team {link.team}
            </Button>
            <Button color="inherit" size="small" onClick={() => sendUnlinkTeam(teamNumber, link.team)}>
              Unlink
            </Button>
          </Box>
        }
      >
        Today this robot is team <strong>{link.team}</strong>&apos;s: its videos and data go on {link.team}&apos;s
        practice day. On the field it is still {teamNumber}.
      </Alert>
    ) : (
      <LinkForm robotTeam={teamNumber} />
    );
  }
  const spares = links.links.filter(l => l.team === teamNumber);
  if (spares.length === 0) return null;
  return (
    <>
      {spares.map(l => (
        <Alert
          key={l.robotTeam}
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => sendUnlinkTeam(l.robotTeam, teamNumber)}>
              Unlink
            </Button>
          }
        >
          Robot <strong>{l.robotTeam}</strong> is yours today: its videos and data are on your practice day.
        </Alert>
      ))}
    </>
  );
}

/** "Which team is this robot for?" */
function LinkForm({ robotTeam }: { robotTeam: number }) {
  const [teamText, setTeamText] = useState('');
  const [hidden, setHidden] = useState(false);
  const auth = useTeamAuthStatus();
  const team = Number(teamText);
  const valid = /^\d+$/.test(teamText) && isLinkableTeam(team);

  if (hidden) {
    return (
      <Box sx={{ mb: 2 }}>
        <Button size="small" onClick={() => setHidden(false)}>
          Link {robotTeam} to your team
        </Button>
      </Box>
    );
  }

  return (
    <Alert severity="info" sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }} onClose={() => setHidden(true)}>
      <Box sx={{ mb: 1 }}>
        <strong>{robotTeam}</strong> is a spare-robot number. Which team is this robot for today? Its videos and data
        will go on that team&apos;s practice day. Nothing changes on the field: it stays {robotTeam}.
      </Box>
      <TextField
        size="small"
        label="Your team number"
        value={teamText}
        onChange={e => setTeamText(e.target.value.trim())}
        error={teamText !== '' && !valid}
        helperText={teamText !== '' && !valid ? 'A team number, not 9900–9999' : undefined}
        slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'off' } }}
        sx={{ width: 170, mr: 1 }}
      />
      {valid && auth[team]?.passwordSet ? (
        // Keyed by team, so a different number starts its own login.
        <LinkWithLogin key={team} robotTeam={robotTeam} team={team} />
      ) : (
        <Button variant="contained" disabled={!valid} onClick={() => sendLinkTeam(robotTeam, team)}>
          Link
        </Button>
      )}
    </Alert>
  );
}

/** The real team has a password: this device logs in as it first. */
function LinkWithLogin({ robotTeam, team }: { robotTeam: number; team: number }) {
  const { status, act } = useTeamLogin(team);
  if (!status) return null;
  if (status.loggedIn) {
    return (
      <Button variant="contained" onClick={() => sendLinkTeam(robotTeam, team)}>
        Link
      </Button>
    );
  }
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        Team {team} has a password. Log in as {team} on this device to link this robot.
      </Typography>
      <TeamLoginForm team={team} onLogin={password => act('login', { password })} />
    </Box>
  );
}
