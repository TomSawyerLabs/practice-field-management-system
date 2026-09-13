import { useState, useRef } from 'react';
import { TeamAvatar } from './TeamAvatar';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import TextField from '@mui/material/TextField';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import SettingsIcon from '@mui/icons-material/Settings';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import TableHead from '@mui/material/TableHead';
import { StationName, SavedWiFiSetting } from '../../../src/types';
import {
  useLatest,
  useMatchState,
  sendNewConfig,
  sendInternetToggle,
  useUpdateCallback,
  useLatestTelemetry,
  useTelemetryCallback,
  useNetworkStats,
  useSubnetScan,
  useMdnsActivity,
  useRoutePreferenceState,
  useDriveSessionState,
  sendDrive,
  useLastLinked,
  usePortBridgeState,
  useStationTestState,
  sendStationTestModeRequest,
  sendStationTestModeStop,
  sendStationRadioConfigureRequest,
} from '../hooks/useBackend';
import { MatchPanel } from './MatchPanel';
import { StationNetworkCard } from './NetworkPage';
import { useSavedWiFiSettings } from '../hooks/useSavedWiFiSettings';
import { useBackendStagedChanges } from '../hooks/useBackend';
import { TimeDisplay } from './TimeDisplay';
import { describeIp, formatAge, formatBytes, prettyStationName } from '../../../src/utils';
import { Alert, Box, FormControlLabel, Switch, Tooltip, useMediaQuery, useTheme } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { CopyToClipboard } from './CopyToClipboard';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ClearIcon from '@mui/icons-material/Clear';
import PublicIcon from '@mui/icons-material/Public';
import PublicOffIcon from '@mui/icons-material/PublicOff';
import { StationChart, GroupedChart, handleStatusUpdate, handleTelemetryUpdate } from './StationChart';
import { TeamChecksPanel } from './TeamChecksPanel';
import { WaitingForRobot } from './WaitingForRobot';
import { InlineTestPortMode } from './InlineTestPortMode';
import Chip from '@mui/material/Chip';
import { HostDisplay, useHostname } from './HostDisplay';

// Helper function to format numbers with thin space as thousands separator
function formatNumberWithThinSpace(num: number | undefined): string {
  if (num === undefined) return '';
  return num.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

/** Banner shown when this station's team is also assigned to other stations. */
function RoutePreferenceBanner({ station }: { station: StationName }) {
  const routeState = useRoutePreferenceState();
  if (!routeState) return null;

  // Find conflicting teams that include this station
  const myConflicts = Object.entries(routeState.conflictingTeams).filter(([, stations]) => stations.includes(station));
  if (myConflicts.length === 0) return null;

  const isSelected = routeState.preference === station;
  const otherSelected = routeState.preference !== null && routeState.preference !== station;

  return (
    <Box sx={{ mb: 1 }}>
      {myConflicts.map(([team, stations]) => (
        <Box
          key={team}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 1,
            borderRadius: 1,
            backgroundColor: isSelected ? 'success.main' : otherSelected ? 'warning.main' : 'info.main',
            color: 'white',
          }}
        >
          <TeamAvatar teamNumber={parseInt(team, 10) || null} size={20} />
          <Typography variant="body2" sx={{ flex: 1 }}>
            Team {team} is on {stations.length} stations
            {otherSelected && ` (driving ${prettyStationName(routeState.preference!)})`}
          </Typography>
          <Button
            size="small"
            variant="contained"
            color={isSelected ? 'inherit' : 'primary'}
            onClick={() => sendDrive(isSelected ? null : station)}
            sx={isSelected ? { color: 'success.main' } : {}}
          >
            {isSelected ? 'Stop driving' : 'Drive this robot'}
          </Button>
        </Box>
      ))}
    </Box>
  );
}

