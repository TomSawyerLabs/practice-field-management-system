import { useCallback, useEffect, useState } from 'react';
import {
  Alliance,
  ApiKeyCreated,
  ApiKeyState,
  AppLogMessage,
  InternetToggle,
  MatchConfig,
  MatchState,
  MdnsActivity,
  NetworkStats,
  SavedTeamsState,
  SubnetScanResults,
  TeamCheckResults,
  TelemetryUpdate,
  isApiKeyCreated,
  isApiKeyState,
  isAppLogMessage,
  isMatchState,
  isMdnsActivity,
  isNetworkStats,
  isSavedTeamsState,
  isSubnetScanResults,
  isTeamCheckResults,
  isTelemetryUpdate,
  isRoutePreferenceState,
  isPendingCommitState,
  isLastLinkedState,
  isServerInfo,
  isPortBridgeState,
  isRobotTestState,
  isFirmwareUpdateProgress,
  isRadioConfigureProgress,
  isScoreState,
  isStopCast,
  isCastReceiverList,
  isCastReceiverSwap,
  isCastReceiverMute,
  isPlayGetReady,
  isSupportState,
  isSupportChatIncoming,
  isAdminAuthResult,
  isSlackConfigState,
  isSetupProbeState,
  isSetupConfigState,
  isAudioDeviceState,
  AudioDeviceState,
  isMatchHistoryState,
  MatchHistoryState,
  isMatchRecordingState,
  MatchRecordingState,
  isRecordingStreamTestResult,
  RecordingStreamTestResult,
  isUsageState,
  UsageState,
  isDriveSessionState,
  DriveSessionState,
  isHostnamesState,
  HostnamesState,
  isExternalAccessState,
  isExternalAccessTokenCreated,
  isStationTestState,
  ExternalAccessState,
  ExternalAccessTokenCreated,
  StationTestState,
  CastReceiverList,
  CastReceiverRegister,
  CastReceiverSwap,
  CastReceiverMute,
  PlayGetReady,
  StopCast,
  RoutePreferenceState,
  RobotTestState,
  ScoreState,
  FirmwareUpdateProgress,
  FirmwareUpdateRequest,
  RadioConfigureRequest,
  RadioConfigureProgress,
  PendingCommitState,
  LastLinkedState,
  ServerInfo,
  PortBridgeState,
  PortBridgeRequest,
  RoutePreferenceMsg,
  DriveAction,
  RunTeamChecks,
  StaffRole,
  StationName,
  StationUpdate,
  StatusEntry,
  SupportState,
  SupportChatMessage,
  SupportMetadata,
  AdminAuthResult,
  SlackConfigState,
  SetupProbeState,
  SetupConfigState,
  SetupSettings,
  SetupStepId,
  StagedStationChange,
} from '../../../src/types';
import { Message as RadioMessage } from 'syslog-server';

let ws: WebSocket | null = null;
let wsConnected = false;
let lastMessageAt = Date.now();

// Dead-socket watchdog: the server heartbeats serverInfo every 10 s, so a
// socket silent for 30+ s is dead even if TCP never noticed (Chromecast
// receivers whose Wi-Fi naps are the classic case — the display freezes on
// stale scores). Force a close; the onclose handler reconnects and the
// server replays fresh state.
const WS_SILENCE_TIMEOUT_MS = 30_000;
setInterval(() => {
  if (!ws || !wsConnected) return;
  if (Date.now() - lastMessageAt > WS_SILENCE_TIMEOUT_MS) {
    console.warn(`WebSocket silent for ${WS_SILENCE_TIMEOUT_MS / 1000}s — forcing reconnect`);
    try {
      ws.close();
    } catch {
      // already closing
    }
  }
}, 5_000);

function connect() {
  const schema = window.location.protocol === 'https:' ? 'wss' : 'ws';

  // The scores page uses a public read-only WebSocket that only receives
  // scoreState and matchState — no auth required, no sensitive data.
  const wsPath = window.location.pathname === '/scores' ? '/ws/scores' : '/ws';
  const url = `${schema}://${window.location.host}${wsPath}`;

  console.log(`Connecting to backend: ${url}`);

  // TODO: Reconnect
  const nws = new WebSocket(url);

  nws.onmessage = msg => {
    lastMessageAt = Date.now();
    const parsed = JSON.parse(msg.data);
    if (Array.isArray(parsed)) {
      processHistory(parsed);
    } else {
      receiveMessage(parsed);
    }
  };

  nws.onopen = () => {
    console.log('Connected to backend');
    lastMessageAt = Date.now();
    wsConnected = true;
    events.dispatchEvent(new CustomEvent('wsStatus', { detail: true }));
  };
  nws.onerror = error => {
    if (!wsConnected) return;

    console.error('WebSocket error:', error);
    wsConnected = false;
    events.dispatchEvent(new CustomEvent('wsStatus', { detail: false }));
  };

  nws.onclose = () => {
    console.log('Disconnected from backend');
    wsConnected = false;
    events.dispatchEvent(new CustomEvent('wsStatus', { detail: false }));
    setTimeout(connect, 1000);
  };

  ws = nws;
}

connect();
const history: StatusEntry[] = [];

const radioMessages: RadioMessage[] = [];

// Track time offset between server and client (serverTime - clientTime)
let timeOffset = 0;
let timeOffsetInitialized = false;

/** Fold a server-stamped wall-clock timestamp into the clock-offset estimate.
 *  The first sample seeds the estimate directly — easing from 0 would take
 *  dozens of messages to converge on a large skew — and later samples are
 *  smoothed with an EMA to absorb network-latency jitter. Called for every
 *  message type that carries a fresh server timestamp, so pages on the public
 *  /ws/scores socket (which never sees StatusEntry) still get calibrated. */
function noteServerTimestamp(serverTimestamp: number) {
  const measured = serverTimestamp - Date.now();
  if (!timeOffsetInitialized) {
    timeOffset = measured;
    timeOffsetInitialized = true;
    return;
  }
  const alpha = 0.1;
  timeOffset = timeOffset * (1 - alpha) + measured * alpha;
}

function processHistory(entries: StatusEntry[]) {
  // TODO: Validate
  history.push(...entries);

  console.log(`Received ${entries.length} history entries`);

  // Delay dispatching events to allow React components to mount and register listeners
  // This ensures charts and other UI components can receive the historical data
  setTimeout(() => {
    console.log(`Dispatching ${entries.length} historical updates to UI`);

    // Dispatch entries with a small stagger so Smoothie charts can properly render
    // Smoothie is a real-time streaming library and needs time to establish viewport
    entries.forEach((entry, index) => {
      setTimeout(() => {
        events.dispatchEvent(new CustomEvent('update', { detail: entry }));
      }, index * 10); // 10ms stagger between each entry
    });
  }, 200); // 200ms initial delay to allow components to mount
}

export function sendNewConfig(
  station: StationName,
  ssid: string,
  wpaKey: string,
  stage = false,
  internetAccess?: boolean,
) {
  const update: StationUpdate = {
    type: 'station',
    station,
    ssid,
    wpaKey,
    stage,
    internetAccess,
  };
  console.log('Sending config update:', update);
  ws?.send(JSON.stringify(update));
}

export function sendInternetToggle(station: StationName, enabled: boolean) {
  const msg: InternetToggle = {
    type: 'internetToggle',
    station,
    enabled,
  };
  console.log('Sending internet toggle:', msg);
  ws?.send(JSON.stringify(msg));
}

const events = new EventTarget();

type StatusUpdateCallback = (e: StatusEntry) => void;

export function useUpdateCallback(cb: StatusUpdateCallback) {
  useEventListener('update', cb);
}

type RadioMessageCallback = (e: RadioMessage) => void;

export function useRadioMessageCallback(cb: RadioMessageCallback) {
  useEventListener('radio', cb);
}

type AppLogCallback = (e: AppLogMessage) => void;

export function useAppLogCallback(cb: AppLogCallback) {
  useEventListener('appLog', cb);
}

type TelemetryCallback = (e: TelemetryUpdate) => void;

export function useTelemetryCallback(cb: TelemetryCallback) {
  useEventListener('telemetry', cb);
}

