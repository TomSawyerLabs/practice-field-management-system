import TvIcon from '@mui/icons-material/Tv';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import GlobalStyles from '@mui/material/GlobalStyles';

import { StationName, StationNameList, NetworkStats } from '../../../src/types';
import {
  sendMainDisplayCamera,
  useMainDisplayCamera,
  useMatchState,
  useMdnsActivity,
  useNetworkStats,
  useRoutePreferenceState,
  useSubnetScan,
} from '../hooks/useBackend';
import { MdnsLookupsCard } from './MdnsLookupsCard';
import { PULSE_STYLES, StationNetworkCard } from './StationNetworkCard';
import type { CameraActions } from './HostServiceChips';

function NeighborTableGauge({ stats }: { stats: NetworkStats['neighborTable'] }) {
  if (!stats || stats.limit === 0) return null;
  const pct = Math.round((stats.entries / stats.limit) * 100);
  const color = pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success';
  const top = Object.entries(stats.byInterface)
    .slice(0, 6)
    .map(([dev, n]) => `${dev} ${n}`)
    .join(' · ');
  return (
    <Card variant="outlined" sx={{ mb: 2, p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          ARP table
        </Typography>
        <Chip size="small" color={color} label={`${stats.entries} / ${stats.limit} (${pct}%)`} />
        {stats.overflows > 0 && (
          <Chip size="small" color="error" label={`${stats.overflows} overflow(s) since start`} />
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {top}
        </Typography>
      </Box>
      {pct >= 70 && (
        <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 0.5 }}>
          Above the limit the kernel drops packets to hosts without an entry — robots lose their Driver Stations. The
          device scanner accounts for about 250 entries per configured slot.
        </Typography>
      )}
    </Card>
  );
}

/** Under a watched camera: put it on the scoreboard TVs for everyone, or take it off. */
const mainDisplayButton: CameraActions = ({ station, ip, port }) => (
  <MainDisplayButton station={station} ip={ip} port={port} />
);

function MainDisplayButton({ station, ip, port }: { station: StationName; ip: string; port: number }) {
  const onMain = useMainDisplayCamera();
  const isOnMain = onMain?.station === station && onMain.ip === ip && onMain.port === port;
  return (
    <Button
      size="small"
      variant={isOnMain ? 'contained' : 'outlined'}
      startIcon={<TvIcon />}
      onClick={() => sendMainDisplayCamera(isOnMain ? null : { station, ip, port })}
      sx={{ mt: 0.5 }}
    >
      {isOnMain ? 'Take off the main display' : 'Show on the main display'}
    </Button>
  );
}

/** Says when a robot camera is up on the scoreboard TVs, with a way to take it down. */
function MainDisplayCameraBanner() {
  const camera = useMainDisplayCamera();
  if (!camera) return null;
  return (
    <Alert
      severity="info"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={() => sendMainDisplayCamera(null)}>
          Take it down
        </Button>
      }
    >
      The main display is showing Team {camera.team}'s camera {camera.port}.
    </Alert>
  );
}

export function NetworkPage() {
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const matchState = useMatchState();
  const mdnsActivity = useMdnsActivity();
  const routeState = useRoutePreferenceState();
  const yourIp = routeState?.yourIp;

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <GlobalStyles styles={PULSE_STYLES} />
      <Typography variant="h3" gutterBottom>
        Network Status
      </Typography>
      <MainDisplayCameraBanner />
      <NeighborTableGauge stats={networkStats?.neighborTable} />
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          {StationNameList.slice(0, 3).map(s => (
            <StationNetworkCard
              key={s}
              station={s}
              stats={networkStats?.stations[s]}
              scan={subnetScan?.stations[s]}
              mdns={mdnsActivity?.stations[s]}
              dsInfo={matchState?.connectedStations[s]}
              yourIp={yourIp}
              cameraActions={mainDisplayButton}
            />
          ))}
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          {StationNameList.slice(3).map(s => (
            <StationNetworkCard
              key={s}
              station={s}
              stats={networkStats?.stations[s]}
              scan={subnetScan?.stations[s]}
              mdns={mdnsActivity?.stations[s]}
              dsInfo={matchState?.connectedStations[s]}
              yourIp={yourIp}
              cameraActions={mainDisplayButton}
            />
          ))}
        </Grid>
      </Grid>
      <MdnsLookupsCard />
    </Container>
  );
}
