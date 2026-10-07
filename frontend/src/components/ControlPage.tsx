import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { TeamAvatar } from './TeamAvatar';
import {
  useLatest,
  useMatchState,
  useDriveSessionState,
  useSavedTeams,
  sendNewConfig,
  sendSaveTeam,
  sendEnableSavedRobot,
  sendInternetToggle,
  useLatestTelemetry,
  useUpdateCallback,
  useTelemetryCallback,
  useNetworkStats,
  useSubnetScan,
  useMdnsActivity,
  usePendingCommitState,
  sendCancelStationChange,
  sendDrive,
  sendRoutePreference,
  useRoutePreferenceState,
  usePortBridgeState,
  sendPortBridge,
  useRobotWifiScan,
  sendRobotWifiTest,
  useSixGhzWatch,
  getServerTime,
} from '../hooks/useBackend';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import { holdReasonText, DEFERRED_TEXT_TEAM, teamOfSsid } from './PendingRadioChanges';
import {
  broadcastsForTeam,
  describeNameForTeam,
  describeStallForTeam,
  stallsForTeam,
  suffixOf,
} from '../utils/robotWifi';
import { clashesForTeam, describeClashForTeam, isSixGhzWatching } from '../utils/sixGhzWatch';
import { FreeplayControl, MatchPanelForControl } from './MatchPanel';
import { QueueBanner } from './QueueBanner';
import { NudgeSettings } from './NudgeSettings';
import { MatchVideoCard } from './MatchVideoCard';
import { LaptopWifiCheck } from './LaptopWifiCheck';
import { TeamChecksModal } from './TeamChecksModal';
import { StationNetworkCard } from './NetworkPage';
import { HostDisplay } from './HostDisplay';
import { StationName, StationNameList, SavedTeamClientConfig, PortConfig } from '../../../src/types';
import { createHash } from './cryptoUtils';
import { StationChart, handleStatusUpdate, handleTelemetryUpdate } from './StationChart';
import { CopyToClipboard } from './CopyToClipboard';
import IconButton from '@mui/material/IconButton';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import PublicIcon from '@mui/icons-material/Public';
import PublicOffIcon from '@mui/icons-material/PublicOff';
import InputAdornment from '@mui/material/InputAdornment';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import TableHead from '@mui/material/TableHead';
import Alert from '@mui/material/Alert';
import { formatBytes, describeIp, formatAge } from '../../../src/utils';

// Helper function to format numbers with thin space as thousands separator
function formatNumberWithThinSpace(num: number | undefined): string {
  if (num === undefined) return '';
  return num.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

/** What a station will hold once everything waiting has gone through. A
 *  held request (applied when the match is over or staff apply it) or a
 *  change waiting for robots to be disabled beats what the radio reports
 *  right now. `ssid` null = the station is, or is about to be, empty. */
type ProjectedStation = {
  ssid: string | null;
  pending: 'held' | 'deferred' | null;
  /** A robot queued to leave because the match ended. The station counts
   *  as free for newcomers, but it is still this robot's team's until staff
   *  apply — joining the next match keeps it. */
  leaving?: string;
};

function useProjectedStations(): Record<StationName, ProjectedStation> {
  const latest = useLatest();
  const pending = usePendingCommitState();

  return useMemo(() => {
    const radio = latest?.radioUpdate?.stationStatuses;
    const result = {} as Record<StationName, ProjectedStation>;
    for (const station of StationNameList) {
      const held = pending.stagedChanges?.[station];
      const deferred = pending.deferredChanges?.[station];
      if (held !== undefined) {
        const onRadio = radio?.[station]?.ssid || undefined;
        const leaving =
          held === null &&
          onRadio &&
          pending.changes?.some(c => c.kind === 'release' && c.reason === 'postMatch' && c.ssid === onRadio)
            ? onRadio
            : undefined;
        result[station] = { ssid: held?.ssid ?? null, pending: 'held', leaving };
      } else if (deferred !== undefined) result[station] = { ssid: deferred?.ssid ?? null, pending: 'deferred' };
      else result[station] = { ssid: radio?.[station]?.ssid || null, pending: null };
    }
    return result;
  }, [latest, pending]);
}

/**
 * Every SSID that is on the field, or on its way there, across ALL stations.
 * Returns a Map of ssid → stationName so callers can find which station owns an SSID.
 */
function useAllActiveSSIDs(): Map<string, StationName> {
  const projected = useProjectedStations();

  return useMemo(() => {
    const ssids = new Map<string, StationName>();
    for (const station of StationNameList) {
      const { ssid } = projected[station];
      if (ssid) ssids.set(ssid, station);
    }
    return ssids;
  }, [projected]);
}

/**
 * Every station that belongs (or is about to belong) to a team's robots.
 * Returns a Map of ssid → stationName. A station whose robot is on its way
 * off the field is not included.
 */
function useStationsForTeam(teamNumber: number): Map<string, StationName> {
  const projected = useProjectedStations();

  return useMemo(() => {
    const result = new Map<string, StationName>();
    for (const station of StationNameList) {
      const { ssid, leaving } = projected[station];
      const own = ssid ?? leaving; // a robot the match end queued to leave is still the team's to keep
      if (own && teamOfSsid(own) === teamNumber) result.set(own, station);
    }
    return result;
  }, [projected, teamNumber]);
}

/** The first station that is empty, or about to be, once everything waiting
 *  has gone through. Null when the field is full. */
function useFindAvailableStation(): StationName | null {
  const projected = useProjectedStations();

  return useMemo(() => {
    for (const station of StationNameList) {
      if (projected[station].ssid === null) return station;
    }
    return null;
  }, [projected]);
}

/** What a team sees when the field is full. Making room is field staff's
 *  call (Release on the admin page), never another team's — teams are not
 *  asked to pick whose robot to bump. */
function FieldFullAlert() {
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      The field is full ({StationNameList.length} robots). Ask field staff to make room for your robot, or wait for a
      team to leave.
    </Alert>
  );
}

