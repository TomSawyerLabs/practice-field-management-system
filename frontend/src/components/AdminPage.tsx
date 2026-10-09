import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { MatchRecordingSection } from './MatchRecordingSection';
import { TimelapseSettingsSection } from './TimelapseSection';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';

import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';

import type { StationName, StationControlState, ControllerPolicy } from '../../../src/types';
import { StationNameList } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { PendingRadioChangesPanel } from './PendingRadioChanges';

import type { ApiKeyCreated, ExternalAccessTokenCreated, PendingDevice } from '../../../src/types';
import type {
  RobotWifiKeyCheck,
  RobotWifiScanState,
  SixGhzNetwork,
  SixGhzWatchState,
  WifiCardInfo,
  WifiSecurity,
  WifiTestJoinResult,
} from '../../../src/types';
import {
  useMatchState,
  useLatest,
  useScoreState,
  useApiKeyState,
  useApiKeyCreatedEvent,
  useSlackConfigState,
  useSlackTestResult,
  sendAdminStopMatch,
  sendAdminGlobalEStop,
  sendAdminClearEStop,
  sendAdminClearAllStations,
  sendAdminRestart,
  sendMatchKickStation,
  sendNewConfig,
  sendRemoveSavedTeam,
  sendStopCast,
  useCastReceivers,
  sendCastReceiverSwap,
  sendCastReceiverMute,
  sendCastReceiverChecks,
  useFirmwareStore,
  sendCreateApiKey,
  sendRevokeApiKey,
  sendReactivateApiKey,
  sendDeleteApiKey,
  sendApprovePendingDevice,
  sendDismissPendingDevice,
  sendScoreReset,
  sendSaveSlackConfig,
  sendTestSlackConnection,
  useExternalAccessState,
  useExternalAccessTokenCreatedEvent,
  sendCreateExternalAccessToken,
  sendRevokeExternalAccessToken,
  useAudioDeviceState,
  sendSaveAudioDeviceConfig,
  sendTestAudioDevice,
  sendRefreshAudioDevices,
  useSetupConfig,
  useRobotWifiScan,
  useSixGhzWatch,
  useWifiCards,
  sendWifiTestJoin,
  useMatchRecordingState,
  sendUpdateSetupSettings,
} from '../hooks/useBackend';

import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';

// ── Global E-Stop ───────────────────────────────────────────────────

/** E-STOP ALL stops every robot on the field — in a match or not (out of a
 *  match the field cuts its Driver Station's control traffic and takes the DS
 *  under field control). Stopped robots stay held until staff clear it here
 *  or per station on the match page. */
function GlobalEStopSection() {
  const matchState = useMatchState();
  const stopped = StationNameList.filter(s => matchState?.stationStates[s]?.eStop);
  const [confirmClear, setConfirmClear] = useState(false);
  const phase = matchState?.phase;
  const matchRunning = phase !== undefined && phase !== 'idle' && phase !== 'postMatch';
  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          variant="contained"
          color="error"
          fullWidth
          sx={{ fontSize: '1.5rem', py: 2.5, fontWeight: 'bold' }}
          onClick={() => sendAdminGlobalEStop()}
        >
          E-STOP ALL
        </Button>
        {/* The one way to end a running match early without e-stopping
            anyone: /match only aborts a countdown. */}
        {matchRunning && (
          <Button
            variant="outlined"
            color="error"
            sx={{ fontWeight: 'bold', flexShrink: 0, px: 3 }}
            onClick={sendAdminStopMatch}
          >
            Force stop match
          </Button>
        )}
      </Box>
      {stopped.length > 0 && (
        <Alert
          severity="error"
          sx={{ mt: 1 }}
          action={
            confirmClear ? (
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    sendAdminClearEStop();
                    setConfirmClear(false);
                  }}
                >
                  Yes, clear
                </Button>
                <Button color="inherit" size="small" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
              </Box>
            ) : (
              <Button color="inherit" size="small" onClick={() => setConfirmClear(true)}>
                Clear all e-stops
              </Button>
            )
          }
        >
          E-stopped: {stopped.map(s => prettyStationName(s)).join(', ')}. These robots stay stopped until the e-stop is
          cleared; teams then enable again from their Driver Station.
        </Alert>
      )}
    </Box>
  );
}

// ── Connected Teams ─────────────────────────────────────────────────

/** How the team list is ordered. Connection time is the default: it reads as
 *  the queue the teams arrived in, and it does not reshuffle when a robot
 *  drops its radio link or gets enabled. */
type TeamSortKey = 'connected' | 'team' | 'enabled' | 'slot';

const teamSortLabels: Record<TeamSortKey, string> = {
  connected: 'Connected',
  team: 'Team',
  enabled: 'Last enabled',
  slot: 'Slot',
};

/** Ascending means "smallest first" for the column's own value; for the two
 *  time columns that is the oldest, which is the order worth landing on when
 *  you first pick them. */
const teamSortDefaultDirection: Record<TeamSortKey, 'asc' | 'desc'> = {
  connected: 'asc',
  team: 'asc',
  enabled: 'desc',
  slot: 'asc',
};

/** A compact elapsed time — finer than hour-rounding, because a team that has
 *  been on the field 2h40m should not read the same as one at 2h05m. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

type TeamRow = {
  station: StationName;
  teamNumber: number;
  /** The robot's SSID as the radio reports it (the saved-team key). */
  ssid: string | null;
  state: StationControlState;
  isRobotLinked: boolean;
};

/** One row per team on the field. Slots with no team are left out entirely —
 *  an unconfigured slot has nothing to control and nothing to report. */
function useConnectedTeamRows(): TeamRow[] {
  const matchState = useMatchState();
  const latest = useLatest();

  return StationNameList.flatMap(station => {
    const state = matchState?.stationStates[station];
    if (!state || state.teamNumber === null) return [];
    const radio = latest?.radioUpdate?.stationStatuses[station];
    return [
      {
        station,
        teamNumber: state.teamNumber,
        ssid: radio?.ssid || null,
        state,
        isRobotLinked: radio?.isLinked ?? false,
      },
    ];
  });
}

function sortTeamRows(rows: TeamRow[], key: TeamSortKey, direction: 'asc' | 'desc'): TeamRow[] {
  const value = (row: TeamRow): number => {
    switch (key) {
      case 'team':
        return row.teamNumber;
      case 'slot':
        return StationNameList.indexOf(row.station);
      // A missing timestamp sorts as the oldest: a team restored from a config
      // written before pFMS tracked this has, in fact, been here a while.
      case 'connected':
        return row.state.connectedAt ?? 0;
      case 'enabled':
        return row.state.lastEnabledAt ?? 0;
    }
  };
  const sign = direction === 'asc' ? 1 : -1;
  // Slot order is the tiebreak, so equal values (a whole field enabled in the
  // same instant) stay put instead of jittering between renders.
  return [...rows].sort(
    (a, b) => sign * (value(a) - value(b)) || StationNameList.indexOf(a.station) - StationNameList.indexOf(b.station),
  );
}

/** The team's control state, as the chips the admin actually acts on. */
function TeamStateChips({ state, isRobotLinked }: { state: StationControlState; isRobotLinked: boolean }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {isRobotLinked ? (
        <Chip label="Robot linked" size="small" color="success" variant="outlined" />
      ) : (
        <Chip label="No robot" size="small" color="warning" variant="outlined" />
      )}
      {state.joined && <Chip label="Joined" size="small" color="primary" variant="outlined" />}
      {state.eStop && <Chip label="E-STOP" size="small" color="error" />}
      {state.aStop && <Chip label="A-STOP" size="small" color="warning" />}
      {state.enabled && <Chip label="Enabled" size="small" color="success" />}
      {!state.enabled && !state.eStop && !state.aStop && <Chip label="Disabled" size="small" variant="outlined" />}
      {state.blockedReason && <Chip label="Blocked" size="small" color="warning" variant="outlined" />}
    </Box>
  );
}

/** Slot management, not robot control: the field's E-Stop is the big button
 *  at the top, and a robot's enable/disable belongs to the match page.
 *  - Release: take the robot off the field (its Wi-Fi is turned off). Goes
 *    through the same path as a team's own release, so it waits for enabled
 *    robots or a match like any other change.
 *  - Kick: drop the team from the match being set up.
 *  - Forget: release AND delete the team's saved passphrase, so the robot has
 *    to be added again from scratch. Two taps, since it is not undoable. */