export function StationStatus({ station, full }: { station: StationName; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ssid, setSsid] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [internetAccess, setInternetAccess] = useState(false);
  const [showPassphrases, setShowPassphrases] = useState(false);
  const [chartMode, setChartMode] = useState(full ?? false);
  const ssidInputRef = useRef<HTMLInputElement | null>(null);

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const latest = useLatest();
  const matchState = useMatchState();
  const routeState = useRoutePreferenceState();
  const driveSession = useDriveSessionState();
  const yourIp = routeState?.yourIp;
  const dsHostname = useHostname(driveSession?.sessions?.[station]?.dsIp);
  const { recentSettings, saveSetting, clearSettings, removeSetting } = useSavedWiFiSettings();
  const stagedChanges = useBackendStagedChanges();
  const hasStagedChange = (s: StationName) => s in stagedChanges;

  // Always register the chart data collection handler, even if charts aren't visible
  // This ensures chart data is collected from page load, not just when charts are first shown
  useUpdateCallback(handleStatusUpdate);
  useTelemetryCallback(handleTelemetryUpdate);

  const telemetry = useLatestTelemetry(station);
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const mdnsActivity = useMdnsActivity();
  const lastLinked = useLastLinked();
  const portBridgeState = usePortBridgeState();
  const stationTestState = useStationTestState(station);

  const {
    ssid: stationSsid,
    hashedWpaKey,
    isLinked,
    macAddress,
    dataAgeMs,
    signalDbm,
    noiseDbm,
    signalNoiseRatio,
    rxRateMbps,
    rxPackets,
    rxBytes,
    txRateMbps,
    txPackets,
    txBytes,
    bandwidthUsedMbps,
    connectionQuality,
  } = latest?.radioUpdate?.stationStatuses[station] || {};

  const handleOpen = () => {
    setSsid(stationSsid || '');
    setPassphrase('');
    setInternetAccess(false);
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleSave = (stage: boolean) => {
    // Always send to backend — stage=true stores in pendingChanges without committing
    sendNewConfig(station, ssid, passphrase, stage);

    // Auto-save to recent settings if valid
    if (ssid.trim() && passphrase.trim()) {
      saveSetting(ssid, passphrase);
    }

    setOpen(false);
  };

  const handleApplySetting = (setting: SavedWiFiSetting) => {
    setSsid(setting.ssid);
    setPassphrase(setting.wpaKey);
  };

  const handleRemoveSetting = (e: React.MouseEvent, setting: SavedWiFiSetting) => {
    e.stopPropagation(); // Prevent row click
    removeSetting(setting.ssid, setting.wpaKey);
  };

  const handleClearStation = () => {
    // Only clear if the station is actually configured
    if (stationSsid || hasStagedChange(station)) {
      // Stage the clear on the backend — committed when user clicks Apply
      sendNewConfig(station, '', '', true);
    }
  };

  const ssidRegex = /^[a-zA-Z0-9-]{0,14}$/;
  const ssidFormatRegex = /^\d{1,6}(?:-.*)?$/; // FIRST SSID format
  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;

  const isSSIDEmpty = ssid === '';
  const isSaveEnabled: boolean =
    isSSIDEmpty || (passphraseRegex.test(passphrase) && ssidRegex.test(ssid) && ssidFormatRegex.test(ssid));

  const pretty = prettyStationName(station);

  const modalStyle = {
    minHeight: '5em',
    minWidth: isMobile ? undefined : '30em',
    maxWidth: '100%',
  };

  return (
    <>
      {full && <MatchPanel station={station} />}
      <RoutePreferenceBanner station={station} />
      {/* Drive session info: DS IP, blocked DSes, timeout countdown */}
      {(() => {
        const session = driveSession?.sessions?.[station];
        const blocked = driveSession?.blockedDs?.[station];
        const isYouBlocked = blocked?.includes(yourIp ?? '');
        const isSessionStale = session && session.timeoutRemaining < 20;

        // Prominent banner when YOUR browser IP is a blocked DS for this station
        if (isYouBlocked && session) {
          return (
            <Alert
              severity="warning"
              sx={{ mb: 1, fontWeight: 700, fontSize: '1.1rem', '& .MuiAlert-icon': { fontSize: '1.5rem' } }}
            >
              YOUR DRIVER STATION IS BLOCKED
              <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 400 }}>
                Another DS (
                <strong>
                  <HostDisplay ip={session.dsIp} />
                </strong>
                ) is active on this station.
                {isSessionStale
                  ? ` It will time out in ${session.timeoutRemaining}s.`
                  : ' Close the other DS to take over (~20s timeout).'}
              </Typography>
            </Alert>
          );
        }

        // Multiple DS alert (duplicate detection)
        if (blocked && blocked.length > 0 && session) {
          return (
            <Alert
              severity="error"
              sx={{ mb: 1, fontWeight: 700, fontSize: '1.1rem', '& .MuiAlert-icon': { fontSize: '1.5rem' } }}
            >
              MULTIPLE DRIVER STATIONS DETECTED
              <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5, fontSize: '0.9rem', fontWeight: 400 }}>
                <li>
                  <strong>
                    <HostDisplay ip={session.dsIp} />
                  </strong>
                  {session.dsIp === yourIp && (
                    <Chip label="YOU" size="small" color="info" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />
                  )}
                  {' — active'}
                </li>
                {blocked.map(ip => (
                  <li key={ip}>
                    <strong>
                      <HostDisplay ip={ip} />
                    </strong>
                    {ip === yourIp && (
                      <Chip label="YOU" size="small" color="error" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />
                    )}
                    {' — blocked'}
                  </li>
                ))}
              </Box>
              <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 400 }}>
                Close the extra Driver Station{blocked.length > 1 ? 's' : ''}.
              </Typography>
            </Alert>
          );
        }

        return null;
      })()}
      <Card
        style={{
          marginBottom: full ? undefined : '1rem',
          height: full ? undefined : '22em',
        }}
      >
        <CardContent sx={full ? { height: '100%', display: 'flex', flexDirection: 'column' } : {}}>
          <Typography variant="h5" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              {pretty}
              <SSIDDisplay ssid={stationSsid} hashedWpaKey={hashedWpaKey} />
              {hasStagedChange(station) && (
                <>
                  <span style={{ userSelect: 'none' }}> → </span>
                  {stagedChanges[station]?.ssid ? (
                    <SSIDDisplay ssid={stagedChanges[station]?.ssid} secure={stagedChanges[station]?.secured} />
                  ) : (
                    <Chip label="(clear)" size="small" variant="outlined" color="warning" sx={{ height: 20 }} />
                  )}
                </>
              )}
              {/* DS IP indicator */}
              {driveSession?.sessions?.[station] && (
                <Tooltip
                  title={`Driver Station: ${driveSession.sessions[station]!.dsIp}${driveSession.sessions[station]!.timeoutRemaining < 20 ? ` (timeout in ${driveSession.sessions[station]!.timeoutRemaining}s)` : ''}`}
                >
                  <Chip
                    label={`DS ${dsHostname ?? driveSession.sessions[station]!.dsIp}`}
                    size="small"
                    variant="outlined"
                    color={driveSession.sessions[station]!.timeoutRemaining < 20 ? 'warning' : 'success'}
                    sx={{ height: 20, fontSize: '0.65rem', ml: 1 }}
                  />
                </Tooltip>
              )}
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {/** CLEAR BUTTON */}
              {(stationSsid || hasStagedChange(station)) && (
                <Tooltip title="Clear station configuration">
                  <IconButton
                    onClick={handleClearStation}
                    size="small"
                    sx={{
                      color: 'text.secondary',
                      '&:hover': {
                        color: 'error.main',
                        backgroundColor: 'error.light',
                      },
                    }}
                  >
                    <ClearIcon />
                  </IconButton>
                </Tooltip>
              )}
              {/** INTERNET TOGGLE BUTTON - only show if station is configured */}
              {stationSsid && (
                <Tooltip title={internetAccess ? 'Disable internet access' : 'Enable internet access'}>
                  <IconButton
                    onClick={() => {
                      const next = !internetAccess;
                      setInternetAccess(next);
                      sendInternetToggle(station, next);
                    }}
                    size="small"
                    sx={{
                      color: internetAccess ? 'success.main' : 'text.secondary',
                      '&:hover': {
                        color: internetAccess ? 'success.dark' : 'success.main',
                        backgroundColor: 'action.hover',
                      },
                    }}
                  >
                    {internetAccess ? <PublicIcon /> : <PublicOffIcon />}
                  </IconButton>
                </Tooltip>
              )}
              {/** CHART TOGGLE BUTTON - only show if station is configured */}
              {stationSsid && (
                <Tooltip title={chartMode ? 'Show table view' : 'Show live charts'}>
                  <IconButton
                    onClick={() => setChartMode(!chartMode)}
                    size="small"
                    sx={{
                      color: chartMode ? 'primary.main' : 'text.secondary',
                      backgroundColor: chartMode ? 'primary.light' : 'transparent',
                      '&:hover': {
                        backgroundColor: chartMode ? 'primary.main' : 'action.hover',
                        color: chartMode ? 'primary.contrastText' : 'text.primary',
                      },
                    }}
                  >
                    <ShowChartIcon />
                  </IconButton>
                </Tooltip>
              )}
              {/** SETTINGS BUTTON */}
              <IconButton onClick={handleOpen} size="small">
                <SettingsIcon />
              </IconButton>
            </Box>
          </Typography>

          {stationSsid || hasStagedChange(station) ? (
            <>
              {stationSsid &&
                (isLinked ? (
                  <CopyToClipboard text={macAddress || ''} tooltipText="Click to copy MAC address">
                    <Typography
                      variant="body2"
                      sx={{
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        color: 'text.secondary',
                        marginBottom: 0.5,
                        cursor: 'pointer',
                        textAlign: 'center',
                        paddingX: 0.5,
                        paddingY: 0.25,
                        borderRadius: 0.5,
                        '&:hover': {
                          color: 'text.primary',
                          backgroundColor: 'action.hover',
                        },
                        transition: 'all 0.2s',
                      }}
                    >
                      {macAddress}
                    </Typography>
                  </CopyToClipboard>
                ) : (
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                      fontStyle: 'italic',
                      color: 'warning.main',
                      marginBottom: 0.5,
                      textAlign: 'center',
                      paddingX: 0.5,
                      paddingY: 0.25,
                    }}
                  >
                    not linked
                  </Typography>
                ))}
              {stationTestState ? (
                <InlineTestPortMode
                  testState={stationTestState}
                  onStop={() => sendStationTestModeStop(station)}
                  onConfigureRadio={(teamNumber, wpaKey6, wpaKey24, ssidSuffix) =>
                    sendStationRadioConfigureRequest(station, teamNumber, wpaKey6, wpaKey24, ssidSuffix)
                  }
                />
              ) : stationSsid && !isLinked ? (
                <WaitingForRobot
                  stationSsid={stationSsid}
                  lastLinkedTimestamp={lastLinked[station]}
                  portBridgeState={portBridgeState}
                  onStartTestPortMode={portVlanId => sendStationTestModeRequest(station, portVlanId)}
                />
              ) : chartMode && stationSsid ? (
                <Box
                  sx={{
                    overflowY: 'auto',
                    ...(full ? { flex: 1, minHeight: 0 } : { height: 'calc(22em - 95px + 5px)' }),
                  }}
                >
                  {full ? (
                    <>
                      {/* Full view: show all charts separately */}
                      <StationChart station={station} metric="signalLevels" height="60px" />
                      <StationChart station={station} metric="snr" height="60px" />
                      <StationChart station={station} metric="rates" height="60px" />
                      <StationChart station={station} metric="packets" height="60px" />
                      <StationChart station={station} metric="bytes" height="60px" />
                      <StationChart station={station} metric="bandwidth" height="60px" />
                      <StationChart station={station} metric="dataAge" height="60px" />
                      <StationChart station={station} metric="quality" height="60px" />
                      <StationChart station={station} metric="batteryVoltage" height="60px" />
                      <StationChart station={station} metric="dsCpuPercent" height="60px" />
                      <StationChart station={station} metric="robotStatus" height="60px" />
                    </>
                  ) : (
                    <>
                      {/* Non-full view: use grouped charts */}
                      <GroupedChart
                        station={station}
                        metrics={['snr', 'signalLevels']}
                        height="60px"
                        defaultMetricIndex={0}
                        marginBottom={0.5}
                      />
                      <GroupedChart
                        station={station}
                        metrics={['rates', 'packets', 'bytes']}
                        height="60px"
                        defaultMetricIndex={0}
                        marginBottom={0.5}
                      />
                      <GroupedChart
                        station={station}
                        metrics={['quality', 'bandwidth', 'dataAge']}
                        height="60px"
                        defaultMetricIndex={0}
                        marginBottom={0.5}
                      />
                      <GroupedChart
                        station={station}
                        metrics={['batteryVoltage', 'dsCpuPercent', 'robotStatus']}
                        height="60px"
                        defaultMetricIndex={0}
                        marginBottom={0.5}
                      />
                    </>
                  )}
                </Box>
              ) : (
                <>
                  {stationSsid && isLinked && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 0.5 }}>
                      {/* Signal Levels Group */}
                      <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ textAlign: 'right' }}>Signal</TableCell>
                            <TableCell sx={{ textAlign: 'right' }}>Noise</TableCell>
                            <TableCell sx={{ textAlign: 'right' }}>SNR</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          <TableRow>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.light', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(signalDbm)} dBm
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.light', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(noiseDbm)} dBm
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(signalNoiseRatio)} dB
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>

                      {/* Connection Quality, Bandwidth, and Data Age Group */}
                      <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                        <TableHead>
                          <TableRow>
                            <TableCell>Quality</TableCell>
                            <TableCell sx={{ textAlign: 'right' }}>Used</TableCell>
                            <TableCell sx={{ textAlign: 'right' }}>of Available</TableCell>
                            <TableCell sx={{ textAlign: 'right' }}>Data Age</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          <TableRow>
                            <TableCell
                              sx={{
                                color:
                                  connectionQuality === 'excellent'
                                    ? 'success.main'
                                    : connectionQuality === 'good'
                                      ? 'success.light'
                                      : connectionQuality === 'caution'
                                        ? 'warning.main'
                                        : connectionQuality === 'warning'
                                          ? 'error.main'
                                          : 'text.disabled',
                              }}
                            >
                              {connectionQuality}
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(bandwidthUsedMbps)} Mbps
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(
                                (bandwidthUsedMbps! / Math.min(rxRateMbps!, txRateMbps!)) * 100,
                              )}
                              %
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'warning.light', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(dataAgeMs)} ms
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>

                      {/* TX/RX Group */}
                      <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                        <TableHead>
                          <TableRow>
                            <TableCell></TableCell>
                            <Tooltip title="To robot">
                              <TableCell sx={{ textAlign: 'right' }}>TX</TableCell>
                            </Tooltip>
                            <Tooltip title="From robot">
                              <TableCell sx={{ textAlign: 'right' }}>RX</TableCell>
                            </Tooltip>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          <TableRow>
                            <TableCell>Rate</TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(txRateMbps)} Mbps
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.main', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(rxRateMbps)} Mbps
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Packets</TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(txPackets)}
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.main', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(rxPackets)}
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Bytes</TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(txBytes)}
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.main', textAlign: 'right' }}>
                              {formatNumberWithThinSpace(rxBytes)}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>

                      {/* IP Forwarding Counters (iptables FORWARD rules) */}
                      {networkStats?.stations[station] &&
                        (() => {
                          const fwd = networkStats.stations[station]!;
                          return (
                            <Table
                              size="small"
                              sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}
                            >
                              <TableHead>
                                <TableRow>
                                  <TableCell>IP Forwarding</TableCell>
                                  <Tooltip title="Packet count">
                                    <TableCell sx={{ textAlign: 'right' }}>Packets</TableCell>
                                  </Tooltip>
                                  <Tooltip title="Byte count">
                                    <TableCell sx={{ textAlign: 'right' }}>Bytes</TableCell>
                                  </Tooltip>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                <TableRow>
                                  <TableCell>From robot</TableCell>
                                  <TableCell
                                    sx={{
                                      whiteSpace: 'nowrap',
                                      color: 'error.main',
                                      textAlign: 'right',
                                      fontFamily: 'monospace',
                                    }}
                                  >
                                    {fwd.rxPackets.toLocaleString()}
                                  </TableCell>
                                  <TableCell
                                    sx={{
                                      whiteSpace: 'nowrap',
                                      color: 'error.main',
                                      textAlign: 'right',
                                      fontFamily: 'monospace',
                                    }}
                                  >
                                    {formatBytes(fwd.rxBytes)}
                                  </TableCell>
                                </TableRow>
                                <TableRow>
                                  <TableCell>To robot</TableCell>
                                  <TableCell
                                    sx={{
                                      whiteSpace: 'nowrap',
                                      color: 'success.main',
                                      textAlign: 'right',
                                      fontFamily: 'monospace',
                                    }}
                                  >
                                    {fwd.txPackets.toLocaleString()}
                                  </TableCell>
                                  <TableCell
                                    sx={{
                                      whiteSpace: 'nowrap',
                                      color: 'success.main',
                                      textAlign: 'right',
                                      fontFamily: 'monospace',
                                    }}
                                  >
                                    {formatBytes(fwd.txBytes)}
                                  </TableCell>
                                </TableRow>
                              </TableBody>
                            </Table>
                          );
                        })()}

                      {/* Robot Telemetry Group (only shown when telemetry data exists) */}
                      {telemetry && (
                        <>
                          <Table
                            size="small"
                            sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}
                          >
                            <TableHead>
                              <TableRow>
                                <TableCell sx={{ textAlign: 'right' }}>Battery</TableCell>
                                <TableCell sx={{ textAlign: 'right' }}>RTT</TableCell>
                                <TableCell sx={{ textAlign: 'right' }}>Lost Pkts</TableCell>
                                <TableCell sx={{ textAlign: 'right' }}>CAN</TableCell>
                                <TableCell sx={{ textAlign: 'right' }}>DS CPU</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              <TableRow>
                                <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                                  {telemetry.batteryVoltage !== undefined
                                    ? `${telemetry.batteryVoltage.toFixed(1)} V`
                                    : '—'}
                                </TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                                  {telemetry.rttMs !== undefined ? `${telemetry.rttMs} ms` : '—'}
                                </TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                                  {telemetry.lostPackets !== undefined ? telemetry.lostPackets : '—'}
                                </TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                                  {telemetry.canUtil !== undefined ? `${telemetry.canUtil}%` : '—'}
                                </TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                                  {telemetry.dsCpuPercent !== undefined ? `${telemetry.dsCpuPercent}%` : '—'}
                                </TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>

                          {/* Status Chips */}
                          {telemetry.dsStatus && (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                              <Chip
                                label={
                                  telemetry.dsStatus.mode === 'teleOp'
                                    ? 'TeleOp'
                                    : telemetry.dsStatus.mode === 'auto'
                                      ? 'Auto'
                                      : 'Test'
                                }
                                size="small"
                                sx={{
                                  backgroundColor:
                                    telemetry.dsStatus.mode === 'teleOp'
                                      ? 'info.main'
                                      : telemetry.dsStatus.mode === 'auto'
                                        ? 'success.main'
                                        : 'warning.main',
                                  color: '#fff',
                                  fontSize: '0.7rem',
                                  height: 20,
                                }}
                              />
                              <Chip
                                label={telemetry.dsStatus.robotComms ? 'Comms' : 'No Comms'}
                                size="small"
                                sx={{
                                  backgroundColor: telemetry.dsStatus.robotComms ? 'success.main' : 'error.main',
                                  color: '#fff',
                                  fontSize: '0.7rem',
                                  height: 20,
                                }}
                              />
                              <Chip
                                label={telemetry.dsStatus.radioPing ? 'Radio' : 'No Radio'}
                                size="small"
                                sx={{
                                  backgroundColor: telemetry.dsStatus.radioPing ? 'info.main' : 'error.main',
                                  color: '#fff',
                                  fontSize: '0.7rem',
                                  height: 20,
                                }}
                              />
                              <Chip
                                label={telemetry.dsStatus.rioPing ? 'RIO' : 'No RIO'}
                                size="small"
                                sx={{
                                  backgroundColor: telemetry.dsStatus.rioPing ? 'info.main' : 'error.main',
                                  color: '#fff',
                                  fontSize: '0.7rem',
                                  height: 20,
                                }}
                              />
                              {telemetry.dsStatus.eStop && (
                                <Chip
                                  label="E-STOP"
                                  size="small"
                                  sx={{
                                    backgroundColor: 'error.main',
                                    color: '#fff',
                                    fontSize: '0.7rem',
                                    height: 20,
                                    fontWeight: 'bold',
                                  }}
                                />
                              )}
                              {telemetry.brownout && (
                                <Chip
                                  label="BROWNOUT"
                                  size="small"
                                  sx={{
                                    backgroundColor: 'warning.main',
                                    color: '#fff',
                                    fontSize: '0.7rem',
                                    height: 20,
                                    fontWeight: 'bold',
                                  }}
                                />
                              )}
                            </Box>
                          )}
                        </>
                      )}
                      {/* Subnet Scan — discovered devices on the team VLAN */}
                      {(() => {
                        const scan = subnetScan?.stations[station];
                        if (!scan || scan.hosts.length === 0) return null;
                        const aliveCount = scan.hosts.filter(h => h.alive).length;
                        return (
                          <Box sx={{ mt: 0.5 }}>
                            <Box
                              sx={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                px: 1,
                                mb: 0.25,
                              }}
                            >
                              <Typography variant="caption" color="text.secondary">
                                Subnet {scan.subnet}
                              </Typography>
                              <Chip
                                label={`${aliveCount} / ${scan.hosts.length}`}
                                size="small"
                                color={aliveCount > 0 ? 'success' : 'default'}
                                sx={{ height: 18, fontSize: '0.7rem' }}
                              />
                            </Box>
                            <Table
                              size="small"
                              sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}
                            >
                              <TableHead>
                                <TableRow>
                                  <TableCell>IP</TableCell>
                                  <TableCell>Status</TableCell>
                                  <TableCell>Device</TableCell>
                                  <TableCell>Last Seen</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {scan.hosts.map(host => (
                                  <TableRow key={host.ip} sx={{ opacity: host.alive ? 1 : 0.5 }}>
                                    <TableCell sx={{ fontFamily: 'monospace' }}>{host.ip}</TableCell>
                                    <TableCell>
                                      <Chip
                                        label={host.alive ? 'UP' : 'DOWN'}
                                        size="small"
                                        color={host.alive ? 'success' : 'error'}
                                        variant={host.alive ? 'filled' : 'outlined'}
                                        sx={{ height: 18, fontSize: '0.7rem' }}
                                      />
                                    </TableCell>
                                    <TableCell>{describeIp(host) ?? ''}</TableCell>
                                    <TableCell>{formatAge(host.lastSeen)}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </Box>
                        );
                      })()}
                      {/* mDNS Activity (full view only) */}
                      {full &&
                        (() => {
                          const mdns = mdnsActivity?.stations[station];
                          if (!mdns) return null;
                          return (
                            <Box sx={{ mt: 0.5 }}>
                              <Box
                                sx={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  px: 1,
                                  mb: 0.25,
                                }}
                              >
                                <Typography variant="caption" color="text.secondary">
                                  mDNS Reflector
                                </Typography>
                                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                                  {mdns.queriesForwarded}q / {mdns.responsesForwarded}r
                                </Typography>
                              </Box>
                              {mdns.recentNames.length > 0 && (
                                <Table
                                  size="small"
                                  sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}
                                >
                                  <TableHead>
                                    <TableRow>
                                      <TableCell>Name</TableCell>
                                      <TableCell>IP</TableCell>
                                      <TableCell>Requester</TableCell>
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    {mdns.recentNames.map(entry => (
                                      <TableRow key={entry.name}>
                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                          {entry.services && entry.services.length > 0 ? (
                                            <Tooltip title={entry.services.join(', ')} arrow placement="right">
                                              <span style={{ cursor: 'help', textDecoration: 'underline dotted' }}>
                                                {entry.name}
                                              </span>
                                            </Tooltip>
                                          ) : (
                                            entry.name
                                          )}
                                        </TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                          {entry.resolvedIp ?? '—'}
                                        </TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                          {entry.requester ?? '—'}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </Box>
                          );
                        })()}
                      {!full && <TeamChecksPanel station={station} />}
                    </Box>
                  )}
                </>
              )}
            </>
          ) : (
            <Typography noWrap style={{ fontStyle: 'italic' }}>
              not configured
            </Typography>
          )}
        </CardContent>
      </Card>

      {full && (
        <StationNetworkCard
          station={station}
          stats={networkStats?.stations[station]}
          scan={subnetScan?.stations[station]}
          mdns={mdnsActivity?.stations[station]}
          dsInfo={matchState?.connectedStations[station]}
        />
      )}

      <Dialog
        open={open}
        onClose={handleClose}
        fullScreen={isMobile}
        fullWidth={!isMobile}
        maxWidth={isMobile ? undefined : 'sm'}
        slotProps={{
          transition: {
            onEntered: () => {
              ssidInputRef.current?.focus();
              ssidInputRef.current?.select();
            },
          },
        }}
      >
        <form
          style={{
            ...(isMobile ? { display: 'flex', flexDirection: 'column', height: '100%' } : {}),
          }}
          onSubmit={e => {
            e.preventDefault();
            // Empty SSID = clear: stage it (consistent with the X button).
            // Non-empty SSID = save: commit immediately.
            if (isSaveEnabled) handleSave(isSSIDEmpty);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.shiftKey) {
              // Shift+Enter: Stage
              if (isSaveEnabled) handleSave(true);
              e.preventDefault(); // Prevent form submit
            }
          }}
        >
          <DialogTitle>Configure {pretty} Wi-Fi</DialogTitle>
          <DialogContent sx={isMobile ? { flex: 1, overflow: 'auto' } : {}}>
            <TextField
              label="SSID"
              value={ssid}
              onChange={e => setSsid(e.target.value)}
              fullWidth
              style={modalStyle}
              margin="normal"
              inputRef={ssidInputRef} // Attach the ref here
              helperText={
                isSSIDEmpty
                  ? "Your robot's broadcast SSID.\ne.g. 123-Comp\nCase-sensitive."
                  : !ssidRegex.test(ssid)
                    ? 'SSID must be alphanumeric and up to 14 characters.'
                    : !ssidFormatRegex.test(ssid)
                      ? 'SSID must start with 1-6 digits and optionally include a hyphen and more characters.'
                      : ''
              }
              error={!isSSIDEmpty && (!ssidRegex.test(ssid) || !ssidFormatRegex.test(ssid))}
              slotProps={{ formHelperText: { sx: { whiteSpace: 'pre-line' } } }}
            />
            <TextField
              label="Passphrase"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              fullWidth
              style={modalStyle}
              disabled={isSSIDEmpty}
              margin="normal"
              helperText={
                !isSSIDEmpty && !passphraseRegex.test(passphrase)
                  ? 'Passphrase must be alphanumeric and between 8-16 characters.'
                  : ''
              }
              error={!isSSIDEmpty && !passphraseRegex.test(passphrase)}
            />

            {recentSettings.length > 0 && (
              <Box
                sx={{
                  marginTop: 2,
                  padding: 2,
                  backgroundColor: 'background.paper',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                }}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 1 }}>
                  <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                    Recent Configurations
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <Tooltip title={showPassphrases ? 'Hide passphrases' : 'Show passphrases'}>
                      <IconButton
                        size="small"
                        onClick={() => setShowPassphrases(!showPassphrases)}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': {
                            color: 'text.primary',
                          },
                        }}
                      >
                        {showPassphrases ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Clear all recent configurations">
                      <IconButton
                        size="small"
                        onClick={clearSettings}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': {
                            color: 'error.main',
                          },
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
                <Table size="small" sx={{ tableLayout: 'fixed' }}>
                  <TableBody>
                    {recentSettings.map(setting => (
                      <Tooltip
                        key={`${setting.ssid}-${setting.createdAt}`}
                        title={`Last used: ${formatAge(setting.lastUsedAt)} · Added: ${formatAge(setting.createdAt)}`}
                        placement="left"
                        arrow
                      >
                        <TableRow
                          hover
                          onClick={() => handleApplySetting(setting)}
                          sx={{
                            cursor: 'pointer',
                            position: 'relative',
                            '&:hover': {
                              backgroundColor: 'action.hover',
                              '& .delete-button': {
                                opacity: 1,
                              },
                            },
                          }}
                        >
                          <TableCell
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: '0.75rem',
                              padding: '4px 8px',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {setting.ssid}
                          </TableCell>
                          <TableCell
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: '0.75rem',
                              padding: '4px 8px',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {showPassphrases ? setting.wpaKey : '••••••••'}
                          </TableCell>
                          {/* Floating delete button */}
                          <IconButton
                            className="delete-button"
                            size="small"
                            onClick={e => handleRemoveSetting(e, setting)}
                            sx={{
                              position: 'absolute',
                              right: 4,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              opacity: 0,
                              transition: 'opacity 0.2s',
                              backgroundColor: 'background.paper',
                              boxShadow: 1,
                              zIndex: 1,
                              '&:hover': {
                                backgroundColor: 'error.light',
                                color: 'error.contrastText',
                              },
                            }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </TableRow>
                      </Tooltip>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} color="secondary">
              Cancel
            </Button>
            {!isSSIDEmpty && (
              <Button onClick={() => isSaveEnabled && handleSave(true)} color="secondary" disabled={!isSaveEnabled}>
                Stage
              </Button>
            )}
            <Button type="submit" color="primary" disabled={!isSaveEnabled}>
              {isSSIDEmpty ? 'Clear' : 'Save'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}

export default StationStatus;

function SSIDDisplay({ ssid, hashedWpaKey, secure }: { ssid?: string; hashedWpaKey?: string; secure?: boolean }) {
  if (!ssid) {
    return null;
  }

  return (
    <>
      {ssid && <SecureStatus secure={secure ?? !!hashedWpaKey} />}
      <CopyToClipboard text={ssid} tooltipText="Click to copy SSID">
        <Typography
          variant="h6"
          sx={{
            color: 'text.secondary',
            fontFamily: 'monospace',
            cursor: 'pointer',
            paddingX: 0.5,
            paddingY: 0.25,
            borderRadius: 0.5,
            '&:hover': {
              color: 'text.primary',
              backgroundColor: 'action.hover',
            },
            transition: 'all 0.2s',
          }}
        >
          {ssid}
        </Typography>
      </CopyToClipboard>
    </>
  );
}

function SecureStatus({ secure }: { secure: boolean }) {
  return (
    <Tooltip title={secure ? 'passphrase set' : 'no passphrase'}>
      <span style={{ userSelect: 'none', fontSize: '0.75em' }}>
        <>{secure ? '🔒' : '🔓'}</>
      </span>
    </Tooltip>
  );
}