function useEventListener(type: 'update', cb: StatusUpdateCallback): void;
function useEventListener(type: 'radio', cb: RadioMessageCallback): void;
function useEventListener(type: 'appLog', cb: AppLogCallback): void;
function useEventListener(type: 'telemetry', cb: TelemetryCallback): void;
function useEventListener(
  type: 'update' | 'radio' | 'appLog' | 'telemetry',
  callback: StatusUpdateCallback | RadioMessageCallback | AppLogCallback | TelemetryCallback,
) {
  const cb: EventListener = useCallback(
    event => {
      const { detail } = event as CustomEvent;
      callback(detail);
    },
    [callback],
  );

  useEffect(() => {
    events.addEventListener(type, cb);
    return () => events.removeEventListener(type, cb);
  }, [type, cb]);
}

const MaxHistoryAge = 1000 * 60 * 5; // 5 minutes

function isStatusEntry(entry: unknown): entry is StatusEntry {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;
  if (!('timestamp' in entry)) return false;
  if (!('radioUpdate' in entry)) return false;
  return true;
}

function isErrorEntry(entry: unknown): entry is { error: string; details: string } {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;
  if (!('error' in entry)) return false;
  if (!('details' in entry)) return false;
  return true;
}

let currentMatchState: MatchState | null = null;
let currentNetworkStats: NetworkStats | null = null;
let currentSubnetScan: SubnetScanResults | null = null;
let currentSavedTeams: SavedTeamsState | null = null;
let currentMdnsActivity: MdnsActivity | null = null;
let currentRoutePreferenceState: RoutePreferenceState | null = null;
let currentPendingCommit = false;
let currentStagedChanges: Record<string, StagedStationChange | null> = {};
let currentLastLinked: Partial<Record<StationName, number>> = {};
let currentServerInfo: ServerInfo | null = null;
const currentTeamCheckResults = new Map<StationName, TeamCheckResults>();

type Message =
  | StatusEntry
  | ErrorMessage
  | RadioMessage
  | MatchState
  | NetworkStats
  | AppLogMessage
  | TelemetryUpdate
  | SubnetScanResults
  | TeamCheckResults
  | ServerInfo
  | RoutePreferenceState
  | PendingCommitState;
type ErrorMessage = { error: string; details: string };

function isRadioMessage(entry: unknown): entry is RadioMessage {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;

  const { host, message, date, protocol } = entry as Omit<RadioMessage, 'date'> & { date: string };

  if (typeof host !== 'string') return false;
  if (typeof message !== 'string') return false;
  if (typeof date !== 'string') return false;
  if (typeof protocol !== 'string') return false;

  (entry as RadioMessage).date = new Date(date); // Convert date to Date object

  return true;
}

function handleErrorEntry(detail: { error: string; details: string }) {
  console.error('Error returned from radio:', detail);
  // Show it to the user too — a failed radio commit that only hits the console
  // looks like the button did nothing (field incident 2026-07-24, team 8048).
  events.dispatchEvent(
    new CustomEvent('serverResponse', {
      detail: { severity: 'error', message: detail.details ? `${detail.error}: ${detail.details}` : detail.error },
    }),
  );
}

function handleStatusEntry(detail: StatusEntry) {
  // detail.timestamp is the server's current time when the message was created
  noteServerTimestamp(detail.timestamp);

  history.push(detail);

  // Remove old history
  while (history[0].timestamp < Date.now() - MaxHistoryAge) history.shift();

  events.dispatchEvent(new CustomEvent('update', { detail }));
}

function handleRadioMessage(detail: RadioMessage) {
  radioMessages.push(detail);
  events.dispatchEvent(new CustomEvent('radio', { detail }));
}

function handleMatchState(state: MatchState) {
  currentMatchState = state;
  events.dispatchEvent(new CustomEvent('matchState', { detail: state }));
}

function handleNetworkStats(stats: NetworkStats) {
  currentNetworkStats = stats;
  events.dispatchEvent(new CustomEvent('networkStats', { detail: stats }));
}

function handleAppLog(msg: AppLogMessage) {
  events.dispatchEvent(new CustomEvent('appLog', { detail: msg }));
}

function handleSubnetScan(scan: SubnetScanResults) {
  currentSubnetScan = scan;
  events.dispatchEvent(new CustomEvent('subnetScan', { detail: scan }));
}

function handleMdnsActivity(activity: MdnsActivity) {
  currentMdnsActivity = activity;
  events.dispatchEvent(new CustomEvent('mdnsActivity', { detail: activity }));
}

function handleTelemetry(update: TelemetryUpdate) {
  // Telemetry is broadcast within milliseconds of the server stamping it, so
  // it doubles as a clock beacon — the only steady one on /ws/scores. Update
  // the offset before dispatching so chart handlers convert with fresh data.
  noteServerTimestamp(update.timestamp);
  events.dispatchEvent(new CustomEvent('telemetry', { detail: update }));
}

function handleRoutePreferenceState(state: RoutePreferenceState) {
  currentRoutePreferenceState = state;
  events.dispatchEvent(new CustomEvent('routePreferenceState', { detail: state }));
}

let currentPendingCommitState: PendingCommitState = { type: 'pendingCommitState', pending: false };

function handlePendingCommitState(state: PendingCommitState) {
  currentPendingCommit = state.pending;
  currentPendingCommitState = state;
  currentStagedChanges = state.stagedChanges ?? {};
  events.dispatchEvent(new CustomEvent('pendingCommitState', { detail: state }));
}

function handleLastLinkedState(state: LastLinkedState) {
  currentLastLinked = state.timestamps;
  events.dispatchEvent(new CustomEvent('lastLinkedState', { detail: state }));
}

function handleTeamCheckResults(results: TeamCheckResults) {
  currentTeamCheckResults.set(results.station, results);
  events.dispatchEvent(new CustomEvent('teamCheckResults', { detail: results }));
}

function handleSavedTeamsState(state: SavedTeamsState) {
  currentSavedTeams = state;
  events.dispatchEvent(new CustomEvent('savedTeamsState', { detail: state }));
}

// ── Port Bridge State ────────────────────────────────────────────────

let currentPortBridgeState: PortBridgeState | null = null;

function handlePortBridgeState(state: PortBridgeState) {
  currentPortBridgeState = state;
  events.dispatchEvent(new CustomEvent('portBridgeState', { detail: state }));
}

// ── Support System State ────────────────────────────────────────────

let currentSupportState: SupportState | null = null;
let currentSlackConfigState: SlackConfigState | null = null;
let currentAudioDeviceState: AudioDeviceState | null = null;
let currentMatchHistoryState: MatchHistoryState | null = null;
let currentUsageState: UsageState | null = null;
let currentAdminAuth: AdminAuthResult | null = null;
let currentSetupProbeState: SetupProbeState | null = null;
let currentSetupConfigState: SetupConfigState | null = null;

function handleSupportState(state: SupportState) {
  currentSupportState = state;
  events.dispatchEvent(new CustomEvent('supportState', { detail: state }));
}

function handleSupportChatIncoming(msg: { message: SupportChatMessage }) {
  events.dispatchEvent(new CustomEvent('supportChatMessage', { detail: msg.message }));
  // Also dispatch to window for non-React consumers
  window.dispatchEvent(new CustomEvent('supportChatMessage', { detail: msg.message }));
}

function handleAdminAuthResult(result: AdminAuthResult) {
  currentAdminAuth = result;
  events.dispatchEvent(new CustomEvent('adminAuthResult', { detail: result }));

  // When admin login succeeds with an external access token, set the browser
  // cookie by fetching the auth URL. This grants remote access automatically.
  if (result.authenticated && result.externalAccessToken) {
    fetch(`/admin/auth/${result.externalAccessToken}`).catch(() => {
      // Cookie-setting failed — not critical, admin can create tokens manually
    });
  }
}

function handleSlackConfigState(state: SlackConfigState) {
  currentSlackConfigState = state;
  events.dispatchEvent(new CustomEvent('slackConfigState', { detail: state }));
}

function handleSetupProbeState(state: SetupProbeState) {
  currentSetupProbeState = state;
  events.dispatchEvent(new CustomEvent('setupProbeState', { detail: state }));
}