function TeamControlButtons({ row }: { row: TeamRow }) {
  const { station, state, ssid } = row;
  const matchState = useMatchState();
  const [confirmForget, setConfirmForget] = useState(false);
  const canKick = state.joined && matchState?.phase === 'created';

  useEffect(() => {
    if (!confirmForget) return;
    const timer = setTimeout(() => setConfirmForget(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmForget]);

  return (
    <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {canKick && (
        <Button size="small" variant="outlined" color="warning" onClick={() => sendMatchKickStation(station)}>
          Kick
        </Button>
      )}
      <Button size="small" variant="outlined" color="warning" onClick={() => sendNewConfig(station, '', '')}>
        Release
      </Button>
      {ssid &&
        (confirmForget ? (
          <Button
            size="small"
            variant="contained"
            color="error"
            onClick={() => {
              sendRemoveSavedTeam(ssid);
              setConfirmForget(false);
            }}
          >
            Forget {ssid}?
          </Button>
        ) : (
          <Button size="small" variant="outlined" color="error" onClick={() => setConfirmForget(true)}>
            Forget
          </Button>
        ))}
    </Box>
  );
}

function ConnectedTeamRow({ row }: { row: TeamRow }) {
  const { station, teamNumber, state, isRobotLinked } = row;
  const now = Date.now();

  return (
    <TableRow hover>
      <TableCell>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TeamAvatar teamNumber={teamNumber} size={28} />
          <Typography variant="subtitle1" fontWeight="bold" sx={{ whiteSpace: 'nowrap' }}>
            {teamNumber}
          </Typography>
        </Box>
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>{prettyStationName(station)}</TableCell>
      <TableCell>
        <TeamStateChips state={state} isRobotLinked={isRobotLinked} />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        {state.connectedAt === undefined ? (
          <Typography variant="body2" sx={{ color: 'text.disabled' }}>
            unknown
          </Typography>
        ) : (
          <Typography variant="body2">{formatElapsed(now - state.connectedAt)}</Typography>
        )}
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        {state.enabled ? (
          <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 'bold' }}>
            now
          </Typography>
        ) : state.lastEnabledAt === undefined ? (
          <Typography variant="body2" sx={{ color: 'text.disabled' }}>
            never
          </Typography>
        ) : (
          <Typography variant="body2">{formatElapsed(now - state.lastEnabledAt)} ago</Typography>
        )}
      </TableCell>
      <TableCell align="right">
        <TeamControlButtons row={row} />
      </TableCell>
    </TableRow>
  );
}

