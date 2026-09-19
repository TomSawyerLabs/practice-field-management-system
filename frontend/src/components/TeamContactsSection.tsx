import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { TeamContactSaveResult, TeamSlackContact } from '../../../src/types';
import {
  sendRemoveTeamContact,
  sendSaveTeamContact,
  useSlackConfigState,
  useTeamContacts,
  useTeamContactSaveResult,
} from '../hooks/useBackend';

/**
 * Admin → Team Slack contacts: who gets each team's practice-video link.
 * A channel (`#team-5940`) or people (`@alice, @bob`), checked against the
 * workspace when saved so a typo is caught here rather than at send time.
 */
export function TeamContactsSection() {
  const contacts = useTeamContacts();
  const slack = useSlackConfigState();
  const [team, setTeam] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TeamContactSaveResult | null>(null);

  useTeamContactSaveResult(
    useCallback((r: TeamContactSaveResult) => {
      setResult(r);
      setBusy(false);
      if (r.ok) {
        setTeam('');
        setTarget('');
      }
    }, []),
  );

  const teamNumber = Number.parseInt(team, 10);
  const valid = Number.isInteger(teamNumber) && teamNumber > 0 && target.trim().length > 0;
  const save = () => {
    if (!valid) return;
    setBusy(true);
    setResult(null);
    sendSaveTeamContact(teamNumber, target.trim());
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h5">Team Slack Contacts</Typography>
          {!slack?.connected && <Chip size="small" color="warning" label="Slack not connected" />}
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          When a team that records practice video is done for the day, the link to their videos is posted here: a
          channel the bot is in (<code>#team-5940</code>) or one or more people as a group DM (<code>@alice, @bob</code>
          ). Teams without a contact get nothing; a note appears in the support channel instead. The bot needs the{' '}
          <code>channels:read</code>, <code>groups:read</code>, <code>users:read</code>, <code>im:write</code> and{' '}
          <code>mpim:write</code> scopes for this.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap', mb: 2 }}>
          <TextField
            size="small"
            label="Team"
            value={team}
            onChange={e => setTeam(e.target.value.replace(/\D/g, ''))}
            sx={{ width: 110 }}
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          />
          <TextField
            size="small"
            label="Channel or people"
            placeholder="#team-5940 or @mentor1, @mentor2"
            value={target}
            onChange={e => setTarget(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') save();
            }}
            sx={{ flex: 1, minWidth: 260 }}
          />
          <Button variant="contained" onClick={save} disabled={!valid || busy || !slack?.connected}>
            {busy ? 'Checking…' : 'Save'}
          </Button>
        </Box>
        {result && !result.ok && (
          <Typography variant="body2" color="error" sx={{ mb: 2 }}>
            Team {result.teamNumber}: {result.error}
          </Typography>
        )}
        {result?.ok && result.contact && (
          <Typography variant="body2" color="success.main" sx={{ mb: 2 }}>
            Team {result.teamNumber} → {describe(result.contact)}
          </Typography>
        )}

        {contacts && contacts.contacts.length > 0 ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {contacts.contacts.map(c => (
              <Box key={c.teamNumber} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography sx={{ fontWeight: 600, minWidth: 70 }}>{c.teamNumber}</Typography>
                <Typography variant="body2">{describe(c)}</Typography>
                <Button size="small" color="inherit" onClick={() => sendRemoveTeamContact(c.teamNumber)}>
                  Remove
                </Button>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No team contacts yet.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function describe(c: TeamSlackContact): string {
  if (c.kind === 'channel') return `#${c.channelName ?? c.channelId}`;
  return `DM with ${(c.users ?? []).map(u => u.name).join(', ')}`;
}