function handleSetupConfigState(state: SetupConfigState) {
  currentSetupConfigState = state;
  events.dispatchEvent(new CustomEvent('setupConfigState', { detail: state }));
}

function handleAudioDeviceState(state: AudioDeviceState) {
  currentAudioDeviceState = state;
  events.dispatchEvent(new CustomEvent('audioDeviceState', { detail: state }));
}

function handleMatchHistoryState(state: MatchHistoryState) {
  currentMatchHistoryState = state;
  events.dispatchEvent(new CustomEvent('matchHistoryState', { detail: state }));
}

let currentMatchRecordingState: MatchRecordingState | null = null;

function handleMatchRecordingState(state: MatchRecordingState) {
  currentMatchRecordingState = state;
  events.dispatchEvent(new CustomEvent('matchRecordingState', { detail: state }));
}

function handleUsageState(state: UsageState) {
  currentUsageState = state;
  events.dispatchEvent(new CustomEvent('usageState', { detail: state }));
}

function handleSupportIssueCreated(msg: { type: string; issueId: string }) {
  events.dispatchEvent(new CustomEvent('supportIssueCreated', { detail: msg }));
  window.dispatchEvent(new CustomEvent('supportIssueCreated', { detail: msg }));
}

function handleSupportChatStarted(msg: { type: string; sessionId: string }) {
  events.dispatchEvent(new CustomEvent('supportChatStarted', { detail: msg }));
  window.dispatchEvent(new CustomEvent('supportChatStarted', { detail: msg }));
}

function handleSlackTestResult(msg: { ok: boolean; error?: string; channelName?: string }) {
  events.dispatchEvent(new CustomEvent('slackTestResult', { detail: msg }));
}

function handleServerInfo(info: ServerInfo) {
  // Sent once on connect — seeds the clock offset before any other traffic
  if (info.now !== undefined) noteServerTimestamp(info.now);

  // Auto-refresh if the backend has been updated since this frontend was built.
  // Both sides use the git short hash; 'unknown' means we can't compare (dev mode, no git).
  const buildVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'unknown';
  if (buildVersion !== 'unknown' && info.version !== 'unknown' && info.version !== buildVersion) {
    console.log(`Version mismatch: frontend=${buildVersion}, server=${info.version} — reloading`);
    window.location.reload();
    return;
  }

  currentServerInfo = info;
  events.dispatchEvent(new CustomEvent('serverInfo', { detail: info }));
}

function receiveMessage(detail: Message) {
  if (isServerInfo(detail)) {
    handleServerInfo(detail);
    return;
  }

  if (isPendingCommitState(detail)) {
    handlePendingCommitState(detail);
    return;
  }

  if (isLastLinkedState(detail)) {
    handleLastLinkedState(detail);
    return;
  }

  if (isRoutePreferenceState(detail)) {
    handleRoutePreferenceState(detail);
    return;
  }

  if (isErrorEntry(detail)) {
    handleErrorEntry(detail);
    return;
  }

  if (isTelemetryUpdate(detail)) {
    handleTelemetry(detail);
    return;
  }

  if (isMatchState(detail)) {
    handleMatchState(detail);
    return;
  }

  if (isSubnetScanResults(detail)) {
    handleSubnetScan(detail);
    return;
  }

  if (isTeamCheckResults(detail)) {
    handleTeamCheckResults(detail);
    return;
  }

  if (isMdnsActivity(detail)) {
    handleMdnsActivity(detail);
    return;
  }

  if (isNetworkStats(detail)) {
    handleNetworkStats(detail);
    return;
  }

  if (isRobotTestState(detail)) {
    handleRobotTestState(detail);
    return;
  }

  if (isStationTestState(detail)) {
    handleStationTestState(detail);
    return;
  }

  if (isFirmwareUpdateProgress(detail)) {
    handleFirmwareProgress(detail);
    return;
  }

  if (isRadioConfigureProgress(detail)) {
    handleRadioConfigureProgress(detail);
    return;
  }

  if (typeof detail === 'object' && detail !== null && (detail as { type: string }).type === 'firmwareStoreUpdate') {
    handleFirmwareStoreUpdate((detail as unknown as { entries: FirmwareEntry[] }).entries);
    return;
  }

  if (isScoreState(detail)) {
    handleScoreState(detail);
    return;
  }

  if (isStopCast(detail)) {
    handleStopCast();
    return;
  }

  if (isCastReceiverList(detail)) {
    handleCastReceiverList(detail);
    return;
  }

  if (isCastReceiverSwap(detail)) {
    handleCastReceiverSwap(detail);
    return;
  }

  if (isCastReceiverMute(detail)) {
    handleCastReceiverMute(detail);
    return;
  }

  if (isPlayGetReady(detail)) {
    events.dispatchEvent(new CustomEvent('playGetReady'));
    return;
  }

  if (isApiKeyState(detail)) {
    handleApiKeyState(detail);
    return;
  }

  if (isApiKeyCreated(detail)) {
    handleApiKeyCreated(detail);
    return;
  }

  if (isExternalAccessState(detail)) {
    handleExternalAccessState(detail);
    return;
  }

  if (isDriveSessionState(detail)) {
    handleDriveSessionState(detail);
    return;
  }

  if (isHostnamesState(detail)) {
    handleHostnamesState(detail);
    return;
  }

  if (isExternalAccessTokenCreated(detail)) {
    handleExternalAccessTokenCreated(detail);
    return;
  }

  if (isSavedTeamsState(detail)) {
    handleSavedTeamsState(detail);
    return;
  }

  if (isPortBridgeState(detail)) {
    handlePortBridgeState(detail);
    return;
  }

  if (isSupportState(detail)) {
    handleSupportState(detail);
    return;
  }

  if (isSupportChatIncoming(detail)) {
    handleSupportChatIncoming(detail);
    return;
  }

  if (isAdminAuthResult(detail)) {
    handleAdminAuthResult(detail);
    return;
  }

  if (isSlackConfigState(detail)) {
    handleSlackConfigState(detail);
    return;
  }

  if (isSetupProbeState(detail)) {
    handleSetupProbeState(detail);
    return;
  }

  if (isSetupConfigState(detail)) {
    handleSetupConfigState(detail);
    return;
  }

  if (isAudioDeviceState(detail)) {
    handleAudioDeviceState(detail);
    return;
  }

  if (isMatchHistoryState(detail)) {
    handleMatchHistoryState(detail);
    return;
  }

  if (isMatchRecordingState(detail)) {
    handleMatchRecordingState(detail);
    return;
  }

  if (isRecordingStreamTestResult(detail)) {
    events.dispatchEvent(new CustomEvent('recordingStreamTestResult', { detail }));
    return;
  }

  if (isUsageState(detail)) {
    handleUsageState(detail);
    return;
  }

  // Handle support-specific response messages
  if (typeof detail === 'object' && detail !== null) {
    const d = detail as { type?: string };
    if (d.type === 'supportIssueCreated') {
      handleSupportIssueCreated(detail as unknown as { type: string; issueId: string });
      return;
    }
    if (d.type === 'supportChatStarted') {
      handleSupportChatStarted(detail as unknown as { type: string; sessionId: string });
      return;
    }
    if (d.type === 'slackTestResult') {
      handleSlackTestResult(detail as unknown as { ok: boolean; error?: string; channelName?: string });
      return;
    }
  }

  if (isAppLogMessage(detail)) {
    handleAppLog(detail);
    return;
  }

  if (isRadioMessage(detail)) {
    handleRadioMessage(detail);
    return;
  }

  if (isStatusEntry(detail)) {
    handleStatusEntry(detail);
    return;
  }

  // Handle generic server responses (info/error messages from config operations etc.)
  if (typeof detail === 'object' && detail !== null) {
    const msg = detail as { info?: string; error?: string };
    if (msg.info) {
      events.dispatchEvent(new CustomEvent('serverResponse', { detail: { severity: 'info', message: msg.info } }));
      return;
    }
    if (msg.error) {
      events.dispatchEvent(new CustomEvent('serverResponse', { detail: { severity: 'error', message: msg.error } }));
      return;
    }
  }

  console.error('Unknown message:', detail);
}

