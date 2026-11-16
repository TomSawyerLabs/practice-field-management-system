import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { isLinkableTeam, isStandInTeam } from '../../../src/types';
import { sendLinkTeam, sendUnlinkTeam, useTeamLinkResult, useTeamLinks } from '../hooks/useBackend';

/**
 * Stand-in (99xx) team numbers: a team's extra robot set up as 9940 so other
 * software can tell its network from 5940's. On 9940's page this asks which
 * team the robot is for today, and once linked its videos and data are filed
 * under that team's practice day. The robot's network stays 9940's.
 *
 * On a real team's page, it says which stand-ins are linked to it today.
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
            <Button color="inherit" size="small" onClick={() => sendUnlinkTeam(teamNumber)}>
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
  const standIns = links.links.filter(l => l.team === teamNumber);
  if (standIns.length === 0) return null;
  return (
    <>
      {standIns.map(l => (
        <Alert
          key={l.robotTeam}
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => sendUnlinkTeam(l.robotTeam)}>
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

/** "Which team is this robot for?", and the team's passphrase when it has one. */
function LinkForm({ robotTeam }: { robotTeam: number }) {
  const [teamText, setTeamText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [hidden, setHidden] = useState(false);
  const result = useTeamLinkResult(robotTeam);
  const team = Number(teamText);
  const valid = /^\d+$/.test(teamText) && isLinkableTeam(team);
  // The passphrase field appears once the server says this team has one.
  const needsPassphrase = !!result && !result.ok && result.team === team;

  // A different team number starts over.
  useEffect(() => setPassphrase(''), [teamText]);

  if (hidden) {
    return (
      <Box sx={{ mb: 2 }}>
        <Button size="small" onClick={() => setHidden(false)}>
          Link {robotTeam} to your team
        </Button>
      </Box>
    );
  }

  const submit = () => {
    if (valid) sendLinkTeam(robotTeam, team, needsPassphrase ? passphrase : undefined);
  };

  return (
    <Alert severity="info" sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }} onClose={() => setHidden(true)}>
      <Box sx={{ mb: 1 }}>
        <strong>{robotTeam}</strong> is a spare-robot number. Which team is this robot for today? Its videos and data
        will go on that team&apos;s practice day. Nothing changes on the field: it stays {robotTeam}.
      </Box>
      <Box
        component="form"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
        sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}
      >
        <TextField
          size="small"
          label="Your team number"
          value={teamText}
          onChange={e => setTeamText(e.target.value.trim())}
          error={teamText !== '' && !valid}
          helperText={teamText !== '' && !valid ? 'A team number, not 9900–9999' : undefined}
          slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'off' } }}
          sx={{ width: 170 }}
        />
        {needsPassphrase && (
          <TextField
            size="small"
            type="password"
            label={`Team ${team}'s robot Wi-Fi passphrase`}
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            error={result?.error === 'wrongPassphrase'}
            helperText={
              result?.error === 'wrongPassphrase'
                ? "That isn't one of the team's saved passphrases"
                : `Team ${team} has a saved robot passphrase. Enter it to link.`
            }
            autoFocus
            sx={{ minWidth: 240, flex: 1 }}
          />
        )}
        <Button type="submit" variant="contained" disabled={!valid || (needsPassphrase && passphrase.length < 8)}>
          Link
        </Button>
      </Box>
    </Alert>
  );
}
