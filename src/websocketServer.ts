import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { execFileSync } from 'node:child_process';
import { SiteHealthChecker } from './siteHealth.js';
import RadioManager from './radioManager.js';
import {
  isStationUpdate,
  isInternetToggle,
  isAdminStopMatch,
  isAdminGlobalEStop,
  isAdminStationEStop,
  isAdminStationDisable,
  isAdminClearEStop,
  isStationJoin,
  isStationJoinAlliance,
  isStationLeave,
  isStationReady,
  isStationStartMatch,
  isStationPauseMatch,
  isStationResumeMatch,
  isStationAbandonMatch,
  isUpdateMatchConfig,
  isRoutePreferenceMsg,
  isDriveAction,
  isApplyConfig,
  isRunTeamChecks,
  isFirmwareUpdateRequest,
  isStopCast,
  isCastReceiverRegister,
  isCastReceiverSwap,
  isCastReceiverMute,
  isPlayGetReady,
  isRadioConfigureRequest,
  isRemoveSavedTeam,
  isSaveSavedTeam,
  isEnableSavedRobot,
  isCreateApiKey,
  isRevokeApiKey,
  isReactivateApiKey,
  isDeleteApiKey,
  isApprovePendingDevice,
  isDismissPendingDevice,
  isScoreReset,
  isPortBridgeRequest,
  isMatchCreate,
  isMatchCancel,
  isMatchAbortCountdown,
  isMatchClear,
  isMatchSwapStation,
  isMatchKickStation,
  isMatchSetAutoWinner,
  isMatchRequestReady,
  isMatchStaffIgnore,
  isStaffReady,
  isStaffHeartbeat,
  isStationSelfDisable,
  isStationSelfUndisable,
  isStationSelfEStop,
  isStationSelfAStop,
  isStationClearAStop,
  isAdminStationEnable,
  isSubmitSupportIssue,
  isStartSupportChat,
  isSendSupportChatMessage,
  isEndSupportChat,
  isCreateIssueFromChat,
  isAdminLogin,
  isAdminCheckAuth,
  isAdminSetPassphrase,
  isSaveSlackConfig,
  isRequestSetupProbe,
  isUpdateSetupSettings,
  isTestRecordingStream,
  isMarkSetupStep,
  type SetupConfigState,
  type SetupProbeState,
  isTestSlackConnection,
  isCreateExternalAccessToken,
  isRevokeExternalAccessToken,
  isStationTestModeRequest,
  isStationTestModeStop,
  isStationRadioConfigureRequest,
  isStationFirmwareUpdateRequest,
  isSaveAudioDeviceConfig,
  isTestAudioDevice,
  isRefreshAudioDevices,
  isClearMatchHistory,
  isSetPracticeRecording,
  isRequestPracticeDayLink,
  type PracticeDayLink,
  CastReceiverList,
  RoutePreferenceState,
  PendingCommitState,
  LastLinkedState,
  ServerInfo,
  StationName,
  StationNameList,
} from './types.js';
import { getRealClientIp, normalizeIp } from './utils.js';
import { handleVideoProxy } from './videoProxy.js';
import CIDRMatcher from 'cidr-matcher';
import { appError, appWarn } from './appLogger.js';
import { MatchEngine } from './matchEngine.js';
import type { SavedTeamStore } from './savedTeamStore.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import type { ScoringEngine } from './scoringEngine.js';
import type { PortBridgeManager } from './portBridgeManager.js';
import type { SupportStore } from './supportStore.js';
import type { SlackBridge } from './slackBridge.js';
import type { AdminAuth } from './adminAuth.js';
import type { ExternalAccessStore } from './externalAccessStore.js';
import type { MatchAudio } from './matchAudio.js';
import type { MatchHistoryStore } from './matchHistoryStore.js';
import type { UsageTracker } from './usageTracker.js';
import type { HostnameResolver } from './hostnameResolver.js';
import type { SetupConfigStore } from './setupConfigStore.js';
import type { MatchRecorder } from './matchRecorder.js';
import type { PracticeRecorder } from './practiceRecorder.js';
import type { PracticeStore } from './practiceStore.js';
import { practiceDayOf } from './practiceStore.js';
import { createStaticHandler, findAssetDir } from './staticServer.js';
import { join } from 'node:path';
import {
  setRoutePreference,
  clearRoutePreference,
  getPreference,
  getConflictingTeams,
} from './routePreferenceManager.js';

export type HttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface WebSocketContext {
  server: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  /** Send a JSON-serializable message to all connected clients. */
  broadcast: (msg: unknown) => void;
  /** Send updated route preference state to all connected clients (e.g., after config change). */
  broadcastRouteState: () => void;
  /** Public (read-only) WebSocket connections — only receive scoreState and matchState. */
  publicConnections: ReadonlySet<WebSocket>;
}

export type RunTeamChecksCallback = (station: StationName) => void;
export type FirmwareUpdateCallback = (
  wpaKey: string | undefined,
  wpaKey24: string | undefined,
  skipReconfigure: boolean,
) => void;

export type RadioConfigureCallback = (
  teamNumber: number,
  wpaKey6: string,
  wpaKey24: string | undefined,
  ssidSuffix: string | undefined,
) => void;

/**
 * Called when a client sends a 'drive' message to start or stop driving a station.
 * dsIp is the client's IP, station is null to stop driving.
 */
export type DriveActionCallback = (dsIp: string, station: StationName | null) => void;

export type StationTestModeCallback = (station: StationName, portVlanId: number) => void;
export type StationTestModeStopCallback = (station: StationName) => void;
export type StationRadioConfigureCallback = (
  station: StationName,
  teamNumber: number,
  wpaKey6: string,
  wpaKey24: string | undefined,
  ssidSuffix: string | undefined,
) => void;
export type StationFirmwareUpdateCallback = (
  station: StationName,
  wpaKey: string | undefined,
  wpaKey24: string | undefined,
  skipReconfigure: boolean,
) => void;