type RobotPending = {
  kind: 'held-enable' | 'held-release' | 'deferred-enable' | 'deferred-release';
  station: StationName;
} | null;

/** Whether this robot has a request in flight, and which way it is going:
 *  held (a match exists / staff hold) or deferred (robots are enabled). */
function useRobotPending(ssid: string): RobotPending {
  const latest = useLatest();
  const pending = usePendingCommitState();

  return useMemo(() => {
    const radio = latest?.radioUpdate?.stationStatuses;
    for (const station of StationNameList) {
      const onRadio = radio?.[station]?.ssid === ssid;
      const held = pending.stagedChanges?.[station];
      if (held !== undefined) {
        if (held?.ssid === ssid) return { kind: 'held-enable', station };
        if (held === null && onRadio) return { kind: 'held-release', station };
        continue;
      }
      const deferred = pending.deferredChanges?.[station];
      if (deferred !== undefined) {
        if (deferred?.ssid === ssid && !onRadio) return { kind: 'deferred-enable', station };
        if (deferred === null && onRadio) return { kind: 'deferred-release', station };
      }
    }
    return null;
  }, [latest, pending, ssid]);
}

/** The team page's tabs, in display order. The id is also the URL hash. */
const CONTROL_TABS = [
  { id: 'robots', label: 'Robots', needsRobot: false },
  { id: 'radio', label: 'Radio', needsRobot: true },
  // Open without a robot too: it holds the laptop's own Wi-Fi check
  { id: 'network', label: 'Network', needsRobot: false },
  { id: 'video', label: 'Video', needsRobot: false },
] as const;
type ControlTab = (typeof CONTROL_TABS)[number]['id'];

function tabFromHash(): ControlTab | null {
  const hash = window.location.hash.slice(1);
  return CONTROL_TABS.find(t => t.id === hash)?.id ?? null;
}

/**
 * The main control page component.
 * URL: /<ssid>#<tab>
 *
 * Shows a robot management dashboard for a single team. Alerts and the match
 * panel (with its stop buttons) are always on screen; everything else is split
 * into tabs:
 * - Robots: saved robot configs, enable/release, add robot, verify passphrase
 * - Radio: the selected robot's radio status, charts or tables
 * - Network: port bridging and network diagnostics, and the laptop Wi-Fi check
 * - Video: match and practice recordings
 *
 * Each DS laptop opens /<ssid> for the specific robot it drives.
 * Selecting a different robot or tab updates the URL via replaceState.
 */
