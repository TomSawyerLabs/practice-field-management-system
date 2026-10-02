// MUST come first: exits with a readable message on an unsupported platform
// before networkManager tries to build a network backend at module load.
import './platformGuard.js';
import RadioManager from './radioManager.js';
import { runSyslogServer } from './runSyslogServer.js';
import { setupWebSocket } from './websocketServer.js';
import { runFMS, UdpSendPort } from './fmsServer.js';
import { startConfigurationScheduler } from './scheduler.js';
import { waitForRadio, detectFirmwareMode, checkInterfaceIps, checkRequiredTools } from './startupChecks.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import type { NetworkBackend } from './node-ip/index.js';
import CIDRMatcher from 'cidr-matcher';
import { toCidr } from './utils.js';
import { DriveSessions, type BlockRule, type DnatRule } from './driveSessions.js';
import { MatchEngine } from './matchEngine.js';
import {
  stopAllDHCP,
  vlanMap,
  bridgeName,
  restorePreviousStations,
  cleanupOldVlanInterfaces,
  dropHairpinForwarding,
} from './networkManager.js';
import {
  onConfigChange as onRouteConfigChange,
  cleanupAllPreferences,
  restorePreferencesFromKernel,
  setRoutePreference,
  clearRoutePreference,
  getPreference,
} from './routePreferenceManager.js';
import { buildNetworkStats } from './networkStats.js';
import { setBroadcast, appInfo, appWarn } from './appLogger.js';
import { TelemetryManager } from './telemetryManager.js';
import { createTelemetryCoalescer } from './telemetryThrottle.js';
import { MatchAudio } from './matchAudio.js';
import { SubnetScanner } from './subnetScanner.js';
import { MdnsReflector } from './mdnsReflector.js';
import { TeamChecker, setControllerPolicyResolver, controllerBlockReason } from './teamChecker.js';
import { RobotTestMonitor } from './robotTestMonitor.js';
import { RobotPacketCapture } from './robotPacketCapture.js';
import { FirmwareStore } from './firmwareStore.js';
import { handleFirmwareRequest } from './firmwareApi.js';
import { handleTeamAvatarRequest } from './teamAvatarApi.js';
import { ScoringEngine } from './scoringEngine.js';
import { handleScoringRequest } from './scoringApi.js';
import { handleMatchReviewRequest } from './matchReviewApi.js';
import { SavedTeamStore } from './savedTeamStore.js';
import { RobotWifiScanner, WpaSupplicantRunner, listWirelessInterfaces, type ConnectAttempt } from './robotWifiScan.js';
import { WifiCards } from './wifiCards.js';
import { ApiKeyStore } from './apiKeyStore.js';
import { PortBridgeManager, parseFieldPorts } from './portBridgeManager.js';
import { StationTestManager } from './stationTestManager.js';
import { SupportStore } from './supportStore.js';
import { SlackBridge } from './slackBridge.js';
import { announceDeploy } from './deployAnnouncer.js';
import { AdminAuth } from './adminAuth.js';
import { handleExternalAccessAuth } from './externalAccessAuth.js';
import { OnLinkChecker } from './onLink.js';
import { ExternalAccessStore } from './externalAccessStore.js';
import { MatchHistoryStore } from './matchHistoryStore.js';
import { MatchQueue } from './matchQueue.js';
import { setupNextMatch, type SetupMode, type StageOutcome } from './matchSetup.js';
import { TeamPrefsStore } from './teamPrefsStore.js';
import { PushService } from './pushService.js';
import { QueueNudger } from './queueNudger.js';
import { handleManifestRequest } from './manifestApi.js';
import { describeSpaceChange, MatchRecorder } from './matchRecorder.js';
import { handleRecordingsRequest } from './recordingsApi.js';
import { handlePublicMatchRequest } from './publicMatchApi.js';
import { SessionMetadataCollector } from './sessionMetadata.js';
import { PracticeStore } from './practiceStore.js';
import { PracticeRecorder } from './practiceRecorder.js';
import { FieldTimelapse } from './fieldTimelapse.js';
import { FieldActivityLog } from './fieldActivityLog.js';
import { handleTimelapseRequest } from './timelapseApi.js';
import { createDiagReportHandler } from './diagReportApi.js';
import { findAssetDir } from './staticServer.js';
import { getRealClientIp } from './utils.js';
import { PracticeNotifier } from './practiceNotifier.js';
import { countPracticeDayItems, handlePracticeRequest, type PracticeApiDeps } from './practiceApi.js';
import { UsageTracker } from './usageTracker.js';
import { HostnameResolver } from './hostnameResolver.js';
import {
  StationName,
  StationNameList,
  StationNameRegex,
  TeamCheckResults,
  DriveSessionState,
  RecordingStreamConfig,
  isRecordingStreamConfig,
  RobotController,
  RobotWifiScanState,
  WifiCardsState,
} from './types.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { maybeRunCli } from './cli.js';
import { SetupConfigStore } from './setupConfigStore.js';
import { scoringRequiresKey } from './httpApiUtils.js';
import { setVideoProxyTargetResolver } from './videoProxy.js';
import { runSetupProbe } from './setupProbe.js';
import { StationChecksTracker } from './stationChecks.js';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// CLI commands (--clear-config, --help) run instead of starting the field.
// Detected synchronously here so module-level side effects below (notably
// consuming the keep-network flag) don't fire for a command that never starts
// the field. The command itself runs at the top of main().
const CliArgs = process.argv.slice(2);
const CliMode = CliArgs.some(arg => arg === '--clear-config' || arg === '--help' || arg === '-h');

const IPTABLES_COMMENT_PREFIX = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';

// When true, skip flushing iptables/ip rules on startup and restore preferences from the kernel.
// Set automatically by a graceful reload (systemctl reload writes /run/pfms-keep-network before
// sending SIGHUP). Can also be forced via KEEP_NETWORK=true env var for manual overrides.
const KEEP_NETWORK_FLAG = '/run/pfms-keep-network';
const keepNetworkFlagExists = !CliMode && existsSync(KEEP_NETWORK_FLAG);
if (keepNetworkFlagExists) rmSync(KEEP_NETWORK_FLAG, { force: true });
const KeepNetwork = keepNetworkFlagExists || process.env.KEEP_NETWORK === 'true';

// Configuration
// Settings saved in the setup wizard win over the environment; env stays the
// seed for a fresh install. Loaded here, at module scope, because these are
// read once at startup — which is also why changing them in the UI only takes
// effect on the next restart.
const setupConfigStore = new SetupConfigStore();

/** `name=url,name=url` → recording stream list (all enabled). Bad entries are
 *  logged and skipped rather than taking the whole list down. */
function parseRecordingStreamsEnv(raw: string | undefined): RecordingStreamConfig[] {
  if (!raw?.trim()) return [];
  const streams: RecordingStreamConfig[] = [];
  for (const entry of raw.split(',')) {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq).trim() : '';
    const url = eq > 0 ? entry.slice(eq + 1).trim() : entry.trim();
    const candidate = { name: name || `stream-${streams.length + 1}`, url, enabled: true };
    if (isRecordingStreamConfig(candidate)) streams.push(candidate);
    else console.warn(`MATCH_RECORDING_STREAMS: ignoring "${entry.trim()}" (expected name=rtsp://host/path)`);
  }
  return streams;
}

// resolveSetting() is the single precedence rule (saved value, then env), so
// it's also what the tests exercise — see scripts/test-setup-config.ts.
const RadioUrl = setupConfigStore.resolveSetting('radioUrl', 'RADIO_URL').value ?? 'http://10.0.100.2';
const VlanInterface = setupConfigStore.resolveSetting('vlanInterface', 'VLAN_INTERFACE').value; // 'eno1', or undefined
const StartFMS = process.env.FMS_ENDPOINT === 'true';
// Experimental: stations whose DS gets the TCP station-assignment reply even
// outside a match ("slot1,slot2" or "all") — for testing whether a TCP-only
// reply locks the DS out of local enable before defaulting it on for everyone.
const FmsTcpReplyStations = process.env.FMS_TCP_REPLY_STATIONS ?? '';
const StartSyslog = process.env.SYSLOG_ENDPOINT === 'true';
const StartMdnsReflector = process.env.MDNS_REFLECTOR === 'true';
const TestInterface = process.env.TEST_INTERFACE;
const VlanHostOctet = Number(process.env.VLAN_HOST_OCTET) || 254;
const WebSocketPort = Number(process.env.WEBSOCKET_PORT) || 3000;

// Physical port bridging configuration
const FieldPorts = parseFieldPorts(process.env.FIELD_PORTS);

// Trusted proxy configuration
const trustedProxyMatcher = process.env.TRUSTED_PROXIES
  ? new CIDRMatcher(
      process.env.TRUSTED_PROXIES.split(/[,\s]+/g)
        .filter(s => s)
        .map(toCidr),
    )
  : undefined;

// Devices on this host's own networks get the internal UI without a cookie,
// whichever address family they arrive on — see src/onLink.ts.
const onLinkChecker = new OnLinkChecker();

// Scheduled configuration clearing
const RadioClearSchedule = process.env.RADIO_CLEAR_SCHEDULE;
const RadioClearTimezone = process.env.RADIO_CLEAR_TIMEZONE;

