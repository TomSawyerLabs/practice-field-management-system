import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import GlobalStyles from '@mui/material/GlobalStyles';

import {
  DSConnectionInfo,
  StationMdnsActivity,
  StationName,
  StationNameList,
  StationNetworkStats,
  NetworkStats,
  StationSubnetScan,
} from '../../../src/types';
import { describeIp, formatAge, formatBytes, formatDuration, prettyStationName } from '../../../src/utils';
import {
  useDriveSessionState,
  useMatchState,
  useMdnsActivity,
  useNetworkStats,
  useRoutePreferenceState,
  useSubnetScan,
} from '../hooks/useBackend';
import { HostDisplay } from './HostDisplay';

const PULSE_STYLES = {
  '@keyframes ds-pulse': {
    '0%': { transform: 'scale(1.8)', opacity: 1 },
    '100%': { transform: 'scale(1)', opacity: 0.4 },
  },
} as const;

export function StationNetworkCard({
  station,
  stats,
  scan,
  mdns,
  dsInfo,
  hideStationLabel,
  yourIp,
}: {
  station: StationName;
  stats?: StationNetworkStats;
  scan?: StationSubnetScan;
  mdns?: StationMdnsActivity;
  dsInfo?: DSConnectionInfo;
  /** The current browser client's IP address (for labeling DS IPs with "YOU"). */
  yourIp?: string;
  /** Hide the station name header and alliance-colored border (for team-facing pages). */
  hideStationLabel?: boolean;
}) {
  const team = scan?.team ?? mdns?.team;

  // Blocked-DS info comes from driveSessionState — the authoritative broadcast
  // built from the backend's accepted/blocked maps. matchState's per-station DS
  // entry expires after 20s idle and can't be trusted to carry block info.
  const driveSession = useDriveSessionState();
  const blockedIps = driveSession?.blockedDs?.[station];
  const acceptedDsIp = driveSession?.sessions?.[station]?.dsIp ?? dsInfo?.ip;

  return (
    <Card sx={{ mb: 1.5 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* Header */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            {!hideStationLabel && prettyStationName(station)}
            {!hideStationLabel && team != null && (
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                Team {team}
              </Typography>
            )}
          </Typography>
          {dsInfo && (
            <Chip
              key={dsInfo.lastSeen}
              label={
                <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Box
                    component="span"
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: 'success.main',
                      animation: 'ds-pulse 2s ease-out forwards',
                    }}
                  />
                  DS: <HostDisplay ip={dsInfo.ip} />
                </Box>
              }
              size="small"
              color="info"
              variant="outlined"
              sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
            />
          )}
        </Box>

        {blockedIps && blockedIps.length > 0 && acceptedDsIp && (
          <Alert severity="warning" sx={{ mb: 1, py: 0, fontSize: '0.8rem' }}>
            {blockedIps.length === 1 ? 'Second' : `${blockedIps.length} extra`} DS blocked:{' '}
            <strong>
              {blockedIps.map((ip, i) => (
                <span key={ip}>
                  {i > 0 && ', '}
                  <HostDisplay ip={ip} />
                  {ip === yourIp && ' (YOU)'}
                </span>
              ))}
            </strong>{' '}
            — only <HostDisplay ip={acceptedDsIp} />
            {acceptedDsIp === yourIp && ' (YOU)'} can control this station. Close the other Driver Station
            {blockedIps.length > 1 ? 's' : ''}.
          </Alert>
        )}

        {/* Forwarding Counters */}
        {stats ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1 }}>
            <Box />
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
              Packets
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
              Bytes
            </Typography>

            <Typography variant="body2">From robot</Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {stats.rxPackets.toLocaleString()}
            </Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {formatBytes(stats.rxBytes)}
            </Typography>

            <Typography variant="body2">To robot</Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {stats.txPackets.toLocaleString()}
            </Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {formatBytes(stats.txBytes)}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No forwarding rules
          </Typography>
        )}

        {/* Discovered Devices */}
        {scan && scan.hosts.length > 0 && (
          <>
            <Divider sx={{ my: 1 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Discovered Devices
              </Typography>
              <Chip
                label={`${scan.hosts.filter(h => h.alive).length} / ${scan.hosts.length}`}
                size="small"
                color={scan.hosts.some(h => h.alive) ? 'success' : 'default'}
              />
            </Box>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Host</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Activity</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {scan.hosts.map(host => (
                  <TableRow key={host.ip} sx={{ opacity: host.alive ? 1 : 0.5 }}>
                    <TableCell sx={{ fontFamily: 'monospace', py: 0.5 }}>
                      <HostDisplay ip={host.ip} />
                      {host.source === 'conntrack' && (
                        <Chip
                          label="Guest"
                          size="small"
                          variant="outlined"
                          color="warning"
                          sx={{ ml: 0.75, height: 18, fontSize: '0.6rem' }}
                        />
                      )}
                    </TableCell>
                    <TableCell sx={{ py: 0.5 }}>
                      <Chip
                        label={host.alive ? 'UP' : 'DOWN'}
                        size="small"
                        color={host.alive ? 'success' : 'error'}
                        variant={host.alive ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                    <TableCell sx={{ py: 0.5 }}>{describeIp(host) ?? ''}</TableCell>
                    <TableCell sx={{ py: 0.5, whiteSpace: 'nowrap' }}>
                      {host.alive ? (
                        <Box
                          key={host.lastSeen}
                          component="span"
                          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
                        >
                          <Box
                            component="span"
                            sx={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              backgroundColor: 'success.main',
                              animation: 'ds-pulse 8s ease-out forwards',
                            }}
                          />
                          {formatDuration(host.onlineSince)}
                        </Box>
                      ) : (
                        formatAge(host.lastSeen)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        {/* mDNS Activity */}
        {mdns && (
          <>
            <Divider sx={{ my: 1 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                mDNS Reflector
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                {mdns.queriesForwarded} queries, {mdns.responsesForwarded} responses
              </Typography>
            </Box>
            {mdns.recentNames.length > 0 && (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Resolved IP</TableCell>
                    <TableCell>Requester</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mdns.recentNames.map(entry => (
                    <TableRow key={entry.name}>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', py: 0.5 }}>
                        {entry.services && entry.services.length > 0 ? (
                          <Tooltip title={entry.services.join(', ')} arrow placement="right">
                            <span style={{ cursor: 'help', textDecoration: 'underline dotted' }}>{entry.name}</span>
                          </Tooltip>
                        ) : (
                          entry.name
                        )}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', py: 0.5 }}>
                        {entry.resolvedIp ?? '—'}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', py: 0.5 }}>
                        {entry.requester ? <HostDisplay ip={entry.requester} /> : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Kernel ARP table fill level — the thing that silently black-holed three
 *  robots at the 2026-09-13 scrimmage when it hit its ceiling. */
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
            />
          ))}
        </Grid>
      </Grid>
    </Container>
  );
}