function StationControlSection() {
  const rows = useConnectedTeamRows();
  const [sortKey, setSortKey] = useState<TeamSortKey>('connected');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(teamSortDefaultDirection.connected);
  const [, setTick] = useState(0);

  // Re-render every second so the elapsed-time columns stay honest
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const sortBy = (key: TeamSortKey) => {
    if (key === sortKey) setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDirection(teamSortDefaultDirection[key]);
    }
  };

  const sorted = sortTeamRows(rows, sortKey, sortDirection);

  const sortableHeader = (key: TeamSortKey) => (
    <TableCell sortDirection={sortKey === key ? sortDirection : false} sx={{ whiteSpace: 'nowrap' }}>
      <TableSortLabel
        active={sortKey === key}
        direction={sortKey === key ? sortDirection : teamSortDefaultDirection[key]}
        onClick={() => sortBy(key)}
      >
        {teamSortLabels[key]}
      </TableSortLabel>
    </TableCell>
  );

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h5">Teams &amp; Controls</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Every team on the field, longest-connected first. Tap a column heading to reorder. Slots with no team are not
          listed. Release takes a robot off the field; Forget also deletes its saved passphrase.
        </Typography>

        {sorted.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
            No teams are on the field. A team appears here once a radio slot is configured for it.
          </Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {sortableHeader('team')}
                  {sortableHeader('slot')}
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>State</TableCell>
                  {sortableHeader('connected')}
                  {sortableHeader('enabled')}
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {sorted.map(row => (
                  <ConnectedTeamRow key={row.station} row={row} />
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/** Admin switch: may teams drive (enable from their own Driver Station)
 *  while they are not in a match? Allowed by default. Words chosen so
 *  "enabled"/"disabled" — which mean something else for a robot — never
 *  appear: the state is Allowed or Held, and the button names the action.
 *  Setting key stays `outOfMatchControl`. */
function OutOfMatchControlSection() {
  const setupConfig = useSetupConfig();
  const allowed = setupConfig?.config.settings.outOfMatchControl !== false;
  return (
    <Card sx={{ mb: 3 }}>
      <CardContent
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}
      >
        <Box sx={{ minWidth: 260, flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h6">Freeplay outside matches</Typography>
            <Chip size="small" color={allowed ? 'success' : 'warning'} label={allowed ? 'Allowed' : 'Held'} />
          </Box>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            {allowed
              ? 'Teams can enable their robot from their own Driver Station whenever it is not in a match.'
              : 'Robots stay disabled unless they are in a match. The Driver Station shows "Admin disabled" and the team\'s station page says why.'}
          </Typography>
        </Box>
        <Button
          variant="outlined"
          color={allowed ? 'warning' : 'success'}
          onClick={() => sendUpdateSetupSettings({ outOfMatchControl: !allowed })}
        >
          {allowed ? 'Hold robots' : 'Allow freeplay'}
        </Button>
      </CardContent>
    </Card>
  );
}

const KEY_CHECK_LABELS: Record<RobotWifiKeyCheck['result'], string> = {
  checking: 'Checking…',
  ok: 'Works',
  wrongKey: 'Wrong passphrase',
  unreachable: 'Could not check',
  open: 'No passphrase',
};

const CARD_USE: Record<
  WifiCardInfo['use'],
  { label: string; color: 'default' | 'success' | 'info' | 'warning' | 'error' }
> = {
  free: { label: 'Free', color: 'success' },
  robotScan: { label: 'Robot scan', color: 'info' },
  sixGhzWatch: { label: '6 GHz watch', color: 'info' },
  test: { label: 'Testing', color: 'info' },
  host: { label: 'In use by host', color: 'warning' },
  blocked: { label: 'Blocked', color: 'error' },
};

const TEST_OUTCOME: Record<
  WifiTestJoinResult['outcome'],
  { label: string; color: 'default' | 'success' | 'warning' | 'error' }
> = {
  running: { label: 'Joining…', color: 'default' },
  connected: { label: 'Joined', color: 'success' },
  wrongKey: { label: 'Wrong passphrase', color: 'error' },
  notFound: { label: 'Not heard', color: 'default' },
  needsPassphrase: { label: 'Needs a passphrase', color: 'warning' },
  failed: { label: 'Failed', color: 'error' },
  timeout: { label: 'No answer', color: 'warning' },
};

const SECURITY_LABEL: Record<WifiSecurity, string> = { 'WPA-PSK': 'WPA2', SAE: 'WPA3', open: 'open' };

/** 2412 → 6, 5180 → 36, 5955 → 1 (6 GHz). */
function wifiChannel(mhz: number): string {
  if (mhz === 2484) return '2.4 GHz ch 14';
  if (mhz >= 2412 && mhz <= 2472) return `2.4 GHz ch ${(mhz - 2407) / 5}`;
  if (mhz >= 5160 && mhz <= 5885) return `5 GHz ch ${(mhz - 5000) / 5}`;
  if (mhz >= 5955 && mhz <= 7115) return `6 GHz ch ${(mhz - 5950) / 5}`;
  return `${mhz} MHz`;
}

/** The wireless cards on the pFMS host: what each is doing, and a test join
 *  on the ones pFMS may use — join a network briefly (no address) to see
 *  whether it can, then leave. */
function WifiCardsSection() {
  const state = useWifiCards();
  const heard = useRobotWifiScan()?.broadcasts ?? [];
  const phase = useMatchState()?.phase;
  const matchActive = phase !== undefined && phase !== 'idle' && phase !== 'created' && phase !== 'postMatch';
  const [testing, setTesting] = useState<string | null>(null);
  const [ssid, setSsid] = useState('');
  const [passphrase, setPassphrase] = useState('');
  if (!state) return null;
  const { cards, tests } = state;

  const open = (iface: string) => {
    setTesting(iface);
    setSsid('');
    setPassphrase('');
  };
  const submit = () => {
    if (!testing || !ssid) return;
    sendWifiTestJoin(testing, ssid, passphrase || undefined);
    setTesting(null);
    setPassphrase('');
  };
  const passphraseProblem =
    passphrase && !/^[\x20-\x7e]{8,63}$/.test(passphrase) ? '8 to 63 printable characters' : null;

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h6">Wireless cards</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Wi-Fi cards on the pFMS host. One can listen for robots, another on 6 GHz for other access points (below). Any
          card the host isn&apos;t using can test-join a network: pFMS joins it, says whether that worked, and leaves —
          it never takes an address, so the host&apos;s own networking is untouched.
        </Typography>
        {cards.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No wireless card found on the pFMS host.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Card</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {cards.map(c => {
                const use = CARD_USE[c.use];
                const why = matchActive ? 'Not during a match' : c.canTestJoin ? '' : c.detail;
                return (
                  <TableRow key={c.iface}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                        {c.iface}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {[c.driver, c.mac].filter(Boolean).join(' · ')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Chip size="small" color={use.color} label={use.label} />
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                          {c.detail}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title={why}>
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={!!why}
                            onClick={() => open(c.iface)}
                            sx={{ whiteSpace: 'nowrap' }}
                          >
                            Test join
                          </Button>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {tests.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Recent test joins
            </Typography>
            <Table size="small">
              <TableBody>
                {tests.map(t => {
                  const outcome = TEST_OUTCOME[t.outcome];
                  const facts = [
                    t.frequency !== undefined && wifiChannel(t.frequency),
                    t.signal !== undefined && `${t.signal} dBm`,
                    t.security && SECURITY_LABEL[t.security],
                    t.bssid,
                    t.joinMs !== undefined && `answered in ${(t.joinMs / 1000).toFixed(1)} s, then left`,
                    t.durationMs !== undefined && `${(t.durationMs / 1000).toFixed(1)} s in all`,
                  ].filter(Boolean);
                  return (
                    <TableRow key={t.id}>
                      <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                        {new Date(t.at).toLocaleTimeString()}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {t.ssid}
                        </Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          on {t.iface}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={outcome.color}
                          label={outcome.label}
                          icon={t.outcome === 'running' ? <CircularProgress size={12} /> : undefined}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                          {facts.join(' · ')}
                        </Typography>
                        {t.detail && (
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            {t.detail}
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </CardContent>

      <Dialog open={testing !== null} onClose={() => setTesting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Test join on {testing}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            pFMS scans for the network, joins its strongest access point, reports what happened, and leaves. No address
            is taken. The passphrase is used for this test only — never stored.
          </Typography>
          <Autocomplete
            freeSolo
            options={[...new Set(heard.map(b => b.ssid))]}
            inputValue={ssid}
            onInputChange={(_, v) => setSsid(v)}
            renderInput={params => (
              <TextField
                {...params}
                autoFocus
                label="Network name (SSID)"
                helperText="Exact, capitals included. Robot networks heard nearby are suggested."
                inputProps={{ ...params.inputProps, maxLength: 32 }}
              />
            )}
          />
          <TextField
            fullWidth
            sx={{ mt: 2 }}
            type="password"
            label="Passphrase"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !passphraseProblem && submit()}
            error={!!passphraseProblem}
            helperText={passphraseProblem ?? 'Leave empty for an open network'}
            autoComplete="off"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTesting(null)}>Cancel</Button>
          <Button variant="contained" onClick={submit} disabled={!ssid || !!passphraseProblem}>
            Join
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

/** Robot Wi-Fi scan: which wireless card pFMS may use to listen for robots'
 *  2.4 GHz networks and check saved passphrases, and what it hears. The card
 *  is dedicated to this — pFMS runs its own wpa_supplicant on it. */
function RobotWifiScanSection() {
  const setupConfig = useSetupConfig();
  const scan = useRobotWifiScan();
  const chosen = setupConfig?.config.settings.robotWifiInterface ?? '';
  const interfaces = scan?.interfaces ?? [];
  const cards = useWifiCards()?.cards ?? [];
  const statusChip: Record<
    RobotWifiScanState['status'],
    { label: string; color: 'default' | 'success' | 'info' | 'error' }
  > = {
    off: { label: 'Off', color: 'default' },
    starting: { label: 'Starting', color: 'info' },
    running: { label: 'Listening', color: 'success' },
    error: { label: 'Stopped', color: 'error' },
  };
  const status = statusChip[scan?.status ?? 'off'];

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
          <Typography variant="h6">Robot Wi-Fi scan</Typography>
          <Chip size="small" color={status.color} label={status.label} />
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Listens for the 2.4 GHz network every robot radio broadcasts (FRC-1234 or FRC-1234-Suffix) and tells the team,
          and the CSA page, when it doesn&apos;t match what they saved — capitals included. The first time a saved
          passphrase can be tried, pFMS joins that network briefly to check it. Needs a spare wireless card that nothing
          else uses.
        </Typography>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="robot-wifi-iface">Wireless card</InputLabel>
          <Select
            labelId="robot-wifi-iface"
            label="Wireless card"
            value={chosen}
            onChange={e => sendUpdateSetupSettings({ robotWifiInterface: String(e.target.value) })}
          >
            <MenuItem value="">Off</MenuItem>
            {[...new Set([...interfaces, ...(chosen ? [chosen] : [])])].map(i => {
              const card = cards.find(c => c.iface === i);
              return (
                // A card the host is using can't be picked (it stays listed,
                // and selectable once chosen, so it can be switched off).
                <MenuItem key={i} value={i} disabled={card ? !card.canRobotScan && i !== chosen : false}>
                  <Box>
                    <Box sx={{ fontFamily: 'monospace' }}>{i}</Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {interfaces.includes(i) ? (card?.detail ?? '') : 'not found on this host'}
                    </Typography>
                  </Box>
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
        {interfaces.length === 0 && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
            No wireless card found on the pFMS host.
          </Typography>
        )}
        {scan?.status === 'error' && scan.error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {scan.error}
          </Alert>
        )}

        {scan?.status === 'running' && (
          <Box sx={{ mt: 2 }}>
            {scan.broadcasts.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                No robot networks heard{scan.lastScanAt ? '' : ' yet'}.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Heard</TableCell>
                    <TableCell>Signal</TableCell>
                    <TableCell>Saved as</TableCell>
                    <TableCell>Passphrase</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {scan.broadcasts.map(b => {
                    // A stalled connection's test (the field's passphrase) wins over
                    // the saved passphrase tried before the robot was enabled
                    const keyCheck = scan.stalls?.find(st => st.broadcast.ssid === b.ssid)?.keyCheck ?? b.keyCheck;
                    return (
                      <TableRow key={b.ssid}>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{b.ssid}</TableCell>
                        <TableCell>{b.signal} dBm</TableCell>
                        <TableCell>
                          {b.match.kind === 'exact' ? (
                            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                              {b.match.savedSsid}
                            </Typography>
                          ) : b.match.kind === 'caseOnly' ? (
                            <Chip size="small" color="error" label={`${b.match.savedSsid} — capitals differ`} />
                          ) : (
                            <Typography variant="body2" sx={{ color: 'text.disabled' }}>
                              not saved
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          {keyCheck ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              color={
                                keyCheck.result === 'ok'
                                  ? 'success'
                                  : keyCheck.result === 'wrongKey'
                                    ? 'error'
                                    : 'default'
                              }
                              label={KEY_CHECK_LABELS[keyCheck.result]}
                            />
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

const SIX_GHZ_KIND: Record<
  SixGhzNetwork['kind'],
  { label: string; color: 'default' | 'success' | 'warning' | 'error' }
> = {
  competing: { label: 'Competing with the field', color: 'error' },
  teamAp: { label: "Team's own AP?", color: 'warning' },
  field: { label: 'Field', color: 'success' },
  other: { label: 'Other', color: 'default' },
};

/** 6 GHz watch: which wireless card pFMS may use to listen on 6 GHz for
 *  other access points using a team's network name, the Wi-Fi country it
 *  needs, and everything it hears. Scan only — the card never joins. */
function SixGhzWatchSection() {
  const setupConfig = useSetupConfig();
  const watch = useSixGhzWatch();
  const cards = useWifiCards()?.cards ?? [];
  const settings = setupConfig?.config.settings;
  const chosen = settings?.sixGhzWatchInterface ?? '';
  const [country, setCountry] = useState<string | null>(null);
  const savedCountry = settings?.wifiCountry ?? '';
  const countryDraft = country ?? savedCountry;
  const countryOk = countryDraft === '' || /^[A-Z]{2}$/.test(countryDraft);
  const commitCountry = () => {
    if (country === null) return;
    if (countryOk && country !== savedCountry) sendUpdateSetupSettings({ wifiCountry: country || undefined });
    setCountry(null);
  };
  const statusChip: Record<
    SixGhzWatchState['status'],
    { label: string; color: 'default' | 'success' | 'info' | 'error' }
  > = {
    off: { label: 'Off', color: 'default' },
    starting: { label: 'Starting', color: 'info' },
    running: { label: 'Listening', color: 'success' },
    error: { label: 'Stopped', color: 'error' },
  };
  const status = statusChip[watch?.status ?? 'off'];
  const ifaces = [...new Set([...cards.map(c => c.iface), ...(chosen ? [chosen] : [])])];
  const facts =
    watch?.status === 'running'
      ? [
          `${watch.channels} channel${watch.channels === 1 ? '' : 's'}`,
          watch.country && `country ${watch.country}`,
          watch.field && `field on 6 GHz ch ${watch.field.channel} (${watch.field.bandwidthMHz} MHz)`,
          watch.lastScanAt ? `last scan ${new Date(watch.lastScanAt).toLocaleTimeString()}` : 'first scan running',
        ].filter(Boolean)
      : [];

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
          <Typography variant="h6">6 GHz watch</Typography>
          <Chip size="small" color={status.color} label={status.label} />
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Listens on 6 GHz for other access points using a team&apos;s network name — usually a team&apos;s own AP or
          spare radio left on, which their robot may join instead of the field. Warns the team and the CSA page. Needs a
          6 GHz-capable card that nothing else uses (not the robot scan&apos;s); it only listens, never joins. Sets the
          host&apos;s Wi-Fi country, which 6 GHz needs.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel id="six-ghz-iface">Wireless card</InputLabel>
            <Select
              labelId="six-ghz-iface"
              label="Wireless card"
              value={chosen}
              onChange={e => sendUpdateSetupSettings({ sixGhzWatchInterface: String(e.target.value) })}
            >
              <MenuItem value="">Off</MenuItem>
              {ifaces.map(i => {
                const card = cards.find(c => c.iface === i);
                return (
                  // A card in use elsewhere can't be picked (it stays listed,
                  // and selectable once chosen, so it can be switched off).
                  <MenuItem key={i} value={i} disabled={card ? !card.canSixGhzWatch && i !== chosen : false}>
                    <Box>
                      <Box sx={{ fontFamily: 'monospace' }}>{i}</Box>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {card ? [card.driver, card.detail].filter(Boolean).join(' · ') : 'not found on this host'}
                      </Typography>
                    </Box>
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="Wi-Fi country"
            placeholder="US"
            value={countryDraft}
            onChange={e => setCountry(e.target.value.toUpperCase().slice(0, 2))}
            onBlur={commitCountry}
            onKeyDown={e => e.key === 'Enter' && commitCountry()}
            error={!countryOk}
            helperText={countryOk ? 'Two letters; empty = US' : 'Two letters, e.g. US'}
            sx={{ width: 140 }}
          />
        </Box>
        {watch?.status === 'error' && watch.error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {watch.error}
          </Alert>
        )}
        {watch?.problem && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            {watch.problem}
          </Alert>
        )}

        {watch?.status === 'running' && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
              {facts.join(' · ')}
            </Typography>
            {watch.networks.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Nothing heard on 6 GHz{watch.lastScanAt ? '' : ' yet'}.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Network</TableCell>
                    <TableCell>Access point</TableCell>
                    <TableCell>Channel</TableCell>
                    <TableCell>Signal</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {watch.networks.map(n => {
                    const kind = SIX_GHZ_KIND[n.kind];
                    return (
                      <TableRow key={n.bssid}>
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          {n.ssid || (
                            <Typography component="span" variant="body2" sx={{ color: 'text.disabled' }}>
                              (hidden)
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{n.bssid}</TableCell>
                        <TableCell>{wifiChannel(n.frequency)}</TableCell>
                        <TableCell>{n.signal} dBm</TableCell>
                        <TableCell>
                          <Chip size="small" variant="outlined" color={kind.color} label={kind.label} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/** Holds on Wi-Fi changes: teams' requests are parked instead of applied
 *  until staff apply them — always, or only around a match. The
 *  pending panel underneath is the same one the match page shows. */
function WifiChangesSection() {
  const setupConfig = useSetupConfig();
  const hold = setupConfig?.config.settings.holdRadioChanges === true;
  const holdForMatch = setupConfig?.config.settings.holdRadioChangesForMatch !== false;
  const releaseAfterMatch = setupConfig?.config.settings.releaseAfterMatch !== false;
  return (
    <>
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6">Wi-Fi changes</Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={hold}
                onChange={e => sendUpdateSetupSettings({ holdRadioChanges: e.target.checked })}
              />
            }
            label="Hold Wi-Fi changes until I apply them"
          />
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
            {hold
              ? 'Teams can still press Enable Robot, but nothing reaches the radio until you press Apply now below.'
              : 'Teams’ Wi-Fi requests apply as they come — as soon as every robot is disabled — unless something is already waiting, in which case they join that batch. Tick this to hold them all the time, e.g. a busy scrimmage day. Waiting changes only go out when you press Apply now.'}
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={holdForMatch}
                onChange={e => sendUpdateSetupSettings({ holdRadioChangesForMatch: e.target.checked })}
              />
            }
            label="Hold Wi-Fi changes while a match is set up"
          />
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
            {holdForMatch
              ? 'While a match is set up or just over, requests wait for Apply now. The match page has this same switch. A set-up match that no team joins cancels itself after 10 minutes and lets waiting robots join.'
              : 'Requests apply as they come even while a match is set up or just over. They are still held while a match is running.'}
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={releaseAfterMatch}
                onChange={e => sendUpdateSetupSettings({ releaseAfterMatch: e.target.checked })}
              />
            }
            label="Queue every robot to leave when a match ends"
          />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {releaseAfterMatch
              ? 'When a match ends, every robot on the field is queued to leave so the next match starts clean. A robot that joins the next match, or whose team presses Keep, stays. Nothing leaves until you press Apply now.'
              : 'Robots stay on the field after a match until their team releases them or you clear the radio.'}
          </Typography>
        </CardContent>
      </Card>
      <PendingRadioChangesPanel />
    </>
  );
}

/** Staff escape hatches for a field that has got into a state: empty the
 *  radio, or restart the backend. Both confirm first and refuse mid-match
 *  (the server refuses too). */
function FieldResetSection() {
  const matchState = useMatchState();
  const [confirm, setConfirm] = useState<'clear' | 'restart' | null>(null);
  const phase = matchState?.phase ?? 'idle';
  const matchActive = phase !== 'idle' && phase !== 'created' && phase !== 'postMatch';

  const run = () => {
    if (confirm === 'clear') sendAdminClearAllStations();
    if (confirm === 'restart') sendAdminRestart();
    setConfirm(null);
  };

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6">Field reset</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          For when the radio and pFMS disagree and keep reconfiguring, or a slot will not clear. Neither is available
          while a match is running.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="outlined" color="warning" disabled={matchActive} onClick={() => setConfirm('clear')}>
            Clear all robots from the radio
          </Button>
          <Button variant="outlined" color="warning" disabled={matchActive} onClick={() => setConfirm('restart')}>
            Restart pFMS
          </Button>
        </Box>
      </CardContent>
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogTitle>{confirm === 'clear' ? 'Clear all robots from the radio?' : 'Restart pFMS?'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirm === 'clear'
              ? 'Every robot loses its Wi-Fi and any waiting Wi-Fi requests are dropped, so teams will need to press Enable Robot again. Robots joined to a match being set up leave it.'
              : 'Every page reconnects in a few seconds. Network rules and routing are kept, so robots stay on Wi-Fi and Driver Stations re-attach on their own.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button onClick={run} variant="contained" color="warning">
            {confirm === 'clear' ? 'Clear the radio' : 'Restart'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

/** Field policy on robot control systems. Advisory: it changes what a team
 *  sees in their robot check, it does not stop a robot connecting. */
function ControllerPolicySection() {
  const setupConfig = useSetupConfig();
  const policy: ControllerPolicy = setupConfig?.config.settings.controllerPolicy ?? 'none';
  const options: { value: ControllerPolicy; label: string; help: string }[] = [
    { value: 'none', label: 'No preference', help: 'Both control systems are fine. Teams see nothing about this.' },
    {
      value: 'preferSystemCore',
      label: 'Encourage SystemCore',
      help: 'Teams still on the roboRIO get a warning in their robot check. They are still allowed to play.',
    },
    {
      value: 'blockRoboRIO',
      label: 'SystemCore only',
      help: 'roboRIO robots cannot be enabled — in a match or messing around out of one.',
    },
    {
      value: 'blockSystemCore',
      label: 'No SystemCore',
      help: 'SystemCore robots cannot be enabled — in a match or messing around out of one.',
    },
  ];
  const current = options.find(o => o.value === policy) ?? options[0];
  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
          <Typography variant="h6">Robot control system</Typography>
          <Chip
            size="small"
            color={policy === 'none' ? 'default' : policy === 'preferSystemCore' ? 'info' : 'warning'}
            label={current.label}
          />
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          {current.help} A blocked robot still connects and shows up normally; the field simply refuses to enable it,
          and its station says why. Only a robot whose control system was positively identified is blocked.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {options.map(o => (
            <Button
              key={o.value}
              size="small"
              variant={o.value === policy ? 'contained' : 'outlined'}
              color={o.value === policy ? 'primary' : 'inherit'}
              onClick={() => sendUpdateSetupSettings({ controllerPolicy: o.value })}
            >
              {o.label}
            </Button>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Recordings (watched on their own page) ──────────────────────────

/** Everything filmed is watched — and deleted — on /recordings, which anyone
 *  may open; this tab only holds the settings. */
function RecordingsLinkSection() {
  const recording = useMatchRecordingState();
  return (
    <Card sx={{ mt: 2 }}>
      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5">Recordings</Typography>
        {recording?.activeMatchId && <Chip size="small" color="error" label="● Recording" />}
        {recording && recording.space !== 'ok' && (
          <Chip
            size="small"
            color={recording.space === 'critical' ? 'error' : 'warning'}
            label={recording.space === 'critical' ? 'Disk nearly full' : 'Disk low — clips paused'}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" size="small" href="/recordings">
          Watch &amp; manage recordings
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────

const ADMIN_TABS = [
  { id: 'match', label: 'Match' },
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'video', label: 'Video' },
  { id: 'scoring', label: 'Scoring & integrations' },
  { id: 'access', label: 'Access' },
] as const;
type AdminTab = (typeof ADMIN_TABS)[number]['id'];

function adminTabFromHash(): AdminTab {
  const hash = window.location.hash.slice(1);
  return ADMIN_TABS.find(t => t.id === hash)?.id ?? 'match';
}

/** The sections on each tab, in page order. Only the open tab is mounted:
 *  the page stays light, and nothing on a hidden tab polls or ticks. */
function AdminTabContent({ tab }: { tab: AdminTab }) {
  switch (tab) {
    case 'match':
      return (
        <>
          <FieldResetSection />
          <OutOfMatchControlSection />
          <ControllerPolicySection />
          <StationControlSection />
        </>
      );
    case 'wifi':
      return (
        <>
          <WifiChangesSection />
          <WifiCardsSection />
          <RobotWifiScanSection />
          <SixGhzWatchSection />
          <FirmwareSection />
        </>
      );
    case 'video':
      return (
        <>
          <RecordingsLinkSection />
          <MatchRecordingSection />
          <TimelapseSettingsSection />
        </>
      );
    case 'scoring':
      return (
        <>
          <ScoringSection />
          <ApiKeySection />
          <SlackConfigSection />
          <AudioDeviceSection />
        </>
      );
    case 'access':
      return <ExternalAccessSection />;
  }
}

// ── Admin Page ──────────────────────────────────────────────────────

/**
 * /admin#<tab>. E-STOP ALL (and Force stop while a match runs) sits above
 * the tabs, so it is on screen whichever tab is open. The match itself is
 * run and watched on /match.
 */
export function AdminPage() {
  const [tab, setTab] = useState<AdminTab>(adminTabFromHash);

  // Back/forward and links like /admin#video switch tabs too.
  useEffect(() => {
    const onHash = () => setTab(adminTabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectTab = (next: AdminTab) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  };

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Field Admin
      </Typography>

      <GlobalEStopSection />

      <Tabs
        value={tab}
        onChange={(_, v: AdminTab) => selectTab(v)}
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ mb: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        {ADMIN_TABS.map(t => (
          <Tab key={t.id} value={t.id} label={t.label} />
        ))}
      </Tabs>

      <AdminTabContent tab={tab} />
    </Container>
  );
}

// ── Audio Device ────────────────────────────────────────────────────

function AudioDeviceSection() {
  const audioState = useAudioDeviceState();
  const [selected, setSelected] = useState('');

  useEffect(() => {
    if (audioState?.selectedDeviceName != null) {
      setSelected(audioState.selectedDeviceName);
    } else {
      setSelected('');
    }
  }, [audioState?.selectedDeviceName]);

  if (!audioState) return null;

  const handleSave = () => {
    sendSaveAudioDeviceConfig(selected || null);
  };

  const hasChanged = (selected || null) !== (audioState.selectedDeviceName || null);

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Match Audio</Typography>
          <Chip
            label={
              audioState.status === 'active'
                ? 'Active'
                : audioState.status === 'disconnected'
                  ? 'Disconnected'
                  : 'Disabled'
            }
            size="small"
            color={
              audioState.status === 'active' ? 'success' : audioState.status === 'disconnected' ? 'warning' : 'default'
            }
          />
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Select an audio output device for match phase sounds (start horn, end buzzer, etc.). The device is locked by
          name so it auto-recovers if the USB device moves to a different port.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
          <FormControl size="small" sx={{ minWidth: 250, flex: 1 }}>
            <InputLabel>Audio Device</InputLabel>
            <Select value={selected} label="Audio Device" onChange={e => setSelected(e.target.value)}>
              <MenuItem value="">
                <em>Disabled</em>
              </MenuItem>
              {audioState.available.map(d => (
                <MenuItem key={d.cardIndex} value={d.name}>
                  {d.name} ({d.driver})
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button variant="contained" size="small" onClick={handleSave} disabled={!hasChanged}>
            Save
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={sendTestAudioDevice}
            disabled={audioState.status !== 'active'}
          >
            Test
          </Button>
          <Button variant="text" size="small" onClick={sendRefreshAudioDevices}>
            Refresh
          </Button>
        </Box>

        {audioState.status === 'disconnected' && audioState.selectedDeviceName && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            Device "{audioState.selectedDeviceName}" is not connected. It will auto-reconnect when plugged in.
          </Alert>
        )}

        {audioState.status === 'active' && audioState.resolvedDevice && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            Resolved to {audioState.resolvedDevice}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── Slack Configuration ──────────────────────────────────────────────

function SlackConfigSection() {
  const slackConfig = useSlackConfigState();
  const setupConfig = useSetupConfig();
  const recording = useMatchRecordingState();
  const snapshotsOn = setupConfig?.config.settings.slackSnapshots === true;
  // Only offerable with Slack connected and a camera to take the picture.
  const snapshotBlocked = !slackConfig?.connected
    ? 'Connect Slack first.'
    : !recording?.available
      ? 'ffmpeg is not available on this host.'
      : !recording.streams.some(s => s.enabled)
        ? 'Add and enable a camera stream on the Recordings page (/recordings) first.'
        : null;
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [channelId, setChannelId] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; channelName?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useSlackTestResult(
    useCallback((result: { ok: boolean; error?: string; channelName?: string }) => {
      setTestResult(result);
    }, []),
  );

  const handleSave = () => {
    if (!botToken || !appToken || !channelId) return;
    setSaving(true);
    sendSaveSlackConfig(botToken, appToken, channelId);
    // Reset saving state after a timeout (result comes via slackConfigState)
    setTimeout(() => setSaving(false), 3000);
  };

  const handleTest = () => {
    setTestResult(null);
    sendTestSlackConnection();
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Slack Integration</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            {slackConfig?.configured && (
              <Chip
                label={
                  slackConfig.connected
                    ? `Connected${slackConfig.channelName ? ` (#${slackConfig.channelName})` : ''}`
                    : 'Disconnected'
                }
                size="small"
                color={slackConfig.connected ? 'success' : 'error'}
              />
            )}
            {!slackConfig?.configured && <Chip label="Not Configured" size="small" color="default" />}
          </Box>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Connect to a Slack channel to receive support issue reports and enable real-time chat. Uses Socket Mode — no
          public URL or HTTPS required.
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1.5 }}>
          <Box sx={{ minWidth: 260, flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="subtitle1">Field snapshots on request</Typography>
              <Chip size="small" color={snapshotsOn ? 'success' : 'default'} label={snapshotsOn ? 'On' : 'Off'} />
            </Box>
            <Typography variant="body2" color="text.secondary">
              Anyone in the support channel can ask for a live picture of the field — mention the bot with
              &quot;snapshot&quot; or &quot;photo&quot;, or post just <code>!snapshot</code> — and it is posted as a
              reply to that message, at most one every 5 minutes. Requests in threads, DMs and other channels are
              ignored.
              {snapshotBlocked && !snapshotsOn && ` ${snapshotBlocked}`}
              {snapshotBlocked && snapshotsOn && ` It cannot answer right now: ${snapshotBlocked}`}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            color={snapshotsOn ? 'warning' : 'success'}
            disabled={!snapshotsOn && snapshotBlocked !== null}
            onClick={() => sendUpdateSetupSettings({ slackSnapshots: !snapshotsOn })}
          >
            {snapshotsOn ? 'Turn off' : 'Turn on'}
          </Button>
        </Box>

        <Accordion
          disableGutters
          sx={{ mb: 2, backgroundColor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            sx={{ px: 0, minHeight: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}
          >
            <Typography variant="body2" color="primary">
              Setup wizard — create a Slack App and connect it
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Box
              component="ol"
              sx={{
                pl: 2.5,
                my: 0,
                '& > li': { mb: 2, fontSize: '0.875rem', color: 'text.secondary' },
                '& code': { backgroundColor: 'action.hover', px: 0.5, borderRadius: 0.5, fontSize: '0.8rem' },
                '& strong': { color: 'text.primary' },
              }}
            >
              <li>
                Go to{' '}
                <a href="https://api.slack.com/apps" target="_blank" rel="noopener" style={{ color: 'inherit' }}>
                  api.slack.com/apps
                </a>{' '}
                → <strong>Create New App</strong> → <strong>From scratch</strong>. Name it (e.g. "PFMS Support") and
                pick your workspace.
              </li>
              <li>
                <strong>Add Bot Token Scopes:</strong> Go to <em>OAuth & Permissions</em> → <em>Scopes</em> →{' '}
                <em>Bot Token Scopes</em> and add: <code>chat:write</code>, <code>channels:read</code>,{' '}
                <code>files:write</code>, <code>users:read</code>, <code>emoji:read</code>.
              </li>
              <li>
                <strong>Install to Workspace:</strong> Go to <em>OAuth & Permissions</em> →{' '}
                <em>Install to Workspace</em>. Copy the <strong>Bot User OAuth Token</strong> and paste it here:
                <TextField
                  size="small"
                  label="Bot Token (xoxb-...)"
                  type="password"
                  value={botToken}
                  onChange={e => setBotToken(e.target.value)}
                  placeholder="xoxb-..."
                  fullWidth
                  sx={{ mt: 1 }}
                />
              </li>
              <li>
                <strong>Enable Socket Mode:</strong> Go to <em>Settings</em> → <em>Socket Mode</em> → toggle on. A
                dialog will prompt you to create an <strong>App-Level Token</strong> — the{' '}
                <code>connections:write</code> scope is pre-selected. Give it a name (e.g. "websocket") and click{' '}
                <strong>Generate</strong>. If you missed the dialog, go to <em>Basic Information</em> →{' '}
                <em>App-Level Tokens</em> → <em>Generate Token and Scopes</em>. Paste the token here:
                <TextField
                  size="small"
                  label="App-Level Token (xapp-...)"
                  type="password"
                  value={appToken}
                  onChange={e => setAppToken(e.target.value)}
                  placeholder="xapp-..."
                  fullWidth
                  sx={{ mt: 1 }}
                />
              </li>
              <li>
                <strong>Subscribe to Events:</strong> Go to <em>Event Subscriptions</em> → toggle on →{' '}
                <em>Subscribe to bot events</em> → add <code>message.channels</code>.
              </li>
              <li>
                <strong>Invite the bot</strong> to your support channel: in Slack, type{' '}
                <code>/invite @PFMS Support</code> in the channel.
              </li>
              <li>
                <strong>Get the Channel ID:</strong> Right-click the channel → <em>View channel details</em> → scroll to
                the bottom. Paste the <strong>Channel ID</strong> here:
                <TextField
                  size="small"
                  label="Channel ID"
                  value={channelId}
                  onChange={e => setChannelId(e.target.value)}
                  placeholder="C0XXXXXXX"
                  fullWidth
                  sx={{ mt: 1 }}
                />
              </li>
            </Box>
          </AccordionDetails>
        </Accordion>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="contained"
              size="small"
              onClick={handleSave}
              disabled={saving || !botToken || !appToken || !channelId}
            >
              {saving ? 'Saving...' : 'Save & Connect'}
            </Button>
            {slackConfig?.configured && (
              <Button variant="outlined" size="small" onClick={handleTest}>
                Test Connection
              </Button>
            )}
          </Box>

          {slackConfig?.error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {slackConfig.error}
            </Alert>
          )}

          {testResult && (
            <Alert severity={testResult.ok ? 'success' : 'error'} sx={{ mt: 1 }}>
              {testResult.ok
                ? `Connection OK${testResult.channelName ? ` — posting to #${testResult.channelName}` : ''}`
                : `Connection failed: ${testResult.error}`}
            </Alert>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Scoring ─────────────────────────────────────────────────────────

function formatAge(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function formatLag(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ScoringSection() {
  const score = useScoreState();
  const castReceivers = useCastReceivers();
  const [, setTick] = useState(0);

  // Re-render every second to update sliding window / source ages
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!score) return null;

  const elements = Object.values(score.elements);
  const sources = Object.entries(score.sources);
  const hasScores = score.red.total > 0 || score.blue.total > 0;

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Scoring</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Chip
              label={
                score.mode === 'freePlay'
                  ? `Free Play (${score.batchTimeoutSeconds}s batch / ${score.windowSeconds}s window)`
                  : 'Match'
              }
              size="small"
              color={score.mode === 'match' ? 'primary' : 'default'}
            />
            {score.mode === 'freePlay' && (
              <>
                <Chip
                  label={`Red: ${score.redBatchActive ? 'active' : 'idle'}`}
                  size="small"
                  variant="outlined"
                  color={score.redBatchActive ? 'error' : 'default'}
                />
                <Chip
                  label={`Blue: ${score.blueBatchActive ? 'active' : 'idle'}`}
                  size="small"
                  variant="outlined"
                  color={score.blueBatchActive ? 'info' : 'default'}
                />
              </>
            )}
            {hasScores && (
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={() => sendScoreReset()}
                sx={{ textTransform: 'none', fontSize: '0.75rem' }}
              >
                Reset
              </Button>
            )}
          </Box>
        </Box>

        {/* Score totals */}
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <ScoreCard alliance="red" score={score.red} />
          <ScoreCard alliance="blue" score={score.blue} />
        </Box>

        {/* Element breakdown */}
        {elements.length > 0 && hasScores && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Element Breakdown
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Element</TableCell>
                  <TableCell sx={{ color: '#d32f2f' }} align="right">
                    Red
                  </TableCell>
                  <TableCell sx={{ color: '#1565c0' }} align="right">
                    Blue
                  </TableCell>
                  <TableCell align="right">Pts each</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {elements.map(el => {
                  const red = score.red.elements[el.id];
                  const blue = score.blue.elements[el.id];
                  if (!red && !blue) return null;
                  return (
                    <TableRow key={el.id}>
                      <TableCell sx={{ py: 0.5 }}>
                        {el.name}
                        {el.awardToOpponent && (
                          <Typography component="span" variant="caption" color="warning.main" sx={{ ml: 0.5 }}>
                            (foul)
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontFamily: 'monospace' }}>
                        {red?.count ?? 0}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontFamily: 'monospace' }}>
                        {blue?.count ?? 0}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontFamily: 'monospace', color: 'text.secondary' }}>
                        {el.pointValue}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}

        {/* Phase breakdown (match mode) */}
        {score.mode === 'match' && score.phaseBreakdown && Object.keys(score.phaseBreakdown).length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Phase Breakdown
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              {Object.entries(score.phaseBreakdown).map(([phase, scores]) => (
                <Chip
                  key={phase}
                  label={`${phase}: R${scores.red.total} / B${scores.blue.total}`}
                  size="small"
                  variant="outlined"
                />
              ))}
            </Box>
          </Box>
        )}

        {/* Sources */}
        {sources.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Sources
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {sources.map(([id, src]) => {
                const stale = Date.now() - src.lastSeen > 30_000;
                // A source that reports how old each score is gets judged at
                // the moment the ball scored, so lag is harmless. One that
                // doesn't is only as accurate as its delivery delay.
                const lag =
                  src.lastLagMs === undefined
                    ? ''
                    : src.lastTiming === 'receive'
                      ? ' · no timing'
                      : ` · lag ${formatLag(src.lastLagMs)}`;
                const last = src.lastElement ? ` · ${src.lastAlliance} ${src.lastElement}` : '';
                return (
                  <Chip
                    key={id}
                    label={`${id} · ${src.eventCount} · ${formatAge(src.lastSeen)}${lag}${last}`}
                    size="small"
                    variant="outlined"
                    color={stale ? 'default' : src.lastTiming === 'receive' ? 'warning' : 'success'}
                  />
                );
              })}
            </Box>
          </Box>
        )}

        {/* Cast Receivers */}
        {castReceivers.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
              Displays
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {castReceivers.map(r => (
                <Box key={r.id} sx={{ display: 'flex', gap: 0.25, alignItems: 'center' }}>
                  <Chip
                    label={`${r.name} (${r.swapped ? 'swapped' : 'normal'})`}
                    size="small"
                    variant="outlined"
                    color="success"
                    onClick={() => sendCastReceiverSwap(r.id, !r.swapped)}
                    onDelete={() => sendStopCast(r.id)}
                    deleteIcon={<Typography sx={{ fontSize: '0.7rem', cursor: 'pointer', px: 0.5 }}>✕</Typography>}
                  />
                  <Chip
                    label={r.muted ? '🔇 muted' : '🔊 sound'}
                    size="small"
                    variant={r.muted ? 'filled' : 'outlined'}
                    color={r.muted ? 'warning' : 'success'}
                    onClick={() => sendCastReceiverMute(r.id, !r.muted)}
                  />
                  <Chip
                    label={r.checks ? '✅ checks on' : 'checks off'}
                    size="small"
                    variant={r.checks ? 'filled' : 'outlined'}
                    color={r.checks ? 'info' : 'default'}
                    onClick={() => sendCastReceiverChecks(r.id, !r.checks)}
                  />
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {!hasScores && sources.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No scoring devices connected. Send events to <code>POST /api/score</code>
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function ScoreCard({ alliance, score }: { alliance: 'red' | 'blue'; score: { total: number } }) {
  const color = alliance === 'red' ? '#d32f2f' : '#1565c0';
  return (
    <Box
      sx={{
        flex: 1,
        textAlign: 'center',
        py: 1.5,
        borderRadius: 1,
        border: 2,
        borderColor: color,
        backgroundColor: `${color}11`,
      }}
    >
      <Typography variant="h3" sx={{ fontWeight: 700, color, fontFamily: 'monospace' }}>
        {score.total}
      </Typography>
      <Typography variant="caption" sx={{ color, textTransform: 'uppercase', fontWeight: 600 }}>
        {alliance}
      </Typography>
    </Box>
  );
}

// ── API Key Management ──────────────────────────────────────────────

// ── External Access Tokens ──────────────────────────────────────────

function ExternalAccessSection() {
  const state = useExternalAccessState();
  const [newLabel, setNewLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<ExternalAccessTokenCreated | null>(null);
  const [, setTick] = useState(0);

  // Re-render every second to update relative timestamps
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Listen for token creation events (raw token shown once)
  useExternalAccessTokenCreatedEvent(useCallback((msg: ExternalAccessTokenCreated) => setCreatedToken(msg), []));

  // Dismiss the banner when the token is revoked
  useEffect(() => {
    if (createdToken && state && !state.tokens.some(t => t.id === createdToken.id)) {
      setCreatedToken(null);
    }
  }, [createdToken, state]);

  if (!state) return null;

  const handleCreate = () => {
    if (!newLabel.trim()) return;
    sendCreateExternalAccessToken(newLabel.trim());
    setNewLabel('');
  };

  const authUrl = createdToken ? `${window.location.origin}/admin/auth/${createdToken.token}` : '';

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h5" sx={{ mb: 1 }}>
          External Access
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Grant trusted users access to the internal UI from outside the local network. Each token generates a shareable
          URL — visiting it sets a browser cookie that Caddy checks on every request.
        </Typography>

        {/* Token creation form */}
        <Box sx={{ display: 'flex', gap: 1, my: 2, alignItems: 'flex-end' }}>
          <TextField
            size="small"
            label="Label"
            placeholder="e.g. Cameron's phone"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            sx={{ flex: 1 }}
          />
          <Button variant="contained" size="small" onClick={handleCreate} disabled={!newLabel.trim()}>
            Create Token
          </Button>
        </Box>

        {/* One-time auth URL display */}
        <Collapse in={!!createdToken} unmountOnExit>
          <Alert severity="success" onClose={() => setCreatedToken(null)} sx={{ mb: 2 }}>
            <Typography variant="subtitle2">Token created: {createdToken?.label}</Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all', my: 0.5 }}
            >
              {authUrl}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Share this URL — it will not be shown again.
            </Typography>
          </Alert>
        </Collapse>

        {/* Token list */}
        {state.tokens.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last Used</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.tokens.map(token => (
                <TableRow key={token.id}>
                  <TableCell>{token.label}</TableCell>
                  <TableCell>
                    <Tooltip title={new Date(token.createdAt).toLocaleString()}>
                      <span>{formatAge(token.createdAt)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {token.lastUsedAt ? (
                      <Tooltip title={new Date(token.lastUsedAt).toLocaleString()}>
                        <span>{formatAge(token.lastUsedAt)}</span>
                      </Tooltip>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Never
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="small" color="error" onClick={() => sendRevokeExternalAccessToken(token.id)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {state.tokens.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No external access tokens. External users see the public page only.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── API Keys ────────────────────────────────────────────────────────

function ApiKeySection() {
  const apiKeyState = useApiKeyState();
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [approveDevice, setApproveDevice] = useState<PendingDevice | null>(null);
  const [approveLabel, setApproveLabel] = useState('');
  const [, setTick] = useState(0);

  // Re-render every second to update relative timestamps
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Listen for key creation events (full key shown once)
  useApiKeyCreatedEvent(useCallback((msg: ApiKeyCreated) => setCreatedKey(msg), []));

  // Dismiss the new-key banner when the key is deleted
  useEffect(() => {
    if (createdKey && apiKeyState && !apiKeyState.keys.some(k => k.id === createdKey.id)) {
      setCreatedKey(null);
    }
  }, [createdKey, apiKeyState]);

  if (!apiKeyState) return null;

  const handleCreate = () => {
    if (!newKeyLabel.trim()) return;
    sendCreateApiKey(newKeyLabel.trim());
    setNewKeyLabel('');
  };

  const handleApprove = () => {
    if (!approveDevice) return;
    sendApprovePendingDevice(approveDevice.id, approveLabel.trim() || `Device ${approveDevice.sourceIp}`);
    setApproveDevice(null);
    setApproveLabel('');
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Scoring API Keys</Typography>
          <Chip
            label={apiKeyState.authRequired ? 'Auth Required' : 'Open Access'}
            size="small"
            color={apiKeyState.authRequired ? 'success' : 'warning'}
          />
        </Box>

        {/* Key creation form */}
        <Box sx={{ display: 'flex', gap: 1, my: 2, alignItems: 'flex-end' }}>
          <TextField
            size="small"
            label="New Key Label"
            placeholder="e.g. Speaker Sensor"
            value={newKeyLabel}
            onChange={e => setNewKeyLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            sx={{ flex: 1 }}
          />
          <Button variant="contained" size="small" onClick={handleCreate} disabled={!newKeyLabel.trim()}>
            Create Key
          </Button>
        </Box>

        {/* One-time key display */}
        <Collapse in={!!createdKey} unmountOnExit>
          <Alert severity="success" onClose={() => setCreatedKey(null)} sx={{ mb: 2 }}>
            <Typography variant="subtitle2">New key created: {createdKey?.label}</Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all', my: 0.5 }}
            >
              {createdKey?.key}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Copy this key now — it will not be shown again.
            </Typography>
          </Alert>
        </Collapse>

        {/* Registered keys table */}
        {apiKeyState.keys.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell>
                <TableCell>Key</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Requests</TableCell>
                <TableCell>Last Used</TableCell>
                <TableCell>Last IP</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {apiKeyState.keys.map(key => (
                <TableRow key={key.id}>
                  <TableCell>{key.label}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {key.keyPreview}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={key.status} size="small" color={key.status === 'active' ? 'success' : 'error'} />
                  </TableCell>
                  <TableCell align="right">{key.requestCount}</TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {key.lastUsedAt ? formatAge(key.lastUsedAt) : 'Never'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {key.lastSourceIp ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {key.status === 'active' ? (
                        <Button
                          size="small"
                          color="warning"
                          onClick={() => sendRevokeApiKey(key.id)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          color="success"
                          onClick={() => sendReactivateApiKey(key.id)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Reactivate
                        </Button>
                      )}
                      <Button
                        size="small"
                        color="error"
                        onClick={() => sendDeleteApiKey(key.id)}
                        sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                      >
                        Delete
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Pending devices section */}
        {apiKeyState.pendingDevices.length > 0 && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              Pending Devices ({apiKeyState.pendingDevices.length})
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>IP Address</TableCell>
                  <TableCell>User Agent</TableCell>
                  <TableCell align="right">Attempts</TableCell>
                  <TableCell>Last Seen</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {apiKeyState.pendingDevices.map(device => (
                  <TableRow key={device.id}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                        {device.sourceIp}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {device.userAgent ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{device.requestCount}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatAge(device.lastSeen)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <Button
                          size="small"
                          color="success"
                          onClick={() => {
                            setApproveDevice(device);
                            setApproveLabel('');
                          }}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          onClick={() => sendDismissPendingDevice(device.id)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem', minWidth: 0, px: 1 }}
                        >
                          Dismiss
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        {/* Approve device dialog */}
        <Dialog open={!!approveDevice} onClose={() => setApproveDevice(null)}>
          <DialogTitle>Approve Device</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Generate an API key for device at <strong>{approveDevice?.sourceIp}</strong>
              {approveDevice?.userAgent && (
                <>
                  <br />
                  <Typography component="span" variant="caption" color="text.secondary">
                    {approveDevice.userAgent}
                  </Typography>
                </>
              )}
            </Typography>
            <TextField
              label="Device Label"
              placeholder={`Device ${approveDevice?.sourceIp ?? ''}`}
              value={approveLabel}
              onChange={e => setApproveLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleApprove()}
              fullWidth
              autoFocus
              size="small"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setApproveDevice(null)}>Cancel</Button>
            <Button onClick={handleApprove} variant="contained" color="success">
              Approve & Generate Key
            </Button>
          </DialogActions>
        </Dialog>

        {/* Empty state */}
        {apiKeyState.keys.length === 0 && apiKeyState.pendingDevices.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No API keys configured. The scoring API is currently open to all devices on the network. Create a key to
            require authentication.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── Firmware Management ─────────────────────────────────────────────

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function FirmwareSection() {
  const entries = useFirmwareStore();
  const [uploading, setUploading] = useState(false);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadChecksum, setUploadChecksum] = useState('');
  const [uploadType, setUploadType] = useState<'from12x' | 'pre12x'>('from12x');
  const [message, setMessage] = useState('');

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file || !uploadVersion || !uploadChecksum) return;

    setUploading(true);
    setMessage('');
    try {
      const data = await file.arrayBuffer();
      const params = new URLSearchParams({ checksum: uploadChecksum, version: uploadVersion, upgradeFrom: uploadType });
      const res = await fetch(`/api/firmware/upload?${params}`, { method: 'POST', body: data });
      const json = await res.json();
      setMessage(res.ok ? `Uploaded: ${json.entry?.version ?? 'ok'}` : `Error: ${json.error}`);
    } catch (err) {
      setMessage(`Upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
    }
  };

  // Group entries by version
  type FwEntry = (typeof entries)[number];
  const versions = new Map<string, { pre12x?: FwEntry; from12x?: FwEntry }>();
  for (const e of entries) {
    const row = versions.get(e.version) ?? {};
    if (e.upgradeFrom === 'pre12x') row.pre12x = e;
    else row.from12x = e;
    versions.set(e.version, row);
  }

  const allCached = entries.length > 0 && entries.every(e => e.filePath);
  const anyDownloading = entries.some(e => e.downloading);

  const triggerDownload = () => {
    fetch('/api/firmware/download', { method: 'POST' });
  };

  const fwStatusCell = (entry?: FwEntry) => {
    if (!entry) {
      return (
        <Typography variant="caption" color="text.disabled">
          —
        </Typography>
      );
    }
    let label = 'missing';
    let color: string = 'warning.main';
    if (entry.filePath) {
      label = 'cached';
      color = 'success.main';
    } else if (entry.downloading) {
      color = 'info.main';
      if (entry.downloadedBytes !== undefined && entry.totalBytes) {
        label = `downloading ${Math.round((entry.downloadedBytes / entry.totalBytes) * 100)}%`;
      } else if (entry.downloadedBytes !== undefined) {
        label = `downloading ${formatBytes(entry.downloadedBytes)}`;
      } else {
        label = 'downloading...';
      }
    } else if (entry.downloadError) {
      label = `failed: ${entry.downloadError}`;
      color = 'error.main';
    }
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box
          component="span"
          sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }}
        />
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Box>
    );
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h5">Radio Firmware</Typography>
          {!allCached && !anyDownloading && (
            <Button size="small" variant="outlined" onClick={triggerDownload} sx={{ textTransform: 'none' }}>
              Download from Internet
            </Button>
          )}
        </Box>

        {versions.size > 0 && (
          <Box
            sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '4px 16px', alignItems: 'center', mb: 2 }}
          >
            <Box />
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
              From 1.2.x+
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
              Pre-1.2
            </Typography>
            {[...versions].map(([ver, row]) => (
              <Box key={ver} sx={{ display: 'contents' }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  v{ver}
                </Typography>
                {fwStatusCell(row.from12x)}
                {fwStatusCell(row.pre12x)}
              </Box>
            ))}
          </Box>
        )}

        {!allCached && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Manual Upload
            </Typography>
            <form onSubmit={handleUpload}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <input type="file" accept=".enc,.bin,.img" required disabled={uploading} />
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <input
                    type="text"
                    placeholder="Version (e.g. 2.0.1)"
                    value={uploadVersion}
                    onChange={e => setUploadVersion(e.target.value)}
                    required
                    style={{ flex: 1, padding: '4px 8px' }}
                  />
                  <input
                    type="text"
                    placeholder="SHA-256 checksum"
                    value={uploadChecksum}
                    onChange={e => setUploadChecksum(e.target.value)}
                    required
                    style={{ flex: 2, padding: '4px 8px', fontFamily: 'monospace' }}
                  />
                  <select value={uploadType} onChange={e => setUploadType(e.target.value as 'from12x' | 'pre12x')}>
                    <option value="from12x">From 1.2.x+</option>
                    <option value="pre12x">Pre-1.2</option>
                  </select>
                </Box>
                <Button type="submit" size="small" variant="contained" disabled={uploading}>
                  {uploading ? 'Uploading...' : 'Upload Firmware'}
                </Button>
              </Box>
            </form>
          </>
        )}
        {message && (
          <Typography
            variant="body2"
            sx={{ mt: 1, color: message.startsWith('Error') ? 'error.main' : 'success.main' }}
          >
            {message}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
