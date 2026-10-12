import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { StationName } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import { useRoutePreferenceState, useMyDriveStation, sendDrive } from '../hooks/useBackend';
import { useHostname } from './HostDisplay';

function ConflictingTeamCard({
  team,
  stations,
  driving,
}: {
  team: string;
  stations: StationName[];
  /** The station this laptop drives (its drive session), if any */
  driving: StationName | null;
}) {
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
          Team {team}
        </Typography>
        <ButtonGroup variant="outlined" size="large" fullWidth>
          {stations.map(station => {
            const selected = driving === station;
            return (
              <Button
                key={station}
                onClick={() => sendDrive(selected ? null : station)}
                variant={selected ? 'contained' : 'outlined'}
                color={selected ? 'primary' : 'inherit'}
              >
                {prettyStationName(station)}
              </Button>
            );
          })}
        </ButtonGroup>
        {driving && stations.includes(driving) && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Driving:
            </Typography>
            <Chip label={prettyStationName(driving)} size="small" color="primary" />
            <Button size="small" onClick={() => sendDrive(null)} sx={{ ml: 'auto' }}>
              Clear
            </Button>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

export function RoutePage() {
  const state = useRoutePreferenceState();
  const driving = useMyDriveStation();
  const yourHostname = useHostname(state?.yourIp);

  const conflictingTeams = state?.conflictingTeams ?? {};
  const hasConflicts = Object.keys(conflictingTeams).length > 0;

  return (
    <Container maxWidth="sm" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Robot Routing
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        When a team has two robots on the field, choose which one your laptop drives.
      </Typography>

      {state && (
        <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {yourHostname ? 'Your device:' : 'Your IP:'}
          </Typography>
          <Typography variant="body2" fontFamily="monospace">
            {yourHostname ?? state.yourIp}
          </Typography>
          {yourHostname && (
            <Typography variant="body2" color="text.secondary" fontFamily="monospace">
              ({state.yourIp})
            </Typography>
          )}
        </Box>
      )}

      {!state && <Typography color="text.secondary">Connecting...</Typography>}

      {state && !hasConflicts && (
        <Card>
          <CardContent>
            <Typography color="text.secondary">
              No teams are currently on multiple stations. Routing is automatic.
            </Typography>
          </CardContent>
        </Card>
      )}

      {hasConflicts &&
        Object.entries(conflictingTeams).map(([team, stations]) => (
          <ConflictingTeamCard key={team} team={team} stations={stations} driving={driving} />
        ))}
    </Container>
  );
}