export function ControlPage({ teamNumber, selectedSsid }: { teamNumber: number; selectedSsid: string }) {
  const [currentSsid, setCurrentSsid] = useState(selectedSsid);
  const latest = useLatest();

  // Collect chart data from the page root, so the charts are already full
  // when the Radio tab is opened.
  useUpdateCallback(handleStatusUpdate);
  useTelemetryCallback(handleTelemetryUpdate);

  // Radio card toggles live here so they survive switching tabs.
  const [chartMode, setChartMode] = useState(true);
  const [internetAccess, setInternetAccess] = useState<Partial<Record<StationName, boolean>>>({});

  // All active stations for this team
  const activeStations = useStationsForTeam(teamNumber);
  const availableStation = useFindAvailableStation();

  // Server-side saved team configs: the server sends only this team's
  const savedTeams = useSavedTeams({ team: teamNumber });
  const teamConfigs = useMemo(() => {
    if (!savedTeams) return [];
    return savedTeams.teams.filter(t => {
      const num = parseInt(t.ssid.split('-', 2)[0]);
      return num === teamNumber;
    });
  }, [savedTeams, teamNumber]);

  // Selection handler — updates URL for viewing, but does NOT start driving.
  // The team must explicitly click "Drive" to set up the DNAT/routing.
  const handleSelectRobot = useCallback((ssid: string) => {
    setCurrentSsid(ssid);
    window.history.replaceState(null, '', `/${encodeURIComponent(ssid)}${window.location.hash}`);
  }, []);

  // Auto-select: if the current SSID is not active but another robot for this team is,
  // switch to the first active one.
  useEffect(() => {
    if (activeStations.has(currentSsid)) return;
    if (activeStations.size > 0) {
      const firstSsid = activeStations.keys().next().value as string;
      handleSelectRobot(firstSsid);
    }
  }, [activeStations, currentSsid, handleSelectRobot]);

  const selectedStation = activeStations.get(currentSsid) ?? null;

  // Route preference state — for multi-robot routing feedback
  const routeState = useRoutePreferenceState();
  const routePreference = routeState?.preference ?? null;
  const isMultiRobot = activeStations.size >= 2;

  // Resolve the SSID that the laptop is currently routed to
  const routedSsid = useMemo(() => {
    if (!routePreference) return null;
    for (const [ssid, station] of activeStations) {
      if (station === routePreference) return ssid;
    }
    return null;
  }, [routePreference, activeStations]);

  // Auto-connect to the selected robot's station on first load if no preference exists.
  const autoConnectDone = useRef(false);
  useEffect(() => {
    if (autoConnectDone.current) return;
    if (routeState === null) return; // Haven't received state from server yet
    if (routePreference) return; // Already connected to something
    if (!selectedStation) return; // Selected robot isn't active
    autoConnectDone.current = true;
    sendRoutePreference(selectedStation);
  }, [routeState, routePreference, selectedStation]);

  // Tab: the URL hash if it names one, else picked once the field state first
  // arrives — Radio when a robot is already on the field, Robots otherwise.
  // Picked once, not live, so enabling a robot doesn't yank the team off the
  // Robots tab while its Wi-Fi is still coming up.
  const [tabChoice, setTabChoice] = useState<ControlTab | null>(tabFromHash);
  useEffect(() => {
    if (tabChoice || !latest) return;
    setTabChoice(activeStations.size > 0 ? 'radio' : 'robots');
  }, [tabChoice, latest, activeStations]);
  const selectTab = (tab: ControlTab) => {
    setTabChoice(tab);
    window.history.replaceState(null, '', `#${tab}`);
  };
  // Radio and Network describe the selected robot — without one on the field
  // they're disabled, so fall back to Robots.
  const tab: ControlTab =
    tabChoice && !(CONTROL_TABS.find(t => t.id === tabChoice)!.needsRobot && !selectedStation) ? tabChoice : 'robots';
  const selectedLinked = selectedStation ? !!latest?.radioUpdate?.stationStatuses[selectedStation]?.isLinked : false;

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <TeamAvatar teamNumber={teamNumber} size={40} />
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          Team {teamNumber}
        </Typography>
      </Box>

      {/* Where this team stands in the match queue, or "Play next" when the line is open */}
      <QueueBanner teamNumber={teamNumber} />

      {/* Network routing banner — shows once connected, with option to switch or disconnect */}
      {routePreference && activeStations.size > 0 && (
        <Alert
          severity={routedSsid === currentSsid ? 'success' : 'warning'}
          sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}
          action={
            <Button color="inherit" size="small" onClick={() => sendRoutePreference(null)}>
              Disconnect
            </Button>
          }
        >
          Connected to <strong>{routedSsid ?? routePreference}</strong>.
          {isMultiRobot && routedSsid !== currentSsid && ' Select the robot you want below or click its Drive button.'}
        </Alert>
      )}

      {/* Always on screen, whatever the tab: alerts, and the match panel with
          its stop buttons (which also keeps the match pop-out window alive). */}
      {selectedStation && (
        <>
          <StationAlerts station={selectedStation} />
          <FreeplayControl station={selectedStation} />
          <MatchPanelForControl station={selectedStation} ssid={currentSsid} />
        </>
      )}

      <Tabs
        value={tab}
        onChange={(_, v: ControlTab) => selectTab(v)}
        variant="fullWidth"
        sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        {CONTROL_TABS.map(t => (
          <Tab
            key={t.id}
            value={t.id}
            label={t.label}
            disabled={t.needsRobot && !selectedStation}
            // The Radio tab carries the link state, so a dropped link shows from any tab
            icon={
              t.id === 'radio' && selectedStation ? (
                <Box
                  component="span"
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: selectedLinked ? 'success.main' : 'warning.main',
                  }}
                />
              ) : undefined
            }
            iconPosition="end"
            sx={{ minHeight: 48 }}
          />
        ))}
      </Tabs>

      {tab === 'robots' && (
        <>
          <RobotList
            teamNumber={teamNumber}
            teamConfigs={teamConfigs}
            activeStations={activeStations}
            availableStation={availableStation}
            selectedSsid={currentSsid}
            onSelectRobot={handleSelectRobot}
            routePreference={routePreference}
            isMultiRobot={isMultiRobot}
          />
          {activeStations.size === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
              No robots on the field yet. Enable a robot&apos;s Wi-Fi to see its radio and network status.
            </Typography>
          )}
          <NudgeSettings teamNumber={teamNumber} />
        </>
      )}

      {tab === 'radio' && selectedStation && (
        <>
          <Typography variant="h6" sx={{ fontFamily: 'monospace', mb: 1 }}>
            {currentSsid}
          </Typography>
          <RadioStatusCard
            station={selectedStation}
            chartMode={chartMode}
            onChartModeChange={setChartMode}
            internetAccess={internetAccess[selectedStation] ?? false}
            onInternetAccessChange={on => {
              setInternetAccess(prev => ({ ...prev, [selectedStation]: on }));
              sendInternetToggle(selectedStation, on);
            }}
          />
        </>
      )}

      {tab === 'network' &&
        selectedStation &&
        // Selected robot first, with its port selector; the team's other robots after
        Array.from(activeStations.entries())
          .sort(([a], [b]) => (a === currentSsid ? -1 : b === currentSsid ? 1 : 0))
          .map(([ssid, station]) => (
            <Box key={ssid} sx={{ mb: 2 }}>
              <Typography variant="h6" sx={{ fontFamily: 'monospace', mb: 1 }}>
                {ssid}
              </Typography>
              {ssid === currentSsid && <PortSelector station={station} ssid={ssid} />}
              <StationNetwork station={station} />
            </Box>
          ))}

      {tab === 'network' && <LaptopWifiCheck />}

      {tab === 'video' && (
        <MatchVideoCard
          teamNumber={teamNumber}
          emptyText="Recording isn't set up on this field, and there are no videos of your team yet."
        />
      )}
    </Container>
  );
}

/**
 * List of saved robot configs for this team + add-robot form.
 * Includes inline passphrase verification: a "Verify" button expands into a text field,
 * and a matching passphrase puts a checkmark on the corresponding robot row.
 */