export function setupWebSocket(
  radioManager: RadioManager,
  matchEngine: MatchEngine,
  port: number,
  trustedProxyMatcher?: CIDRMatcher,
  onRunTeamChecks?: RunTeamChecksCallback,
  httpHandlers?: HttpRequestHandler[],
  onFirmwareUpdate?: FirmwareUpdateCallback,
  onRadioConfigure?: RadioConfigureCallback,
  savedTeamStore?: SavedTeamStore,
  apiKeyStore?: ApiKeyStore,
  scoringEngine?: ScoringEngine,
  portBridgeManager?: PortBridgeManager,
  onDriveAction?: DriveActionCallback,
  supportStore?: SupportStore,
  slackBridge?: SlackBridge,
  adminAuth?: AdminAuth,
  externalAccessStore?: ExternalAccessStore,
  onStationTestMode?: StationTestModeCallback,
  onStationTestModeStop?: StationTestModeStopCallback,
  onStationRadioConfigure?: StationRadioConfigureCallback,
  onStationFirmwareUpdate?: StationFirmwareUpdateCallback,
  matchAudio?: MatchAudio,
  matchHistoryStore?: MatchHistoryStore,
  usageTracker?: UsageTracker,
  hostnameResolver?: HostnameResolver,
  // Grouped rather than appended as two more positional params — this
  // signature is already 25 long (see ISSUES.md) and shouldn't grow further.
  setup?: {
    configStore: SetupConfigStore;
    runProbe: () => Promise<SetupProbeState>;
    /** Match video recorder — configured through the same admin-gated settings. */
    matchRecorder?: MatchRecorder;
    /** Public address of the field for share links (undefined = use the page's own origin). */
    publicUrl?: () => string | undefined;
    /** "Record while enabled" and the per-team practice-day links. */
    practice?: {
      recorder: PracticeRecorder;
      store: PracticeStore;
      /** Recordings a team's day link lists right now (matches + runs). */
      countItems: (teamNumber: number, day: string) => number;
    };
  },
): WebSocketContext {
  let serverVersion = 'unknown';
  try {
    serverVersion = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    // Not a git repo or git not available — fall back to unknown
  }

  const serverStartTime = Date.now();

  // What devices on the field network get when they open LAN_URL — see
  // src/siteHealth.ts. Unset means /health/site only proves the backend is up.
  const siteHealth = new SiteHealthChecker(process.env.LAN_URL);

  // Looks beside the executable first, then in the repo/deploy layout, so a
  // checkout, a container image and an unzipped binary all behave the same.
  const webRoot = findAssetDir(['web', join('frontend', 'dist')], process.env.WEB_ROOT);
  const staticHandler = webRoot ? createStaticHandler({ webRoot, soundsDir: findAssetDir(['sounds']) }) : null;
  if (staticHandler) console.log(`Serving the built frontend from ${webRoot} — no separate web server required`);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Try registered HTTP handlers first (e.g. scoring API)
    if (httpHandlers) {
      for (const handler of httpHandlers) {
        if (handler(req, res)) return;
      }
    }

    // WHEP (WebRTC) signaling proxy for the scoreboard video view
    if (handleVideoProxy(req, res)) return;

    // Uptime probe, which the reverse proxy publishes as /health. Kept apart
    // from /health on purpose: update.sh's match guard reads /health with
    // `curl -f`, and a 503 there would read as "no match running" and let a
    // deploy reload straight through a live match.
    if (req.url === '/health/site') {
      siteHealth
        .check()
        .then(result => {
          res.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(result));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        });
      return;
    }

    // Health/status endpoint — used by update.sh to check for active matches,
    // and to skip the reload when the running backend is already the commit
    // being deployed (two overlapping deploys used to reload every screen twice).
    if (req.url === '/health') {
      const state = matchEngine.getState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ phase: state.phase, version: serverVersion }));
      return;
    }

    // Per-field Cast identifiers. A Cast receiver app is registered against a
    // specific HTTPS URL, so a field that wants casting registers its own and
    // sets CAST_RECEIVER_APP_ID rather than inheriting one that points at
    // somebody else's scoreboard.
    if (req.url?.split('?')[0] === '/cast-config.js') {
      const appId = process.env.CAST_RECEIVER_APP_ID ?? '260A23F5';
      const namespace = process.env.CAST_NAMESPACE ?? 'urn:x-cast:com.tomsawyerlabs.pfms';
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(`window.__PFMS_CAST=${JSON.stringify({ appId, namespace })};`);
      return;
    }

    // Built frontend + sounds, so `node dist` alone serves a working field.
    // Last in the chain: API routes above always win, and in development
    // there's no build to serve so this is a no-op and Vite handles it.
    if (staticHandler?.(req, res)) return;

    // CORS headers for unhandled routes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({ server });

  /** Track which IP each WebSocket connection belongs to */
  const wsToIp = new Map<WebSocket, string>();

  /** Track which WebSocket connections are admin-authenticated */
  const adminConnections = new Set<WebSocket>();

  /** Track public (read-only) WebSocket connections (connected via /ws/scores).
   *  These only receive scoreState and matchState — no sensitive data. */
  const publicConnections = new Set<WebSocket>();

  /** Message types safe to send to public (unauthenticated) connections. */
  const PUBLIC_SAFE_TYPES = new Set(['scoreState', 'matchState', 'telemetry', 'playGetReady']);

  /** Track which WebSocket connections are in which chat sessions */
  const wsToChatSession = new Map<WebSocket, string>();

  /** Track registered cast receivers (TV displays) */
  let nextReceiverId = 1;
  const castReceivers = new Map<WebSocket, { id: string; name: string; swapped: boolean; muted: boolean }>();

  function broadcastReceiverList() {
    const list: CastReceiverList = {
      type: 'castReceiverList',
      receivers: [...castReceivers.values()],
    };
    broadcast(list);
  }

  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    const msgType = (msg as Record<string, unknown>)?.type;
    const isPublicSafe = typeof msgType === 'string' && PUBLIC_SAFE_TYPES.has(msgType);

    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      // Public connections only receive whitelisted message types
      if (publicConnections.has(client) && !isPublicSafe) return;
      try {
        client.send(data);
      } catch {
        // Client socket in bad state — ignore, error handler will clean up
      }
    });
  }

  // Periodic serverInfo heartbeat — keeps every client's clock-offset estimate
  // fresh and gives them a liveness signal: a socket silent for much longer
  // than this is dead even if TCP never noticed (e.g. a Chromecast whose Wi-Fi
  // napped without a close), and the client watchdog forces a reconnect.
  setInterval(() => {
    const msg = JSON.stringify({
      type: 'serverInfo',
      startTime: serverStartTime,
      version: serverVersion,
      now: Date.now(),
      publicUrl: setup?.publicUrl?.(),
    } satisfies ServerInfo);
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(msg);
      } catch {
        // Bad socket — its error handler cleans up
      }
    });
  }, 10_000);

  function buildRouteState(clientIp: string): RoutePreferenceState {
    return {
      type: 'routePreferenceState',
      yourIp: clientIp,
      preference: getPreference(clientIp),
      conflictingTeams: getConflictingTeams(s => radioManager.getTeamForStation(s)),
    };
  }

  function sendRouteState(ws: WebSocket, clientIp: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(buildRouteState(clientIp)));
    } catch {
      // Client socket in bad state — ignore
    }
  }

  function broadcastRouteState() {
    for (const [ws, ip] of wsToIp) {
      if (ws.readyState === WebSocket.OPEN) {
        sendRouteState(ws, ip);
      }
    }
  }

  // Broadcast radio status to all clients
  radioManager.addStatusListener(broadcast);

  // Broadcast match state to all clients
  matchEngine.addStateListener(broadcast);

  // Broadcast saved team config changes to all clients
  savedTeamStore?.addListener(broadcast);

  // Broadcast pending commit state changes to all clients
  radioManager.addPendingCommitListener(pending => {
    broadcast({
      type: 'pendingCommitState',
      pending,
      stagedChanges: pending ? radioManager.getStagedChanges() : undefined,
      deferred: pending ? radioManager.deferredCommit : undefined,
    } satisfies PendingCommitState);
  });

  // Broadcast last-linked timestamp changes to all clients
  radioManager.addLastLinkedListener(timestamps => {
    broadcast({ type: 'lastLinkedState', timestamps } satisfies LastLinkedState);
  });

  // Broadcast port bridge state changes to all clients
  portBridgeManager?.setOnChange(() => {
    broadcast(portBridgeManager.getState());
  });

  // ── Setup wizard ──────────────────────────────────────────────────
  // The probe shells out and talks to the radio, so it only runs while a
  // setup page is actually open. Clients register by asking for a probe and
  // are dropped when their socket closes.
  const setupWatchers = new Set<WebSocket>();
  let setupProbeInFlight = false;

  /**
   * Setup is writable by anyone until the field is claimed with an admin
   * passphrase; after that it's an admin surface like the rest of /admin.
   * With no adminAuth wired at all, behave as before.
   */
  function setupWritesAllowed(ws: WebSocket): boolean {
    if (!adminAuth?.isConfigured()) return true;
    return adminConnections.has(ws);
  }

  function setupConfigMessage(): SetupConfigState {
    const store = setup!.configStore;
    return { type: 'setupConfigState', config: store.get(), nextStep: store.nextStep() };
  }

  async function runAndBroadcastProbe(): Promise<void> {
    if (!setup || setupProbeInFlight) return;
    setupProbeInFlight = true;
    try {
      broadcast(await setup.runProbe());
    } catch (err) {
      appWarn(`Setup probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setupProbeInFlight = false;
    }
  }

  if (setup?.matchRecorder) {
    setup.matchRecorder.addListener(state => broadcast(state));
  }
  if (setup?.practice) {
    setup.practice.recorder.addListener(state => broadcast(state));
  }

  if (setup) {
    setup.configStore.addListener(() => broadcast(setupConfigMessage()));
    // Live re-check, so a step goes green the moment the operator fixes it.
    setInterval(() => {
      if (setupWatchers.size > 0) void runAndBroadcastProbe();
    }, 5000).unref();
  }

  // Broadcast support state changes to all clients
  supportStore?.addListener(broadcast);

  // Broadcast Slack config state changes to all clients
  slackBridge?.addListener(broadcast);

  // Broadcast external access token state changes to all clients
  externalAccessStore?.addListener(broadcast);

  matchAudio?.addStateListener(broadcast);

  // Broadcast match history changes to all clients
  matchHistoryStore?.addListener(broadcast);

  // Broadcast usage tracking state changes to all clients
  usageTracker?.addListener(broadcast);

  // Handle incoming Slack messages and forward to appropriate chat WebSocket clients
  if (slackBridge && supportStore) {
    slackBridge.onSlackMessage = (threadTs, senderName, text) => {
      const session = supportStore.getChatSessionBySlackThread(threadTs);
      if (!session) return;

      const message = supportStore.addChatMessage(session.id, 'admin', senderName, text);
      if (!message) return;

      // Send to all connected clients that are in this chat session
      const incoming = { type: 'supportChatMessage', message };
      const data = JSON.stringify(incoming);
      for (const [clientWs, sessionId] of wsToChatSession) {
        if (sessionId === session.id && clientWs.readyState === WebSocket.OPEN) {
          try {
            clientWs.send(data);
          } catch {
            // Client in bad state
          }
        }
      }
    };
  }

  wss.on('connection', (ws: WebSocket, req) => {
    // Public connections (/ws/scores) are read-only and only receive score + match data.
    // Handle them separately to avoid leaking sensitive state.
    if (req.url?.startsWith('/ws/scores')) {
      publicConnections.add(ws);
      console.log('Public scores client connected');
      ws.send(JSON.stringify(matchEngine.getState()));
      ws.send(
        JSON.stringify({
          type: 'serverInfo',
          startTime: serverStartTime,
          version: serverVersion,
          now: Date.now(),
          publicUrl: setup?.publicUrl?.(),
        } satisfies ServerInfo),
      );
      // Cast receivers (Chromecast TVs) load the public scores page, so their
      // registration arrives on this socket. Accept ONLY that message here —
      // everything else on the read-only socket stays ignored.
      ws.on('message', (raw: Buffer) => {
        try {
          const data: unknown = JSON.parse(raw.toString());
          if (isCastReceiverRegister(data)) {
            const id = `cast-${nextReceiverId++}`;
            castReceivers.set(ws, { id, name: data.name, swapped: data.swapped, muted: !!data.muted });
            ws.send(JSON.stringify({ type: 'castReceiverId', id }));
            broadcastReceiverList();
          }
        } catch {
          // Malformed message on the public socket — ignore
        }
      });
      ws.on('close', () => {
        publicConnections.delete(ws);
        if (castReceivers.delete(ws)) {
          broadcastReceiverList();
        }
      });
      ws.on('error', err => {
        console.error('Public WebSocket error:', err.message);
        ws.terminate();
      });
      // Score state is sent by the index.ts connection handler (which checks publicConnections)
      return;
    }

    const socketRemoteAddress = (ws as any)._socket?.remoteAddress;
    const rawIp = getRealClientIp(socketRemoteAddress, req.headers, trustedProxyMatcher);
    const clientIp = normalizeIp(rawIp);
    console.log(`New client connected: ${clientIp}`);

    wsToIp.set(ws, clientIp);

    // Resolve the client's own hostname so pages can label it (e.g. "YOU" rows)
    hostnameResolver?.track(clientIp);

    // Send initial history + match state
    ws.send(JSON.stringify(radioManager.getStatusHistory()));
    ws.send(JSON.stringify(matchEngine.getState()));

    // Send known guest-network hostnames (IP → device name)
    if (hostnameResolver) {
      ws.send(JSON.stringify(hostnameResolver.getState()));
    }

    // Send initial route preference state
    sendRouteState(ws, clientIp);

    // Send initial pending commit state
    ws.send(
      JSON.stringify({
        type: 'pendingCommitState',
        pending: radioManager.pendingCommit,
        stagedChanges: radioManager.pendingCommit ? radioManager.getStagedChanges() : undefined,
        deferred: radioManager.pendingCommit ? radioManager.deferredCommit : undefined,
      } satisfies PendingCommitState),
    );

    // Send initial last-linked timestamps
    ws.send(
      JSON.stringify({
        type: 'lastLinkedState',
        timestamps: radioManager.getLastLinkedTimestamps(),
      } satisfies LastLinkedState),
    );

    // Send server info (start time for uptime display)
    ws.send(
      JSON.stringify({
        type: 'serverInfo',
        startTime: serverStartTime,
        version: serverVersion,
        now: Date.now(),
        publicUrl: setup?.publicUrl?.(),
      } satisfies ServerInfo),
    );

    // Send saved team configs
    if (savedTeamStore) {
      ws.send(JSON.stringify(savedTeamStore.getState()));
    }

    // Send API key management state
    if (apiKeyStore) {
      ws.send(JSON.stringify(apiKeyStore.getState()));
    }

    // Send port bridge state (available ports and active bridges)
    if (portBridgeManager?.enabled) {
      ws.send(JSON.stringify(portBridgeManager.getState()));
    }

    // Send support system state
    if (supportStore) {
      ws.send(JSON.stringify(supportStore.getState()));
    }

    // Send Slack config state
    if (slackBridge) {
      ws.send(JSON.stringify(slackBridge.getState()));
    }

    // Send external access token state
    if (externalAccessStore) {
      ws.send(JSON.stringify(externalAccessStore.getState()));
    }

    // Send persisted setup state so the wizard can resume where it left off
    if (setup) {
      ws.send(JSON.stringify(setupConfigMessage()));
    }

    // Send audio device state
    if (matchAudio) {
      ws.send(JSON.stringify(matchAudio.getState()));
    }

    // Send match history state
    if (matchHistoryStore) {
      ws.send(JSON.stringify(matchHistoryStore.getState()));
    }

    // Send match video recorder state
    if (setup?.matchRecorder) {
      ws.send(JSON.stringify(setup.matchRecorder.getState()));
    }

    // Practice recording ("record while enabled")
    if (setup?.practice) {
      ws.send(JSON.stringify(setup.practice.recorder.getState()));
    }

    // Send usage tracking state
    if (usageTracker) {
      ws.send(JSON.stringify(usageTracker.getState()));
    }

    ws.on('close', () => {
      wsToIp.delete(ws);
      adminConnections.delete(ws);
      wsToChatSession.delete(ws);
      setupWatchers.delete(ws);
      if (castReceivers.delete(ws)) {
        broadcastReceiverList();
      }
    });

    ws.on('error', err => {
      console.error(`WebSocket error from ${clientIp}:`, err.message);
      ws.terminate();
    });

    ws.on('message', (message: string) => {
      let data: unknown;
      try {
        data = JSON.parse(message);
      } catch {
        appError('Invalid JSON from client');
        ws.send(JSON.stringify({ error: 'Invalid JSON', details: 'Could not parse message' }));
        return;
      }

      // Log the configuration to be sent for debugging (with passphrase redacted)
      const sanitizedConfig = { ...(data as Record<string, unknown>) };
      if ('wpaKey' in sanitizedConfig) sanitizedConfig.wpaKey = '***';
      console.log('Received message:', sanitizedConfig);

      if (isStationUpdate(data)) {
        if (matchEngine.isMatchActive()) {
          ws.send(JSON.stringify({ error: 'Cannot reconfigure stations during an active match' }));
        } else {
          const current = radioManager.getStationConfig(data.station);
          const staged = radioManager.getStagedConfig(data.station);
          const hasStagedChange = staged !== undefined; // null = staged clear, object = staged config
          const activeMatchesRequest = current && current.ssid === data.ssid && current.wpaKey === data.wpaKey;
          const internetChanged = current && !!current.internetAccess !== !!data.internetAccess;

          if (activeMatchesRequest && !internetChanged && !hasStagedChange) {
            // Nothing changed at all
            ws.send(JSON.stringify({ info: 'No changes detected — configuration already active' }));
          } else if (activeMatchesRequest && hasStagedChange) {
            // Active config already matches — just cancel the staged change (e.g. undo a pending release)
            radioManager.cancelStagedChange(data.station);
            if (internetChanged) {
              radioManager.toggleInternetAccess(data.station, !!data.internetAccess).catch(err => {
                appError('Error toggling internet access: ' + err.message);
                ws.send(JSON.stringify({ error: 'Failed to toggle internet access', details: err.message }));
              });
            }
          } else if (activeMatchesRequest && internetChanged) {
            // Only internet access changed — toggle it without reconfiguring the radio
            radioManager.toggleInternetAccess(data.station, !!data.internetAccess).catch(err => {
              appError('Error toggling internet access: ' + err.message);
              ws.send(JSON.stringify({ error: 'Failed to toggle internet access', details: err.message }));
            });
          } else {
            // SSID or WPA changed — full radio reconfiguration
            radioManager.configure(data.station, data).catch(err => {
              appError('Error configuring station: ' + err.message);
              ws.send(JSON.stringify({ error: 'Failed to configure station', details: err.message }));
            });
          }
        }
      } else if (isInternetToggle(data)) {
        if (matchEngine.isMatchActive()) {
          ws.send(JSON.stringify({ error: 'Cannot toggle internet access during an active match' }));
        } else {
          radioManager.toggleInternetAccess(data.station, data.enabled).catch(err => {
            appError('Error toggling internet access: ' + err.message);
            ws.send(JSON.stringify({ error: 'Failed to toggle internet access', details: err.message }));
          });
        }
      } else if (isDriveAction(data)) {
        if (clientIp === 'unknown') {
          ws.send(JSON.stringify({ error: 'Cannot drive: client IP could not be determined' }));
        } else if (data.station === null) {
          // Stop driving: clear forward path (ip rule) and reverse path (DNAT)
          clearRoutePreference(clientIp)
            .then(() => {
              sendRouteState(ws, clientIp);
              onDriveAction?.(clientIp, null);
            })
            .catch(err => {
              appError('Error stopping drive: ' + err.message);
            });
        } else {
          const team = radioManager.getTeamForStation(data.station);
          if (team === null) {
            ws.send(JSON.stringify({ error: 'Station has no team assigned' }));
          } else {
            // Start driving: set forward path (ip rule) and reverse path (DNAT)
            setRoutePreference(clientIp, data.station, team)
              .then(() => {
                sendRouteState(ws, clientIp);
                onDriveAction?.(clientIp, data.station);
              })
              .catch(err => {
                appError('Error starting drive: ' + err.message);
              });
          }
        }
      } else if (isRoutePreferenceMsg(data)) {
        // Legacy: route preference only sets the forward path (ip rule), not DNAT.
        // New clients should use 'drive' instead.
        if (clientIp === 'unknown') {
          ws.send(JSON.stringify({ error: 'Cannot set route preference: client IP could not be determined' }));
        } else if (data.station === null) {
          clearRoutePreference(clientIp)
            .then(() => sendRouteState(ws, clientIp))
            .catch(err => {
              appError('Error clearing route preference: ' + err.message);
            });
        } else {
          const team = radioManager.getTeamForStation(data.station);
          if (team === null) {
            ws.send(JSON.stringify({ error: 'Station has no team assigned' }));
          } else {
            setRoutePreference(clientIp, data.station, team)
              .then(() => sendRouteState(ws, clientIp))
              .catch(err => {
                appError('Error setting route preference: ' + err.message);
              });
          }
        }
      } else if (isStationJoinAlliance(data)) {
        matchEngine.joinStationAlliance(data.station, data.alliance);
      } else if (isStationJoin(data)) {
        // Backward compat: infer alliance from station name prefix
        matchEngine.joinStation(data.station);
      } else if (isStationLeave(data)) {
        matchEngine.leaveStation(data.station);
      } else if (isStationReady(data)) {
        matchEngine.setReady(data.station, data.ready);
      } else if (isStationStartMatch(data)) {
        matchEngine.startMatch();
      } else if (isStationPauseMatch(data)) {
        matchEngine.pauseMatch();
      } else if (isStationResumeMatch(data)) {
        matchEngine.resumeMatch();
      } else if (isStationAbandonMatch(data)) {
        matchEngine.abandonMatch();
      } else if (isUpdateMatchConfig(data)) {
        matchEngine.updateMatchConfig(data.config);
      } else if (isAdminStopMatch(data)) {
        matchEngine.stopMatch();
      } else if (isAdminGlobalEStop(data)) {
        matchEngine.globalEStop();
      } else if (isAdminStationEStop(data)) {
        matchEngine.stationEStop(data.station);
      } else if (isAdminStationDisable(data)) {
        matchEngine.stationDisable(data.station, 'admin');
      } else if (isAdminStationEnable(data)) {
        matchEngine.undisable(data.station, true);
      } else if (isAdminClearEStop(data)) {
        matchEngine.clearEStop(data.station);
      } else if (isMatchCreate(data)) {
        matchEngine.createMatch();
      } else if (isMatchCancel(data)) {
        matchEngine.cancelMatch();
      } else if (isMatchAbortCountdown(data)) {
        matchEngine.abortCountdown();
      } else if (isMatchClear(data)) {
        matchEngine.clearMatch();
      } else if (isMatchSwapStation(data)) {
        matchEngine.swapStationAlliance(data.station);
      } else if (isMatchKickStation(data)) {
        matchEngine.kickStation(data.station);
      } else if (isMatchSetAutoWinner(data)) {
        matchEngine.setAutoWinner(data.winner);
      } else if (isMatchRequestReady(data)) {
        matchEngine.setReadyRequested(data.requested);
      } else if (isMatchStaffIgnore(data)) {
        matchEngine.setStaffIgnored(data.role, data.ignored);
      } else if (isStaffReady(data)) {
        matchEngine.setStaffReady(data.role, data.ready);
      } else if (isStaffHeartbeat(data)) {
        matchEngine.staffHeartbeat(data.role);
      } else if (isPlayGetReady(data)) {
        // "Get ready" attention sound: field speaker + every un-muted display.
        // Hold match starts until the clip clears the exclusive audio device,
        // or a countdown started mid-announcement loses its 3-2-1 audio.
        matchAudio?.play('getready');
        matchEngine.holdStart(3000);
        // The call is a request for a fresh confirmation: everyone readies
        // up again (the ready check stays open).
        matchEngine.clearTeamReadiness('Get Ready called');
        broadcast(data);
      } else if (isStationSelfDisable(data)) {
        matchEngine.stationDisable(data.station, 'self');
      } else if (isStationSelfUndisable(data)) {
        matchEngine.undisable(data.station, false);
      } else if (isStationSelfEStop(data)) {
        matchEngine.stationEStop(data.station);
      } else if (isStationSelfAStop(data)) {
        matchEngine.stationAStop(data.station);
      } else if (isStationClearAStop(data)) {
        matchEngine.stationClearAStop(data.station);
      } else if (isApplyConfig(data)) {
        radioManager.applyPendingChanges().catch(err => {
          appError('Error applying config: ' + err.message);
          ws.send(JSON.stringify({ error: 'Failed to apply configuration', details: err.message }));
        });
      } else if (isRunTeamChecks(data)) {
        onRunTeamChecks?.(data.station);
      } else if (isFirmwareUpdateRequest(data)) {
        onFirmwareUpdate?.(data.wpaKey, data.wpaKey24, !!data.skipReconfigure);
      } else if (isRadioConfigureRequest(data)) {
        onRadioConfigure?.(data.teamNumber, data.wpaKey6, data.wpaKey24, data.ssidSuffix);
      } else if (isStopCast(data)) {
        if (data.receiverId) {
          // Stop a specific receiver
          for (const [rws, info] of castReceivers) {
            if (info.id === data.receiverId && rws.readyState === WebSocket.OPEN) {
              rws.send(JSON.stringify(data));
            }
          }
        } else {
          broadcast(data);
        }
      } else if (isCastReceiverRegister(data)) {
        const id = `cast-${nextReceiverId++}`;
        castReceivers.set(ws, { id, name: data.name, swapped: data.swapped, muted: !!data.muted });
        // Send the assigned ID back to the receiver
        ws.send(JSON.stringify({ type: 'castReceiverId', id }));
        broadcastReceiverList();
      } else if (isRemoveSavedTeam(data)) {
        if (savedTeamStore) {
          savedTeamStore.removeTeam(data.ssid);
        }
        // Also release any radio slot currently configured with this SSID
        // so the team can re-add the robot without it appearing "already active".
        for (const station of StationNameList) {
          if (radioManager.getStationConfig(station)?.ssid === data.ssid) {
            radioManager.configure(station, { ssid: '', wpaKey: '', stage: true }).catch(err => {
              appError(`Error releasing station ${station} after removing saved team ${data.ssid}: ${err.message}`);
            });
            break; // SSIDs are unique across stations
          }
        }
      } else if (isSaveSavedTeam(data)) {
        if (savedTeamStore) {
          savedTeamStore.saveTeam(data.ssid, data.wpaKey);
        }
      } else if (isEnableSavedRobot(data)) {
        // Enable a previously-saved robot by SSID — server looks up the passphrase
        if (!savedTeamStore) {
          ws.send(JSON.stringify({ error: 'Saved team store not available' }));
        } else if (matchEngine.isMatchActive()) {
          ws.send(JSON.stringify({ error: 'Cannot reconfigure stations during an active match' }));
        } else {
          const saved = savedTeamStore.getTeam(data.ssid);
          if (!saved) {
            ws.send(JSON.stringify({ error: `No saved config found for SSID "${data.ssid}"` }));
          } else {
            radioManager
              .configure(data.station, {
                ssid: saved.ssid,
                wpaKey: saved.wpaKey,
                stage: data.stage,
                internetAccess: saved.internetAccess,
              })
              .catch(err => {
                appError(`Error enabling saved robot ${data.ssid} on ${data.station}: ${err.message}`);
                ws.send(JSON.stringify({ error: 'Failed to configure station', details: err.message }));
              });
          }
        }
      } else if (isCastReceiverSwap(data)) {
        // Find the target receiver and send it the swap command
        for (const [rws, info] of castReceivers) {
          if (info.id === data.receiverId) {
            info.swapped = data.swapped;
            if (rws.readyState === WebSocket.OPEN) {
              rws.send(JSON.stringify(data));
            }
            break;
          }
        }
        broadcastReceiverList();
      } else if (isCastReceiverMute(data)) {
        // Find the target receiver and send it the mute command
        for (const [rws, info] of castReceivers) {
          if (info.id === data.receiverId) {
            info.muted = data.muted;
            if (rws.readyState === WebSocket.OPEN) {
              rws.send(JSON.stringify(data));
            }
            break;
          }
        }
        broadcastReceiverList();
      } else if (isCreateApiKey(data)) {
        if (apiKeyStore) {
          const entry = apiKeyStore.createKey(data.label);
          // Send the full key ONLY to the requesting client (shown once)
          ws.send(JSON.stringify({ type: 'apiKeyCreated', key: entry.key, id: entry.id, label: entry.label }));
        }
      } else if (isRevokeApiKey(data)) {
        apiKeyStore?.revokeKey(data.id);
      } else if (isReactivateApiKey(data)) {
        apiKeyStore?.reactivateKey(data.id);
      } else if (isDeleteApiKey(data)) {
        apiKeyStore?.deleteKey(data.id);
      } else if (isApprovePendingDevice(data)) {
        if (apiKeyStore) {
          const entry = apiKeyStore.approveDevice(data.id, data.label);
          if (entry) {
            // Send the full key ONLY to the requesting admin client (shown once)
            ws.send(JSON.stringify({ type: 'apiKeyCreated', key: entry.key, id: entry.id, label: entry.label }));
          }
        }
      } else if (isDismissPendingDevice(data)) {
        apiKeyStore?.dismissDevice(data.id);
      } else if (isScoreReset(data)) {
        scoringEngine?.reset();
      } else if (isPortBridgeRequest(data)) {
        if (!portBridgeManager?.enabled) {
          ws.send(JSON.stringify({ error: 'Port bridging is not configured on this server' }));
        } else if (data.portVlanId === null) {
          // Unbind all ports from this station
          portBridgeManager.unbridgeAllFromStation(data.station).catch(err => {
            appError('Error unbridging ports: ' + err.message);
            ws.send(JSON.stringify({ error: 'Failed to unbind port', details: err.message }));
          });
        } else {
          portBridgeManager.bridgePort(data.station, data.portVlanId).catch(err => {
            appError('Error bridging port: ' + err.message);
            ws.send(JSON.stringify({ error: 'Failed to bridge port', details: err.message }));
          });
        }

        // ── Station Test Port Mode ─────────────────────────────────
      } else if (isStationTestModeRequest(data)) {
        onStationTestMode?.(data.station, data.portVlanId);
      } else if (isStationTestModeStop(data)) {
        onStationTestModeStop?.(data.station);
      } else if (isStationRadioConfigureRequest(data)) {
        onStationRadioConfigure?.(data.station, data.teamNumber, data.wpaKey6, data.wpaKey24, data.ssidSuffix);
      } else if (isStationFirmwareUpdateRequest(data)) {
        onStationFirmwareUpdate?.(data.station, data.wpaKey, data.wpaKey24, !!data.skipReconfigure);

        // ── Support System ──────────────────────────────────────────
      } else if (isSubmitSupportIssue(data)) {
        if (supportStore) {
          const issue = supportStore.createIssue(
            data.tryingToDo,
            data.stepsPerformed,
            data.expected,
            data.actual,
            { ...data.metadata, clientIp },
            data.screenshotDataUrl,
            data.recentLogs,
          );
          ws.send(JSON.stringify({ type: 'supportIssueCreated', issueId: issue.id }));

          // Forward to Slack if configured
          if (slackBridge?.isConnected()) {
            slackBridge.postIssue(issue).then(threadTs => {
              if (threadTs) {
                supportStore.setIssueSlackThread(issue.id, threadTs);
              }
            });
          }
        }
      } else if (isStartSupportChat(data)) {
        if (supportStore) {
          const session = supportStore.createChatSession(data.issueId, data.senderName);
          wsToChatSession.set(ws, session.id);
          // Slack thread is deferred until the first message arrives
          ws.send(JSON.stringify({ type: 'supportChatStarted', sessionId: session.id }));
        }
      } else if (isSendSupportChatMessage(data)) {
        if (supportStore) {
          const message = supportStore.addChatMessage(
            data.sessionId,
            'user',
            data.senderName ?? 'Field User',
            data.text,
            data.screenshotDataUrl,
          );
          if (message) {
            const session = supportStore.getChatSession(data.sessionId);

            if (session && !session.slackThreadTs && slackBridge?.isConnected()) {
              // First message — create Slack thread with field config summary
              const configLines: string[] = [];
              for (const station of StationNameList) {
                const config = radioManager.getStationConfig(station);
                if (config?.ssid) {
                  const team = radioManager.getTeamForStation(station);
                  configLines.push(`• ${station}: Team ${team ?? 'unknown'} (${config.ssid})`);
                }
              }
              const configSummary =
                configLines.length > 0 ? configLines.join('\n') : 'No stations currently configured';

              const displayName = session.senderName ?? data.senderName ?? 'Unknown';

              slackBridge.startChatThread(session.id, session.issueId, displayName).then(threadTs => {
                if (!threadTs) return;
                supportStore.setSlackThreadTs(session.id, threadTs);

                // Post field config summary as context
                const headerText = `*Field Configuration:*\n${configSummary}`;
                return slackBridge
                  .postChatMessage(threadTs, 'System', headerText)
                  .then(() => {
                    // If started from an issue, also post issue context
                    if (session.issueId) {
                      const issue = supportStore.getIssue(session.issueId);
                      if (issue) {
                        return slackBridge.postChatMessage(
                          threadTs,
                          'System',
                          `Issue context:\n• *Trying to do:* ${issue.tryingToDo}\n• *What happened:* ${issue.actual}`,
                        );
                      }
                    }
                  })
                  .then(() => {
                    // Post the user's first message
                    slackBridge.postChatMessage(threadTs, displayName, data.text, data.screenshotDataUrl);
                  });
              });
            } else if (session?.slackThreadTs && slackBridge?.isConnected()) {
              // Thread already exists — just forward
              slackBridge.postChatMessage(
                session.slackThreadTs,
                data.senderName ?? 'Field User',
                data.text,
                data.screenshotDataUrl,
              );
            }

            // Broadcast to all clients in this chat session
            const incoming = { type: 'supportChatMessage', message };
            const msgData = JSON.stringify(incoming);
            for (const [clientWs, sessionId] of wsToChatSession) {
              if (sessionId === data.sessionId && clientWs.readyState === WebSocket.OPEN) {
                try {
                  clientWs.send(msgData);
                } catch {
                  // Client in bad state
                }
              }
            }
          }
        }
      } else if (isEndSupportChat(data)) {
        if (supportStore) {
          const session = supportStore.getChatSession(data.sessionId);
          supportStore.endChatSession(data.sessionId);
          wsToChatSession.delete(ws);

          // Notify Slack
          if (session?.slackThreadTs && slackBridge?.isConnected()) {
            slackBridge.postChatEnded(session.slackThreadTs);
          }
        }
      } else if (isCreateIssueFromChat(data)) {
        if (supportStore) {
          const issue = supportStore.createIssueFromChat(data.sessionId, data.tryingToDo, data.actual);
          if (issue) {
            ws.send(JSON.stringify({ type: 'supportIssueCreated', issueId: issue.id }));

            // Forward the new issue to Slack
            if (slackBridge?.isConnected()) {
              slackBridge.postIssue(issue).then(threadTs => {
                if (threadTs) {
                  supportStore.setIssueSlackThread(issue.id, threadTs);
                }
              });
            }
          }
        }

        // ── Admin Auth ──────────────────────────────────────────────
      } else if (isAdminLogin(data)) {
        if (adminAuth) {
          const token = adminAuth.login(data.passphrase);
          if (token) {
            adminConnections.add(ws);
            // Auto-create an external access token so the admin's browser
            // gets a cookie for remote access without a separate step.
            const extToken = externalAccessStore?.createToken(`Admin login`);
            ws.send(
              JSON.stringify({
                type: 'adminAuthResult',
                authenticated: true,
                token,
                passphraseConfigured: true,
                externalAccessToken: extToken?.token,
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                type: 'adminAuthResult',
                authenticated: false,
                passphraseConfigured: adminAuth.isConfigured(),
              }),
            );
          }
        }
      } else if (isAdminCheckAuth(data)) {
        if (adminAuth) {
          const valid = adminAuth.validateToken(data.token);
          if (valid) adminConnections.add(ws);
          ws.send(
            JSON.stringify({
              type: 'adminAuthResult',
              authenticated: valid,
              passphraseConfigured: adminAuth.isConfigured(),
            }),
          );
        }
      } else if (isAdminSetPassphrase(data)) {
        if (adminAuth) {
          // Allow setting passphrase if none is configured, or if this connection is admin-authenticated
          const canSet = !adminAuth.isConfigured() || adminConnections.has(ws);
          if (canSet) {
            const success = adminAuth.setPassphrase(data.passphrase, adminConnections.has(ws));
            if (success) {
              // Auto-login the user who set the passphrase
              const token = adminAuth.login(data.passphrase);
              if (token) adminConnections.add(ws);
              ws.send(
                JSON.stringify({
                  type: 'adminAuthResult',
                  authenticated: true,
                  token,
                  passphraseConfigured: true,
                }),
              );
            } else {
              ws.send(JSON.stringify({ error: 'Failed to set passphrase (must be at least 4 characters)' }));
            }
          } else {
            ws.send(JSON.stringify({ error: 'Not authorized to change passphrase' }));
          }
        }

        // ── Setup wizard ────────────────────────────────────────────
        // Open only while no admin passphrase exists — the same
        // trust-on-first-use window as claiming the passphrase itself. Once a
        // field is claimed, setup writes need admin: `radioUrl` decides where
        // station configs (containing every team's plaintext WPA key) get
        // POSTed, so an unauthenticated write is credential exfiltration.
      } else if (isRequestSetupProbe(data)) {
        if (setup) {
          setupWatchers.add(ws);
          void runAndBroadcastProbe();
        }
      } else if (isUpdateSetupSettings(data)) {
        if (setup) {
          if (!setupWritesAllowed(ws)) {
            ws.send(JSON.stringify({ error: 'Admin authentication required to change setup settings' }));
          } else {
            setup.configStore.updateSettings(data.settings);
            // Settings change what the probe reports, so re-run immediately.
            void runAndBroadcastProbe();
          }
        }
      } else if (isMarkSetupStep(data)) {
        if (setup) {
          if (!setupWritesAllowed(ws)) {
            ws.send(JSON.stringify({ error: 'Admin authentication required to change setup progress' }));
          } else {
            setup.configStore.markStep(data.step, data.status);
          }
        }
      } else if (isTestRecordingStream(data)) {
        // Probing makes the server open a connection to whatever URL was
        // typed, so it is gated exactly like saving the setting would be.
        if (setup?.matchRecorder) {
          if (!setupWritesAllowed(ws)) {
            ws.send(JSON.stringify({ error: 'Admin authentication required to test a stream' }));
          } else {
            const recorder = setup.matchRecorder;
            void recorder.testStream(data.url).then(result => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
            });
          }
        }

        // ── Slack Config ────────────────────────────────────────────
      } else if (isSaveSlackConfig(data)) {
        if (slackBridge && adminAuth) {
          if (!adminConnections.has(ws)) {
            ws.send(JSON.stringify({ error: 'Admin authentication required to configure Slack' }));
          } else {
            slackBridge
              .saveConfig(data.botToken, data.appToken, data.channelId)
              .then(() => {
                ws.send(JSON.stringify({ info: 'Slack configuration saved and connected' }));
              })
              .catch(err => {
                ws.send(JSON.stringify({ error: 'Failed to configure Slack', details: err.message }));
              });
          }
        }
      } else if (isTestSlackConnection(data)) {
        if (slackBridge) {
          slackBridge.testConnection().then(result => {
            ws.send(
              JSON.stringify({
                type: 'slackTestResult',
                ...result,
              }),
            );
          });
        }

        // ── External Access Tokens ─────────────────────────────────────
      } else if (isCreateExternalAccessToken(data)) {
        if (externalAccessStore && adminConnections.has(ws)) {
          const { token, id } = externalAccessStore.createToken(data.label);
          ws.send(JSON.stringify({ type: 'externalAccessTokenCreated', token, id, label: data.label }));
        } else if (externalAccessStore) {
          ws.send(JSON.stringify({ error: 'Admin authentication required' }));
        }
      } else if (isRevokeExternalAccessToken(data)) {
        if (externalAccessStore && adminConnections.has(ws)) {
          externalAccessStore.revokeToken(data.id);
        } else if (externalAccessStore) {
          ws.send(JSON.stringify({ error: 'Admin authentication required' }));
        }
        // ── Audio Device Management ───────────────────────────────────
      } else if (isSaveAudioDeviceConfig(data)) {
        if (matchAudio && adminConnections.has(ws)) {
          matchAudio.selectDevice(data.deviceName);
        } else if (matchAudio) {
          ws.send(JSON.stringify({ error: 'Admin authentication required' }));
        }
      } else if (isTestAudioDevice(data)) {
        if (matchAudio && adminConnections.has(ws)) {
          matchAudio.play('start');
        } else if (matchAudio) {
          ws.send(JSON.stringify({ error: 'Admin authentication required' }));
        }
      } else if (isRefreshAudioDevices(data)) {
        if (matchAudio && adminConnections.has(ws)) {
          ws.send(JSON.stringify(matchAudio.getState()));
        }
      } else if (isClearMatchHistory(data)) {
        if (matchHistoryStore && adminConnections.has(ws)) {
          matchHistoryStore.clear();
        }

        // ── Practice recording ("record while enabled") ──────────────
      } else if (isSetPracticeRecording(data)) {
        // Station pages are not authenticated (same trust as the rest of the
        // station page); the checkbox is per team number.
        if (setup?.practice) {
          setup.practice.store.setOptIn(data.teamNumber, data.enabled);
          setup.practice.recorder.onOptInChanged();
        }
      } else if (isRequestPracticeDayLink(data)) {
        // The token is answered to this client only, never broadcast.
        if (setup?.practice) {
          const day = practiceDayOf(Date.now());
          const entry = setup.practice.store.findDay(data.teamNumber, day);
          const reply: PracticeDayLink = {
            type: 'practiceDayLink',
            teamNumber: data.teamNumber,
            day,
            token: entry?.token ?? null,
            count: entry ? setup.practice.countItems(data.teamNumber, day) : 0,
          };
          ws.send(JSON.stringify(reply));
        }
      } else {
        appWarn('Unknown message type from client: ' + JSON.stringify(sanitizedConfig));
      }
    });
  });

  server.listen(port, () => {
    console.log(`HTTP + WebSocket server running on port ${port}`);
  });

  return { server, wss, broadcast, broadcastRouteState, publicConnections };
}