export function useHistory() {
  const [retHistory, setHistory] = useState<StatusEntry[]>([...history]);

  useUpdateCallback(useCallback(_ => setHistory([...history]), [setHistory]));

  return retHistory;
}

export function useLatest() {
  const [latest, setLatest] = useState<StatusEntry | undefined>(history[history.length - 1]);

  useUpdateCallback(setLatest);

  return latest;
}

export function useRadioMessages() {
  const [messages, setMessages] = useState<RadioMessage[]>([...radioMessages]);

  useRadioMessageCallback(useCallback(_ => setMessages([...radioMessages]), [setMessages]));

  return messages;
}

/**
 * Returns the current server time (adjusted for clock offset between client and server)
 */
export function getServerTime(): number {
  return Date.now() + timeOffset;
}

/**
 * Converts a server timestamp to browser/client time
 */
export function serverToBrowserTime(serverTimestamp: number): number {
  return serverTimestamp - timeOffset;
}

// ── Robot Telemetry ─────────────────────────────────────────────────

export function useLatestTelemetry(station: StationName): TelemetryUpdate | undefined {
  const [latest, setLatest] = useState<TelemetryUpdate | undefined>();

  useTelemetryCallback(
    useCallback(
      (update: TelemetryUpdate) => {
        if (update.station === station) setLatest(update);
      },
      [station],
    ),
  );

  return latest;
}

// ── WebSocket Connection State ───────────────────────────────────────

export function useWsConnected(): boolean {
  const [connected, setConnected] = useState(wsConnected);

  useEffect(() => {
    const handler = (e: Event) => setConnected((e as CustomEvent).detail);
    events.addEventListener('wsStatus', handler);
    return () => events.removeEventListener('wsStatus', handler);
  }, []);

  return connected;
}

// ── Saved Teams ─────────────────────────────────────────────────────

export function useSavedTeams(): SavedTeamsState | null {
  const [state, setState] = useState<SavedTeamsState | null>(currentSavedTeams);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('savedTeamsState', handler);
    return () => events.removeEventListener('savedTeamsState', handler);
  }, []);

  return state;
}

// ── Match State ─────────────────────────────────────────────────────

export function useMatchState(): MatchState | null {
  const [state, setState] = useState<MatchState | null>(currentMatchState);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('matchState', handler);
    return () => events.removeEventListener('matchState', handler);
  }, []);

  return state;
}

// ── Network Stats ───────────────────────────────────────────────────

export function useNetworkStats(): NetworkStats | null {
  const [state, setState] = useState<NetworkStats | null>(currentNetworkStats);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('networkStats', handler);
    return () => events.removeEventListener('networkStats', handler);
  }, []);

  return state;
}

// ── Subnet Scan ─────────────────────────────────────────────────────

export function useSubnetScan(): SubnetScanResults | null {
  const [state, setState] = useState<SubnetScanResults | null>(currentSubnetScan);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('subnetScan', handler);
    return () => events.removeEventListener('subnetScan', handler);
  }, []);

  return state;
}

// ── mDNS Activity ───────────────────────────────────────────────────

export function useMdnsActivity(): MdnsActivity | null {
  const [state, setState] = useState<MdnsActivity | null>(currentMdnsActivity);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('mdnsActivity', handler);
    return () => events.removeEventListener('mdnsActivity', handler);
  }, []);

  return state;
}

// ── Station match commands ───────────────────────────────────────────

export function sendStationJoin(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationJoin', station }));
}

/** Join a station to a specific alliance (decoupled from physical port). */
export function sendStationJoinAlliance(station: StationName, alliance: Alliance) {
  ws?.send(JSON.stringify({ type: 'stationJoinAlliance', station, alliance }));
}

/** Save a team config to the server without assigning it to a station. */
export function sendSaveTeam(ssid: string, wpaKey: string) {
  ws?.send(JSON.stringify({ type: 'saveSavedTeam', ssid, wpaKey }));
}

/** Remove a saved team config from the server. */
export function sendRemoveSavedTeam(ssid: string) {
  ws?.send(JSON.stringify({ type: 'removeSavedTeam', ssid }));
}

/** Enable a previously-saved robot by SSID — server looks up the passphrase. */
export function sendEnableSavedRobot(station: StationName, ssid: string, stage = false) {
  ws?.send(JSON.stringify({ type: 'enableSavedRobot', ssid, station, stage }));
}

export function sendStationLeave(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationLeave', station }));
}

export function sendStationReady(station: StationName, ready: boolean) {
  ws?.send(JSON.stringify({ type: 'stationReady', station, ready }));
}

export function sendStationStartMatch() {
  ws?.send(JSON.stringify({ type: 'stationStartMatch' }));
}

export function sendStationPauseMatch() {
  ws?.send(JSON.stringify({ type: 'stationPauseMatch' }));
}

export function sendStationResumeMatch() {
  ws?.send(JSON.stringify({ type: 'stationResumeMatch' }));
}

export function sendStationAbandonMatch() {
  ws?.send(JSON.stringify({ type: 'stationAbandonMatch' }));
}

export function sendUpdateMatchConfig(config: MatchConfig) {
  ws?.send(JSON.stringify({ type: 'updateMatchConfig', config }));
}

// ── Admin Commands ──────────────────────────────────────────────────

// ── Match Controller Commands ────────────────────────────────────────

export function sendMatchCreate() {
  ws?.send(JSON.stringify({ type: 'matchCreate' }));
}

export function sendMatchAbortCountdown() {
  ws?.send(JSON.stringify({ type: 'matchAbortCountdown' }));
}

export function sendMatchCancel() {
  ws?.send(JSON.stringify({ type: 'matchCancel' }));
}

export function sendMatchClear() {
  ws?.send(JSON.stringify({ type: 'matchClear' }));
}

export function sendMatchSwapStation(station: StationName) {
  ws?.send(JSON.stringify({ type: 'matchSwapStation', station }));
}

export function sendMatchKickStation(station: StationName) {
  ws?.send(JSON.stringify({ type: 'matchKickStation', station }));
}

export function sendMatchSetAutoWinner(winner: Alliance) {
  ws?.send(JSON.stringify({ type: 'matchSetAutoWinner', winner }));
}

/** Host opens or retracts the ready check. */
export function sendMatchRequestReady(requested: boolean) {
  ws?.send(JSON.stringify({ type: 'matchRequestReady', requested }));
}

/** Host marks a staff role required / not required for this match. */
export function sendMatchStaffIgnore(role: StaffRole, ignored: boolean) {
  ws?.send(JSON.stringify({ type: 'matchStaffIgnore', role, ignored }));
}

// ── Staff Commands (from /staff pages) ───────────────────────────────

export function sendStaffReady(role: StaffRole, ready: boolean) {
  ws?.send(JSON.stringify({ type: 'staffReady', role, ready }));
}

export function sendStaffHeartbeat(role: StaffRole) {
  // Fired on a timer from page mount, so unlike user-action sends it can race
  // the socket still CONNECTING — send() then throws and crashes the page.
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'staffHeartbeat', role }));
}

export function sendStationSelfDisable(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationSelfDisable', station }));
}

export function sendStationSelfUndisable(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationSelfUndisable', station }));
}

export function sendStationSelfEStop(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationSelfEStop', station }));
}

export function sendStationSelfAStop(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationSelfAStop', station }));
}

export function sendStationClearAStop(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationClearAStop', station }));
}

export function sendAdminStopMatch() {
  ws?.send(JSON.stringify({ type: 'adminStopMatch' }));
}

export function sendAdminGlobalEStop() {
  ws?.send(JSON.stringify({ type: 'adminGlobalEStop' }));
}

export function sendAdminStationEStop(station: StationName) {
  ws?.send(JSON.stringify({ type: 'adminStationEStop', station }));
}

export function sendAdminStationDisable(station: StationName) {
  ws?.send(JSON.stringify({ type: 'adminStationDisable', station }));
}

export function sendAdminStationEnable(station: StationName) {
  ws?.send(JSON.stringify({ type: 'adminStationEnable', station }));
}

export function sendAdminClearEStop(station?: StationName) {
  ws?.send(JSON.stringify({ type: 'adminClearEStop', station }));
}