function RobotList({
  teamNumber,
  teamConfigs,
  activeStations,
  availableStation,
  selectedSsid,
  onSelectRobot,
  routePreference,
  isMultiRobot,
}: {
  teamNumber: number;
  teamConfigs: SavedTeamClientConfig[];
  activeStations: Map<string, StationName>;
  availableStation: StationName | null;
  selectedSsid: string;
  onSelectRobot: (ssid: string) => void;
  routePreference: StationName | null;
  isMultiRobot: boolean;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [addSuffix, setAddSuffix] = useState('');

  // Passphrase verification state
  const [showVerifyField, setShowVerifyField] = useState(false);
  const [verifyValue, setVerifyValue] = useState('');
  const [verifiedSsid, setVerifiedSsid] = useState<string | null>(null);
  const hasHashes = teamConfigs.some(c => c.wpaKeyHash);

  const handleVerifyInput = useCallback(
    (value: string) => {
      setVerifyValue(value);
      if (value.length < 8) {
        setVerifiedSsid(null);
        return;
      }
      for (const config of teamConfigs) {
        if (!config.wpaKeyHash) continue;
        // Hash is SHA-256(ssid + passphrase) — ssid acts as salt (contains team number + robot name)
        const hash = createHash(config.ssid + value);
        if (hash === config.wpaKeyHash) {
          setVerifiedSsid(config.ssid);
          return;
        }
      }
      setVerifiedSsid(null);
    },
    [teamConfigs],
  );

  const closeVerify = () => {
    setShowVerifyField(false);
    setVerifyValue('');
    setVerifiedSsid(null);
  };

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Robots</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {/* Verify button — only visible when robots with hashes exist */}
            {teamConfigs.length > 0 &&
              hasHashes &&
              (showVerifyField ? (
                <TextField
                  size="small"
                  placeholder="Enter passphrase"
                  value={verifyValue}
                  onChange={e => handleVerifyInput(e.target.value)}
                  autoFocus
                  error={verifyValue.length >= 8 && !verifiedSsid}
                  sx={{ width: 200 }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton size="small" onClick={closeVerify} edge="end">
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
              ) : (
                <Button size="small" onClick={() => setShowVerifyField(true)}>
                  Verify Passphrase
                </Button>
              ))}
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => {
                setAddSuffix('');
                setShowAddForm(!showAddForm);
              }}
            >
              Add Robot
            </Button>
          </Box>
        </Box>

        {!availableStation && <FieldFullAlert />}

        <RobotWifiHeard
          teamNumber={teamNumber}
          hasRobotOnField={activeStations.size > 0}
          onAdd={suffix => {
            setAddSuffix(suffix);
            setShowAddForm(true);
          }}
        />

        <SixGhzClashAlerts teamNumber={teamNumber} />

        {showAddForm && (
          <AddRobotForm
            key={addSuffix}
            initialSuffix={addSuffix}
            teamNumber={teamNumber}
            availableStation={availableStation}
            onDone={() => setShowAddForm(false)}
            onSelectRobot={onSelectRobot}
          />
        )}

        {teamConfigs.length === 0 && !showAddForm ? (
          <Typography variant="body2" color="text.secondary">
            No saved robots for this team. Click "Add Robot" to configure one.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {teamConfigs.map(config => (
              <RobotRow
                key={config.ssid}
                config={config}
                isActive={activeStations.has(config.ssid)}
                isSelected={config.ssid === selectedSsid}
                activeStation={activeStations.get(config.ssid) ?? null}
                availableStation={availableStation}
                onSelect={() => onSelectRobot(config.ssid)}
                routePreference={routePreference}
                isMultiRobot={isMultiRobot}
                isVerified={config.ssid === verifiedSsid}
              />
            ))}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A single row in the robot list showing a saved config.
 * Clickable to select — the selected robot's experience is shown below the list.
 */
function RobotRow({
  config,
  isActive,
  isSelected,
  activeStation,
  availableStation,
  onSelect,
  routePreference,
  isMultiRobot,
  isVerified,
}: {
  config: SavedTeamClientConfig;
  isActive: boolean;
  isSelected: boolean;
  activeStation: StationName | null;
  availableStation: StationName | null;
  onSelect: () => void;
  routePreference: StationName | null;
  isMultiRobot: boolean;
  isVerified: boolean;
}) {
  const [pendingDrive, setPendingDrive] = useState(false);
  const [showEnableHint, setShowEnableHint] = useState(false);
  const [configCooldown, setConfigCooldown] = useState(false);
  const suffix = config.ssid.includes('-') ? config.ssid.split('-').slice(1).join('-') : null;
  const robotPending = useRobotPending(config.ssid);
  const pendingState = usePendingCommitState();
  // "Active" means the radio has it and nothing is waiting to change that.
  const isLive = isActive && !robotPending;

  // Clear pending state once the server confirms (or the situation changes)
  useEffect(() => {
    if (routePreference === activeStation || !isMultiRobot) setPendingDrive(false);
  }, [routePreference, activeStation, isMultiRobot]);

  // Clear the enable hint once the robot becomes active
  useEffect(() => {
    if (isActive) setShowEnableHint(false);
  }, [isActive]);

  const startCooldown = () => {
    setConfigCooldown(true);
    setTimeout(() => setConfigCooldown(false), 2000);
  };

  const handleEnable = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!availableStation || configCooldown) return;
    startCooldown();
    sendEnableSavedRobot(availableStation, config.ssid);
    onSelect(); // Auto-select the robot being enabled
  };

  const handleRelease = (e: React.MouseEvent) => {
    e.stopPropagation();
    const station = robotPending?.station ?? activeStation;
    if (!station || configCooldown) return;
    startCooldown();
    sendNewConfig(station, '', '');
  };

  /** Withdraw a request that is still waiting: an enable is cancelled, a
   *  release is kept off. */
  const handleWithdraw = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!robotPending || configCooldown) return;
    startCooldown();
    if (robotPending.kind === 'deferred-release') {
      // Already off pFMS's books — put it back (the radio never changed).
      sendEnableSavedRobot(robotPending.station, config.ssid);
    } else {
      sendCancelStationChange(robotPending.station);
    }
  };

  const pendingChip =
    robotPending?.kind === 'held-enable'
      ? { label: 'Waiting', color: 'warning' as const }
      : robotPending?.kind === 'deferred-enable'
        ? { label: 'Connecting…', color: 'info' as const }
        : robotPending
          ? { label: 'Leaving', color: 'warning' as const }
          : null;
  const pendingReason = !robotPending
    ? null
    : robotPending.kind.startsWith('held')
      ? holdReasonText(pendingState.hold, 'team')
      : DEFERRED_TEXT_TEAM;

  // This robot's entry on the pending list, if any. A new entry opens a
  // dialog once — the match admin has to apply it, which is not obvious from
  // a "Waiting" chip — and stays dismissed until the entry changes.
  const myChange = pendingState.changes?.find(c => c.ssid === config.ssid);
  const [dismissedChangeId, setDismissedChangeId] = useState<string | null>(null);
  const waitingDialogOpen =
    !!myChange && !!robotPending && robotPending.kind.startsWith('held') && myChange.id !== dismissedChangeId;
  const dismissWaiting = () => setDismissedChangeId(myChange?.id ?? null);
  const leavingAfterMatch = myChange?.kind === 'release' && myChange.reason === 'postMatch';

  return (
    <>
      <Dialog open={waitingDialogOpen} onClose={dismissWaiting} maxWidth="xs" fullWidth>
        <DialogTitle>
          {leavingAfterMatch
            ? 'The match is over — your robot is queued to leave'
            : myChange?.kind === 'release'
              ? 'Your robot is queued to leave the field'
              : 'Waiting for the match admin'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {leavingAfterMatch
              ? 'When a match ends, every robot on the field is queued to leave so the next match starts clean. Nothing changes until the match admin presses Apply now. Playing again? Press Keep — joining the next match keeps it too.'
              : myChange?.kind === 'release'
                ? 'Your release is on the list for the match admin to apply. Until then the robot stays on Wi-Fi. Changed your mind? Press Keep.'
                : 'Your Wi-Fi request is on the list. Nothing reaches the radio until the match admin presses Apply now on the match page — every change goes out together, between matches, so no robot is cut off mid-drive.'}
          </Typography>
          {pendingReason && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {pendingReason}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={e => {
              handleWithdraw(e);
              dismissWaiting();
            }}
            variant={myChange?.kind === 'release' ? 'contained' : 'text'}
            disabled={configCooldown}
          >
            {myChange?.kind === 'release' ? 'Keep my robot on the field' : 'Cancel request'}
          </Button>
          <Button onClick={dismissWaiting} variant={myChange?.kind === 'release' ? 'text' : 'contained'}>
            OK
          </Button>
        </DialogActions>
      </Dialog>
      <Box
        onClick={isActive ? onSelect : () => setShowEnableHint(true)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          borderRadius: 1,
          cursor: 'pointer',
          backgroundColor: isSelected ? 'action.selected' : 'transparent',
          borderLeft: isSelected ? 3 : 0,
          borderColor: 'primary.main',
          '&:hover': { backgroundColor: isSelected ? 'action.selected' : 'action.hover' },
          transition: 'background-color 0.15s',
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
              {suffix ?? config.ssid}
            </Typography>
            {isVerified && (
              <Tooltip title="Passphrase verified">
                <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />
              </Tooltip>
            )}
            {isLive && <Chip label="Active" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
            {pendingChip && (
              <Chip
                label={pendingChip.label}
                color={pendingChip.color}
                size="small"
                variant="outlined"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            )}
            {isLive && isMultiRobot && (routePreference === activeStation || pendingDrive) && (
              <Chip
                label="Driving"
                color={pendingDrive && routePreference !== activeStation ? 'default' : 'info'}
                size="small"
                sx={{ height: 20, fontSize: '0.7rem', fontWeight: 700 }}
                onDelete={e => {
                  e.stopPropagation();
                  setPendingDrive(false);
                  sendDrive(null);
                }}
              />
            )}
          </Box>
          <Typography variant="caption" color="text.secondary">
            Last used {formatAge(config.lastUsedAt)}
          </Typography>
          {pendingReason && (
            <Typography variant="caption" sx={{ display: 'block', color: 'warning.main' }}>
              {pendingReason}
            </Typography>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {robotPending ? (
            robotPending.kind === 'deferred-enable' ? (
              <Button
                size="small"
                variant="outlined"
                color="warning"
                disabled={configCooldown}
                onClick={e => handleRelease(e)}
              >
                Release
              </Button>
            ) : (
              <Button size="small" variant="outlined" disabled={configCooldown} onClick={e => handleWithdraw(e)}>
                {robotPending.kind === 'held-enable' ? 'Cancel' : 'Keep'}
              </Button>
            )
          ) : isActive ? (
            <>
              {isMultiRobot && !routePreference && !pendingDrive && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={e => {
                    e.stopPropagation();
                    setPendingDrive(true);
                    sendDrive(activeStation!);
                    onSelect();
                  }}
                >
                  Drive
                </Button>
              )}
              <Button
                size="small"
                variant="outlined"
                color="warning"
                disabled={configCooldown}
                onClick={e => handleRelease(e)}
              >
                Release
              </Button>
            </>
          ) : (
            // Disabled when the field is full — the alert above says what to do.
            <Button
              size="small"
              variant="contained"
              disabled={configCooldown || !availableStation}
              onClick={e => handleEnable(e)}
            >
              Enable Robot
            </Button>
          )}
        </Box>
      </Box>

      {showEnableHint && !isActive && (
        <Alert severity="info" sx={{ mx: 2, mb: 0.5 }} onClose={() => setShowEnableHint(false)}>
          Enable this robot first to see its status.
        </Alert>
      )}
    </>
  );
}

/**
 * What pFMS hears of this team's robots on 2.4 GHz (`FRC-<team>[-suffix]`),
 * matched against their saved robots: the fastest way to spot a name typed
 * with the wrong capitals. When a robot is taking too long to join the
 * field, says so and offers "Test connection" — the field's passphrase,
 * tried on the robot's network (pFMS also tries it once by itself when the
 * names match). Renders nothing unless the robot Wi-Fi scan is on.
 */
function RobotWifiHeard({
  teamNumber,
  hasRobotOnField,
  onAdd,
}: {
  teamNumber: number;
  hasRobotOnField: boolean;
  onAdd: (suffix: string) => void;
}) {
  const scan = useRobotWifiScan();
  const sixGhzWatching = isSixGhzWatching(useSixGhzWatch());
  if (scan?.status !== 'running') return null;
  const stalls = stallsForTeam(scan, teamNumber);
  // A robot a stall already talks about isn't described twice
  const heard = broadcastsForTeam(scan, teamNumber).filter(b => !stalls.some(st => st.broadcast.ssid === b.ssid));
  const now = getServerTime();

  if (heard.length === 0 && stalls.length === 0) {
    // Only worth saying while they are still trying to get a robot on.
    if (hasRobotOnField) return null;
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The field listens for your robot&apos;s own Wi-Fi (FRC-{teamNumber}…) to help spot typos. None heard right now —
        is the robot powered on?
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
      {stalls.map(st => {
        const { severity, lines } = describeStallForTeam(st, now, { sixGhzWatching });
        const checking = st.keyCheck?.result === 'checking';
        return (
          <Alert key={st.station} severity={severity}>
            {lines.map(line => (
              <Typography key={line} variant="body2">
                {line}
              </Typography>
            ))}
            <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
              <Button size="small" variant="outlined" disabled={checking} onClick={() => sendRobotWifiTest(st.station)}>
                {checking ? 'Testing…' : st.keyCheck ? 'Test again' : 'Test connection'}
              </Button>
              {st.broadcast.match !== 'exact' && (
                <Button size="small" variant="contained" onClick={() => onAdd(suffixOf(st.broadcast.robotSsid))}>
                  Add as {st.broadcast.robotSsid}
                </Button>
              )}
            </Box>
          </Alert>
        );
      })}
      {heard.map(b => {
        const name = describeNameForTeam(b);
        return (
          <Alert key={b.ssid} severity={name.severity}>
            <Typography variant="body2">{name.text}</Typography>
            {b.match.kind !== 'exact' && (
              <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                <Button size="small" variant="contained" onClick={() => onAdd(suffixOf(b.robotSsid))}>
                  Add as {b.robotSsid}
                </Button>
              </Box>
            )}
          </Alert>
        );
      })}
    </Box>
  );
}

/**
 * Another access point broadcasting one of the team's network names on
 * 6 GHz — usually their own AP or spare radio left on, which the robot may
 * join instead of the field. Renders nothing unless the 6 GHz watch is on
 * and hears one.
 */
function SixGhzClashAlerts({ teamNumber }: { teamNumber: number }) {
  const clashes = clashesForTeam(useSixGhzWatch(), teamNumber);
  if (clashes.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
      {clashes.map(c => {
        const { severity, text } = describeClashForTeam(c);
        return (
          <Alert key={c.ssid} severity={severity}>
            <Typography variant="body2">{text}</Typography>
          </Alert>
        );
      })}
    </Box>
  );
}

/**
 * Form for adding a new robot (suffix + passphrase).
 */
function AddRobotForm({
  teamNumber,
  availableStation,
  initialSuffix = '',
  onDone,
  onSelectRobot,
}: {
  teamNumber: number;
  availableStation: StationName | null;
  /** Prefilled from the robot's own broadcast name ("Add as 1234-Comp"). */
  initialSuffix?: string;
  onDone: () => void;
  onSelectRobot: (ssid: string) => void;
}) {
  const [suffix, setSuffix] = useState(initialSuffix);
  const [passphrase, setPassphrase] = useState('');
  const allActiveSSIDs = useAllActiveSSIDs();

  const ssid = suffix ? `${teamNumber}-${suffix}` : `${teamNumber}`;
  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;
  const isValid = passphraseRegex.test(passphrase);
  const duplicateStation = allActiveSSIDs.get(ssid) ?? null;

  const handleSubmit = () => {
    if (!isValid || !availableStation) return;
    sendNewConfig(availableStation, ssid, passphrase);
    onSelectRobot(ssid); // Auto-select the newly added robot
    onDone();
  };

  const handleReplace = () => {
    if (!isValid || !duplicateStation) return;
    sendNewConfig(duplicateStation, ssid, passphrase);
    onSelectRobot(ssid);
    onDone();
  };

  /** Field full: keep the robot so Enable Robot is one tap once room opens. */
  const handleAdd = () => {
    if (!isValid) return;
    sendSaveTeam(ssid, passphrase);
    onSelectRobot(ssid);
    onDone();
  };

  return (
    <Card variant="outlined" sx={{ mb: 2, p: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        New Robot
      </Typography>
      <Typography variant="body2" color={duplicateStation ? 'warning.main' : 'text.secondary'} sx={{ mb: 1 }}>
        SSID: <strong>{ssid}</strong>
        {duplicateStation && ' — already on the field; saving replaces its passphrase'}
      </Typography>
      <TextField
        label="Suffix (optional)"
        value={suffix}
        onChange={e => setSuffix(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 10))}
        fullWidth
        size="small"
        helperText="Exactly as set on the radio. Capitals matter: Comp and comp are different robots."
        sx={{ mb: 1 }}
        InputProps={
          suffix
            ? {
                startAdornment: (
                  <InputAdornment position="start">
                    <Typography sx={{ fontFamily: 'monospace' }}>{teamNumber}-</Typography>
                  </InputAdornment>
                ),
              }
            : undefined
        }
      />
      <TextField
        label="Passphrase"
        value={passphrase}
        onChange={e => setPassphrase(e.target.value)}
        fullWidth
        size="small"
        helperText={
          passphrase && !isValid
            ? 'Must be 8-16 letters and numbers.'
            : 'The 6 GHz passphrase set on the radio. Capitals matter.'
        }
        error={!!passphrase && !isValid}
        sx={{ mb: 2 }}
      />
      <Box sx={{ display: 'flex', gap: 1 }}>
        {duplicateStation ? (
          <Button variant="contained" size="small" color="warning" disabled={!isValid} onClick={handleReplace}>
            Replace
          </Button>
        ) : availableStation ? (
          <Button variant="contained" size="small" disabled={!isValid} onClick={handleSubmit}>
            Enable Robot
          </Button>
        ) : (
          // Field full — the alert above says to ask field staff. Keep the
          // robot so Enable Robot is one tap once there is room.
          <Button variant="contained" size="small" disabled={!isValid} onClick={handleAdd}>
            Add robot
          </Button>
        )}
        <Button size="small" onClick={onDone}>
          Cancel
        </Button>
      </Box>
    </Card>
  );
}

/**
 * Debounce the "multiple DS" warning so it doesn't flicker when DS TCP flaps (~6s cycle).
 * Holds the warning for `holdMs` after the blocked-DS list clears, then releases.
 */
type DebouncedDsInfo = { acceptedIp: string; blockedIps: string[] } | null;

function useDebouncedMultipleDsWarning(station: StationName, holdMs = 10_000): DebouncedDsInfo {
  // Read from driveSessionState — the authoritative broadcast built from the
  // backend's accepted-DS/blocked-DS maps — NOT from matchState, whose per-station
  // DS entry expires after 20s idle and silently dropped block info (2026-07-12).
  const driveSession = useDriveSessionState();
  const liveBlockedIps = driveSession?.blockedDs?.[station];
  const liveAcceptedIp = driveSession?.sessions?.[station]?.dsIp;
  const hasBlocked = liveBlockedIps && liveBlockedIps.length > 0;

  const [displayed, setDisplayed] = useState<DebouncedDsInfo>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNonEmptyRef = useRef<DebouncedDsInfo>(null);

  useEffect(() => {
    if (hasBlocked && liveAcceptedIp) {
      // Blocked IPs present — show immediately and cancel any pending clear
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      const info: DebouncedDsInfo = { acceptedIp: liveAcceptedIp, blockedIps: [...liveBlockedIps] };
      lastNonEmptyRef.current = info;
      setDisplayed(info);
    } else if (lastNonEmptyRef.current) {
      // Blocked IPs just cleared — hold the previous value for holdMs
      if (!holdTimerRef.current) {
        holdTimerRef.current = setTimeout(() => {
          setDisplayed(null);
          lastNonEmptyRef.current = null;
          holdTimerRef.current = null;
        }, holdMs);
      }
    }
  }, [hasBlocked, liveAcceptedIp, liveBlockedIps, holdMs]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  return displayed;
}

/**
 * Alerts for the selected robot that must show whatever tab is open: the
 * team checks (a modal when something failed) and the multiple-Driver-Station
 * warning.
 */
function StationAlerts({ station }: { station: StationName }) {
  const multipleDsWarning = useDebouncedMultipleDsWarning(station);
  const yourIp = useRoutePreferenceState()?.yourIp;

  return (
    <>
      <TeamChecksModal station={station} />

      {/* DS connection alerts — shows all DS IPs (accepted + blocked) with debounced hold */}
      {multipleDsWarning && (
        <Alert
          severity="error"
          sx={{ mb: 1, fontWeight: 700, fontSize: '1.1rem', '& .MuiAlert-icon': { fontSize: '1.5rem' } }}
        >
          MULTIPLE DRIVER STATIONS DETECTED
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5, fontSize: '0.9rem', fontWeight: 400 }}>
            <li>
              <strong>
                <HostDisplay ip={multipleDsWarning.acceptedIp} />
              </strong>
              {multipleDsWarning.acceptedIp === yourIp && (
                <Chip label="YOU" size="small" color="info" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />
              )}
              {' — active'}
            </li>
            {multipleDsWarning.blockedIps.map(ip => (
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
            Close the extra Driver Station{multipleDsWarning.blockedIps.length > 1 ? 's' : ''}.
          </Typography>
        </Alert>
      )}
    </>
  );
}

/** A robot's network diagnostics card (DS, forwarding, subnet scan, mDNS). */
function StationNetwork({ station }: { station: StationName }) {
  const matchState = useMatchState();
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const mdnsActivity = useMdnsActivity();
  const yourIp = useRoutePreferenceState()?.yourIp;

  return (
    <StationNetworkCard
      station={station}
      stats={networkStats?.stations[station]}
      scan={subnetScan?.stations[station]}
      mdns={mdnsActivity?.stations[station]}
      dsInfo={matchState?.connectedStations[station]}
      hideStationLabel
      yourIp={yourIp}
    />
  );
}

/**
 * The selected robot's radio status: live charts, or tables of radio,
 * forwarding, telemetry, subnet scan and mDNS figures. The toggles are held
 * by the page so they survive switching tabs.
 */
function RadioStatusCard({
  station,
  chartMode,
  onChartModeChange,
  internetAccess,
  onInternetAccessChange,
}: {
  station: StationName;
  chartMode: boolean;
  onChartModeChange: (chartMode: boolean) => void;
  internetAccess: boolean;
  onInternetAccessChange: (on: boolean) => void;
}) {
  const latest = useLatest();
  const telemetry = useLatestTelemetry(station);
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const mdnsActivity = useMdnsActivity();

  const stationStatus = latest?.radioUpdate?.stationStatuses[station];
  const {
    ssid: stationSsid,
    isLinked,
    macAddress,
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
    dataAgeMs,
  } = stationStatus || {};

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h6">Radio Status</Typography>
            {isLinked ? (
              <Chip label="Linked" color="success" size="small" />
            ) : stationSsid ? (
              <Chip label="Not Linked" color="warning" size="small" variant="outlined" />
            ) : null}
          </Box>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            {/* Internet access toggle */}
            {stationSsid && (
              <Tooltip title={internetAccess ? 'Disable internet access' : 'Enable internet access'}>
                <IconButton
                  onClick={() => onInternetAccessChange(!internetAccess)}
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
            {/* Chart/table toggle */}
            <Tooltip title={chartMode ? 'Show table view' : 'Show live charts'}>
              <IconButton
                onClick={() => onChartModeChange(!chartMode)}
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
          </Box>
        </Box>

        {isLinked && macAddress && (
          <CopyToClipboard text={macAddress} tooltipText="Click to copy MAC address">
            <Typography
              variant="body2"
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color: 'text.secondary',
                mb: 1,
                cursor: 'pointer',
                '&:hover': { color: 'text.primary', backgroundColor: 'action.hover' },
                borderRadius: 0.5,
                px: 0.5,
                py: 0.25,
                transition: 'all 0.2s',
                width: 'fit-content',
              }}
            >
              {macAddress}
            </Typography>
          </CopyToClipboard>
        )}

        {chartMode && stationSsid ? (
          <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
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
          </Box>
        ) : stationSsid && isLinked ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {/* Signal Levels */}
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

            {/* Connection Quality, Bandwidth, and Data Age */}
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
                    {rxRateMbps && txRateMbps
                      ? `${formatNumberWithThinSpace((bandwidthUsedMbps! / Math.min(rxRateMbps, txRateMbps)) * 100)}%`
                      : '—'}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', color: 'warning.light', textAlign: 'right' }}>
                    {formatNumberWithThinSpace(dataAgeMs)} ms
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {/* TX/RX */}
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

            {/* IP Forwarding Counters */}
            {networkStats?.stations[station] &&
              (() => {
                const fwd = networkStats.stations[station]!;
                return (
                  <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
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

            {/* Robot Telemetry */}
            {telemetry && (
              <>
                <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
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
                        {telemetry.batteryVoltage !== undefined ? `${telemetry.batteryVoltage.toFixed(1)} V` : '—'}
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
                    {telemetry.dsStatus.aStop && (
                      <Chip
                        label="A-STOP"
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

            {/* Subnet Scan */}
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
                  <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>Host</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Device</TableCell>
                        <TableCell>Last Seen</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {scan.hosts.map(host => (
                        <TableRow key={host.ip} sx={{ opacity: host.alive ? 1 : 0.5 }}>
                          <TableCell sx={{ fontFamily: 'monospace' }}>
                            <HostDisplay ip={host.ip} />
                          </TableCell>
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

            {/* mDNS Activity */}
            {(() => {
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
                    <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
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
          </Box>
        ) : stationSsid ? (
          <Typography variant="body2" color="warning.main" sx={{ fontStyle: 'italic', mt: 1 }}>
            Radio not linked — waiting for connection...
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Port selector — lets a team bridge a physical Ethernet port to their station.
 * Only rendered when FIELD_PORTS is configured on the server.
 *
 * Shows a row of buttons, one per port:
 * - Bridged to THIS station: active/selected, clickable to disconnect
 * - Bridged to another station: disabled, shows the other team's SSID
 * - Free: clickable to bridge to this station
 */
function PortSelector({ station, ssid }: { station: StationName; ssid: string }) {
  const portState = usePortBridgeState();
  const latest = useLatest();

  // Don't render if port bridging is not configured
  if (!portState || portState.ports.length === 0) return null;

  const stationStatuses = latest?.radioUpdate?.stationStatuses;

  return (
    <Card sx={{ mb: 1 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', flexShrink: 0, fontSize: '0.8rem' }}>
            Connect to:
          </Typography>
          {portState.ports.map(port => {
            const bridgedToStation = portState.activeBridges[port.vlanId] ?? null;
            const isMine = bridgedToStation === station;
            const isOther = bridgedToStation !== null && !isMine;

            // Find the SSID on the other station using this port
            const otherSsid = isOther ? (stationStatuses?.[bridgedToStation!]?.ssid ?? bridgedToStation) : null;

            const handleClick = () => {
              if (isMine) {
                // Toggle off — disconnect this port
                sendPortBridge(station, null);
              } else if (!isOther) {
                // Free port — connect it
                sendPortBridge(station, port.vlanId);
              }
              // isOther: disabled, no action
            };

            return (
              <Tooltip
                key={port.vlanId}
                title={
                  isMine
                    ? `Disconnect ${port.name}`
                    : isOther
                      ? `${port.name} — in use by ${otherSsid}`
                      : `Connect ${port.name} to ${ssid}`
                }
              >
                <span style={{ flex: 1, display: 'flex' }}>
                  <Button
                    size="small"
                    variant={isMine ? 'contained' : 'outlined'}
                    color={isMine ? 'success' : 'primary'}
                    disabled={isOther}
                    onClick={handleClick}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      px: 1,
                      fontSize: '0.75rem',
                      textTransform: 'none',
                      fontWeight: isMine ? 700 : 400,
                    }}
                  >
                    {isOther ? (otherSsid ?? port.name) : port.name}
                  </Button>
                </span>
              </Tooltip>
            );
          })}
        </Box>
      </CardContent>
    </Card>
  );
}
