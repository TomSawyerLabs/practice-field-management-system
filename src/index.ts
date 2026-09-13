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
import { MatchEngine } from './matchEngine.js';
import {
  stopAllDHCP,
  vlanMap,
  bridgeName,
  restorePreviousStations,
  cleanupOldVlanInterfaces,
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
import { TeamChecker } from './teamChecker.js';
import { RobotTestMonitor } from './robotTestMonitor.js';
import { RobotPacketCapture } from './robotPacketCapture.js';
import { FirmwareStore } from './firmwareStore.js';
import { handleFirmwareRequest } from './firmwareApi.js';
import { handleTeamAvatarRequest } from './teamAvatarApi.js';
import { ScoringEngine } from './scoringEngine.js';
import { handleScoringRequest } from './scoringApi.js';
import { handleMatchReviewRequest } from './matchReviewApi.js';
import { SavedTeamStore } from './savedTeamStore.js';
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
import { MatchRecorder } from './matchRecorder.js';
import { handleRecordingsRequest } from './recordingsApi.js';
import { handlePublicMatchRequest } from './publicMatchApi.js';
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
} from './types.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { maybeRunCli } from './cli.js';
import { SetupConfigStore } from './setupConfigStore.js';
import { scoringRequiresKey } from './httpApiUtils.js';
import { setVideoProxyTargetResolver } from './videoProxy.js';
import { runSetupProbe } from './setupProbe.js';
import { existsSync, rmSync } from 'node:fs';
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
  const matchEngine = new MatchEngine(s => radioManager.getTeamForStation(s));

  // Initialize match audio (plays FRC field sounds on phase transitions)
  const matchAudio = new MatchAudio();
  await matchAudio.init();
  matchAudio.attachToEngine(matchEngine);

  // Initialize saved team store (server-side WiFi credential persistence)
  const savedTeamStore = new SavedTeamStore();

  // A stream server saved in the setup UI wins over the environment, and is
  // read per-request so it applies without a restart.
  setVideoProxyTargetResolver(() => setupConfigStore.get().settings.videoProxyTarget ?? process.env.VIDEO_PROXY_TARGET);

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

  // Match video recorder. Streams saved in the admin panel win over the
  // environment seed (`MATCH_RECORDING_STREAMS="all-field=rtsp://…,…"`),
  // read per match so a change applies to the next match without a restart.
  const envRecordingStreams = parseRecordingStreamsEnv(process.env.MATCH_RECORDING_STREAMS);
  const matchRecorder = new MatchRecorder({
    getStreams: () => setupConfigStore.get().settings.recordingStreams ?? envRecordingStreams,
    getRetentionDays: () =>
      setupConfigStore.get().settings.recordingRetentionDays ??
      (Number(process.env.MATCH_RECORDING_RETENTION_DAYS) || undefined),
  });

  // Initialize field usage tracker (tracks robot connection hours per team)
  const usageTracker = new UsageTracker();
  usageTracker.attach(radioManager);

  // Initialize support system
  const supportStore = new SupportStore();
  const slackBridge = new SlackBridge();
  // Announce version changes to the support channel (commit subjects since last deploy)
  announceDeploy(text => slackBridge.postToChannel(text)).catch(err => {
    console.warn('Deploy announcement failed:', (err as Error).message);
  });
  const adminAuth = new AdminAuth();
  const externalAccessStore = new ExternalAccessStore();

  // Initialize WebSocket server (callbacks are set below after subsystems are created)
  let onRunTeamChecks: ((station: StationName) => void) | undefined;
  let onDriveAction: ((dsIp: string, station: StationName | null) => void) | undefined;
  let stationTestManager: StationTestManager | undefined;
  // Resolves guest-network device names (DS laptops) so the UI can show them
  // instead of bare IPs. `broadcast` is const-declared below; the callback only
  // fires after async resolutions, well past initialization.
  const hostnameResolver = new HostnameResolver(state => broadcast(state));
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
      (req, res) => handleFirmwareRequest(req, res, firmwareStore),
      handleTeamAvatarRequest,
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
      // Where this field is reachable from the internet, for the post-match
      // QR link. Setup UI value wins over PUBLIC_URL; both optional.
      publicUrl: () => setupConfigStore.get().settings.publicUrl ?? process.env.PUBLIC_URL,
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

  // Starts listening to match phases; verifies ffmpeg first and says so in
  // the log if recording can't work on this host.
  matchRecorder.start(matchEngine, matchHistoryStore).catch(err => {
    console.error('Match recorder failed to start:', err);
  });

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
  const broadcastTelemetry = createTelemetryCoalescer(update => broadcast(update));

  // Passive robot packet capture — sniff robot→DS UDP to extract battery voltage
  // and robot status without taking FMS control of the Driver Station.
  let robotPacketCapture: RobotPacketCapture | undefined;
  if (VlanInterface && !process.env.DRY_RUN) {
    robotPacketCapture = new RobotPacketCapture(
      VlanInterface,
      () => radioManager.getTeamMappings(),
      update => broadcastTelemetry(update),
      false, // dryRun
      // Resolve station from VLAN ID for disambiguating duplicate teams
      (vlanId: number) => {
        for (const [station, vid] of Object.entries(vlanMap)) {
          if (vid === vlanId) return station as StationName;
        }
        return undefined;
      },
    );
    robotPacketCapture.start();
  }

  wss.on('connection', ws => {
    // Public connections (/ws/scores) only receive score state — all other
    // initial data is private (subnet scans, robot test state, firmware, etc.)
    ws.send(JSON.stringify(scoringEngine.getState()));
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
    // Synchronous record of the accepted DS IP per station. Updated immediately
    // in trySetDSAddress (before the async addDnatRule resolves) to close the race
    // window where a second DS could sneak in during the first DS's iptables call.
    const acceptedDsForStation = new Map<StationName, string>();

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
      // Resolve station for duplicate teams using the accepted DS IP map
      (teamNumber, address) => {
        if (!radioManager.isTeamDuplicated(teamNumber)) return undefined;
        for (const [station, dsIp] of acceptedDsForStation) {
          if (dsIp === address && radioManager.getTeamForStation(station) === teamNumber) {
            return station;
          }
        }
        return undefined;
      },
    );

    // Defer radio configuration while robots are enabled or a match is running
    radioManager.setShouldDefer(() => matchEngine.isMatchActive() || telemetryManager.anyRobotEnabled());

    // Also retry deferred commits when match state changes (e.g., match ends)
    matchEngine.addStateListener(() => {
      radioManager.retryDeferredCommit();
    });

    // Track active DNAT rules so we can clean them up when stations are reconfigured.
    // Map: station → { dsIp, gatewayIp, vlanInterface }
    const activeDnatRules = new Map<StationName, { dsIp: string; gatewayIp: string; vlanInterface: string }>();

    // After a graceful restart, restore DNAT rules from the kernel so we can
    // properly clean them up if a DS reconnects with a different IP.
    if (KeepNetwork) {
      try {
        const { stdout } = await execFile('iptables', ['-t', 'nat', '-S', 'PREROUTING']);
        for (const line of stdout.split('\n')) {
          if (!line.includes(`${IPTABLES_COMMENT_PREFIX}dnat-`)) continue;
          const iMatch = line.match(/-i\s+(\S+)/);
          const dMatch = line.match(/-d\s+(\S+)/);
          const commentMatch = line.match(/--comment\s+(\S+)/);
          const toMatch = line.match(/--to-destination\s+(\S+)/);
          if (!iMatch || !dMatch || !commentMatch || !toMatch) {
            console.warn(`Failed to parse DNAT rule for restoration: ${line.trim()}`);
            continue;
          }
          const station = commentMatch[1].replace(`${IPTABLES_COMMENT_PREFIX}dnat-`, '') as StationName;
          if (!StationNameList.includes(station)) continue;
          const gatewayIp = dMatch[1].replace(/\/\d+$/, '');
          activeDnatRules.set(station, { dsIp: toMatch[1], gatewayIp, vlanInterface: iMatch[1] });
          console.log(`Restored DNAT rule: ${station} UDP → ${gatewayIp} rewritten to ${toMatch[1]}`);
        }
      } catch (err) {
        console.warn('Failed to restore DNAT rules from kernel:', (err as Error).message);
      }
    }

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

    // Track last activity (TCP or UDP) timestamp per accepted DS IP.
    // Used to detect stale drive sessions: if a DS hasn't been seen for
    // DS_STALE_TIMEOUT_MS, its drive session is cleared so a replacement
    // DS can auto-connect. This handles laptop swaps without needing a
    // manual "takeover" button.
    const DS_STALE_TIMEOUT_MS = 20_000; // 20 seconds (covers ~3 DS TCP flap cycles)
    const dsLastActivity = new Map<string, number>();

    /** Update the last-activity timestamp for a DS IP. */
    function touchDsActivity(dsIp: string) {
      dsLastActivity.set(dsIp, Date.now());
    }

    /** Check if a DS IP is considered stale (no activity for DS_STALE_TIMEOUT_MS). */
    function isDsStale(dsIp: string): boolean {
      const last = dsLastActivity.get(dsIp);
      if (!last) return true;
      return Date.now() - last > DS_STALE_TIMEOUT_MS;
    }

    /** Build and broadcast drive session state to all clients. */
    function broadcastDriveSessionState() {
      const now = Date.now();
      const sessions: DriveSessionState['sessions'] = {};
      for (const [station, dsIp] of acceptedDsForStation) {
        const lastActivity = dsLastActivity.get(dsIp) ?? now;
        const elapsed = now - lastActivity;
        const timeoutRemaining = Math.max(0, (DS_STALE_TIMEOUT_MS - elapsed) / 1000);
        sessions[station] = { dsIp, lastActivity, timeoutRemaining: Math.round(timeoutRemaining) };
      }
      const blockedDs: DriveSessionState['blockedDs'] = {};
      for (const [station, blocks] of blockedDsRules) {
        if (blocks.size > 0) blockedDs[station] = [...blocks.keys()];
      }
      // Resolve device names for every DS the UI is about to show — blocked
      // DSes especially, since "Multiple DSes Detected" should name the laptop.
      for (const session of Object.values(sessions)) hostnameResolver.track(session.dsIp);
      for (const ips of Object.values(blockedDs)) ips.forEach(ip => hostnameResolver.track(ip));
      broadcast({ type: 'driveSessionState', sessions, blockedDs } satisfies DriveSessionState);
    }

    // Track blocked (duplicate) DS IPs per station. Multiple DSes can be blocked
    // simultaneously (e.g. someone opens 3 Driver Stations). Map: station → ip → vlanInterface
    const blockedDsRules = new Map<StationName, Map<string, string>>();
    let blockedDsControlTimer: NodeJS.Timeout | null = null;

    /** Send periodic disabled+game data packets to all blocked DSes so they show the warning. */
    function startBlockedDsControlLoop() {
      if (blockedDsControlTimer) return;
      blockedDsControlTimer = setInterval(() => {
        let anyBlocked = false;
        for (const [station, blocks] of blockedDsRules) {
          for (const ip of blocks.keys()) {
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

    /** Block a duplicate DS from forwarding packets to the robot's VLAN. */
    async function blockDuplicateDS(station: StationName, dsIp: string) {
      if (!net || !VlanInterface) return;
      let stationBlocks = blockedDsRules.get(station);
      if (stationBlocks?.has(dsIp)) return; // Already blocked
      if (!stationBlocks) {
        stationBlocks = new Map();
        blockedDsRules.set(station, stationBlocks);
      }
      const brName = bridgeName(station);
      await net.iptables({
        action: '-I',
        chain: 'FORWARD',
        source: dsIp,
        outInterface: brName,
        jump: 'DROP',
        comment: `${IPTABLES_COMMENT_PREFIX}block-dup-ds-${station}`,
      });
      stationBlocks.set(dsIp, brName);
      appWarn(`Blocked duplicate DS ${dsIp} from forwarding to ${station} (${brName})`);
      broadcastDriveSessionState();
      startBlockedDsControlLoop();
    }

    /** Remove the FORWARD DROP rule for one blocked DS. */
    async function unblockDS(station: StationName, dsIp: string) {
      if (!net) return;
      const stationBlocks = blockedDsRules.get(station);
      const vlanInterface = stationBlocks?.get(dsIp);
      if (!vlanInterface) return;
      await net.iptables({
        action: '-D',
        chain: 'FORWARD',
        source: dsIp,
        outInterface: vlanInterface,
        jump: 'DROP',
        comment: `${IPTABLES_COMMENT_PREFIX}block-dup-ds-${station}`,
      });
      stationBlocks!.delete(dsIp);
      if (stationBlocks!.size === 0) blockedDsRules.delete(station);
      appInfo(`Unblocked duplicate DS ${dsIp} for ${station}`);
      broadcastDriveSessionState();
    }

    /** Remove all FORWARD DROP rules for a station. */
    async function unblockAllDS(station: StationName) {
      const stationBlocks = blockedDsRules.get(station);
      if (!stationBlocks) return;
      for (const ip of [...stationBlocks.keys()]) {
        await unblockDS(station, ip);
      }
    }

    /**
     * Attempt to set the DS address for a station. Returns true if accepted,
     * false if this DS was blocked as a duplicate.
     */
    function trySetDSAddress(station: StationName, dsIp: string): boolean {
      const accepted = acceptedDsForStation.get(station);
      // Same IP as current — always accept (idempotent)
      if (!accepted || accepted === dsIp) {
        acceptedDsForStation.set(station, dsIp);
        matchEngine.setDSAddress(station, dsIp);
        return true;
      }
      // Different IP — check if the current DS is still active. Liveness is
      // activity-based only: an open TCP socket proves nothing, because a laptop
      // that sleeps or drops off WiFi never sends FIN, and the ghost socket would
      // block takeover forever (2854's laptop swap, 2026-07-12). A live DS always
      // produces activity within seconds (UDP status at 2 Hz, or the ~6s TCP
      // reconnect cycle), so recent activity still prevents takeover during flaps
      // while allowing it when the old DS is truly gone (~20s).
      if (!isDsStale(accepted)) {
        blockDuplicateDS(station, dsIp).catch(err => {
          console.error(`Failed to block duplicate DS for ${station}:`, err);
        });
        return false;
      }
      // Current DS is stale — accept the new one
      appInfo(`DS takeover: ${dsIp} replacing stale DS ${accepted} on ${station}`);
      acceptedDsForStation.set(station, dsIp);
      matchEngine.setDSAddress(station, dsIp);
      return true;
    }

    /**
     * Add a PREROUTING DNAT rule so all UDP from the robot destined for
     * the gateway (MASQUERADE source) gets forwarded to the real DS laptop
     * on the guest network. Scoped to the gateway IP to avoid catching
     * multicast (mDNS) or broadcast (DHCP) traffic.
     */
    async function addDnatRule(station: StationName, dsIp: string) {
      if (!net || !VlanInterface) return;
      const team = radioManager.getTeamForStation(station);
      if (!team) return;
      const brName = bridgeName(station);
      const gatewayIp = teamGatewayIp(team);
      const existing = activeDnatRules.get(station);
      if (existing?.dsIp === dsIp) return; // Already set, idempotent
      // Don't swap DNAT to a different DS while the current one shows recent
      // activity — prevents thrashing when two DSes compete for one station.
      // Activity-based, not TCP-based: ghost sockets from vanished laptops
      // must not pin the DNAT to a dead DS.
      if (existing && !isDsStale(existing.dsIp)) return;
      if (existing) await removeDnatRule(station); // Current DS gone stale, swap to new one
      await net.iptables({
        action: '-A',
        table: 'nat',
        chain: 'PREROUTING',
        inInterface: brName,
        protocol: 'udp',
        destination: gatewayIp,
        jump: 'DNAT',
        toDestination: dsIp,
        comment: `${IPTABLES_COMMENT_PREFIX}dnat-${station}`,
      });
      activeDnatRules.set(station, { dsIp, gatewayIp, vlanInterface: brName });
      appInfo(`DNAT rule added: ${station} UDP → ${gatewayIp} rewritten to ${dsIp}`);
      // Flush any stale conntrack entries for UDP traffic to the gateway IP.
      // Without this, packets that arrived before the DNAT rule was inserted get
      // cached as local-delivery flows, and subsequent packets bypass the nat table entirely.
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
    }

    async function removeDnatRule(station: StationName) {
      if (!net) return;
      const existing = activeDnatRules.get(station);
      if (!existing) return;
      await net.iptables({
        action: '-D',
        table: 'nat',
        chain: 'PREROUTING',
        inInterface: existing.vlanInterface,
        protocol: 'udp',
        destination: existing.gatewayIp,
        jump: 'DNAT',
        toDestination: existing.dsIp,
        comment: `${IPTABLES_COMMENT_PREFIX}dnat-${station}`,
      });
      activeDnatRules.delete(station);
      appInfo(`DNAT rule removed: ${station}`);
    }

    // Clean up DNAT, route preferences, and blocked DS rules when stations are deconfigured or team changes
    radioManager.addConfigChangeListener(() => {
      for (const [station, existing] of [...activeDnatRules]) {
        const team = radioManager.getTeamForStation(station);
        if (team === null || teamGatewayIp(team) !== existing.gatewayIp) {
          // Clear route preference for the DS that was driving this station
          clearRoutePreference(existing.dsIp).catch(err => {
            console.error(`Failed to clear route preference for ${existing.dsIp}:`, err);
          });
          removeDnatRule(station).catch(err => {
            console.error(`Failed to remove DNAT rule for ${station}:`, err);
          });
          unblockAllDS(station).catch(err => {
            console.error(`Failed to unblock DSes for ${station}:`, err);
          });
          acceptedDsForStation.delete(station);
          matchEngine.clearDSAddress(station);
        }
      }
    });

    /**
     * Unified "drive" action: sets up both the forward path (ip rule) and
     * reverse path (DNAT) so a DS laptop can communicate bidirectionally
     * with a specific station's robot. Also registers the DS with the match engine.
     */
    async function startDrive(dsIp: string, station: StationName, team: number) {
      if (!trySetDSAddress(station, dsIp)) return; // Blocked as duplicate

      // Forward path: ip rule so DS→robot traffic uses the correct VLAN routing table
      await setRoutePreference(dsIp, station, team);

      // Reverse path: DNAT so robot→gateway UDP gets rewritten to the DS's guest WiFi IP
      await addDnatRule(station, dsIp);

      appInfo(`Drive started: ${dsIp} → ${station} (team ${team})`);
      broadcastRouteState();
    }

    /**
     * Stop driving: tear down both the forward path (ip rule) and reverse path (DNAT)
     * for whichever station this DS was driving.
     */
    async function stopDrive(dsIp: string) {
      // Find the station this DS was driving (by DNAT rule)
      for (const [station, rule] of activeDnatRules) {
        if (rule.dsIp === dsIp) {
          await clearRoutePreference(dsIp);
          await removeDnatRule(station);
          acceptedDsForStation.delete(station);
          matchEngine.clearDSAddress(station);
          appInfo(`Drive stopped: ${dsIp} (was on ${station})`);
          broadcastRouteState();
          return;
        }
      }
      // Not driving via DNAT — still clear any route preference
      await clearRoutePreference(dsIp);
      broadcastRouteState();
    }

    // Wire up the drive action callback from WebSocket clients
    onDriveAction = (dsIp, station) => {
      if (station === null) {
        stopDrive(dsIp).catch(err => {
          console.error('Failed to stop drive:', err);
        });
      } else {
        const team = radioManager.getTeamForStation(station);
        if (!team) return;
        // If already driving a different station, stop the old one first
        for (const [oldStation, rule] of activeDnatRules) {
          if (rule.dsIp === dsIp && oldStation !== station) {
            stopDrive(dsIp)
              .then(() => startDrive(dsIp, station, team))
              .catch(err => console.error('Failed to switch drive:', err));
            return;
          }
        }
        startDrive(dsIp, station, team).catch(err => {
          console.error('Failed to start drive:', err);
        });
      }
    };

    const tcpReplyAll = FmsTcpReplyStations.trim() === 'all';
    const tcpReplyOptIn = new Set(
      FmsTcpReplyStations.split(/[,\s]+/).filter((s): s is StationName => StationNameRegex.test(s)),
    );

    runFMS({
      // Station-assignment reply (0x19): only for stations that joined a match,
      // where FMS control is already asserted via UDP. Freeplay DSes must get no
      // reply — answering would lock out their local enable — unless explicitly
      // opted in via FMS_TCP_REPLY_STATIONS to test that lockout hypothesis.
      resolveTeamSlot: teamNumber => {
        const station = radioManager.getStationForTeam(teamNumber);
        if (!station) return undefined;
        const state = matchEngine.getState();
        const joined = state.stationStates[station]?.joined ?? false;
        if (!joined && !tcpReplyAll && !tcpReplyOptIn.has(station)) return undefined;
        // Alliance-aware slot so a blue-alliance DS is assigned a blue station
        // (which side of the field it shows), not the physical-port default,
        // even before the match starts and portToSlot is populated.
        return matchEngine.slotForStation(station);
      },
    }).then(fms => {
      if (!fms) return;
      matchEngine.setUdpSocket(fms.udpSocket);

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
          const dsIp = acceptedDsForStation.get(station) ?? state.connectedStations[station]?.ip;
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
        }
      });

      fms.on('dsConnected', ({ address }) => {
        touchDsActivity(address);
      });
      fms.on('dsDisconnected', ({ address }) => {
        // Drive sessions (DNAT, route preference, accepted DS) are NOT cleaned up
        // on disconnect — DS TCP flaps every ~6s. Instead, the periodic stale
        // session cleanup below handles old DSes that are truly gone.

        // Clean up blocked DS FORWARD DROP rules when a blocked DS disconnects
        for (const [station, stationBlocks] of [...blockedDsRules]) {
          if (stationBlocks.has(address)) {
            unblockDS(station, address).catch(err => {
              console.error(`Failed to unblock DS ${address} for ${station}:`, err);
            });
          }
        }
      });

      // Periodically clean up stale drive sessions and broadcast session state.
      // A drive session is stale when the accepted DS has had no TCP/UDP activity
      // for DS_STALE_TIMEOUT_MS (~20s). This handles laptop swaps: close the old
      // DS, wait ~20s, open the new one — it auto-connects.
      // The 5s interval also keeps the timeout countdown in the UI fresh.
      setInterval(() => {
        for (const [station, dsIp] of [...acceptedDsForStation]) {
          if (isDsStale(dsIp)) {
            appInfo(
              `Clearing stale drive session: ${dsIp} on ${station} (no activity for ${DS_STALE_TIMEOUT_MS / 1000}s)`,
            );
            // Clean up the drive session so a new DS can take over
            removeDnatRule(station).catch(err => console.error(`Failed to remove stale DNAT for ${station}:`, err));
            clearRoutePreference(dsIp).catch(err =>
              console.error(`Failed to clear stale route preference for ${dsIp}:`, err),
            );
            unblockAllDS(station).catch(err => console.error(`Failed to unblock DSes for ${station}:`, err));
            acceptedDsForStation.delete(station);
            matchEngine.clearDSAddress(station);
            dsLastActivity.delete(dsIp);
            broadcastRouteState();
          }
        }
        // Broadcast drive session state so the UI can show DS IPs and timeout countdowns
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
          }
        }

        // Telemetry-only TCP messages (e.g. 0x16 log data) carry no team
        // number but still prove the DS is alive. Without this, a DS that
        // holds one long TCP connection (0x18 is only sent at connect) gets
        // stale-swept after 20s and the field silently stops sending it
        // match control packets (2026-07-17: 5940's auto never enabled).
        if (!('teamNumber' in msg.data)) {
          const address = msg.address.replace(/^::ffff:/, '');
          for (const [station, rule] of activeDnatRules) {
            if (rule.dsIp === address) {
              touchDsActivity(address);
              trySetDSAddress(station, address);
              break;
            }
          }
        }

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

          // Track activity for staleness detection
          touchDsActivity(address);

          // Ignore connections from team subnets — these are devices on the robot
          // network (roboRIO, coprocessors), not Driver Stations.
          isTeamSubnetAddress(address)
            .then(isRobotNetwork => {
              if (isRobotNetwork) return;

              // If this DS is already driving a station for this team, just refresh.
              for (const [station, rule] of activeDnatRules) {
                if (rule.dsIp === address && radioManager.getTeamForStation(station) === teamNumber) {
                  // Already driving — refresh match engine liveness
                  trySetDSAddress(station, address);
                  return;
                }
              }

              if (radioManager.isTeamDuplicated(teamNumber)) {
                // Same team on multiple stations — do NOT auto-assign. The DS must
                // explicitly pick which robot to drive via the "Drive" button in the UI.
                // No DNAT, no route preference — just let the FMS track the connection.
                return;
              }

              // Common case: unique team on one station — auto-drive (full setup).
              // If another DS already has a drive session, startDrive → trySetDSAddress
              // will handle the staleness check and either block or allow takeover.
              const station = radioManager.getStationForTeam(teamNumber);
              if (station) {
                startDrive(address, station, teamNumber).catch(err => {
                  console.error('Auto-drive failed:', err);
                });
              }
            })
            .catch(err => console.error('DS processing error:', err));
        }
      });

      // DNAT rules persist across DS TCP reconnects (the DS flaps every ~6s
      // when no match is running). Rules are cleaned up by the config change
      // listener above when a station loses its team assignment.
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