// ── Route Preferences ───────────────────────────────────────────────

export function useRoutePreferenceState(): RoutePreferenceState | null {
  const [state, setState] = useState<RoutePreferenceState | null>(currentRoutePreferenceState);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('routePreferenceState', handler);
    return () => events.removeEventListener('routePreferenceState', handler);
  }, []);

  return state;
}

export function sendRoutePreference(station: RoutePreferenceMsg['station']) {
  ws?.send(JSON.stringify({ type: 'routePreference', station } satisfies RoutePreferenceMsg));
}

/**
 * Send a "drive" action to the server to start or stop driving a station's robot.
 * Unlike sendRoutePreference (which only sets the forward ip rule), this sets up
 * both the forward path (ip rule) AND the reverse path (DNAT).
 */
export function sendDrive(station: DriveAction['station']) {
  ws?.send(JSON.stringify({ type: 'drive', station } satisfies DriveAction));
}

// ── Pending Commit ──────────────────────────────────────────────────

export function usePendingCommit(): boolean {
  const [pending, setPending] = useState(currentPendingCommit);

  useEffect(() => {
    const handler = (e: Event) => setPending((e as CustomEvent<PendingCommitState>).detail.pending);
    events.addEventListener('pendingCommitState', handler);
    return () => events.removeEventListener('pendingCommitState', handler);
  }, []);

  return pending;
}

/** The whole pending-commit message: what is staged, and whether a deferred
 *  re-apply is owed. For the status bar's summary of what "Apply" will do. */
export function usePendingCommitState(): PendingCommitState {
  const [state, setState] = useState<PendingCommitState>(currentPendingCommitState);

  useEffect(() => {
    setState(currentPendingCommitState);
    const handler = (e: Event) => setState((e as CustomEvent<PendingCommitState>).detail);
    events.addEventListener('pendingCommitState', handler);
    return () => events.removeEventListener('pendingCommitState', handler);
  }, []);

  return state;
}

/** Get the backend's staged changes (not yet committed). */
export function useBackendStagedChanges(): Record<string, StagedStationChange | null> {
  const [staged, setStaged] = useState(currentStagedChanges);

  useEffect(() => {
    const handler = (e: Event) => setStaged((e as CustomEvent<PendingCommitState>).detail.stagedChanges ?? {});
    events.addEventListener('pendingCommitState', handler);
    return () => events.removeEventListener('pendingCommitState', handler);
  }, []);

  return staged;
}

/** Get per-station last-linked timestamps from the backend. */
export function useLastLinked(): Partial<Record<StationName, number>> {
  const [timestamps, setTimestamps] = useState(currentLastLinked);

  useEffect(() => {
    setTimestamps(currentLastLinked);
    const handler = (e: Event) => setTimestamps((e as CustomEvent<LastLinkedState>).detail.timestamps);
    events.addEventListener('lastLinkedState', handler);
    return () => events.removeEventListener('lastLinkedState', handler);
  }, []);

  return timestamps;
}

export function sendApplyConfig() {
  ws?.send(JSON.stringify({ type: 'applyConfig' }));
}

// ── Team Checks ─────────────────────────────────────────────────────

export function useTeamCheckResults(station: StationName): TeamCheckResults | null {
  const [results, setResults] = useState<TeamCheckResults | null>(currentTeamCheckResults.get(station) ?? null);

  useEffect(() => {
    setResults(currentTeamCheckResults.get(station) ?? null);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TeamCheckResults>).detail;
      if (detail.station === station) setResults(detail);
    };
    events.addEventListener('teamCheckResults', handler);
    return () => events.removeEventListener('teamCheckResults', handler);
  }, [station]);

  return results;
}

export function sendRunTeamChecks(station: StationName) {
  ws?.send(JSON.stringify({ type: 'runTeamChecks', station } satisfies RunTeamChecks));
}

// ── Robot Test State ──────────────────────────────────────────────────

let currentRobotTestState: RobotTestState | null = null;

function handleRobotTestState(state: RobotTestState) {
  currentRobotTestState = state;
  events.dispatchEvent(new CustomEvent('robotTestState', { detail: state }));
}

export function useRobotTestState(): RobotTestState | null {
  const [state, setState] = useState<RobotTestState | null>(currentRobotTestState);

  useEffect(() => {
    setState(currentRobotTestState);
    const handler = (e: Event) => setState((e as CustomEvent<RobotTestState>).detail);
    events.addEventListener('robotTestState', handler);
    return () => events.removeEventListener('robotTestState', handler);
  }, []);

  return state;
}

// ── Station Test Port Mode State ─────────────────────────────────────

const currentStationTestStates = new Map<StationName, StationTestState>();

/** A stopped session is signaled by phase 'disabled' with zeroed port fields. */
function isStationTestStopped(state: StationTestState): boolean {
  return state.testState.phase === 'disabled' && state.portVlanId === 0;
}

function handleStationTestState(state: StationTestState) {
  if (isStationTestStopped(state)) {
    currentStationTestStates.delete(state.station);
  } else {
    currentStationTestStates.set(state.station, state);
  }
  events.dispatchEvent(new CustomEvent('stationTestState', { detail: state }));
}

/** Get the test port mode state for a specific station. */
export function useStationTestState(station: StationName): StationTestState | null {
  const [state, setState] = useState<StationTestState | null>(currentStationTestStates.get(station) ?? null);

  useEffect(() => {
    setState(currentStationTestStates.get(station) ?? null);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<StationTestState>).detail;
      if (detail.station === station) {
        setState(isStationTestStopped(detail) ? null : detail);
      }
    };
    events.addEventListener('stationTestState', handler);
    return () => events.removeEventListener('stationTestState', handler);
  }, [station]);

  return state;
}

export function sendStationTestModeRequest(station: StationName, portVlanId: number) {
  ws?.send(JSON.stringify({ type: 'stationTestModeRequest', station, portVlanId }));
}

export function sendStationTestModeStop(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationTestModeStop', station }));
}

export function sendStationRadioConfigureRequest(
  station: StationName,
  teamNumber: number,
  wpaKey6: string,
  wpaKey24?: string,
  ssidSuffix?: string,
) {
  ws?.send(
    JSON.stringify({ type: 'stationRadioConfigureRequest', station, teamNumber, wpaKey6, wpaKey24, ssidSuffix }),
  );
}

export function sendStationFirmwareUpdateRequest(
  station: StationName,
  wpaKey?: string,
  wpaKey24?: string,
  skipReconfigure?: boolean,
) {
  ws?.send(JSON.stringify({ type: 'stationFirmwareUpdateRequest', station, wpaKey, wpaKey24, skipReconfigure }));
}

// ── Firmware Update Progress ─────────────────────────────────────────

let currentFirmwareProgress: FirmwareUpdateProgress | null = null;

function handleFirmwareProgress(progress: FirmwareUpdateProgress) {
  currentFirmwareProgress = progress;
  events.dispatchEvent(new CustomEvent('firmwareProgress', { detail: progress }));
}

export function useFirmwareUpdateProgress(): FirmwareUpdateProgress | null {
  const [progress, setProgress] = useState<FirmwareUpdateProgress | null>(currentFirmwareProgress);

  useEffect(() => {
    setProgress(currentFirmwareProgress);
    const handler = (e: Event) => setProgress((e as CustomEvent<FirmwareUpdateProgress>).detail);
    events.addEventListener('firmwareProgress', handler);
    return () => events.removeEventListener('firmwareProgress', handler);
  }, []);

  return progress;
}

// ── Radio Configure Progress ─────────────────────────────────────────

let currentRadioConfigureProgress: RadioConfigureProgress | null = null;

function handleRadioConfigureProgress(progress: RadioConfigureProgress) {
  currentRadioConfigureProgress = progress;
  events.dispatchEvent(new CustomEvent('radioConfigureProgress', { detail: progress }));
}

export function useRadioConfigureProgress(): RadioConfigureProgress | null {
  const [progress, setProgress] = useState<RadioConfigureProgress | null>(currentRadioConfigureProgress);

  useEffect(() => {
    setProgress(currentRadioConfigureProgress);
    const handler = (e: Event) => setProgress((e as CustomEvent<RadioConfigureProgress>).detail);
    events.addEventListener('radioConfigureProgress', handler);
    return () => events.removeEventListener('radioConfigureProgress', handler);
  }, []);

  return progress;
}