(async () => {
  if (CliMode) {
    process.exit((await maybeRunCli(CliArgs)) ?? 0);
  }

  // Verify expected IPs on the VLAN interface
  let net: NetworkBackend | undefined;
  if (VlanInterface) {
    await checkRequiredTools(['iptables', 'arping', 'fping', 'dnsmasq', 'conntrack', 'tcpdump']);
    net = process.env.DRY_RUN ? createDryRunBackend() : createBackend();
    // pFMS serves multiple roles on this interface:
    const expectedIps = [
      '10.0.100.5', // FMS
      // We reconfigure the radio to use our IP instead of listening on an extra interface
      // '10.0.100.40', // Syslog server
    ];
    await checkInterfaceIps(VlanInterface, expectedIps, net);

    // Always remove legacy VLAN interfaces from the previous version that used
    // radio-native station names (eno1.red1, eno1.blue3). These hold VLAN IDs
    // that conflict with the current eno1.slot1-slot6 names, so they must be
    // cleaned up even during graceful restarts.
    await cleanupOldVlanInterfaces(VlanInterface);

    if (KeepNetwork) {
      // Preserve existing rules — this is a graceful restart. Preferences are
      // restored from the kernel below, after the WebSocket server is up.
      console.log('KEEP_NETWORK=true: skipping iptables flush');
    } else {
      // Clean up stale iptables rules from a previous run (e.g., after a crash)
      await net.flushRulesByComment(IPTABLES_COMMENT_PREFIX);
      // Also flush per-station route tables — these aren't comment-tagged so
      // flushRulesByComment doesn't catch them.
      for (const vlanId of Object.values(vlanMap)) {
        try {
          await execFile('ip', ['route', 'flush', 'table', String(vlanId)]);
        } catch {
          // Table may not exist yet on first run — that's fine.
        }
      }
    }

    // Enable IP forwarding once at startup (required for inter-VLAN routing)
    await net.setSysctl({ key: 'net.ipv4.ip_forward', value: '1' });

    // …but never straight back out the uplink (the gateway ping-pong for team
    // subnets that have no station here). Done here as well as on every radio
    // commit, so a graceful restart with KEEP_NETWORK — which skips the flush
    // and does not touch the radio — still gets the rule (2026-09-27: the
    // first deploy of it installed nothing until the next radio change).
    await dropHairpinForwarding(VlanInterface);

    // Size the kernel neighbor (ARP/NDP) table for what this host does: the
    // subnet scanner sweeps every configured team /24 every 10 s, and each
    // sweep parks ~250 INCOMPLETE/FAILED entries per slot for ~60 s. Ubuntu's
    // default gc_thresh3 of 1024 overflowed with the 4th team at the
    // 2026-09-13 scrimmage ("neighbour: arp_cache: neighbor table overflow!"),
    // and a full table black-holes packets to any host without an entry —
    // three Driver Stations lost their robots in the same second mid-match.
    // 6 slots × 254 + guest network + headroom comfortably fits in 8192.
    for (const family of ['ipv4', 'ipv6']) {
      for (const [key, value] of [
        ['gc_thresh1', '2048'],
        ['gc_thresh2', '4096'],
        ['gc_thresh3', '8192'],
      ] as const) {
        await net.setSysctl({ key: `net.${family}.neigh.default.${key}`, value }).catch(err => {
          console.warn(`Could not set net.${family}.neigh.default.${key}: ${(err as Error).message}`);
        });
      }
    }
  }

  // Initialize port bridge manager (physical Ethernet port → station bridge mapping)
  let portBridgeManager: PortBridgeManager | undefined;
  if (VlanInterface && FieldPorts.length > 0) {
    const portNet = net ?? (process.env.DRY_RUN ? createDryRunBackend() : createBackend());
    portBridgeManager = new PortBridgeManager(portNet, VlanInterface, FieldPorts);

    if (KeepNetwork) {
      // Graceful restart — try to restore port bridge state from kernel
      await portBridgeManager.restoreFromKernel();
    } else {
      // Full restart — clean up stale port VLAN interfaces
      await portBridgeManager.cleanupPortInterfaces();
    }

    console.log(`Port bridging enabled: ${FieldPorts.length} port(s) configured`);
  }

  // Initialize radio manager — firmware mode will be set when the radio connects
  const radioManager = new RadioManager(RadioUrl, VlanInterface);

  // Connect to the radio in the background — don't block startup.
  // After a full restart (iptables were flushed), re-apply the restored activeConfig
  // once firmware mode is known, so configureNetwork knows whether to start dnsmasq.
  (async () => {
    const status = await waitForRadio(RadioUrl);
    if (status) {
      radioManager.setFirmwareMode(detectFirmwareMode(status.version));
    }

    // Re-apply config to rebuild network rules if needed.
    const teamMappings = radioManager.getTeamMappings();
    if (VlanInterface && Object.keys(teamMappings).length > 0) {
      if (KeepNetwork) {
        // Graceful reload — verify team bridges actually exist and have IPs.
        // If a commit was staged but never applied before the restart,
        // the bridges may be missing even though active-config.json has teams.
        let vlansOk = true;
        try {
          const interfaces = await (net ?? createBackend()).listInterfaces();
          const ifaceIps = new Set<string>();
          for (const iface of interfaces) {
            for (const addr of iface.addresses) {
              if (addr.family === 'inet') ifaceIps.add(addr.address);
            }
          }
          for (const team of Object.keys(teamMappings).map(Number)) {
            const high = Math.floor(team / 100);
            const low = team % 100;
            const expectedIp = `10.${high}.${low}.${VlanHostOctet}`;
            if (!ifaceIps.has(expectedIp)) {
              console.warn(`VLAN IP ${expectedIp} missing for team ${team} — will re-apply config`);
              vlansOk = false;
              break;
            }
          }
        } catch {
          vlansOk = false;
        }
        if (!vlansOk) {
          await radioManager.commitConfiguration();
        }
      } else {
        // Full restart — always re-apply
        await radioManager.commitConfiguration();
      }
    }
  })().catch(err => {
    console.error('Background radio connection failed:', err);
  });

  // Initialize match engine (for admin page match simulation & e-stop)
  const matchEngine = new MatchEngine(
    s => radioManager.getTeamForStation(s),
    s => radioManager.getProjectedTeamForStation(s),
  );
  // A joined robot whose Wi-Fi request changes during setup leaves the match.
  // Held requests only announce themselves through the pending-commit state,
  // so listen to both.
  radioManager.addConfigChangeListener(() => matchEngine.reconcileJoinedTeams());
  radioManager.addPendingCommitListener(() => matchEngine.reconcileJoinedTeams());

  // Which control system answered on each station, learned from the team
  // checks. Only a positive identification can block a robot, so a dropped
  // detection never strands a legitimate one.
  const stationController = new Map<StationName, RobotController | null>();

  /** Why this station's robot may not be enabled, per the field policy. */
  function policyBlockReason(station: StationName): string | null {
    return controllerBlockReason(
      stationController.get(station) ?? null,
      setupConfigStore.get().settings.controllerPolicy,
    );
  }

  // Every enable in the match engine goes through this gate.
  matchEngine.setEnableBlocked(policyBlockReason);

  /** Staff set the admin "Freeplay outside matches" switch to Held
   *  (setting `outOfMatchControl: false`). Read live so a flip takes effect
   *  without a restart. Default Allowed. */
  function outOfMatchControlOff(): boolean {
    return setupConfigStore.get().settings.outOfMatchControl === false;
  }

  /** Why the field holds this station's robot disabled OUTSIDE a match, or
   *  null. A policy block (which also applies in a match) wins; otherwise
   *  the admin switch. Callers only ask about stations that aren't joined. */
  function outOfMatchHoldReason(station: StationName): string | null {
    return (
      policyBlockReason(station) ??
      (outOfMatchControlOff() ? 'Field staff have turned off freeplay outside matches.' : null)
    );
  }
  matchEngine.setOutOfMatchHold(outOfMatchHoldReason);

  // How long each team has been on the field, for the admin team list.
  matchEngine.setConnectedAtResolver(s => radioManager.getConnectedAtForStation(s));

  // Teams' Wi-Fi requests wait — parked on the pending list, not applied —
  // while a match exists in any phase (created through post-match), while an
  // admin holds them from the admin page, or while other changes are already
  // waiting. Waiting changes only reach the radio when staff press "Apply
  // now" on the match or admin page. Read live.
  radioManager.setShouldHold(() => {
    if (matchEngine.getState().phase !== 'idle') return 'match';
    if (setupConfigStore.get().settings.holdRadioChanges) return 'admin';
    return null;
  });
  matchEngine.addStateListener(() => radioManager.retryHeldChanges());
  setupConfigStore.addListener(() => radioManager.retryHeldChanges());

  // When a match ends, every robot on the field is queued to leave unless it
  // plays on: joining the next match, or pressing Keep / Enable Wi-Fi,
  // withdraws its release. Nothing leaves until staff apply.
  let phaseBeforeRelease = matchEngine.getState().phase;
  matchEngine.addStateListener(state => {
    const previous = phaseBeforeRelease;
    phaseBeforeRelease = state.phase;
    if (state.phase !== 'postMatch' || previous === 'postMatch') return;
    if (setupConfigStore.get().settings.releaseAfterMatch === false) return;
    radioManager.stageReleaseAll('postMatch');
  });
  matchEngine.setStationJoinHook(station => {
    const ssid = radioManager.getStationConfig(station)?.ssid;
    if (ssid) radioManager.keepRobot(ssid);
  });

  // Initialize match audio (plays FRC field sounds on phase transitions)
  const matchAudio = new MatchAudio();
  await matchAudio.init();
  matchAudio.attachToEngine(matchEngine);

  // Initialize saved team store (server-side WiFi credential persistence)
  const savedTeamStore = new SavedTeamStore();

  // Robot Wi-Fi scan: listen on a spare wireless card for robots' 2.4 GHz
  // networks (FRC-<team>[-suffix]) and check saved passphrases against them.
  // Off unless an admin picks the interface; switching it restarts the scan.
  let robotWifi: RobotWifiScanner | null = null;
  let broadcastRobotWifi: (state: RobotWifiScanState) => void = () => {};
  // Every wireless card on the host, for the admin page: what each is doing
  // (the robot scan, the host, nothing) and staff test joins on the ones
  // pFMS may use. Test joins only associate — no address, no routes.
  let broadcastWifiCards: (state: WifiCardsState) => void = () => {};
  const wifiCards = new WifiCards({
    onChange: state => broadcastWifiCards(state),
    robotScan: () => {
      const scanner = robotWifi;
      if (!scanner) return null;
      const { status, error } = scanner.getState();
      return { iface: scanner.iface, status, ...(error && { error }), testJoin: (r, o) => scanner.testJoin(r, o) };
    },
    matchRunning: () => matchEngine.isMatchActive(),
  });
  // Cards come and go (USB), and the host can take one over at any time.
  setInterval(() => wifiCards.refresh(), 10_000);
  const robotWifiState = (): RobotWifiScanState => ({
    ...(robotWifi?.getState() ?? { type: 'robotWifiScan', status: 'off', interfaces: [], broadcasts: [], stalls: [] }),
    interfaces: listWirelessInterfaces(),
  });
  // What the field is trying to connect, for spotting a robot that is taking
  // too long to join: every configured station, whether its robot is linked,
  // and since when it has been trying. Nothing while the radio isn't ACTIVE —
  // it can't link anyone then, so that wait doesn't count.
  let radioActiveSince: number | null = null;
  let linkedNow: Partial<Record<StationName, boolean>> = {};
  radioManager.addStatusListener(entry => {
    const update = entry.radioUpdate;
    if (update?.status !== 'ACTIVE') {
      radioActiveSince = null;
      return;
    }
    radioActiveSince ??= Date.now();
    linkedNow = Object.fromEntries(StationNameList.map(s => [s, update.stationStatuses[s]?.isLinked ?? false]));
  });
  const connectAttempts = (): ConnectAttempt[] => {
    if (radioActiveSince === null) return [];
    const lastLinked = radioManager.getLastLinkedTimestamps();
    return StationNameList.flatMap(station => {
      const config = radioManager.getStationConfig(station);
      if (!config?.ssid) return [];
      const since = Math.max(
        radioManager.getConnectedAtForStation(station) ?? 0,
        radioActiveSince ?? 0,
        lastLinked[station] ?? 0,
      );
      return [{ station, ssid: config.ssid, wpaKey: config.wpaKey, since, linked: linkedNow[station] ?? false }];
    });
  };
  const applyRobotWifiSetting = () => {
    const iface = setupConfigStore.resolveSetting('robotWifiInterface', 'ROBOT_WIFI_INTERFACE').value || undefined;
    if ((robotWifi?.iface ?? undefined) === iface) return;
    robotWifi?.stop();
    robotWifi = null;
    if (iface) {
      appInfo(`Robot Wi-Fi scan starting on ${iface}`);
      robotWifi = new RobotWifiScanner({
        iface,
        runner: new WpaSupplicantRunner(iface),
        savedSsids: () => savedTeamStore.getTeams().map(t => t.ssid),
        connectAttempts,
        onChange: () => {
          broadcastRobotWifi(robotWifiState());
          wifiCards.refresh();
        },
      });
      void robotWifi.start();
    }
    broadcastRobotWifi(robotWifiState());
    wifiCards.refresh();
  };
  applyRobotWifiSetting();
  setupConfigStore.addListener(applyRobotWifiSetting);
  // A robot saved or changed: re-match what is on the air.
  savedTeamStore.addListener(() => broadcastRobotWifi(robotWifiState()));
  process.on('exit', () => robotWifi?.stop());

  // A stream server saved in the setup UI wins over the environment, and is
  // read per-request so it applies without a restart.
  setVideoProxyTargetResolver(() => setupConfigStore.get().settings.videoProxyTarget ?? process.env.VIDEO_PROXY_TARGET);

  // Field policy on robot control systems — read live so an admin change
  // shows up in the next robot check without a restart.
  setControllerPolicyResolver(() => setupConfigStore.get().settings.controllerPolicy);

  // Initialize scoring engine and API key store
  const ScoringAutoRegisterLimit = Number(process.env.SCORING_AUTO_REGISTER_LIMIT) || 1;
  const scoringEngine = new ScoringEngine();
  const apiKeyStore = new ApiKeyStore();
  scoringEngine.setAutoRegisterLimit(ScoringAutoRegisterLimit);

  // Wire up auto score resolver so match engine can determine auto winner from scoring data
  matchEngine.setAutoScoreResolver(() => {
    const scoreState = scoringEngine.getState();
    // The 'auto' sub-period covers the auto phase and the pause after it —
    // balls in flight at the auto buzzer count. Judged by when each ball
    // scored, so a lagging detector still lands them in auto.
    const auto = scoreState.periodBreakdown?.['auto'];
    if (auto) {
      return { red: auto.red, blue: auto.blue };
    }
    return { red: scoreState.red.total, blue: scoreState.blue.total };
  });

  // Auto-switch scoring mode based on match state
  matchEngine.addStateListener(state => scoringEngine.onMatchStateChange(state));

  // Initialize match history (persist results across restarts)
  const matchHistoryStore = new MatchHistoryStore();
  matchHistoryStore.attach(matchEngine, scoringEngine);

  // The match queue: upcoming matches from a schedule and the fill line,
  // and "Set up next match" for the match page (src/matchSetup.ts).
  const matchQueue = new MatchQueue();
  matchQueue.attach(matchEngine);
  matchQueue.setPresenceResolver(
    team =>
      radioManager.getProjectedStationForTeam(team) !== null ||
      Object.values(matchEngine.getState().stationStates).some(s => s?.joined && s.teamNumber === team),
  );
  const setupNext = (id: string | undefined, mode: SetupMode) =>
    setupNextMatch(
      {
        queue: matchQueue,
        engine: {
          getPhase: () => matchEngine.getState().phase,
          hasJoined: () => Object.values(matchEngine.getState().stationStates).some(s => s?.joined),
          createMatch: () => matchEngine.createMatch(),
          joinStationAlliance: (station, alliance) => matchEngine.joinStationAlliance(station, alliance),
          isJoined: station => !!matchEngine.getState().stationStates[station]?.joined,
        },
        radio: {
          // Every robot goes on the pending list first, then one apply — not
          // one radio reconfigure per robot.
          stageRobots: teams =>
            radioManager.batch(async () => {
              const outcomes = new Map<number, StageOutcome>();
              for (const team of teams) {
                const saved = savedTeamStore.bestForTeam(team);
                if (!saved) {
                  outcomes.set(team, 'noCredentials');
                  continue;
                }
                const station =
                  radioManager.getProjectedStationForTeam(team) ?? radioManager.getFreeProjectedStation() ?? 'slot1';
                const r = await radioManager.configure(station, {
                  ssid: saved.ssid,
                  wpaKey: saved.wpaKey,
                  internetAccess: saved.internetAccess,
                });
                outcomes.set(team, r.result === 'kept' || r.result === 'noop' ? 'kept' : 'staged');
              }
              return outcomes;
            }),
          apply: () => radioManager.applyPendingChanges(),
          stationForTeam: team => radioManager.getProjectedStationForTeam(team),
        },
      },
      id,
      mode,
    );

  // Match video recorder. Streams saved in the admin panel win over the
  // environment seed (`MATCH_RECORDING_STREAMS="all-field=rtsp://…,…"`),
  // read per match so a change applies to the next match without a restart.
  const envRecordingStreams = parseRecordingStreamsEnv(process.env.MATCH_RECORDING_STREAMS);
  const matchRecorder = new MatchRecorder({
    getStreams: () => setupConfigStore.get().settings.recordingStreams ?? envRecordingStreams,
    getRetentionDays: () =>
      setupConfigStore.get().settings.recordingRetentionDays ??
      (Number(process.env.MATCH_RECORDING_RETENTION_DAYS) || undefined),
    getPracticeRetentionDays: () => setupConfigStore.get().settings.practiceRetentionDays,
    getMinFreeGb: () => setupConfigStore.get().settings.recordingMinFreeGb,
  });

  // Initialize field usage tracker (tracks robot connection hours per team)
  const usageTracker = new UsageTracker();
  usageTracker.attach(radioManager);

  // Initialize support system
  const supportStore = new SupportStore();
  const slackBridge = new SlackBridge();
  // Short of disk space (or back from it): tell the people who run the
  // field, once per change, where they will see it.
  matchRecorder.addSpaceListener(change => {
    void slackBridge.postToChannel(describeSpaceChange(change));
  });
  // Announce version changes to the support channel (commit subjects since last deploy)
  announceDeploy(text => slackBridge.postToChannel(text)).catch(err => {
    console.warn('Deploy announcement failed:', (err as Error).message);
  });
  const adminAuth = new AdminAuth();
  const externalAccessStore = new ExternalAccessStore();

  // What was happening while each video ran: every score event and every
  // robot's telemetry for the window, written next to the video by both
  // recorders (metadata.json + CSVs).
  const teamForStation = (station: StationName) => radioManager.getTeamForStation(station) ?? undefined;
  const sessionMetadata = new SessionMetadataCollector({ getTeamForStation: teamForStation });
  matchRecorder.setMetadataCollector(sessionMetadata);
  scoringEngine.addEventListener(e => sessionMetadata.onScoreEvent(e));

  // "Record while enabled": practice runs outside matches, filed per team
  // with a per-day share link, and the link posted to the team's mentors.
  const practiceStore = new PracticeStore();
  const practiceRecorder = new PracticeRecorder({
    directory: matchRecorder.recordingsDirectory,
    ffmpegPath: matchRecorder.ffmpegPath,
    ffprobePath: matchRecorder.ffprobePath,
    getStreams: () => setupConfigStore.get().settings.recordingStreams ?? envRecordingStreams,
    store: practiceStore,
    metadata: sessionMetadata,
    getTeamForStation: teamForStation,
    isAvailable: () => matchRecorder.isAvailable(),
    // No clips while matches are being run — a match is set up on the field,
    // or the queue is in use — since every match is recorded; and none while
    // the recordings volume is short of space.
    pauseReason: () => {
      if (matchRecorder.space() !== 'ok') return 'The field is short of disk space, so practice clips are paused.';
      const queue = matchQueue.getState();
      const queueInUse =
        queue.settings.lineOpen ||
        queue.entries.some(e => e.status === 'queued' || e.status === 'onDeck' || e.status === 'playing');
      if (matchEngine.getState().phase !== 'idle' || queueInUse) {
        return 'Matches are being run, so practice clips are off — every match is recorded instead.';
      }
      return undefined;
    },
  });
  matchEngine.addStateListener(state => practiceRecorder.onMatchState(state));
  matchRecorder.addSweepListener(() => {
    const onDisk = (id: string) => existsSync(join(matchRecorder.recordingsDirectory, id));
    practiceStore.pruneMissing(onDisk);
    matchHistoryStore.pruneMissingRecordings(onDisk);
  });
  // Long-term timelapse: a few archival frames a day, plus a fast timelapse
  // while robots are on the field. Off until an admin enables it. Assigned
  // once the FMS server exists, since that is what owns the telemetry
  // manager; before then nothing can be enabled anyway.
  let anyRobotEnabled = (): boolean => false;
  // What was on the field and when — robots, enables, matches — for the
  // timelapse viewer's timeline. Always on: it is a few kB a day.
  const fieldActivity = new FieldActivityLog({
    directory: join(matchRecorder.recordingsDirectory, '.timelapse', 'activity'),
    getTeamForStation: teamForStation,
  });
  radioManager.addStatusListener(entry => {
    const update = entry.radioUpdate;
    if (!update) return;
    for (const station of StationNameList)
      fieldActivity.onLinkState(station, update.stationStatuses[station]?.isLinked ?? false);
  });
  radioManager.addConfigChangeListener(() => fieldActivity.onConfigChanged());
  matchHistoryStore.addListener(state => fieldActivity.onMatchHistory(state.matches));
  const fieldTimelapse = new FieldTimelapse({
    directory: matchRecorder.recordingsDirectory,
    ffmpegPath: matchRecorder.ffmpegPath,
    ffprobePath: matchRecorder.ffprobePath,
    activity: fieldActivity,
    getStreams: () => setupConfigStore.get().settings.recordingStreams ?? envRecordingStreams,
    getConfig: () => setupConfigStore.get().settings.timelapse,
    isAvailable: () => matchRecorder.isAvailable(),
    isFieldBusy: () => matchEngine.isMatchActive() || anyRobotEnabled(),
  });
  matchEngine.addStateListener(state => fieldTimelapse.onMatchState(state));
  setupConfigStore.addListener(() => fieldTimelapse.onConfigChanged());
  // The live timelapse pauses for matches; each match's recording fills in.
  matchRecorder.addFinishListener(match => fieldTimelapse.onMatchRecorded(match));

  const publicUrl = () => setupConfigStore.get().settings.publicUrl ?? process.env.PUBLIC_URL;
  const practiceApi: PracticeApiDeps = {
    practiceStore,
    historyStore: matchHistoryStore,
    recorder: matchRecorder,
    publicUrl,
  };
  const practiceNotifier = new PracticeNotifier({
    practiceStore,
    historyStore: matchHistoryStore,
    slack: slackBridge,
    lastSeen: team => practiceRecorder.lastSeenForTeam(team),
    countItems: (team, day) => countPracticeDayItems(practiceApi, team, day),
    publicUrl,
    retentionDays: () => matchRecorder.effectiveRetentionDays(),
    practiceRetentionDays: () => matchRecorder.effectivePracticeRetentionDays(),
  });

  // How each team wants to hear about the queue (Slack DM, web push), and
  // the nudger that acts on it when a team is next up, on deck, or a no-show.
  const teamPrefsStore = new TeamPrefsStore();
  const pushService = new PushService(undefined, publicUrl);
  const queueNudger = new QueueNudger({
    queue: matchQueue,
    prefs: teamPrefsStore,
    slack: slackBridge,
    push: pushService,
    publicUrl,
  });

  // Initialize WebSocket server (callbacks are set below after subsystems are created)
  let onRunTeamChecks: ((station: StationName) => void) | undefined;
  let onDriveAction: ((dsIp: string, station: StationName | null) => void) | undefined;
  let stationTestManager: StationTestManager | undefined;
  // Resolves guest-network device names (DS laptops) so the UI can show them
  // instead of bare IPs. `broadcast` is const-declared below; the callback only
  // fires after async resolutions, well past initialization.
  const hostnameResolver = new HostnameResolver(state => broadcast(state));
  // Driver Station laptop Wi-Fi reports: the collector script teams run, and
  // where it uploads to (see src/diagReportApi.ts). A report is tagged with
  // the team on the station whose DS spoke from the same address.
  const handleDiagRequest = createDiagReportHandler({
    scriptDir: findAssetDir(['diag']),
    reportsDir: process.env.DIAG_REPORTS_DIR ?? 'diag-reports',
    clientIp: req => getRealClientIp(req.socket.remoteAddress, req.headers, trustedProxyMatcher),
    teamForIp: ip => {
      const { connectedStations } = matchEngine.getState();
      for (const station of StationNameList) {
        if (connectedStations[station]?.ip === ip) return radioManager.getTeamForStation(station) ?? undefined;
      }
      return undefined;
    },
  });
  const { wss, broadcast, broadcastRouteState, publicConnections } = setupWebSocket(
    radioManager,
    matchEngine,
    WebSocketPort,
    trustedProxyMatcher,
    station => onRunTeamChecks?.(station),
    [
      (req: IncomingMessage, res: ServerResponse) =>
        handleExternalAccessAuth(req, res, externalAccessStore, { trustedProxyMatcher, onLink: onLinkChecker }),
      (req, res) => handleScoringRequest(req, res, scoringEngine, apiKeyStore, trustedProxyMatcher),
      (req, res) => handleMatchReviewRequest(req, res, matchHistoryStore, apiKeyStore, trustedProxyMatcher),
      (req, res) => handleRecordingsRequest(req, res, matchRecorder),
      (req, res) => handlePublicMatchRequest(req, res, matchHistoryStore, matchRecorder),
      (req, res) => handlePracticeRequest(req, res, practiceApi),
      (req, res) =>
        handleTimelapseRequest(req, res, fieldTimelapse, {
          activity: fieldActivity,
          historyMatches: () => matchHistoryStore.getState().matches,
          usageSessions: () => usageTracker.getState().sessions,
          practiceRuns: () => practiceStore.getRuns(),
        }),
      handleDiagRequest,
      (req, res) => handleFirmwareRequest(req, res, firmwareStore),
      handleTeamAvatarRequest,
      handleManifestRequest,
    ],
    (wpaKey, wpaKey24, skipReconfigure) => {
      if (!robotTestMonitor) return;
      // Auto-detect WPA key: active station config → saved team store
      const team = robotTestMonitor.getState().teamNumber;
      const resolvedKey =
        wpaKey ||
        (team
          ? (radioManager.getWpaKeyForTeam(team) ?? savedTeamStore.getWpaKeyForTeam(team) ?? undefined)
          : undefined);
      robotTestMonitor.startFirmwareUpdate(resolvedKey, wpaKey24, skipReconfigure).catch(err => {
        console.error('Firmware update failed:', err.message);
      });
    },
    (teamNumber, wpaKey6, wpaKey24, ssidSuffix) => {
      if (!robotTestMonitor) return;
      robotTestMonitor.configureTeamRadio(teamNumber, wpaKey6, wpaKey24, ssidSuffix).catch(err => {
        console.error('Radio configuration failed:', err.message);
      });
    },
    savedTeamStore,
    apiKeyStore,
    scoringEngine,
    portBridgeManager,
    (dsIp, station) => onDriveAction?.(dsIp, station),
    supportStore,
    slackBridge,
    adminAuth,
    externalAccessStore,
    // Station test port mode callbacks
    (station, portVlanId) => {
      stationTestManager?.startTestMode(station, portVlanId).catch(err => {
        console.error(`Station test mode start failed for ${station}:`, err.message);
      });
    },
    station => {
      stationTestManager?.stopTestMode(station).catch(err => {
        console.error(`Station test mode stop failed for ${station}:`, err.message);
      });
    },
    (station, teamNumber, wpaKey6, wpaKey24, ssidSuffix) => {
      stationTestManager?.configureRadio(station, teamNumber, wpaKey6, wpaKey24, ssidSuffix).catch(err => {
        console.error(`Station radio configure failed for ${station}:`, err.message);
      });
    },
    (station, wpaKey, wpaKey24, skipReconfigure) => {
      stationTestManager?.startFirmwareUpdate(station, wpaKey, wpaKey24, skipReconfigure).catch(err => {
        console.error(`Station firmware update failed for ${station}:`, err.message);
      });
    },
    matchAudio,
    matchHistoryStore,
    usageTracker,
    hostnameResolver,
    {
      configStore: setupConfigStore,
      matchRecorder,
      timelapse: fieldTimelapse,
      // "Restart pFMS" on the admin page: the same graceful path as
      // `systemctl reload` (flag file, then SIGHUP), so network rules and
      // routing survive and systemd's Restart=always brings the service
      // back. A full stop/start is the path that raced the VLAN bridges and
      // crashed on 2026-09-27.
      restart: () => {
        try {
          writeFileSync(KEEP_NETWORK_FLAG, '');
        } catch (err) {
          console.error('Could not write the keep-network flag before restarting:', err);
        }
        process.kill(process.pid, 'SIGHUP');
      },
      // Where this field is reachable from the internet, for the post-match
      // QR link. Setup UI value wins over PUBLIC_URL; both optional.
      publicUrl,
      queue: { store: matchQueue, setupNext },
      robotWifi: { getState: robotWifiState, test: station => robotWifi?.test(station) },
      wifiCards,
      teamPrefs: {
        store: teamPrefsStore,
        vapidPublicKey: () => pushService.publicKey,
        slackAvailable: () => slackBridge.isConnected(),
        testPush: team => queueNudger.test(team),
      },
      practice: {
        recorder: practiceRecorder,
        store: practiceStore,
        countItems: (team, day) => countPracticeDayItems(practiceApi, team, day),
      },
      // Settings saved in the wizard win over the env vars this process
      // started with, so the probe reflects what the operator just chose
      // rather than what was on the command line.
      runProbe: () => {
        const settings = setupConfigStore.get().settings;
        return runSetupProbe({
          vlanInterface: settings.vlanInterface ?? VlanInterface,
          radioUrl: settings.radioUrl ?? RadioUrl,
          fmsAddress: settings.fmsAddress ?? '10.0.100.5',
          dryRun: process.env.DRY_RUN !== undefined,
          videoProxyTarget: settings.videoProxyTarget ?? process.env.VIDEO_PROXY_TARGET,
          audioVerified: settings.audioVerified,
          castVerified: settings.castVerified,
          deploymentMode: settings.deploymentMode,
          scoringOpen: !apiKeyStore.hasAnyActiveKeys() && !scoringRequiresKey(),
        });
      },
    },
  );
  setBroadcast(broadcast);
  broadcastRobotWifi = broadcast;
  broadcastWifiCards = broadcast;

  // Starts listening to match phases; verifies ffmpeg first and says so in
  // the log if recording can't work on this host.
  matchRecorder.start(matchEngine, matchHistoryStore).catch(err => {
    console.error('Match recorder failed to start:', err);
  });
  practiceRecorder.start();
  practiceNotifier.start();
  queueNudger.start();
  fieldActivity.start();
  fieldActivity.onMatchHistory(matchHistoryStore.getState().matches);
  fieldTimelapse.start();

  // Broadcast score state changes to all WebSocket clients
  scoringEngine.addStateListener(broadcast);

  // Broadcast API key state changes to all WebSocket clients
  apiKeyStore.addListener(broadcast);

  // Subnet scanning for device discovery on team VLANs
  const autoConnectInFlight = new Set<string>();
  const subnetScanner = new SubnetScanner(
    s => radioManager.getTeamForStation(s),
    results => {
      latestSubnetScan = results;
      broadcast(results);

      for (const station of StationNameList) {
        const scan = results.stations[station];
        if (!scan) continue;

        // Auto-connect: when conntrack detects a guest WiFi IP communicating with a
        // team subnet, set its route preference so mDNS reflection works automatically.
        // The autoConnectInFlight guard prevents duplicate ip-rule calls when the same
        // IP appears under multiple stations or across overlapping scan cycles.
        for (const host of scan.hosts) {
          if (!host.alive || host.source !== 'conntrack') continue;
          // Guest-network host — resolve its device name for the UI
          hostnameResolver.track(host.ip);
          if (getPreference(host.ip) || autoConnectInFlight.has(host.ip)) continue;
          autoConnectInFlight.add(host.ip);
          setRoutePreference(host.ip, station, scan.team)
            .catch(err => console.error(`Auto-connect failed for ${host.ip} → ${station}:`, err))
            .finally(() => autoConnectInFlight.delete(host.ip));
        }

        // Re-trigger team checks when new devices appear on stations that had error results.
        const team = radioManager.getTeamForStation(station);
        if (!team) continue;
        const lastResults = latestCheckResults.get(station);
        if (!lastResults) continue;
        if (!lastResults.checks.some(c => c.status === 'error')) continue;

        const currentAlive = new Set(scan.hosts.filter(h => h.alive).map(h => h.ip));
        const previousAlive = checksAliveSnapshot.get(station);
        const retries = checksRetryCount.get(station) ?? 0;
        const newDevice = previousAlive != null && [...currentAlive].some(ip => !previousAlive.has(ip));
        // Errors are usually transient (e.g. the radio's HTTP API unreachable during
        // a network blip) and the alive-device set may never change when they clear,
        // so also retry on a backoff timer: 30s, 1m, 2m, 4m, then every 8m forever.
        const retryDelay = Math.min(30_000 * 2 ** retries, 480_000);
        const timedRetry = Date.now() - (checksRanAt.get(station) ?? 0) >= retryDelay;
        if ((newDevice && retries < MAX_AUTO_RETRIGGERS) || timedRetry) {
          checksRetryCount.set(station, retries + 1);
          triggerTeamChecks(station, team);
        }
      }
    },
  );
  let latestSubnetScan: ReturnType<SubnetScanner['getResults']> | null = null;
  subnetScanner.start(10_000);

  // Team checker — runs automated checks when a DS connects
  const teamChecker = new TeamChecker(
    s => {
      const scan = subnetScanner.getResults();
      return scan.stations[s]?.hosts.filter(h => h.alive) ?? [];
    },
    VlanInterface ? VlanHostOctet : undefined,
  );
  const latestCheckResults = new Map<StationName, TeamCheckResults>();
  // Snapshot of alive IPs when checks last ran, so we can re-trigger when new devices appear
  const checksAliveSnapshot = new Map<StationName, Set<string>>();
  // Guard against concurrent check runs per station
  const checksInFlight = new Set<StationName>();
  // Cap new-device re-triggers to avoid loops when devices flap
  const checksRetryCount = new Map<StationName, number>();
  const MAX_AUTO_RETRIGGERS = 5;
  // When the last check run completed, for timed retries of error results
  const checksRanAt = new Map<StationName, number>();

  /** Run team checks for a station, broadcast results, and cache them. */
  function triggerTeamChecks(station: StationName, team: number) {
    if (checksInFlight.has(station)) return;
    checksInFlight.add(station);

    teamChecker
      .runChecks(station, team)
      .then(results => {
        latestCheckResults.set(station, results);
        if (results.controller !== undefined) stationController.set(station, results.controller);
        // Snapshot AFTER checks complete so we compare against what was alive
        // when results were determined, avoiding unnecessary re-triggers
        const scan = subnetScanner.getResults();
        checksAliveSnapshot.set(
          station,
          new Set(scan.stations[station]?.hosts.filter(h => h.alive).map(h => h.ip) ?? []),
        );
        broadcast(results);
      })
      .catch(err => {
        console.error(`Team checks failed for ${station}:`, err);
      })
      .finally(() => {
        checksRanAt.set(station, Date.now());
        checksInFlight.delete(station);
      });
  }

  // Wire up the manual re-run callback
  onRunTeamChecks = (station: StationName) => {
    const team = radioManager.getTeamForStation(station);
    if (team !== null) {
      checksRetryCount.delete(station);
      triggerTeamChecks(station, team);
    }
  };

  // Firmware store — persistent cache for radio firmware files
  const firmwareStore = new FirmwareStore();
  // Broadcast firmware store changes (download progress, availability) to all clients
  firmwareStore.addListener(entries => broadcast({ type: 'firmwareStoreUpdate', entries }));
  // Start downloading known firmware files in the background (non-blocking, retries on failure)
  firmwareStore.startBackgroundDownloads();

  // Robot test monitor — CSA tool for diagnosing individual robots
  let robotTestMonitor: RobotTestMonitor | undefined;
  if (TestInterface) {
    const testNet = process.env.DRY_RUN ? createDryRunBackend() : (net ?? createBackend());
    robotTestMonitor = new RobotTestMonitor(
      TestInterface,
      testNet,
      state => broadcast(state),
      progress => broadcast(progress),
      firmwareStore,
      !!process.env.DRY_RUN,
      () => wss.clients.size > 0,
      progress => broadcast(progress),
    );
    await robotTestMonitor.start();
  }

  // Station test port mode — per-station robot diagnostics via a bridged physical port
  if (portBridgeManager?.enabled) {
    const testNet = process.env.DRY_RUN ? createDryRunBackend() : (net ?? createBackend());
    stationTestManager = new StationTestManager(
      portBridgeManager,
      testNet,
      firmwareStore,
      radioManager,
      state => broadcast(state),
      // Per-station firmware/radio progress is not broadcast as top-level messages
      // to avoid conflating with the global test monitor's progress handlers.
      // The inline UI derives progress from StationTestState (settling banners, etc.).
      () => {},
      () => {},
      !!process.env.DRY_RUN,
      () => wss.clients.size > 0,
    );
  }

  // Telemetry reaches clients through a per-station coalescer: packet capture
  // fires per sniffed packet (250+/s with six robots), which floods slow
  // displays and delays the score updates queued behind it. Status changes
  // still flush immediately.
  const broadcastTelemetry = createTelemetryCoalescer(update => {
    broadcast(update);
    // The same coalesced stream feeds the recording sidecars and the
    // practice recorder's enable/disable detection.
    sessionMetadata.onTelemetry(update);
    practiceRecorder.onTelemetry(update);
    fieldActivity.onTelemetry(update);
    // Any packet from any station means robots are here, which is what the
    // timelapse keys off — it does not care which station or whether enabled.
    fieldTimelapse.onTelemetry();
  });

  // Per-robot setup checks for the scoreboard (DS link, radio, comms,
  // joysticks, battery, Ready), fed by the packet capture, DS status and radio
  // status below.
  let robotPacketCapture: RobotPacketCapture | undefined;
  const stationChecks = new StationChecksTracker({
    getMatchState: () => matchEngine.getState(),
    captureActive: () => robotPacketCapture?.isRunning() ?? false,
  });
  radioManager.addStatusListener(entry => {
    if (entry.radioUpdate) stationChecks.noteRadioUpdate(entry.radioUpdate);
  });

  // Passive robot packet capture — sniff robot→DS UDP to extract battery voltage
  // and robot status without taking FMS control of the Driver Station.
  if (VlanInterface && !process.env.DRY_RUN) {
    robotPacketCapture = new RobotPacketCapture(
      VlanInterface,
      () => radioManager.getTeamMappings(),
      update => {
        stationChecks.noteRobotPacket(update.station, update.batteryVoltage);
        broadcastTelemetry(update);
      },
      false, // dryRun
      // Resolve station from VLAN ID for disambiguating duplicate teams
      (vlanId: number) => {
        for (const [station, vid] of Object.entries(vlanMap)) {
          if (vid === vlanId) return station as StationName;
        }
        return undefined;
      },
      (station, count) => stationChecks.noteJoysticks(station, count),
    );
    robotPacketCapture.start();
  }

  // Broadcast the setup checks when they change (at most twice a second —
  // they're for people watching a TV, not for control).
  let latestStationChecks = JSON.stringify(stationChecks.snapshot());
  setInterval(() => {
    const snapshot = stationChecks.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === latestStationChecks) return;
    latestStationChecks = json;
    broadcast(snapshot);
  }, 500);

  wss.on('connection', ws => {
    // Public connections (/ws/scores) only receive score state and the
    // scoreboard's setup checks — all other initial data is private (subnet
    // scans, robot test state, firmware, etc.)
    ws.send(JSON.stringify(scoringEngine.getState()));
    ws.send(latestStationChecks);
    if (publicConnections.has(ws)) return;

    if (latestSubnetScan) ws.send(JSON.stringify(latestSubnetScan));
    for (const results of latestCheckResults.values()) {
      ws.send(JSON.stringify(results));
    }
    if (robotTestMonitor) ws.send(JSON.stringify(robotTestMonitor.getState()));
    if (stationTestManager) {
      for (const state of stationTestManager.getAllStates()) {
        ws.send(JSON.stringify(state));
      }
    }
    ws.send(JSON.stringify({ type: 'firmwareStoreUpdate', entries: firmwareStore.getEntries() }));
  });

  // Auto-save team configs to the saved team store when radio config changes
  radioManager.addConfigChangeListener(() => {
    for (const station of StationNameList) {
      const config = radioManager.getStationConfig(station);
      if (config?.ssid && config?.wpaKey) {
        savedTeamStore.saveTeam(config.ssid, config.wpaKey, config.internetAccess);
      }
    }
  });

  // Clean up state and broadcast updates when station configs change
  radioManager.addConfigChangeListener(() => {
    broadcast(matchEngine.getState());
    for (const station of StationNameList) {
      if (radioManager.getTeamForStation(station) === null) {
        latestCheckResults.delete(station);
        checksAliveSnapshot.delete(station);
        checksInFlight.delete(station);
        checksRetryCount.delete(station);
        checksRanAt.delete(station);
        subnetScanner.clearStation(station);
        // Unbind any physical ports from this station's bridge
        portBridgeManager?.unbridgeAllFromStation(station).catch(err => {
          console.error(`Failed to unbind ports from ${station}:`, err);
        });
      }
    }
    broadcast(subnetScanner.getResults());
    // Clear stale routing preferences then push updated state to all clients
    onRouteConfigChange(s => radioManager.getTeamForStation(s)).then(() => broadcastRouteState());
  });

  // mDNS reflector — bridges .local queries between main network and team VLANs
  let mdnsReflector: MdnsReflector | undefined;
  if (StartMdnsReflector && VlanInterface) {
    mdnsReflector = new MdnsReflector(
      s => radioManager.getTeamForStation(s),
      ip => getPreference(ip),
      VlanHostOctet,
      process.env.MDNS_EXCLUDE_REQUESTERS,
      process.env.MDNS_LISTEN_INTERFACES?.split(/[,\s]+/).filter(Boolean) ?? [],
    );
    mdnsReflector.start();
    // Refresh after commit — VLAN interfaces only exist after configureNetwork completes
    radioManager.addCommitCompleteListener(() => mdnsReflector!.refreshMemberships());
  } else if (StartMdnsReflector) {
    console.log('MDNS_REFLECTOR=true but VLAN_INTERFACE is not set, skipping mDNS reflector');
  }

  // Initialize scheduled configuration clearing
  if (RadioClearSchedule) {
    startConfigurationScheduler(radioManager, RadioClearSchedule, RadioClearTimezone, matchEngine);
  } else {
    console.log('RADIO_CLEAR_SCHEDULE environment variable is not set. Skipping scheduled configuration clearing.');
  }

  if (StartSyslog) {
    runSyslogServer('10.0.100.5').then(syslogServer => {
      if (!syslogServer) return;

      syslogServer.on('message', msg => {
        broadcast(msg);
      });

      // TODO: Load system IP
      radioManager.setSyslogIP('10.0.100.5').catch(err => {
        console.error('Failed to set Syslog IP:', err);
      });
    });
  }

  if (StartFMS) {
    const telemetryManager = new TelemetryManager(
      () => radioManager.getTeamMappings(),
      update => {
        broadcastTelemetry(update);
        // When a robot transitions to disabled, check if we can flush a deferred commit
        // (outside the coalescer — this reacts to the transition itself)
        if (update.dsStatus && !update.dsStatus.enabled) {
          radioManager.retryDeferredCommit();
        }
      },
      // Two robots of one team: the station of the robot this laptop drives.
      (teamNumber, address) =>
        radioManager.isTeamDuplicated(teamNumber) ? driveSessions.stationDrivenBy(address, teamNumber) : undefined,
    );

    // Defer radio configuration while robots are enabled or a match is running
    radioManager.setShouldDefer(() => matchEngine.isMatchActive() || telemetryManager.anyRobotEnabled());
    // The timelapse asks the same question before it touches the lights.
    anyRobotEnabled = () => telemetryManager.anyRobotEnabled();

    // Also retry deferred commits when match state changes (e.g., match ends)
    matchEngine.addStateListener(() => {
      radioManager.retryDeferredCommit();
    });

    /**
     * Compute the gateway (MASQUERADE source) IP on a team's VLAN.
     * Robot sees this as the source of forwarded DS packets, and sends
     * return traffic here — which the DNAT rule rewrites to the real DS IP.
     */
    function teamGatewayIp(team: number): string {
      const high = Math.floor(team / 100);
      const low = team % 100;
      return `10.${high}.${low}.${VlanHostOctet}`;
    }

    /** Check if an IP routes through a team bridge interface. Uses `ip route get`
     *  to ask the kernel — if the route goes via br-slot*, the source is a
     *  robot-network device, not a Driver Station. */
    const teamVlanRouteCache = new Map<string, boolean>();
    async function isTeamSubnetAddress(ip: string): Promise<boolean> {
      const cached = teamVlanRouteCache.get(ip);
      if (cached !== undefined) return cached;
      try {
        const { stdout } = await execFile('ip', ['route', 'get', ip]);
        // e.g. "10.1.15.202 dev br-slot2 src 10.1.15.254 ..."
        const match = stdout.match(/dev\s+(\S+)/);
        const iface = match?.[1] ?? '';
        const isTeamVlan = /^br-slot\d$/.test(iface);
        teamVlanRouteCache.set(ip, isTeamVlan);
        // Expire cache after 60s (team config may change)
        setTimeout(() => teamVlanRouteCache.delete(ip), 60_000);
        return isTeamVlan;
      } catch {
        return false;
      }
    }

    // Which laptop drives which robot — keyed by robot and laptop, never by
    // slot (see src/driveSessions.ts). The slot is looked up here only to
    // build a kernel rule on that slot's bridge.
    const dnatComment = (station: StationName) => `${IPTABLES_COMMENT_PREFIX}dnat-${station}`;
    const blockComment = (station: StationName) => `${IPTABLES_COMMENT_PREFIX}block-dup-ds-${station}`;
    const dnatOptions = (rule: DnatRule) => ({
      table: 'nat' as const,
      chain: 'PREROUTING',
      inInterface: bridgeName(rule.station),
      protocol: 'udp' as const,
      destination: teamGatewayIp(rule.team),
      jump: 'DNAT',
      toDestination: rule.dsIp,
      comment: dnatComment(rule.station),
    });
    const blockOptions = (rule: BlockRule) => ({
      chain: 'FORWARD',
      source: rule.dsIp,
      outInterface: bridgeName(rule.station),
      jump: 'DROP',
      comment: blockComment(rule.station),
    });

    const driveSessions = new DriveSessions({
      robotOn: station => radioManager.getStationConfig(station)?.ssid || null,
      async addDnat(rule) {
        if (!net || !VlanInterface) return;
        await net.iptables({ action: '-A', ...dnatOptions(rule) });
        // Flush any stale conntrack entries for UDP traffic to the gateway IP.
        // Without this, packets that arrived before the DNAT rule was inserted get
        // cached as local-delivery flows, and subsequent packets bypass the nat table entirely.
        const gatewayIp = teamGatewayIp(rule.team);
        try {
          const { stdout } = await execFile('conntrack', ['-D', '-p', 'udp', '-d', gatewayIp]);
          console.log(`conntrack flush: ${stdout.trim()}`);
        } catch (err: unknown) {
          const { code } = err as { code?: number | string };
          if (code === 1) {
            // No entries matched — the race didn't happen this time. Nothing to flush.
          } else if (code === 'ENOENT') {
            console.error('conntrack binary not found — install with: sudo apt install conntrack');
          } else {
            console.error(`conntrack flush failed (code ${code}):`, (err as Error).message);
          }
        }
      },
      async removeDnat(rule, copies) {
        if (!net) return;
        // The backend deletes one matching rule per call.
        for (let i = 0; i < copies; i++) await net.iptables({ action: '-D', ...dnatOptions(rule) });
      },
      async addBlock(rule) {
        if (!net || !VlanInterface) return;
        await net.iptables({ action: '-I', ...blockOptions(rule) });
        startBlockedDsControlLoop();
      },
      async removeBlock(rule) {
        if (!net) return;
        await net.iptables({ action: '-D', ...blockOptions(rule) });
      },
      routeOf: dsIp => getPreference(dsIp),
      setRoute: (dsIp, station, team) => setRoutePreference(dsIp, station, team),
      clearRoute: dsIp => clearRoutePreference(dsIp),
      engineSetDs: (station, dsIp) => matchEngine.setDSAddress(station, dsIp),
      engineClearDs: station => matchEngine.clearDSAddress(station),
      changed: () => {
        broadcastDriveSessionState();
        broadcastRouteState();
      },
      info: appInfo,
      warn: appWarn,
      error: (message, err) => console.error(`${message}:`, err),
      now: Date.now,
    });

    // After a graceful restart the kernel still holds the previous process's
    // rules. Hand them to the drive sessions: DNAT rules that still match the
    // robot on their slot become sessions again (robots stay connected across
    // a reload); everything else is removed.
    if (KeepNetwork) {
      const dnat: DnatRule[] = [];
      const blocks: BlockRule[] = [];
      try {
        const { stdout } = await execFile('iptables', ['-t', 'nat', '-S', 'PREROUTING']);
        for (const line of stdout.split('\n')) {
          const comment = line.match(/--comment\s+"?([^"\s]+)"?/)?.[1];
          if (!comment?.startsWith(`${IPTABLES_COMMENT_PREFIX}dnat-`)) continue;
          const station = comment.slice(`${IPTABLES_COMMENT_PREFIX}dnat-`.length) as StationName;
          const gateway = line.match(/-d\s+10\.(\d+)\.(\d+)\.\d+/);
          const dsIp = line.match(/--to-destination\s+(\S+)/)?.[1];
          if (!StationNameList.includes(station) || !gateway || !dsIp) {
            console.warn(`Failed to parse DNAT rule for restoration: ${line.trim()}`);
            continue;
          }
          dnat.push({ station, team: Number(gateway[1]) * 100 + Number(gateway[2]), dsIp });
        }
      } catch (err) {
        console.warn('Failed to read DNAT rules from kernel:', (err as Error).message);
      }
      try {
        const { stdout } = await execFile('iptables', ['-S', 'FORWARD']);
        for (const line of stdout.split('\n')) {
          const comment = line.match(/--comment\s+"?([^"\s]+)"?/)?.[1];
          if (!comment?.startsWith(`${IPTABLES_COMMENT_PREFIX}block-dup-ds-`)) continue;
          const station = comment.slice(`${IPTABLES_COMMENT_PREFIX}block-dup-ds-`.length) as StationName;
          const dsIp = line.match(/-s\s+([\d.]+)/)?.[1];
          if (StationNameList.includes(station) && dsIp) blocks.push({ station, dsIp });
        }
      } catch (err) {
        console.warn('Failed to read duplicate-DS blocks from kernel:', (err as Error).message);
      }
      driveSessions.restore(dnat, blocks);
      console.log(`Restored ${dnat.length} DNAT rule(s) and ${blocks.length} duplicate-DS block(s) from the kernel`);
    }

    /** Build and broadcast drive session state to all clients. Keyed by
     *  station on the wire, computed fresh from where each robot is now. */
    function broadcastDriveSessionState() {
      const sessions = driveSessions.sessionsByStation();
      const blockedDs = driveSessions.blockedByStation();
      // Resolve device names for every DS the UI is about to show — blocked
      // DSes especially, since "Multiple DSes Detected" should name the laptop.
      for (const session of Object.values(sessions)) hostnameResolver.track(session.dsIp);
      for (const ips of Object.values(blockedDs)) ips.forEach(ip => hostnameResolver.track(ip));
      broadcast({ type: 'driveSessionState', sessions, blockedDs } satisfies DriveSessionState);
    }

    let blockedDsControlTimer: NodeJS.Timeout | null = null;

    /** Send periodic disabled+game data packets to all blocked DSes so they show the warning. */
    function startBlockedDsControlLoop() {
      if (blockedDsControlTimer) return;
      blockedDsControlTimer = setInterval(() => {
        let anyBlocked = false;
        for (const [station, ips] of Object.entries(driveSessions.blockedByStation()) as [StationName, string[]][]) {
          for (const ip of ips) {
            anyBlocked = true;
            matchEngine.sendRawControlPacket(ip, station, [
              { type: 'gameData', data: 'Multiple DSes Detected. Close Others.' },
            ]);
          }
        }
        if (!anyBlocked) {
          clearInterval(blockedDsControlTimer!);
          blockedDsControlTimer = null;
        }
      }, 500);
    }

    // Robots arriving, leaving or moving: sessions follow the robot.
    radioManager.addConfigChangeListener(() => driveSessions.configChanged());

    // Wire up the drive action callback from WebSocket clients
    onDriveAction = (dsIp, station) => driveSessions.drive(dsIp, station);

    const tcpReplyAll = FmsTcpReplyStations.trim() === 'all';
    const tcpReplyOptIn = new Set(
      FmsTcpReplyStations.split(/[,\s]+/).filter((s): s is StationName => StationNameRegex.test(s)),
    );

    runFMS({
      // Station-assignment reply (0x19/0x1f). Joined stations get their slot.
      // A station that isn't in the match gets a status-2 "not in match" reply
      // (makeNotInMatchReply), which hands the DS back to local control so a
      // driver can enable for freeplay without closing and reopening the DS —
      // in use since 2026-09-15 and confirmed working on the field (a day of
      // misreading the admin switch's wording on 2026-09-27 briefly replaced
      // it with silence; see plans/out-of-match-enable-check.md). A station
      // the field holds — policy block, or freeplay switched off by staff —
      // is assigned a slot like a joined station so the DS stays under field
      // control, and the hold loop below keeps it disabled.
      // FMS_TCP_REPLY_STATIONS assigns a real slot for testing.
      resolveTeamSlot: teamNumber => {
        const station = radioManager.getStationForTeam(teamNumber);
        if (!station) return undefined;
        const state = matchEngine.getState();
        const joined = state.stationStates[station]?.joined ?? false;
        if (!joined && !tcpReplyAll && !tcpReplyOptIn.has(station)) {
          // Held: do NOT hand local control back. Assign the station so the DS
          // stays under field control; the hold loop's disabled packets are
          // what actually refuse the enable while the team is out of a match.
          if (outOfMatchHoldReason(station)) return matchEngine.slotForStation(station);
          // Not in a match and not held: release the DS to local control.
          return 'release';
        }
        // Alliance-aware slot so a blue-alliance DS is assigned a blue station
        // (which side of the field it shows), not the physical-port default,
        // even before the match starts and portToSlot is populated.
        return matchEngine.slotForStation(station);
      },
    }).then(fms => {
      if (!fms) return;
      matchEngine.setUdpSocket(fms.udpSocket);

      // Robots the field holds out of a match — a blocked control system, or
      // the admin out-of-match switch turned off — stay under field control:
      // resolveTeamSlot above assigns them (so the DS cannot enable locally)
      // and this keeps a steady stream of disabled packets going, which is
      // what actually refuses the enable while they are out of a match. The
      // packet's game data tells the driver why on the DS itself. In a match,
      // matchEngine's enable gate handles policy blocks; the admin switch
      // never applies to a joined station.
      // A flip in held state (policy change, admin switch) re-handshakes the
      // DS so it picks up the new answer (held vs released) straight away.
      const wasHeld = new Map<StationName, boolean>();
      setInterval(() => {
        const state = matchEngine.getState();
        for (const station of StationNameList) {
          const joined = state.stationStates[station]?.joined ?? false;
          const blocked = policyBlockReason(station) !== null;
          const held = blocked || outOfMatchControlOff();
          const dsIp = driveSessions.laptopOn(station) ?? state.connectedStations[station]?.ip;
          if (held !== (wasHeld.get(station) ?? false)) {
            wasHeld.set(station, held);
            // A joined station's answer is its slot either way — don't bounce
            // its TCP session (possibly mid-match) for nothing.
            if (dsIp && !joined) {
              const why = blocked ? 'control system blocked' : held ? 'freeplay held by staff' : 'freeplay allowed';
              appInfo(`${station}: ${why} — re-handshaking DS ${dsIp}`);
              fms.emit('disconnectDS', { address: dsIp });
            }
          }
          if (held && !joined && dsIp) {
            // What the DS shows in its game data field. The 2027 DS reads at
            // most 8 characters, so it gets a shorter spelling.
            const gameData = blocked
              ? 'Blocked'
              : matchEngine.dsProtocolFor(dsIp) === 'ds2027'
                ? 'AdminOff'
                : 'Admin disabled';
            matchEngine.sendRawControlPacket(dsIp, station, [{ type: 'gameData', data: gameData }]);
          }
        }
      }, 500).unref();

      // Joining a match hands the DS to the FMS: the 0x19 station-assignment
      // reply locks out local enable, and the join heartbeat keeps the robot
      // disabled until the match starts. Leaving reverses it — the next
      // handshake gets no reply and local control returns. But the DS only
      // handshakes when its TCP connection (re)opens, which can be minutes
      // away on a long-lived connection, so force a reconnect the moment a
      // station joins or leaves (also covers kick and post-match release).
      const prevJoined = new Map<StationName, boolean>();
      // Track alliance too: switching red<->blue while staying joined does not
      // change `joined`, but the DS must re-handshake to pick up the new
      // station colour promptly (else the 2027 DS can hold the old field side
      // until its next reconnect).
      const prevAlliance = new Map<StationName, string | null>();
      matchEngine.addStateListener(state => {
        for (const station of StationNameList) {
          const joined = state.stationStates[station]?.joined ?? false;
          const prev = prevJoined.get(station) ?? false;
          const alliance = state.stationStates[station]?.alliance ?? null;
          const prevAll = prevAlliance.get(station) ?? null;
          const joinedChanged = joined !== prev;
          // A colour change on an already-joined station (no join/leave edge).
          const allianceChanged = joined && prev && alliance !== prevAll;
          prevJoined.set(station, joined);
          prevAlliance.set(station, alliance);
          if (!joinedChanged && !allianceChanged) continue;
          const dsIp = driveSessions.laptopOn(station) ?? state.connectedStations[station]?.ip;
          const edge = joinedChanged ? (joined ? 'joined' : 'left') : `changed to ${alliance}`;
          if (dsIp) {
            appInfo(
              joinedChanged
                ? joined
                  ? `${station} joined — handing DS ${dsIp} to FMS control (disabled until match start)`
                  : `${station} left — releasing DS ${dsIp} back to local control`
                : `${station} changed to ${alliance} — re-handshaking DS ${dsIp} so it gets the new field side`,
            );
            fms.emit('disconnectDS', { address: dsIp });
          }
          // The station may have no DS address on record (the team was just
          // moved here, or its drive session was cleared) while the DS still
          // holds a session with an old assignment — so also close by team
          // number. A no-op for the socket disconnectDS just closed.
          const team = state.stationStates[station]?.teamNumber;
          if (team) fms.emit('disconnectTeam', { teamNumber: team, reason: `${station} ${edge}` });
        }
      });

      // A team moved to another station (or released from one) keeps its DS
      // session, and with it the old station's assignment, until the TCP
      // connection drops. Close it so the next handshake resolves against
      // the new config — 4159 sat out match 64 (2026-09-27) on a stale one.
      const stationByTeam = () => {
        const map = new Map<number, StationName>();
        for (const station of StationNameList) {
          const team = radioManager.getTeamForStation(station);
          if (team !== null) map.set(team, station);
        }
        return map;
      };
      let prevStationByTeam = stationByTeam();
      radioManager.addConfigChangeListener(() => {
        const now = stationByTeam();
        for (const [team, was] of prevStationByTeam) {
          const is = now.get(team);
          if (is === was) continue;
          fms.emit('disconnectTeam', {
            teamNumber: team,
            reason: is ? `team moved from ${was} to ${is}` : `team released from ${was}`,
          });
        }
        prevStationByTeam = now;
      });

      fms.on('dsConnected', ({ address }) => driveSessions.heard(address));
      // Sessions survive a TCP drop (the DS flaps every ~6 s out of a match);
      // a blocked laptop that disconnects is unblocked.
      fms.on('dsDisconnected', ({ address }) => driveSessions.disconnected(address));

      // End sessions whose laptop went quiet (DS_STALE_TIMEOUT_MS), re-sync the
      // kernel rules, and keep the UI's timeout countdown fresh. A laptop swap
      // needs no button: close the old DS, and the new one takes over ~20 s later.
      setInterval(() => {
        driveSessions.sweep();
        broadcastDriveSessionState();
      }, 5_000);

      // Track which stations have already had checks triggered this session,
      // so we don't re-run on every DS UDP heartbeat.
      const checksTriggered = new Set<StationName>();
      // Track radio link state per station — trigger checks when a robot links
      const wasLinked = new Map<StationName, boolean>();

      radioManager.addStatusListener(entry => {
        if (!entry.radioUpdate) return;
        for (const station of StationNameList) {
          const details = entry.radioUpdate.stationStatuses[station];
          const linked = details?.isLinked ?? false;
          const prev = wasLinked.get(station) ?? false;
          wasLinked.set(station, linked);
          if (linked && !prev && !checksTriggered.has(station)) {
            const team = radioManager.getTeamForStation(station);
            if (team) {
              checksTriggered.add(station);
              checksRetryCount.delete(station);
              // Small delay — let the robot finish connecting
              setTimeout(() => triggerTeamChecks(station, team), 3000);
            }
          }
        }
      });

      radioManager.addConfigChangeListener(() => {
        for (const station of StationNameList) {
          if (radioManager.getTeamForStation(station) === null) {
            checksTriggered.delete(station);
            wasLinked.delete(station);
          }
        }
      });

      fms.on('message', msg => {
        // Route telemetry to stations via WebSocket
        telemetryManager.processFmsEvent(msg);

        // Respect DS disable/e-stop from UDP heartbeats.
        // The team must always be able to disable their robot.
        if ('BatteryVoltage' in msg.data) {
          const udp = msg.data as import('./fmsServer.js').UdpMessage;
          const station = radioManager.getStationForTeam(udp.teamNumber);
          if (station) {
            matchEngine.dsReportedStatus(
              station,
              udp.status.enabled,
              udp.status.EStop,
              udp.status.AStop,
              udp.rawStatus,
              udp.status.robotComms,
            );
            stationChecks.noteDsStatus(station, udp.status.robotComms, udp.BatteryVoltage);
          }
        }

        // Telemetry-only TCP messages (e.g. 0x16 log data) carry no team
        // number but still prove the DS is alive. Without this, a DS that
        // holds one long TCP connection (0x18 is only sent at connect) gets
        // stale-swept after 20s and the field silently stops sending it
        // match control packets (2026-07-17: 5940's auto never enabled).
        if (!('teamNumber' in msg.data)) driveSessions.heard(msg.address.replace(/^::ffff:/, ''));

        // Auto-discover DS addresses and set up drive sessions.
        // Match on any message carrying teamNumber — TCP 0x18/0x1e and UDP all do.
        if ('teamNumber' in msg.data) {
          const { teamNumber } = msg.data;
          // TCP remoteAddress may be IPv6-mapped (::ffff:10.x.x.x) — normalize to plain IPv4
          const address = msg.address.replace(/^::ffff:/, '');

          // Learn where to send control packets: the 2027 DS (SystemCore) names
          // its own UDP port in every handshake; the legacy NI DS uses 1121.
          if ('type' in msg.data) {
            if (msg.data.type === 0x1e) matchEngine.setDsEndpoint(address, 'ds2027', msg.data.udpPort);
            else if (msg.data.type === 0x18) matchEngine.setDsEndpoint(address, 'legacy', UdpSendPort);
          }

          // Ignore connections from team subnets — these are devices on the robot
          // network (roboRIO, coprocessors), not Driver Stations. A laptop drives
          // its team's robot wherever that robot is; two robots of one team wait
          // for the Drive button.
          isTeamSubnetAddress(address)
            .then(isRobotNetwork => {
              if (!isRobotNetwork) driveSessions.heard(address, teamNumber);
            })
            .catch(err => console.error('DS processing error:', err));
        }
      });

      // Drive sessions persist across DS TCP reconnects (the DS flaps every ~6s
      // when no match is running) and end when the laptop goes quiet or its
      // robot leaves the field.
    });
  }

  // Broadcast iptables forwarding counters and mDNS activity to all clients every 5 seconds
  if (net) {
    let latestNetworkStats: Awaited<ReturnType<typeof buildNetworkStats>> | null = null;
    let latestMdnsActivity: ReturnType<MdnsReflector['getActivity']> | null = null;

    async function refreshNetworkStats() {
      try {
        latestNetworkStats = await buildNetworkStats(net!, IPTABLES_COMMENT_PREFIX);
        broadcast(latestNetworkStats);
      } catch (err) {
        console.error('Error polling network stats:', err);
      }
      if (mdnsReflector) {
        latestMdnsActivity = mdnsReflector.getActivity();
        // mDNS requesters are guest-network hosts — resolve their names too
        for (const activity of Object.values(latestMdnsActivity.stations)) {
          for (const entry of activity.recentNames) {
            if (entry.requester) hostnameResolver.track(entry.requester);
          }
        }
        broadcast(latestMdnsActivity);
      }
    }

    // Send cached stats immediately when a new client connects (not public)
    wss.on('connection', ws => {
      if (publicConnections.has(ws)) return;
      if (latestNetworkStats) ws.send(JSON.stringify(latestNetworkStats));
      if (latestMdnsActivity) ws.send(JSON.stringify(latestMdnsActivity));
    });

    // Fetch immediately so first clients don't wait 5s
    refreshNetworkStats();
    setInterval(refreshNetworkStats, 5000);
  }

  // Shutdown signal handlers
  if (net) {
    const fullCleanup = () => {
      robotTestMonitor?.stop();
      stationTestManager?.stopAll();
      robotPacketCapture?.stop();
      stopAllDHCP();
      console.log('Cleaning up network rules...');
      const flushRouteTables = Promise.all(
        Object.values(vlanMap).map(id => execFile('ip', ['route', 'flush', 'table', String(id)]).catch(() => {})),
      );
      Promise.all([net!.flushRulesByComment(IPTABLES_COMMENT_PREFIX), cleanupAllPreferences(), flushRouteTables]).then(
        () => process.exit(0),
        err => {
          console.error('Error during cleanup:', err);
          process.exit(1);
        },
      );
    };

    // SIGHUP (systemctl reload): exit without touching network state. systemd will
    // write /run/pfms-keep-network before sending SIGHUP, so the next startup skips
    // the iptables flush and restores routing preferences from the kernel.
    const gracefulExit = () => {
      robotTestMonitor?.stop();
      stationTestManager?.stopAll();
      robotPacketCapture?.stop();
      stopAllDHCP();
      console.log('Graceful exit: network rules preserved.');
      process.exit(0);
    };

    process.on('SIGTERM', fullCleanup);
    process.on('SIGINT', fullCleanup);
    process.on('SIGHUP', gracefulExit);
  }

  // After a graceful restart, restore in-memory state from the kernel so it
  // stays in sync with rules that were left in place.
  if (net && KeepNetwork) {
    // Tell networkManager which teams are already configured so future config
    // changes properly tear down old routes and iptables rules.
    restorePreviousStations(s => radioManager.getTeamForStation(s));

    const restored = await restorePreferencesFromKernel();
    if (restored > 0) {
      console.log(`Restored ${restored} route preference(s) from kernel`);
      broadcastRouteState();
    }
  }
})();