export function sendRadioConfigureRequest(teamNumber: number, wpaKey6: string, wpaKey24?: string, ssidSuffix?: string) {
  ws?.send(
    JSON.stringify({
      type: 'radioConfigureRequest',
      teamNumber,
      wpaKey6,
      wpaKey24,
      ssidSuffix,
    } satisfies RadioConfigureRequest),
  );
}

// ── Firmware Store State ─────────────────────────────────────────────

import type { FirmwareEntry } from '../../../src/firmwareStore';

let currentFirmwareEntries: FirmwareEntry[] = [];

function handleFirmwareStoreUpdate(entries: FirmwareEntry[]) {
  currentFirmwareEntries = entries;
  events.dispatchEvent(new CustomEvent('firmwareStoreUpdate', { detail: entries }));
}

export function useFirmwareStore(): FirmwareEntry[] {
  const [entries, setEntries] = useState<FirmwareEntry[]>(currentFirmwareEntries);

  useEffect(() => {
    setEntries(currentFirmwareEntries);
    const handler = (e: Event) => setEntries((e as CustomEvent<FirmwareEntry[]>).detail);
    events.addEventListener('firmwareStoreUpdate', handler);
    return () => events.removeEventListener('firmwareStoreUpdate', handler);
  }, []);

  return entries;
}

export function sendFirmwareUpdateRequest(wpaKey?: string, wpaKey24?: string, skipReconfigure?: boolean) {
  ws?.send(
    JSON.stringify({
      type: 'firmwareUpdateRequest',
      wpaKey,
      wpaKey24,
      skipReconfigure,
    } satisfies FirmwareUpdateRequest),
  );
}

// ── Score State ──────────────────────────────────────────────────────

let currentScoreState: ScoreState | null = null;

function handleScoreState(state: ScoreState) {
  currentScoreState = state;
  events.dispatchEvent(new CustomEvent('scoreState', { detail: state }));
}

export function useScoreState(): ScoreState | null {
  const [state, setState] = useState<ScoreState | null>(currentScoreState);

  useEffect(() => {
    setState(currentScoreState);
    const handler = (e: Event) => setState((e as CustomEvent<ScoreState>).detail);
    events.addEventListener('scoreState', handler);
    return () => events.removeEventListener('scoreState', handler);
  }, []);

  return state;
}

// ── Cast Control ─────────────────────────────────────────────────────

function handleStopCast() {
  // On receiver (Chromecast): stop the Cast app
  try {
    if (window.__isCastReceiver && typeof cast !== 'undefined' && cast.framework) {
      cast.framework.CastReceiverContext.getInstance().stop();
    }
  } catch {
    // Not a receiver
  }
}

export function sendStopCast(receiverId?: string) {
  ws?.send(JSON.stringify({ type: 'stopCast', receiverId } satisfies StopCast));
}

// ── Cast Receiver List ──────────────────────────────────────────────

let currentCastReceivers: CastReceiverList['receivers'] = [];

function handleCastReceiverList(msg: CastReceiverList) {
  currentCastReceivers = msg.receivers;
  events.dispatchEvent(new CustomEvent('castReceiverList', { detail: msg.receivers }));
}

function handleCastReceiverSwap(msg: CastReceiverSwap) {
  // On receiver: apply the swap
  if (window.__isCastReceiver) {
    localStorage.setItem('scoreboard-swap', msg.swapped ? '1' : '0');
    window.location.reload();
  }
}

function handleCastReceiverMute(msg: CastReceiverMute) {
  // On receiver: apply the mute
  if (window.__isCastReceiver) {
    localStorage.setItem('scoreboard-muted', msg.muted ? '1' : '0');
    window.location.reload();
  }
}

export function useCastReceivers(): CastReceiverList['receivers'] {
  const [receivers, setReceivers] = useState(currentCastReceivers);

  useEffect(() => {
    setReceivers(currentCastReceivers);
    const handler = (e: Event) => setReceivers((e as CustomEvent<CastReceiverList['receivers']>).detail);
    events.addEventListener('castReceiverList', handler);
    return () => events.removeEventListener('castReceiverList', handler);
  }, []);

  return receivers;
}

export function sendCastReceiverSwap(receiverId: string, swapped: boolean) {
  ws?.send(JSON.stringify({ type: 'castReceiverSwap', receiverId, swapped } satisfies CastReceiverSwap));
}

export function sendCastReceiverMute(receiverId: string, muted: boolean) {
  ws?.send(JSON.stringify({ type: 'castReceiverMute', receiverId, muted } satisfies CastReceiverMute));
}

/** Ask the server to play the "get ready" attention sound everywhere. */
export function sendPlayGetReady() {
  ws?.send(JSON.stringify({ type: 'playGetReady' } satisfies PlayGetReady));
}

/** Subscribe to the server-broadcast "get ready" signal. Returns unsubscribe. */
export function onPlayGetReady(fn: () => void): () => void {
  const handler = () => fn();
  events.addEventListener('playGetReady', handler);
  return () => events.removeEventListener('playGetReady', handler);
}

export function sendCastReceiverRegister(name: string, swapped: boolean, muted: boolean) {
  ws?.send(JSON.stringify({ type: 'castReceiverRegister', name, swapped, muted } satisfies CastReceiverRegister));
}

// ── Server Responses ─────────────────────────────────────────────────

export interface ServerResponse {
  severity: 'info' | 'error';
  message: string;
}

/** Subscribe to server info/error responses. Returns the latest response (auto-clears after 5s). */
export function useServerResponse(): ServerResponse | null {
  const [response, setResponse] = useState<ServerResponse | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ServerResponse>).detail;
      setResponse(detail);
      // Auto-clear after 5 seconds
      setTimeout(() => setResponse(prev => (prev === detail ? null : prev)), 5000);
    };
    events.addEventListener('serverResponse', handler);
    return () => events.removeEventListener('serverResponse', handler);
  }, []);

  return response;
}

// ── API Key Management ──────────────────────────────────────────────

let currentApiKeyState: ApiKeyState | null = null;

function handleApiKeyState(state: ApiKeyState) {
  currentApiKeyState = state;
  events.dispatchEvent(new CustomEvent('apiKeyState', { detail: state }));
}

function handleApiKeyCreated(msg: ApiKeyCreated) {
  events.dispatchEvent(new CustomEvent('apiKeyCreated', { detail: msg }));
}

export function useApiKeyState(): ApiKeyState | null {
  const [state, setState] = useState<ApiKeyState | null>(currentApiKeyState);

  useEffect(() => {
    setState(currentApiKeyState);
    const handler = (e: Event) => setState((e as CustomEvent<ApiKeyState>).detail);
    events.addEventListener('apiKeyState', handler);
    return () => events.removeEventListener('apiKeyState', handler);
  }, []);

  return state;
}

/** Subscribe to one-time key creation events (contains the full key value). */
export function useApiKeyCreatedEvent(callback: (msg: ApiKeyCreated) => void) {
  useEffect(() => {
    const handler = (e: Event) => callback((e as CustomEvent<ApiKeyCreated>).detail);
    events.addEventListener('apiKeyCreated', handler);
    return () => events.removeEventListener('apiKeyCreated', handler);
  }, [callback]);
}

export function sendCreateApiKey(label: string) {
  ws?.send(JSON.stringify({ type: 'createApiKey', label }));
}

export function sendRevokeApiKey(id: string) {
  ws?.send(JSON.stringify({ type: 'revokeApiKey', id }));
}

export function sendReactivateApiKey(id: string) {
  ws?.send(JSON.stringify({ type: 'reactivateApiKey', id }));
}

export function sendDeleteApiKey(id: string) {
  ws?.send(JSON.stringify({ type: 'deleteApiKey', id }));
}

export function sendApprovePendingDevice(id: string, label: string) {
  ws?.send(JSON.stringify({ type: 'approvePendingDevice', id, label }));
}

export function sendDismissPendingDevice(id: string) {
  ws?.send(JSON.stringify({ type: 'dismissPendingDevice', id }));
}

// ── External Access Token Management ─────────────────────────────────

let currentExternalAccessState: ExternalAccessState | null = null;

function handleExternalAccessState(state: ExternalAccessState) {
  currentExternalAccessState = state;
  events.dispatchEvent(new CustomEvent('externalAccessState', { detail: state }));
}

function handleExternalAccessTokenCreated(msg: ExternalAccessTokenCreated) {
  events.dispatchEvent(new CustomEvent('externalAccessTokenCreated', { detail: msg }));
}

export function useExternalAccessState(): ExternalAccessState | null {
  const [state, setState] = useState<ExternalAccessState | null>(currentExternalAccessState);

  useEffect(() => {
    setState(currentExternalAccessState);
    const handler = (e: Event) => setState((e as CustomEvent<ExternalAccessState>).detail);
    events.addEventListener('externalAccessState', handler);
    return () => events.removeEventListener('externalAccessState', handler);
  }, []);

  return state;
}

/** Subscribe to one-time token creation events (contains the raw token for sharing). */
export function useExternalAccessTokenCreatedEvent(callback: (msg: ExternalAccessTokenCreated) => void) {
  useEffect(() => {
    const handler = (e: Event) => callback((e as CustomEvent<ExternalAccessTokenCreated>).detail);
    events.addEventListener('externalAccessTokenCreated', handler);
    return () => events.removeEventListener('externalAccessTokenCreated', handler);
  }, [callback]);
}

export function sendCreateExternalAccessToken(label: string) {
  ws?.send(JSON.stringify({ type: 'createExternalAccessToken', label }));
}

export function sendRevokeExternalAccessToken(id: string) {
  ws?.send(JSON.stringify({ type: 'revokeExternalAccessToken', id }));
}

// ── Drive Session State ──────────────────────────────────────────────

let currentDriveSessionState: DriveSessionState | null = null;

function handleDriveSessionState(state: DriveSessionState) {
  currentDriveSessionState = state;
  events.dispatchEvent(new CustomEvent('driveSessionState', { detail: state }));
}

export function useDriveSessionState(): DriveSessionState | null {
  const [state, setState] = useState<DriveSessionState | null>(currentDriveSessionState);

  useEffect(() => {
    setState(currentDriveSessionState);
    const handler = (e: Event) => setState((e as CustomEvent<DriveSessionState>).detail);
    events.addEventListener('driveSessionState', handler);
    return () => events.removeEventListener('driveSessionState', handler);
  }, []);

  return state;
}

// ── Guest Host Names ─────────────────────────────────────────────────

let currentHostnames: HostnamesState['hostnames'] = {};

function handleHostnamesState(state: HostnamesState) {
  currentHostnames = state.hostnames;
  events.dispatchEvent(new CustomEvent('hostnamesState', { detail: state }));
}

/** Resolved device names for guest-network hosts (DS laptops etc.), keyed by IP. */
export function useHostnames(): HostnamesState['hostnames'] {
  const [hostnames, setHostnames] = useState(currentHostnames);

  useEffect(() => {
    setHostnames(currentHostnames);
    const handler = (e: Event) => setHostnames((e as CustomEvent<HostnamesState>).detail.hostnames);
    events.addEventListener('hostnamesState', handler);
    return () => events.removeEventListener('hostnamesState', handler);
  }, []);

  return hostnames;
}

export function sendScoreReset() {
  ws?.send(JSON.stringify({ type: 'scoreReset' }));
}

// ── Port Bridge ─────────────────────────────────────────────────────

export function usePortBridgeState(): PortBridgeState | null {
  const [state, setState] = useState<PortBridgeState | null>(currentPortBridgeState);

  useEffect(() => {
    setState(currentPortBridgeState);
    const handler = (e: Event) => setState((e as CustomEvent<PortBridgeState>).detail);
    events.addEventListener('portBridgeState', handler);
    return () => events.removeEventListener('portBridgeState', handler);
  }, []);

  return state;
}

/** Request to bridge a physical port to a station, or unbind (portVlanId=null). */
export function sendPortBridge(station: StationName, portVlanId: number | null) {
  ws?.send(JSON.stringify({ type: 'portBridge', station, portVlanId } satisfies PortBridgeRequest));
}

// ── Support System ──────────────────────────────────────────────────

export function useSupportState(): SupportState | null {
  const [state, setState] = useState<SupportState | null>(currentSupportState);

  useEffect(() => {
    setState(currentSupportState);
    const handler = (e: Event) => setState((e as CustomEvent<SupportState>).detail);
    events.addEventListener('supportState', handler);
    return () => events.removeEventListener('supportState', handler);
  }, []);

  return state;
}

/** Subscribe to chat messages for a specific session. */
export function useSupportChatMessages(sessionId: string): SupportChatMessage[] {
  const [messages, setMessages] = useState<SupportChatMessage[]>(() => {
    // Initialize from current support state
    const session = currentSupportState?.activeSessions.find(s => s.id === sessionId);
    return session?.messages ?? [];
  });

  useEffect(() => {
    // Re-initialize if state updates
    const session = currentSupportState?.activeSessions.find(s => s.id === sessionId);
    if (session) setMessages([...session.messages]);

    const handler = (e: Event) => {
      const msg = (e as CustomEvent<SupportChatMessage>).detail;
      if (msg.sessionId === sessionId) {
        setMessages(prev => [...prev, msg]);
      }
    };
    events.addEventListener('supportChatMessage', handler);
    return () => events.removeEventListener('supportChatMessage', handler);
  }, [sessionId]);

  return messages;
}

export function sendSubmitSupportIssue(
  tryingToDo: string,
  stepsPerformed: string,
  expected: string,
  actual: string,
  metadata: SupportMetadata,
  screenshotDataUrl?: string,
  recentLogs: string[] = [],
) {
  ws?.send(
    JSON.stringify({
      type: 'submitSupportIssue',
      tryingToDo,
      stepsPerformed,
      expected,
      actual,
      metadata,
      screenshotDataUrl,
      recentLogs,
    }),
  );
}

export function sendStartSupportChat(issueId?: string, senderName?: string) {
  ws?.send(JSON.stringify({ type: 'startSupportChat', issueId, senderName }));
}

export function sendSupportChatMessage(
  sessionId: string,
  text: string,
  screenshotDataUrl?: string,
  senderName?: string,
) {
  ws?.send(
    JSON.stringify({
      type: 'sendSupportChatMessage',
      sessionId,
      text,
      screenshotDataUrl,
      senderName,
    }),
  );
}

export function sendEndSupportChat(sessionId: string) {
  ws?.send(JSON.stringify({ type: 'endSupportChat', sessionId }));
}

export function sendCreateIssueFromChat(sessionId: string, tryingToDo: string, actual: string) {
  ws?.send(JSON.stringify({ type: 'createIssueFromChat', sessionId, tryingToDo, actual }));
}

// ── Admin Auth ──────────────────────────────────────────────────────

export function useAdminAuth(): AdminAuthResult | null {
  const [state, setState] = useState<AdminAuthResult | null>(currentAdminAuth);

  useEffect(() => {
    setState(currentAdminAuth);
    const handler = (e: Event) => setState((e as CustomEvent<AdminAuthResult>).detail);
    events.addEventListener('adminAuthResult', handler);
    return () => events.removeEventListener('adminAuthResult', handler);
  }, []);

  return state;
}

export function sendAdminLogin(passphrase: string) {
  ws?.send(JSON.stringify({ type: 'adminLogin', passphrase }));
}

export function sendAdminCheckAuth(token: string) {
  ws?.send(JSON.stringify({ type: 'adminCheckAuth', token }));
}

export function sendAdminSetPassphrase(passphrase: string) {
  ws?.send(JSON.stringify({ type: 'adminSetPassphrase', passphrase }));
}

// ── Slack Config ────────────────────────────────────────────────────

export function useSlackConfigState(): SlackConfigState | null {
  const [state, setState] = useState<SlackConfigState | null>(currentSlackConfigState);

  useEffect(() => {
    setState(currentSlackConfigState);
    const handler = (e: Event) => setState((e as CustomEvent<SlackConfigState>).detail);
    events.addEventListener('slackConfigState', handler);
    return () => events.removeEventListener('slackConfigState', handler);
  }, []);

  return state;
}

// ── Setup wizard ────────────────────────────────────────────────────

/**
 * Live environment probe. Asking for it also registers this client as a
 * watcher, so the server keeps re-probing every few seconds while the page is
 * open — that's what makes a step go green as soon as it's fixed.
 */
export function useSetupProbe(): SetupProbeState | null {
  const [state, setState] = useState<SetupProbeState | null>(currentSetupProbeState);

  useEffect(() => {
    setState(currentSetupProbeState);
    const handler = (e: Event) => setState((e as CustomEvent<SetupProbeState>).detail);
    events.addEventListener('setupProbeState', handler);
    sendRequestSetupProbe();
    // Re-register after a reconnect, which drops the server's watcher set.
    const id = setInterval(sendRequestSetupProbe, 15_000);
    return () => {
      clearInterval(id);
      events.removeEventListener('setupProbeState', handler);
    };
  }, []);

  return state;
}

/** Persisted wizard progress and settings. */
export function useSetupConfig(): SetupConfigState | null {
  const [state, setState] = useState<SetupConfigState | null>(currentSetupConfigState);

  useEffect(() => {
    setState(currentSetupConfigState);
    const handler = (e: Event) => setState((e as CustomEvent<SetupConfigState>).detail);
    events.addEventListener('setupConfigState', handler);
    return () => events.removeEventListener('setupConfigState', handler);
  }, []);

  return state;
}

/**
 * Send once the socket is actually open.
 *
 * Most senders here are user-triggered, so the socket is long since open by
 * the time they fire. The setup page asks for a probe on mount, which races
 * the initial connection — and `send()` while CONNECTING throws
 * InvalidStateError, which would take the whole page down.
 */
function sendWhenOpen(payload: unknown) {
  const socket = ws;
  if (!socket) return;
  const data = JSON.stringify(payload);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener('open', () => socket.send(data), { once: true });
  }
}

export function sendRequestSetupProbe() {
  sendWhenOpen({ type: 'requestSetupProbe' });
}

export function sendUpdateSetupSettings(settings: Partial<SetupSettings>) {
  sendWhenOpen({ type: 'updateSetupSettings', settings });
}

export function sendMarkSetupStep(step: SetupStepId, status: 'pending' | 'done' | 'skipped') {
  sendWhenOpen({ type: 'markSetupStep', step, status });
}

/** Live status of pFMS's match video recorder (streams, active match, disk). */
export function useMatchRecordingState(): MatchRecordingState | null {
  const [state, setState] = useState<MatchRecordingState | null>(currentMatchRecordingState);

  useEffect(() => {
    setState(currentMatchRecordingState);
    const handler = (e: Event) => setState((e as CustomEvent<MatchRecordingState>).detail);
    events.addEventListener('matchRecordingState', handler);
    return () => events.removeEventListener('matchRecordingState', handler);
  }, []);

  return state;
}

/** Ask the server to probe a stream URL; resolves with the result (or a
 *  timeout error after 20 s if the server never answers). */
export function testRecordingStream(url: string): Promise<RecordingStreamTestResult> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      events.removeEventListener('recordingStreamTestResult', handler);
      resolve({ type: 'recordingStreamTestResult', url, ok: false, error: 'No answer from the server', ms: 20_000 });
    }, 20_000);
    const handler = (e: Event) => {
      const result = (e as CustomEvent<RecordingStreamTestResult>).detail;
      if (result.url !== url) return;
      clearTimeout(timer);
      events.removeEventListener('recordingStreamTestResult', handler);
      resolve(result);
    };
    events.addEventListener('recordingStreamTestResult', handler);
    sendWhenOpen({ type: 'testRecordingStream', url });
  });
}

export function sendSaveSlackConfig(botToken: string, appToken: string, channelId: string) {
  ws?.send(JSON.stringify({ type: 'saveSlackConfig', botToken, appToken, channelId }));
}

export function sendTestSlackConnection() {
  ws?.send(JSON.stringify({ type: 'testSlackConnection' }));
}

export function useSlackTestResult(callback: (result: { ok: boolean; error?: string; channelName?: string }) => void) {
  useEffect(() => {
    const handler = (e: Event) => callback((e as CustomEvent).detail);
    events.addEventListener('slackTestResult', handler);
    return () => events.removeEventListener('slackTestResult', handler);
  }, [callback]);
}

// ── Audio Device ────────────────────────────────────────────────────

export function useAudioDeviceState(): AudioDeviceState | null {
  const [state, setState] = useState<AudioDeviceState | null>(currentAudioDeviceState);

  useEffect(() => {
    setState(currentAudioDeviceState);
    const handler = (e: Event) => setState((e as CustomEvent<AudioDeviceState>).detail);
    events.addEventListener('audioDeviceState', handler);
    return () => events.removeEventListener('audioDeviceState', handler);
  }, []);

  return state;
}

export function sendSaveAudioDeviceConfig(deviceName: string | null) {
  ws?.send(JSON.stringify({ type: 'saveAudioDeviceConfig', deviceName }));
}

export function sendTestAudioDevice() {
  ws?.send(JSON.stringify({ type: 'testAudioDevice' }));
}

export function sendRefreshAudioDevices() {
  ws?.send(JSON.stringify({ type: 'refreshAudioDevices' }));
}

// ── Match History ──────────────────────────────────────────────────

export function useMatchHistory(): MatchHistoryState | null {
  const [state, setState] = useState<MatchHistoryState | null>(currentMatchHistoryState);

  useEffect(() => {
    setState(currentMatchHistoryState);
    const handler = (e: Event) => setState((e as CustomEvent<MatchHistoryState>).detail);
    events.addEventListener('matchHistoryState', handler);
    return () => events.removeEventListener('matchHistoryState', handler);
  }, []);

  return state;
}

export function sendClearMatchHistory() {
  ws?.send(JSON.stringify({ type: 'clearMatchHistory' }));
}

// ── Field Usage ─────────────────────────────────────────────────────

export function useUsageState(): UsageState | null {
  const [state, setState] = useState<UsageState | null>(currentUsageState);

  useEffect(() => {
    setState(currentUsageState);
    const handler = (e: Event) => setState((e as CustomEvent<UsageState>).detail);
    events.addEventListener('usageState', handler);
    return () => events.removeEventListener('usageState', handler);
  }, []);

  return state;
}

// ── Server Info ──────────────────────────────────────────────────────

/** Server build (git short SHA), for bug reports. */
export function useServerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(currentServerInfo?.version ?? null);

  useEffect(() => {
    setVersion(currentServerInfo?.version ?? null);
    const handler = (e: Event) => setVersion((e as CustomEvent<ServerInfo>).detail.version);
    events.addEventListener('serverInfo', handler);
    return () => events.removeEventListener('serverInfo', handler);
  }, []);

  return version;
}

/** Base URL for share links: the configured public address, else this page's origin. */
export function usePublicUrl(): string {
  const [url, setUrl] = useState<string | undefined>(currentServerInfo?.publicUrl);

  useEffect(() => {
    setUrl(currentServerInfo?.publicUrl);
    const handler = (e: Event) => setUrl((e as CustomEvent<ServerInfo>).detail.publicUrl);
    events.addEventListener('serverInfo', handler);
    return () => events.removeEventListener('serverInfo', handler);
  }, []);

  return (url ?? window.location.origin).replace(/\/$/, '');
}

/** Public summary/video page for a match, by share token. */
export function matchSummaryUrl(publicUrl: string, shareToken: string): string {
  return `${publicUrl}/scores?match=${encodeURIComponent(shareToken)}`;
}

export function useServerStartTime(): number | null {
  const [startTime, setStartTime] = useState<number | null>(currentServerInfo?.startTime ?? null);

  useEffect(() => {
    setStartTime(currentServerInfo?.startTime ?? null);
    const handler = (e: Event) => {
      setStartTime((e as CustomEvent<ServerInfo>).detail.startTime);
    };
    events.addEventListener('serverInfo', handler);
    return () => events.removeEventListener('serverInfo', handler);
  }, []);

  return startTime;
}
