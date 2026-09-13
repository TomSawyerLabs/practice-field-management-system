// Type-only import — shiftState imports types back, but both are erased at runtime
import type { MatchSubPeriod } from './shiftState.js';

export interface StationDetails {
  ssid: string;
  hashedWpaKey: string;
  wpaKeySalt: string;
  isLinked: boolean;
  macAddress: MacAddress | '';
  dataAgeMs: number;
  signalDbm: number;
  noiseDbm: number;
  signalNoiseRatio: number;
  rxRateMbps: number;
  rxPackets: number;
  rxBytes: number;
  txRateMbps: number;
  txPackets: number;
  txBytes: number;
  bandwidthUsedMbps: number;
  connectionQuality: ConnectionQuality | '';
}

export type RadioChannel =
  | 5
  | 13
  | 21
  | 29
  | 37
  | 45
  | 53
  | 61
  | 69
  | 77
  | 85
  | 93
  | 101
  | 109
  | 117
  | 125
  | 133
  | 141
  | 149
  | 157
  | 165
  | 173
  | 181
  | 189
  | 197
  | 205
  | 213
  | 221
  | 229;
export type Alliance = 'red' | 'blue';

// ── Station identity (physical slot, decoupled from radio naming) ───
export type SlotNumber = 1 | 2 | 3 | 4 | 5 | 6;
export type StationName = `slot${SlotNumber}`;
export const StationNameList = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6'] as const;
export const StationNameRegex = /^slot[1-6]$/;

// ── Radio-native naming (VH-113 firmware uses red1-blue3) ───────────
export type StationNumber = 1 | 2 | 3;
export type RadioStationName = `${Alliance}${StationNumber}`;
export const RadioStationNameList = ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'] as const;

/** Default mapping from internal slot names to radio station names. */
export const defaultSlotToRadio: Record<StationName, RadioStationName> = {
  slot1: 'red1',
  slot2: 'red2',
  slot3: 'red3',
  slot4: 'blue1',
  slot5: 'blue2',
  slot6: 'blue3',
};

/** Inverse mapping from radio station names to internal slot names. */
export const defaultRadioToSlot: Record<RadioStationName, StationName> = Object.fromEntries(
  Object.entries(defaultSlotToRadio).map(([slot, radio]) => [radio, slot]),
) as Record<RadioStationName, StationName>;
export type Status = 'BOOTING' | 'CONFIGURING' | 'ACTIVE' | 'ERROR';
export type VLAN = '10_20_30' | '40_50_60' | '70_80_90';
export type ConnectionQuality = 'excellent' | 'good' | 'caution' | 'warning';

export function isConnectionQuality(quality: unknown): quality is ConnectionQuality {
  if (typeof quality !== 'string') return false;
  return ['excellent', 'good', 'caution', 'warning'].includes(quality);
}

type HexDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
type HexByte = `${HexDigit}${HexDigit}`;
export type MacAddress = string; // `${HexByte}:${HexByte}:${HexByte}:${HexByte}:${HexByte}:${HexByte}`;
export function isMacAddress(mac: unknown): mac is MacAddress {
  if (typeof mac !== 'string') return false;
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac);
}

export function isVLAN(vlan: unknown): vlan is VLAN {
  if (typeof vlan !== 'string') return false;
  return ['10_20_30', '40_50_60', '70_80_90'].includes(vlan);
}

export function isStationDetails(details: unknown): details is StationDetails {
  if (!details) return false;
  if (typeof details !== 'object') return false;

  const {
    ssid,
    hashedWpaKey,
    wpaKeySalt,
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
  } = details as StationDetails;

  if (typeof ssid !== 'string') return false;
  if (typeof hashedWpaKey !== 'string') return false;
  if (typeof wpaKeySalt !== 'string') return false;
  if (typeof isLinked !== 'boolean') return false;
  if (typeof dataAgeMs !== 'number') return false;
  if (typeof signalDbm !== 'number') return false;
  if (typeof noiseDbm !== 'number') return false;
  if (typeof signalNoiseRatio !== 'number') return false;
  if (typeof rxRateMbps !== 'number') return false;
  if (typeof rxPackets !== 'number') return false;
  if (typeof rxBytes !== 'number') return false;
  if (typeof txRateMbps !== 'number') return false;
  if (typeof txPackets !== 'number') return false;
  if (typeof txBytes !== 'number') return false;
  if (typeof bandwidthUsedMbps !== 'number') return false;

  if (!ssid) return false;
  if (!hashedWpaKey) return false;
  if (!wpaKeySalt) return false;

  if (macAddress !== '' && !isMacAddress(macAddress)) return false;

  if (connectionQuality !== '' && !isConnectionQuality(connectionQuality)) return false;

  return true;
}

/** Validate a raw radio response (station keys are radio-native red1-blue3). */
export function isValidRawRadioUpdate(update: unknown): update is RawRadioUpdate {
  if (typeof update !== 'object') return false;
  if (!update) return false;

  const { channel, channelBandwidth, redVlans, blueVlans, status, stationStatuses, syslogIpAddress, version } =
    update as RawRadioUpdate;

  if (!isStatus(status)) return false;

  if (status !== 'BOOTING') {
    if (!isRadioChannel(channel)) return false;
    if (!isChannelBandwidth(channelBandwidth)) return false;
    if (!isSyslogIpAddress(syslogIpAddress)) return false;
  }

  if (!isVLAN(redVlans)) return false;
  if (!isVLAN(blueVlans)) return false;
  if (!isRawStationStatuses(stationStatuses)) return false;
  if (!isVersion(version)) return false;

  return true;
}

/** Translate a validated raw radio update to our internal slot-keyed format. */
export function translateRadioUpdate(raw: RawRadioUpdate): RadioUpdate {
  const stationStatuses = {} as Record<StationName, StationDetails | null>;
  for (const radioName of RadioStationNameList) {
    const slotName = defaultRadioToSlot[radioName];
    stationStatuses[slotName] = raw.stationStatuses[radioName];
  }
  return { ...raw, stationStatuses };
}

/** @deprecated Use isValidRawRadioUpdate + translateRadioUpdate instead. */
export function isValidRadioUpdate(update: unknown): update is RadioUpdate {
  return isValidRawRadioUpdate(update);
}

// ── Setup wizard probe ──────────────────────────────────────────────

/** Ordered setup stages — each one only makes sense once the prior one passes.
 *  The first five bring the field up; the rest walk through the features that
 *  sit on top of it. */
export const SetupStepOrder = [
  'host',
  'interfaces',
  'fieldControl',
  'radio',
  'teamVlans',
  'audio',
  'scoreboard',
  'deployment',
] as const;

export type SetupStepId = (typeof SetupStepOrder)[number];

/** Per-step wizard progress, so setup can be abandoned and resumed. */
export interface SetupStepProgress {
  status: 'pending' | 'done' | 'skipped';
  at?: number;
}

/** How the operator wants pFMS to keep running across reboots. */
export type DeploymentMode = 'systemd' | 'docker';

/** Settings the wizard persists. Each one overrides its env-var equivalent. */
export interface SetupSettings {
  /** Chosen way to run pFMS permanently — drives which walkthrough is shown. */
  deploymentMode?: DeploymentMode;
  vlanInterface?: string;
  radioUrl?: string;
  fmsAddress?: string;
  /** Base URL of a WHEP server for the scoreboard's video view. */
  videoProxyTarget?: string;
  /** Operator confirmed casting works on a real TV. */
  castVerified?: boolean;
  /** Operator confirmed they heard the test sound on the field speaker. */
  audioVerified?: boolean;
}

export interface SetupConfig {
  version: 1;
  steps: Partial<Record<SetupStepId, SetupStepProgress>>;
  settings: SetupSettings;
  /** Set once every step is done or skipped; cleared if a step re-opens. */
  completedAt?: number;
}

export type SetupCheckStatus = 'pass' | 'warn' | 'fail';

/** One observation about the host, with the command that would fix it. */
export interface SetupCheck {
  id: string;
  label: string;
  status: SetupCheckStatus;
  detail: string;
  /** Exact command or action that resolves a warn/fail, shown verbatim in the UI. */
  fix?: string;
}

export interface SetupStep {
  id: SetupStepId;
  label: string;
  blurb: string;
  status: SetupCheckStatus;
  checks: SetupCheck[];
}

/** Broadcast to clients watching the setup wizard. Purely observational. */
export interface SetupProbeState {
  type: 'setupProbeState';
  checkedAt: number;
  vlanInterface?: string;
  radioUrl: string;
  dryRun: boolean;
  steps: SetupStep[];
}

export function isSetupProbeState(msg: unknown): msg is SetupProbeState {
  return (msg as SetupProbeState)?.type === 'setupProbeState';
}

/** Client asks for an immediate re-probe, and registers as a live watcher so
 *  the server keeps re-probing while the setup page is open. */
export interface RequestSetupProbe {
  type: 'requestSetupProbe';
}

export function isRequestSetupProbe(msg: unknown): msg is RequestSetupProbe {
  return (msg as RequestSetupProbe)?.type === 'requestSetupProbe';
}

/** Current persisted wizard state, pushed on connect and after every change. */
export interface SetupConfigState {
  type: 'setupConfigState';
  config: SetupConfig;
  /** First step that is neither done nor skipped; null once setup is finished. */
  nextStep: SetupStepId | null;
}

export function isSetupConfigState(msg: unknown): msg is SetupConfigState {
  return (msg as SetupConfigState)?.type === 'setupConfigState';
}

/** Persist one or more wizard settings. These override their env equivalents. */
export interface UpdateSetupSettings {
  type: 'updateSetupSettings';
  settings: Partial<SetupSettings>;
}

/**
 * URLs the setup UI is allowed to point pFMS at.
 *
 * `radioUrl` becomes the address the radio manager POSTs station configs to —
 * and those payloads contain every team's plaintext WPA key. An attacker who
 * could set it to a host they control would be handed the field's
 * credentials, so the wizard only accepts private/loopback literals. Hostnames
 * are refused outright: DNS can point anywhere, and a field radio is always at
 * a fixed private address.
 *
 * Values supplied through the environment are NOT filtered by this — those
 * come from whoever runs the process, not from the network.
 */
export function isPrivateHostUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (v4.slice(1).some(part => Number(part) > 255)) return false;
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  // IPv6 loopback, unique-local (fc00::/7), link-local (fe80::/10)
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  return false;
}

/** Per-key validation. Unknown keys are rejected rather than merged blindly. */
const SETUP_SETTING_VALIDATORS: Record<keyof SetupSettings, (v: unknown) => boolean> = {
  vlanInterface: v => typeof v === 'string' && /^[a-zA-Z0-9._-]{1,32}$/.test(v),
  radioUrl: v => typeof v === 'string' && isPrivateHostUrl(v),
  fmsAddress: v => typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v),
  videoProxyTarget: v => typeof v === 'string' && isPrivateHostUrl(v),
  castVerified: v => typeof v === 'boolean',
  audioVerified: v => typeof v === 'boolean',
  deploymentMode: v => v === 'systemd' || v === 'docker',
};

export function isUpdateSetupSettings(msg: unknown): msg is UpdateSetupSettings {
  const m = msg as UpdateSetupSettings;
  if (m?.type !== 'updateSetupSettings') return false;
  if (typeof m.settings !== 'object' || m.settings === null) return false;

  for (const [key, value] of Object.entries(m.settings)) {
    const validate = SETUP_SETTING_VALIDATORS[key as keyof SetupSettings];
    // Unknown key, or a value that fails its check — reject the whole message
    // rather than silently applying the parts that happen to be valid.
    if (!validate) return false;
    if (value !== undefined && !validate(value)) return false;
  }

  return true;
}

/** Mark a wizard step done, skipped, or re-opened. */
export interface MarkSetupStep {
  type: 'markSetupStep';
  step: SetupStepId;
  status: SetupStepProgress['status'];
}

export function isMarkSetupStep(msg: unknown): msg is MarkSetupStep {
  const m = msg as MarkSetupStep;
  return (
    m?.type === 'markSetupStep' &&
    (SetupStepOrder as readonly string[]).includes(m.step) &&
    ['pending', 'done', 'skipped'].includes(m.status)
  );
}

function isRadioChannel(channel: unknown): channel is RadioChannel {
  return [
    // TODO: DRY
    5, 13, 21, 29, 37, 45, 53, 61, 69, 77, 85, 93, 101, 109, 117, 125, 133, 141, 149, 157, 165, 173, 181, 189, 197, 205,
    213, 221, 229,
  ].includes(channel as number);
}

function isChannelBandwidth(bandwidth: unknown): bandwidth is `${number}MHz` {
  if (typeof bandwidth !== 'string') return false;
  return /^[1-9][0-9]*MHz$/.test(bandwidth);
}

function isStatus(status: unknown): status is Status {
  return ['BOOTING', 'CONFIGURING', 'ACTIVE', 'ERROR'].includes(status as string);
}

function arrayCompare<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Validate station statuses keyed by the radio's native names (red1-blue3). */
function isRawStationStatuses(
  stationStatuses: unknown,
): stationStatuses is Record<RadioStationName, StationDetails | null> {
  if (typeof stationStatuses !== 'object') return false;
  if (!stationStatuses) return false;

  if (!arrayCompare(Object.keys(stationStatuses).sort(), [...RadioStationNameList].sort())) return false;

  const statuses = stationStatuses as Record<string, StationDetails | null>;

  for (const stationId in statuses) {
    const station = statuses[stationId];
    if (station === null) continue;
    if (!isStationDetails(station)) {
      return false;
    }
  }

  return true;
}

function isSyslogIpAddress(syslogIpAddress: unknown): syslogIpAddress is string {
  if (typeof syslogIpAddress !== 'string') return false;
  return isIpAddress(syslogIpAddress);
}

function isIpAddress(ipAddress: string): ipAddress is string {
  if (typeof ipAddress !== 'string') return false;
  return /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(ipAddress);
}

function isVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  return true;
}

/** Radio update with station statuses keyed by our internal slot names (slot1-slot6). */
export interface RadioUpdate {
  channel: number;
  channelBandwidth: `${number}MHz`;
  redVlans: VLAN;
  blueVlans: VLAN;
  status: Status;
  stationStatuses: Record<StationName, StationDetails | null>;
  syslogIpAddress: string;
  version: string;
}

/** Raw radio response — station statuses keyed by the radio's native names (red1-blue3).
 *  Used for validation before translation to internal slot names. */
export interface RawRadioUpdate {
  channel: number;
  channelBandwidth: `${number}MHz`;
  redVlans: VLAN;
  blueVlans: VLAN;
  status: Status;
  stationStatuses: Record<RadioStationName, StationDetails | null>;
  syslogIpAddress: string;
  version: string;
}

export interface StatusEntry {
  timestamp: number;
  radioUpdate?: RadioUpdate;
}

export type SmallChannels =
  | 1
  | 9
  | 17
  | 25
  | 33
  | 41
  | 49
  | 57
  | 65
  | 73
  | 81
  | 89
  | 97
  | 105
  | 113
  | 121
  | 129
  | 137
  | 145
  | 153
  | 161
  | 169
  | 177
  | 185
  | 193
  | 201
  | 209
  | 217
  | 225
  | 233;

export type AllChannels = RadioChannel | SmallChannels;

export type ScanResults = LoadingScanResults | ReadyScanResults;

export interface LoadingScanResults {
  progressDots: number; // Number of dots received so far
}

export interface ReadyScanResults {
  channels: ChannelScanDetails[];
  additionalStatistics: AdditionalChannelStatistic[];
}

export type ChannelScanDetails = {
  channel: AllChannels; // Channel number
  channelFrequency: number; // Channel frequency in MHz
  bss: number; // Number of BSS
  minRssi: number; // Minimum RSSI
  maxRssi: number; // Maximum RSSI
  nf: number; // Noise Floor. Run-time average NF_dBr
  channelLoad: number; // Channel Load
  spectralLoad: number; // Spectral Load
  secondaryChannel: number; // Secondary Channel
  spatialReuseBss: number; // Spatial Reuse BSS
  spatialReuseLoad: number; // Spatial Reuse Load
  channelAvailability: number; // Channel Availability
  channelEfficiency: number; // Channel Efficiency
  nearBss: number; // Near BSS
  mediumBss: number; // Medium BSS
  farBss: number; // Far BSS
  effectiveBss: number; // Effective BSS
  grade: number; // Grade
  rank: number; // Rank
  unused: string[]; // "Unused" field
  radar: number; // Radar detection
};

export type AdditionalChannelStatistic = {
  index: number; // Index of the statistic
  channel: AllChannels; // Channel number
  nbss: number; // Number of BSS
  ssid: string; // SSID
  bssid: string; // BSSID
  rssi: number; // RSSI
  phyMode: number; // PHY Mode
};

export function isLoadingScanResults(results: ScanResults): results is LoadingScanResults {
  return 'progressDots' in results;
}

export function isReadyScanResults(results: ScanResults): results is ReadyScanResults {
  return !('progressDots' in results);
}

export function isStationUpdate(update: unknown): update is StationUpdate {
  if (typeof update !== 'object') return false;
  if (!update) return false;

  const { type, station, ssid, wpaKey, stage } = update as StationUpdate;

  if (type !== 'station') return false;
  if (!StationNameRegex.test(station)) return false;
  if (typeof ssid !== 'string') return false;
  if (typeof wpaKey !== 'string') return false;
  if (typeof stage !== 'undefined' && typeof stage !== 'boolean') return false;

  return true;
}

export type StationUpdate = {
  type: 'station';
  station: StationName;
  ssid: string;
  wpaKey: string;
  stage?: boolean;
  internetAccess?: boolean;
};

export type InternetToggle = {
  type: 'internetToggle';
  station: StationName;
  enabled: boolean;
};

export function isInternetToggle(msg: unknown): msg is InternetToggle {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;

  const { type, station, enabled } = msg as InternetToggle;

  if (type !== 'internetToggle') return false;
  if (!StationNameRegex.test(station)) return false;
  if (typeof enabled !== 'boolean') return false;

  return true;
}

// ── Admin / Match Engine Types ──────────────────────────────────────

export type Mode = 'teleOp' | 'test' | 'auto';

export type MatchPhase =
  | 'idle'
  | 'created'
  | 'countdown'
  | 'auto'
  | 'autoPause'
  | 'paused'
  | 'teleop'
  | 'endgame'
  | 'postMatch';

export type AutoWinnerMode = 'red' | 'blue' | 'scores' | 'pause';

export type MatchConfig = {
  autoDuration: number;
  teleopDuration: number;
  endgameDuration: number;
  pauseDuration: number;
  skipAuto?: boolean;
  autoWinner?: AutoWinnerMode;
};

/** A position within a match: alliance + slot number. Semantically distinct from StationName
 *  (which identifies a physical radio slot). A physical station "slot6" could be mapped to
 *  match slot "red1" if the team joined the red alliance. */
export type MatchSlot = `${Alliance}${StationNumber}`;

export type StationControlState = {
  teamNumber: number | null;
  enabled: boolean;
  eStop: boolean;
  /** A-Stop: robot stopped for the remainder of the autonomous period, auto-released at teleop */
  aStop: boolean;
  mode: Mode;
  joined: boolean;
  ready: boolean;
  /** Which alliance this station joined for the match (null = not joined) */
  alliance: Alliance | null;
  /** Assigned match slot during an active match (null when idle) */
  matchSlot: MatchSlot | null;
  /** True when the DS is attached to the FMS (UDP status heartbeats flowing).
   *  Ready is gated on this — a DS that isn't heartbeating won't obey match
   *  control, so letting it ready up would start a match against a dead link. */
  dsAttached?: boolean;
  /** Who latched the current disable, when it wasn't ordinary phase control:
   *  the team's DS (Enter key), the team's own station console, or field
   *  staff. Teams may re-enable themselves after a 'ds' or 'self' disable
   *  (stationSelfUndisable); an 'admin' disable only clears from the admin
   *  console. Null when enabled or when disabled by phase control. */
  disabledBy: 'ds' | 'self' | 'admin' | null;
};

export type MatchEndReason = 'normal' | 'stopped' | 'estop' | 'abandoned';

/** Non-team field staff who ready up digitally alongside the driver stations
 *  before a match starts. A fixed, easily-edited set — add a role here and it
 *  flows through the engine, the /staff pages, and the host ready panel. */
export type StaffRole = 'headRef' | 'scorekeeper' | 'safety';
export const StaffRoleList: StaffRole[] = ['headRef', 'scorekeeper', 'safety'];
export function isStaffRole(v: unknown): v is StaffRole {
  return typeof v === 'string' && (StaffRoleList as string[]).includes(v);
}
/** Human labels for staff roles (shown in the host panel and staff pages). */
export const StaffRoleLabels: Record<StaffRole, string> = {
  headRef: 'Head Referee',
  scorekeeper: 'Scorekeeper',
  safety: 'Safety Monitor',
};

export type StaffRoleState = {
  /** This role has readied up for the current match. */
  ready: boolean;
  /** The match starter has marked this role not required for this match. */
  ignored: boolean;
  /** Someone is currently on this role's page (recent heartbeat). */
  connected: boolean;
};

export type DSConnectionInfo = {
  ip: string;
  /** Server timestamp (Date.now()) of the last packet received from this DS */
  lastSeen: number;
  /** Driver Station generation: legacy NI DS (roboRIO) or the 2027 FIRST
   *  Driver Station (SystemCore), learned from its FMS handshake. */
  protocol?: 'legacy' | 'ds2027';
  /** If set, these DS IPs are trying to connect and are being blocked */
  blockedDsIps?: string[];
};

/** Broadcast state for active drive sessions (DS → station DNAT mappings). */
export interface DriveSessionState {
  type: 'driveSessionState';
  /** Active drive sessions: station → accepted DS IP and last activity. */
  sessions: Partial<
    Record<
      StationName,
      {
        dsIp: string;
        /** Epoch ms of the last FMS message from this DS. */
        lastActivity: number;
        /** Seconds until this session is considered stale and cleared. */
        timeoutRemaining: number;
      }
    >
  >;
  /** Blocked (duplicate) DS IPs per station. */
  blockedDs: Partial<Record<StationName, string[]>>;
}

export function isDriveSessionState(msg: unknown): msg is DriveSessionState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as DriveSessionState).type === 'driveSessionState';
}

export type MatchState = {
  type: 'matchState';
  phase: MatchPhase;
  /** Unique id for this match, assigned when the match starts (countdown).
   *  Links external systems (video recording, score review) to the match. */
  matchId?: string;
  /** Sequential match counter (since server start) for display purposes. */
  matchNumber?: number;
  /** Current sub-period (auto/transition/shift1-4/endgame) for REBUILT shift
   *  scoring. Frozen at its pre-pause value while paused. */
  subPeriod?: MatchSubPeriod | null;
  /** Whose goal is currently INACTIVE due to shift scoring (null = both
   *  active). Frozen at its pre-pause value while paused. */
  inactiveGoalAlliance?: Alliance | null;
  remainingTime: number;
  totalMatchTime: number;
  config: MatchConfig;
  stationStates: Partial<Record<StationName, StationControlState>>;
  /** Map of station → DS connection info for stations with a connected Driver Station */
  connectedStations: Partial<Record<StationName, DSConnectionInfo>>;
  endReason?: MatchEndReason;
  /** Maps physical station names to their assigned alliance match slots during a match */
  portToSlot?: Partial<Record<StationName, MatchSlot>>;
  /** Which alliance won the auto period (set after auto ends, null before or if not determined) */
  autoWinnerAlliance?: Alliance | null;
  /** True when in autoPause waiting for manual auto-winner selection ('pause' mode) */
  awaitingAutoWinner?: boolean;
  /** When phase is 'paused', the phase the match was in before pausing (A-Stop is only meaningful for a pause taken during auto) */
  pausedFrom?: MatchPhase;
  /** Epoch ms when a pending resume re-enables robots, while a paused match is
   *  counting down. Undefined when paused and holding. Robots stay disabled
   *  for the whole countdown; pausing again cancels it. */
  resumeAt?: number;
  /** True once the host has opened the ready check. Until then, no station or
   *  staff role may ready up. Reset whenever the roster changes. */
  readyRequested: boolean;
  /** Per-role readiness for non-team field staff. */
  staffStates: Record<StaffRole, StaffRoleState>;
};

export function isMatchState(msg: unknown): msg is MatchState {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as MatchState).type === 'matchState';
}

// ── Station-driven match messages ────────────────────────────────────

export type StationJoin = { type: 'stationJoin'; station: StationName };
export function isStationJoin(msg: unknown): msg is StationJoin {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationJoin;
  return m.type === 'stationJoin' && StationNameRegex.test(m.station);
}

/** Join a station to a specific alliance (decoupled from physical port). */
export type StationJoinAlliance = { type: 'stationJoinAlliance'; station: StationName; alliance: Alliance };
export function isStationJoinAlliance(msg: unknown): msg is StationJoinAlliance {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationJoinAlliance;
  return (
    m.type === 'stationJoinAlliance' &&
    StationNameRegex.test(m.station) &&
    (m.alliance === 'red' || m.alliance === 'blue')
  );
}

export type StationLeave = { type: 'stationLeave'; station: StationName };
export function isStationLeave(msg: unknown): msg is StationLeave {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationLeave;
  return m.type === 'stationLeave' && StationNameRegex.test(m.station);
}

export type StationReady = { type: 'stationReady'; station: StationName; ready: boolean };
export function isStationReady(msg: unknown): msg is StationReady {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationReady;
  return m.type === 'stationReady' && StationNameRegex.test(m.station) && typeof m.ready === 'boolean';
}

export type StationStartMatch = { type: 'stationStartMatch' };
export function isStationStartMatch(msg: unknown): msg is StationStartMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationStartMatch).type === 'stationStartMatch';
}

export type StationPauseMatch = { type: 'stationPauseMatch' };
export function isStationPauseMatch(msg: unknown): msg is StationPauseMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationPauseMatch).type === 'stationPauseMatch';
}

export type StationResumeMatch = { type: 'stationResumeMatch' };
export function isStationResumeMatch(msg: unknown): msg is StationResumeMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationResumeMatch).type === 'stationResumeMatch';
}

export type StationAbandonMatch = { type: 'stationAbandonMatch' };
export function isStationAbandonMatch(msg: unknown): msg is StationAbandonMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationAbandonMatch).type === 'stationAbandonMatch';
}

export type UpdateMatchConfig = { type: 'updateMatchConfig'; config: MatchConfig };
export function isUpdateMatchConfig(msg: unknown): msg is UpdateMatchConfig {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as UpdateMatchConfig;
  if (m.type !== 'updateMatchConfig') return false;
  if (!m.config || typeof m.config !== 'object') return false;
  if (typeof m.config.autoDuration !== 'number') return false;
  if (typeof m.config.teleopDuration !== 'number') return false;
  if (typeof m.config.endgameDuration !== 'number') return false;
  if (typeof m.config.pauseDuration !== 'number') return false;
  if (m.config.skipAuto !== undefined && typeof m.config.skipAuto !== 'boolean') return false;
  if (m.config.autoWinner !== undefined && !['red', 'blue', 'scores', 'pause'].includes(m.config.autoWinner))
    return false;
  return true;
}

// ── Admin match messages ─────────────────────────────────────────────

export type AdminStopMatch = { type: 'adminStopMatch' };

export function isAdminStopMatch(msg: unknown): msg is AdminStopMatch {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as AdminStopMatch).type === 'adminStopMatch';
}

export type AdminGlobalEStop = { type: 'adminGlobalEStop' };

export function isAdminGlobalEStop(msg: unknown): msg is AdminGlobalEStop {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as AdminGlobalEStop).type === 'adminGlobalEStop';
}

export type AdminStationEStop = { type: 'adminStationEStop'; station: StationName };

export function isAdminStationEStop(msg: unknown): msg is AdminStationEStop {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminStationEStop;
  if (m.type !== 'adminStationEStop') return false;
  if (!StationNameRegex.test(m.station)) return false;
  return true;
}

export type AdminStationDisable = { type: 'adminStationDisable'; station: StationName };

export function isAdminStationDisable(msg: unknown): msg is AdminStationDisable {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminStationDisable;
  if (m.type !== 'adminStationDisable') return false;
  if (!StationNameRegex.test(m.station)) return false;
  return true;
}

/** Re-enable a station a team stopped mid-match (DS/console disable, or after
 *  an e-stop was cleared). Admin form of stationSelfUndisable — also overrides
 *  an admin disable. */
export type AdminStationEnable = { type: 'adminStationEnable'; station: StationName };

export function isAdminStationEnable(msg: unknown): msg is AdminStationEnable {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminStationEnable;
  if (m.type !== 'adminStationEnable') return false;
  if (!StationNameRegex.test(m.station)) return false;
  return true;
}

export type AdminClearEStop = { type: 'adminClearEStop'; station?: StationName };

export function isAdminClearEStop(msg: unknown): msg is AdminClearEStop {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminClearEStop;
  if (m.type !== 'adminClearEStop') return false;
  if (m.station !== undefined && !StationNameRegex.test(m.station)) return false;
  return true;
}

// ── Match Controller messages (from /match page) ────────────────────

export type MatchCreate = { type: 'matchCreate' };
export function isMatchCreate(msg: unknown): msg is MatchCreate {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MatchCreate).type === 'matchCreate';
}

export type MatchCancel = { type: 'matchCancel' };
export function isMatchCancel(msg: unknown): msg is MatchCancel {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MatchCancel).type === 'matchCancel';
}

export type MatchAbortCountdown = { type: 'matchAbortCountdown' };
export function isMatchAbortCountdown(msg: unknown): msg is MatchAbortCountdown {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MatchAbortCountdown).type === 'matchAbortCountdown';
}

export type MatchSwapStation = { type: 'matchSwapStation'; station: StationName };
export function isMatchSwapStation(msg: unknown): msg is MatchSwapStation {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchSwapStation;
  return m.type === 'matchSwapStation' && StationNameRegex.test(m.station);
}

export type MatchKickStation = { type: 'matchKickStation'; station: StationName };
export function isMatchKickStation(msg: unknown): msg is MatchKickStation {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchKickStation;
  return m.type === 'matchKickStation' && StationNameRegex.test(m.station);
}

export type MatchSetAutoWinner = { type: 'matchSetAutoWinner'; winner: Alliance };
export function isMatchSetAutoWinner(msg: unknown): msg is MatchSetAutoWinner {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchSetAutoWinner;
  return m.type === 'matchSetAutoWinner' && (m.winner === 'red' || m.winner === 'blue');
}

/** Host opens or retracts the ready check (from the /match page). */
export type MatchRequestReady = { type: 'matchRequestReady'; requested: boolean };
export function isMatchRequestReady(msg: unknown): msg is MatchRequestReady {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchRequestReady;
  return m.type === 'matchRequestReady' && typeof m.requested === 'boolean';
}

/** Host marks a staff role required / not required for this match. */
export type MatchStaffIgnore = { type: 'matchStaffIgnore'; role: StaffRole; ignored: boolean };
export function isMatchStaffIgnore(msg: unknown): msg is MatchStaffIgnore {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchStaffIgnore;
  return m.type === 'matchStaffIgnore' && isStaffRole(m.role) && typeof m.ignored === 'boolean';
}

// ── Staff-driven match messages (from /staff pages) ──────────────────

/** A staff role readies / un-readies. */
export type StaffReady = { type: 'staffReady'; role: StaffRole; ready: boolean };
export function isStaffReady(msg: unknown): msg is StaffReady {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StaffReady;
  return m.type === 'staffReady' && isStaffRole(m.role) && typeof m.ready === 'boolean';
}

/** Presence heartbeat from an open staff page (drives the role's connected flag). */
export type StaffHeartbeat = { type: 'staffHeartbeat'; role: StaffRole };
export function isStaffHeartbeat(msg: unknown): msg is StaffHeartbeat {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StaffHeartbeat;
  return m.type === 'staffHeartbeat' && isStaffRole(m.role);
}

// ── Station self-service during match ────────────────────────────────

export type StationSelfDisable = { type: 'stationSelfDisable'; station: StationName };
export function isStationSelfDisable(msg: unknown): msg is StationSelfDisable {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationSelfDisable;
  return m.type === 'stationSelfDisable' && StationNameRegex.test(m.station);
}

export type StationSelfEStop = { type: 'stationSelfEStop'; station: StationName };
export function isStationSelfEStop(msg: unknown): msg is StationSelfEStop {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationSelfEStop;
  return m.type === 'stationSelfEStop' && StationNameRegex.test(m.station);
}

export type StationSelfAStop = { type: 'stationSelfAStop'; station: StationName };
export function isStationSelfAStop(msg: unknown): msg is StationSelfAStop {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationSelfAStop;
  return m.type === 'stationSelfAStop' && StationNameRegex.test(m.station);
}

/** Team-side recovery from an accidental mid-match disable (DS Enter key or
 *  the console Disable button). Refused while e-stopped, a-stopped, admin-
 *  disabled, or outside the auto/teleop/endgame phases. */
export type StationSelfUndisable = { type: 'stationSelfUndisable'; station: StationName };
export function isStationSelfUndisable(msg: unknown): msg is StationSelfUndisable {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationSelfUndisable;
  return m.type === 'stationSelfUndisable' && StationNameRegex.test(m.station);
}

/** Cancel a pre-armed A-Stop (only honored during match setup). */
export type StationClearAStop = { type: 'stationClearAStop'; station: StationName };
export function isStationClearAStop(msg: unknown): msg is StationClearAStop {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationClearAStop;
  return m.type === 'stationClearAStop' && StationNameRegex.test(m.station);
}

export type MatchClear = { type: 'matchClear' };
export function isMatchClear(msg: unknown): msg is MatchClear {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MatchClear).type === 'matchClear';
}

// ── Robot Telemetry ─────────────────────────────────────────────────

export interface TelemetryUpdate {
  type: 'telemetry';
  station: StationName;
  timestamp: number;
  /** Robot battery voltage in volts. Omitted when the robot isn't connected to
   *  its Driver Station (the DS reports a 0xFFFF sentinel, which would otherwise
   *  decode to ~256V) — consumers render a "no reading" placeholder instead. */
  batteryVoltage?: number;
  /** Lowest batteryVoltage observed since this station's previous broadcast.
   *  Telemetry is throttled per-station (latest wins), so brief voltage sags
   *  between broadcasts would otherwise be invisible — this carries the
   *  coalescing window's envelope so battery charts can still show them.
   *  Omitted when it equals batteryVoltage. */
  batteryVoltageMin?: number;
  rttMs?: number;
  lostPackets?: number;
  canUtil?: number;
  dsCpuPercent?: number;
  brownout?: boolean;
  dsStatus?: {
    eStop: boolean;
    aStop: boolean;
    robotComms: boolean;
    radioPing: boolean;
    rioPing: boolean;
    enabled: boolean;
    mode: 'teleOp' | 'test' | 'auto';
  };
}

export function isTelemetryUpdate(msg: unknown): msg is TelemetryUpdate {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as TelemetryUpdate).type === 'telemetry';
}

// ── Network Stats ───────────────────────────────────────────────────

export interface StationNetworkStats {
  rxPackets: number; // packets from robot VLAN (FORWARD in)
  rxBytes: number;
  txPackets: number; // packets to robot VLAN (FORWARD out)
  txBytes: number;
}

export interface NetworkStats {
  type: 'networkStats';
  stations: Partial<Record<StationName, StationNetworkStats>>;
}

export function isNetworkStats(msg: unknown): msg is NetworkStats {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as NetworkStats).type === 'networkStats';
}

// ── Subnet Scan ─────────────────────────────────────────────────────

export interface DiscoveredHost {
  ip: string;
  alive: boolean;
  firstSeen: number;
  lastSeen: number;
  /** Start of the current consecutive-alive streak (reset when host goes down) */
  onlineSince: number;
  /** How this host was discovered: 'fping' (team subnet scan) or 'conntrack' (guest network flow) */
  source?: 'fping' | 'conntrack';
}

export interface StationSubnetScan {
  team: number;
  subnet: string;
  hosts: DiscoveredHost[];
  lastScanTime: number;
}

export interface SubnetScanResults {
  type: 'subnetScan';
  stations: Partial<Record<StationName, StationSubnetScan>>;
}

export function isSubnetScanResults(msg: unknown): msg is SubnetScanResults {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as SubnetScanResults).type === 'subnetScan';
}

// ── Guest Host Names ────────────────────────────────────────────────

/** Resolved display names for guest-network hosts (DS laptops etc.), keyed by IP. */
export interface HostnamesState {
  type: 'hostnames';
  hostnames: Record<string, string>;
}

export function isHostnamesState(msg: unknown): msg is HostnamesState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as HostnamesState).type === 'hostnames';
}

// ── App Log Messages ────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error';

export interface AppLogMessage {
  type: 'appLog';
  timestamp: number;
  level: LogLevel;
  message: string;
}

export function isAppLogMessage(msg: unknown): msg is AppLogMessage {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as AppLogMessage).type === 'appLog';
}

// ── Route Preferences / Drive ───────────────────────────────────────

/** Sent from client to server to set or clear a routing preference */
export type RoutePreferenceMsg = {
  type: 'routePreference';
  /** Which station to route to, or null to clear the preference */
  station: StationName | null;
};

export function isRoutePreferenceMsg(msg: unknown): msg is RoutePreferenceMsg {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RoutePreferenceMsg;
  if (m.type !== 'routePreference') return false;
  if (m.station !== null && !StationNameRegex.test(m.station)) return false;
  return true;
}

/**
 * Sent from client to server to start or stop driving a station's robot.
 * Unlike routePreference (which only sets the forward ip rule), this sets up
 * both the forward path (ip rule) AND the reverse path (DNAT) so the DS can
 * communicate bidirectionally with the robot.
 */
export type DriveAction = {
  type: 'drive';
  /** Which station to drive, or null to stop driving */
  station: StationName | null;
};

export function isDriveAction(msg: unknown): msg is DriveAction {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as DriveAction;
  if (m.type !== 'drive') return false;
  if (m.station !== null && !StationNameRegex.test(m.station)) return false;
  return true;
}

/** Sent from server to client with their routing preference state */
export type RoutePreferenceState = {
  type: 'routePreferenceState';
  /** The IP address of the connected client */
  yourIp: string;
  /** The currently active routing preference, or null if none */
  preference: StationName | null;
  /**
   * Teams that are assigned to more than one station simultaneously.
   * Keys are team numbers (as strings), values are the stations they appear on.
   * Only teams with 2+ stations are included.
   */
  conflictingTeams: Record<string, StationName[]>;
};

export function isRoutePreferenceState(msg: unknown): msg is RoutePreferenceState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RoutePreferenceState).type === 'routePreferenceState';
}

// ── Pending Commit Types ────────────────────────────────────────────

/** Sent from server to client when pending commit state changes */
export type PendingCommitState = {
  type: 'pendingCommitState';
  pending: boolean;
  /** Staged changes per station. null = staged clear, absent = no staged change. */
  stagedChanges?: Record<string, { ssid: string; wpaKey: string } | null>;
};

export function isPendingCommitState(msg: unknown): msg is PendingCommitState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as PendingCommitState).type === 'pendingCommitState';
}

// ── Last Linked Types ───────────────────────────────────────────────

/** Sent from server to client with per-station last-linked timestamps. */
export type LastLinkedState = {
  type: 'lastLinkedState';
  /** Map of station → server timestamp (Date.now()) when a robot was last linked. */
  timestamps: Partial<Record<StationName, number>>;
};

export function isLastLinkedState(msg: unknown): msg is LastLinkedState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as LastLinkedState).type === 'lastLinkedState';
}

/** Sent from client to server to trigger a commit of pending changes */
export type ApplyConfigMsg = {
  type: 'applyConfig';
};

export function isApplyConfig(msg: unknown): msg is ApplyConfigMsg {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ApplyConfigMsg).type === 'applyConfig';
}

// ── Saved WiFi Types ────────────────────────────────────────────────

export interface SavedWiFiSetting {
  ssid: string;
  wpaKey: string;
  internetAccess?: boolean;
  createdAt: number; // timestamp when first created
  lastUsedAt: number; // timestamp when last used
}

export function isSavedWiFiSetting(setting: unknown): setting is SavedWiFiSetting {
  if (typeof setting !== 'object') return false;
  if (!setting) return false;

  const { ssid, wpaKey, createdAt, lastUsedAt } = setting as SavedWiFiSetting;

  if (typeof ssid !== 'string') return false;
  if (typeof wpaKey !== 'string') return false;
  if (typeof createdAt !== 'number') return false;
  if (typeof lastUsedAt !== 'number') return false;

  return true;
}

// ── Server-Side Saved Team Configs ──────────────────────────────────

/** A saved team WiFi configuration stored server-side (includes plaintext key). */
export interface SavedTeamConfig {
  ssid: string;
  wpaKey: string;
  /** SHA-256(ssid + wpaKey) — salted with team+robot name so clients can verify without the real key */
  wpaKeyHash: string;
  internetAccess?: boolean;
  createdAt: number;
  lastUsedAt: number;
}

/** Client-facing saved team config — wpaKey stripped so passphrases stay server-side. */
export type SavedTeamClientConfig = Omit<SavedTeamConfig, 'wpaKey'>;

/** Broadcast from server to clients with saved team configs (keys stripped). */
export interface SavedTeamsState {
  type: 'savedTeamsState';
  teams: SavedTeamClientConfig[];
}

export function isSavedTeamsState(msg: unknown): msg is SavedTeamsState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as SavedTeamsState).type === 'savedTeamsState';
}

/** Client request to remove a saved team config. */
export type RemoveSavedTeam = { type: 'removeSavedTeam'; ssid: string };
export function isRemoveSavedTeam(msg: unknown): msg is RemoveSavedTeam {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RemoveSavedTeam;
  return m.type === 'removeSavedTeam' && typeof m.ssid === 'string';
}

/** Client request to save a team config without assigning it to a station. */
export type SaveSavedTeam = { type: 'saveSavedTeam'; ssid: string; wpaKey: string };
export function isSaveSavedTeam(msg: unknown): msg is SaveSavedTeam {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as SaveSavedTeam;
  return m.type === 'saveSavedTeam' && typeof m.ssid === 'string' && typeof m.wpaKey === 'string';
}

/** Client request to enable a previously-saved robot by SSID (server looks up the key). */
export type EnableSavedRobot = {
  type: 'enableSavedRobot';
  ssid: string;
  station: StationName;
  stage?: boolean;
};
export function isEnableSavedRobot(msg: unknown): msg is EnableSavedRobot {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as EnableSavedRobot;
  return (
    m.type === 'enableSavedRobot' &&
    typeof m.ssid === 'string' &&
    typeof m.station === 'string' &&
    StationNameRegex.test(m.station)
  );
}

// ── mDNS Reflector Activity ─────────────────────────────────────────

export interface MdnsResolvedName {
  name: string;
  /** Resolved IPv4 address from A record, if seen */
  resolvedIp?: string;
  /** Source IP of the query that triggered this lookup */
  requester?: string;
  /** Service types discovered for this hostname (e.g. ['_ni-rt._tcp', '_ni._tcp']) */
  services?: string[];
}

export interface StationMdnsActivity {
  team: number;
  queriesForwarded: number;
  responsesForwarded: number;
  recentNames: MdnsResolvedName[];
}

export interface MdnsActivity {
  type: 'mdnsActivity';
  stations: Partial<Record<StationName, StationMdnsActivity>>;
}

export function isMdnsActivity(msg: unknown): msg is MdnsActivity {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MdnsActivity).type === 'mdnsActivity';
}

// ── Team Checks ─────────────────────────────────────────────────────

export type CheckStatus = 'pending' | 'pass' | 'fail' | 'warn' | 'error';

export type CheckResult = {
  name: string;
  status: CheckStatus;
  expected?: string;
  actual?: string;
  message?: string;
  /** URL to documentation for fixing the issue when the check fails */
  helpUrl?: string;
};

export interface TeamCheckResults {
  type: 'teamCheckResults';
  station: StationName;
  team: number;
  timestamp: number;
  checks: CheckResult[];
}

export function isTeamCheckResults(msg: unknown): msg is TeamCheckResults {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TeamCheckResults).type === 'teamCheckResults';
}

// ── Server Info ─────────────────────────────────────────────────────

export interface ServerInfo {
  type: 'serverInfo';
  startTime: number;
  version: string;
  /** Server's Date.now() when the message was sent — lets clients seed their
   *  server↔client clock-offset estimate immediately on connect. */
  now?: number;
}

export function isServerInfo(msg: unknown): msg is ServerInfo {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ServerInfo).type === 'serverInfo';
}

export type RunTeamChecks = { type: 'runTeamChecks'; station: StationName };

export function isRunTeamChecks(msg: unknown): msg is RunTeamChecks {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RunTeamChecks;
  return m.type === 'runTeamChecks' && StationNameRegex.test(m.station);
}

// ── Robot Test (CSA Tool) ───────────────────────────────────────────

export type RobotTestPhase =
  | 'disabled'
  | 'link_down'
  | 'link_up'
  | 'dhcp_requesting'
  | 'ready'
  | 'checking'
  | 'complete';

export interface RobotTestState {
  type: 'robotTestState';
  phase: RobotTestPhase;
  interfaceName: string;
  /** True if the interface is a VLAN (link state not meaningful, no dedicated hardware to show) */
  isVlan?: boolean;
  linkUp: boolean;
  macAddress?: string;
  teamNumber?: number;
  leasedIp?: string;
  routerIp?: string;
  checks: CheckResult[];
  lastUpdate: number;
  /** Timestamp (epoch ms) when the last radio reconfiguration or firmware update completed.
   *  Set after configure/update finishes; cleared once the robot checks pass. */
  reconfiguredAt?: number;
  /** Maximum time (ms) to wait for the network to stabilize after reconfiguration. */
  reconfigureTimeoutMs?: number;
  /** What kind of reconfiguration triggered the settling period. */
  reconfigureType?: 'radio' | 'firmware';
}

export function isRobotTestState(msg: unknown): msg is RobotTestState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RobotTestState).type === 'robotTestState';
}

// ── Firmware Update ─────────────────────────────────────────────────

export type FirmwareUpdateStep =
  | 'verifying'
  | 'downloading'
  | 'uploading'
  | 'flashing'
  | 'waiting_reboot'
  | 'reconfiguring'
  | 'verifying_config'
  | 'complete'
  | 'error';

export interface FirmwareUpdateProgress {
  type: 'firmwareUpdateProgress';
  step: FirmwareUpdateStep;
  message: string;
  /** 0-100 overall progress estimate */
  progress: number;
  /** Milliseconds since the update started */
  elapsedMs: number;
  error?: string;
}

export function isFirmwareUpdateProgress(msg: unknown): msg is FirmwareUpdateProgress {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as FirmwareUpdateProgress).type === 'firmwareUpdateProgress';
}

export interface FirmwareUpdateRequest {
  type: 'firmwareUpdateRequest';
  /** WPA passphrase for 6GHz band. Optional if auto-detected from station config. */
  wpaKey?: string;
  /** WPA passphrase for 2.4GHz band. Defaults to the 6GHz key if omitted. */
  wpaKey24?: string;
  /** If true, flash firmware only — do not reconfigure the radio afterward (leaves it in factory default state). */
  skipReconfigure?: boolean;
}

export function isFirmwareUpdateRequest(msg: unknown): msg is FirmwareUpdateRequest {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as FirmwareUpdateRequest).type === 'firmwareUpdateRequest';
}

// ── Radio Configure (Team Robot Radio mode) ─────────────────────────

/** Request to configure a radio in TEAM_ROBOT_RADIO mode from the test interface. */
export interface RadioConfigureRequest {
  type: 'radioConfigureRequest';
  teamNumber: number;
  /** WPA passphrase for the 6 GHz band. */
  wpaKey6: string;
  /** WPA passphrase for the 2.4 GHz band. Defaults to wpaKey6 if omitted. */
  wpaKey24?: string;
  /** SSID suffix appended after the team number (e.g. "1234_Suffix"). */
  ssidSuffix?: string;
}

export function isRadioConfigureRequest(msg: unknown): msg is RadioConfigureRequest {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RadioConfigureRequest;
  return m.type === 'radioConfigureRequest' && typeof m.teamNumber === 'number' && typeof m.wpaKey6 === 'string';
}

export type RadioConfigureStep = 'sending' | 'waiting_reboot' | 'complete' | 'error';

export interface RadioConfigureProgress {
  type: 'radioConfigureProgress';
  step: RadioConfigureStep;
  message: string;
  /** 0-100 overall progress estimate */
  progress: number;
  /** Milliseconds since the configure started */
  elapsedMs: number;
  error?: string;
}

export function isRadioConfigureProgress(msg: unknown): msg is RadioConfigureProgress {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RadioConfigureProgress).type === 'radioConfigureProgress';
}

// ── Scoring System ──────────────────────────────────────────────────

/** Configuration for a single scoring element (e.g. "speaker", "amp", "foul") */
export interface ScoringElementConfig {
  /** Unique element identifier (e.g. "speaker", "amp", "coral_l1") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Points awarded per count */
  pointValue: number;
  /** If true, points are awarded to the OPPOSING alliance (for fouls/penalties) */
  awardToOpponent?: boolean;
  /** Match phases during which this element scores. Omit or empty = always active. */
  activePhases?: MatchPhase[];
  /** Events for the same element+alliance within this window (ms) are merged. Default: 0 (no dedup) */
  deduplicationWindowMs?: number;
  /** True if this element was auto-registered from an incoming event (not explicitly configured) */
  autoRegistered?: boolean;
}

/** A score event submitted by an external device via the HTTP API */
export interface ScoreEvent {
  /** Identifier of the reporting device/sensor */
  source: string;
  /** Which alliance triggered the scoring action */
  alliance: Alliance;
  /** Scoring element identifier (must match a configured element) */
  element: string;
  /** Number of scores. Default 1. Negative values for corrections. */
  count?: number;
  /**
   * Device-side timestamp (ms since epoch). Optional — the server always records
   * its own receive time, but this lets devices report *when* the score actually
   * happened (e.g. if the device buffers events offline or has network latency).
   * Used for display and ordering; deduplication still uses server receive time.
   */
  timestamp?: number;
}

export function isScoreEvent(msg: unknown): msg is ScoreEvent {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as ScoreEvent;
  if (typeof m.source !== 'string' || !m.source) return false;
  if (m.alliance !== 'red' && m.alliance !== 'blue') return false;
  if (typeof m.element !== 'string' || !m.element) return false;
  if (m.count !== undefined && typeof m.count !== 'number') return false;
  if (m.timestamp !== undefined && typeof m.timestamp !== 'number') return false;
  return true;
}

/** Internal record of a processed score event */
export interface ProcessedScoreEvent {
  id: string;
  source: string;
  alliance: Alliance;
  element: string;
  count: number;
  pointValue: number;
  /** Alliance that actually receives the points (differs from alliance if awardToOpponent) */
  awardedTo: Alliance;
  /** Server receive time (ms since epoch) — used for dedup and sliding window */
  timestamp: number;
  /** Device-reported time (ms since epoch), if provided */
  deviceTimestamp?: number;
  matchPhase?: MatchPhase;
  /** Sub-period within the match (auto, transition, shift1-4, endgame) */
  matchSubPeriod?: string;
  /** True if this event was deduplicated (not counted) */
  deduplicated: boolean;
  /** True if the alliance's goal was inactive (past grace period) when this event arrived */
  goalInactive?: boolean;
}

/** Per-element score breakdown */
export interface ElementScore {
  count: number;
  points: number;
  lastEventTime: number;
}

/** Score totals for one alliance */
export interface AllianceScore {
  total: number;
  elements: Record<string, ElementScore>;
}

/** Status of a scoring source device */
export interface ScoringSourceStatus {
  lastSeen: number;
  eventCount: number;
  lastElement?: string;
  lastAlliance?: Alliance;
}

export type ScoringMode = 'freePlay' | 'match';

/** A completed scoring batch — a run of scores that timed out or was superseded */
export interface ScoreBatch {
  total: number;
  elements: Record<string, ElementScore>;
  startedAt: number;
  endedAt: number;
}

/** The full score state broadcast to clients via WebSocket */
export interface ScoreState {
  type: 'scoreState';
  mode: ScoringMode;
  /** Sliding window size in seconds (freePlay mode) */
  windowSeconds: number;
  /** Max elements that can be auto-registered from incoming events */
  autoRegisterLimit: number;
  /** Grace period (seconds) for attributing events to the previous match phase after a transition */
  phaseGraceSeconds: number;
  /** Seconds of inactivity before a free play batch is considered done (per alliance) */
  batchTimeoutSeconds: number;
  /** Active batch scores (free play) or cumulative match scores */
  red: AllianceScore;
  blue: AllianceScore;
  /** Whether each alliance's current batch is still active (false = timed out, desaturate) */
  redBatchActive?: boolean;
  blueBatchActive?: boolean;
  /** Previous completed batches per alliance (free play only, newest first, up to 5) */
  recentBatches?: { red: ScoreBatch[]; blue: ScoreBatch[] };
  /** Sliding window scores as secondary display (free play only) */
  slidingWindow?: { red: AllianceScore; blue: AllianceScore };
  /** Current match phase (match mode only) */
  matchPhase?: MatchPhase;
  /** Per-phase breakdown (match mode only) */
  phaseBreakdown?: Record<string, { red: AllianceScore; blue: AllianceScore }>;
  /** Per-sub-period breakdown: auto, transition, shift1-4, endgame (match mode only) */
  periodBreakdown?: Record<string, { red: number; blue: number }>;
  /** Which alliances are in match mode (omitted or empty = all follow the top-level mode) */
  matchAlliances?: Alliance[];
  /** Scores from events where the alliance's goal was inactive (match mode only, for display) */
  inactiveScores?: { red: AllianceScore; blue: AllianceScore };
  /** Status of all known scoring sources */
  sources: Record<string, ScoringSourceStatus>;
  /** Configured scoring elements */
  elements: Record<string, ScoringElementConfig>;
}

export function isScoreState(msg: unknown): msg is ScoreState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ScoreState).type === 'scoreState';
}

// ── API Key Management ──────────────────────────────────────────────

export type ApiKeyStatus = 'active' | 'revoked';

/** A registered API key for the scoring API. */
export interface ApiKeyEntry {
  /** Short display identifier (first 8 hex chars of the key). */
  id: string;
  /** The full API key (64-char hex string). */
  key: string;
  /** Human-readable label (e.g. "Speaker Sensor", "Ref Tablet"). */
  label: string;
  /** Current status. */
  status: ApiKeyStatus;
  /** When the key was created. */
  createdAt: number;
  /** When the key was last used to authenticate a request. */
  lastUsedAt?: number;
  /** Total number of authenticated requests made with this key. */
  requestCount: number;
  /** The most recent source IP that used this key. */
  lastSourceIp?: string;
  /** The User-Agent header from the most recent request. */
  lastUserAgent?: string;
  /** If this key was created by approving a pending device, the source IP of that device. */
  discoveredFromIp?: string;
}

/** Summary of a key for the admin UI (full key value is never broadcast). */
export interface ApiKeySummary {
  id: string;
  /** Masked key for display: first 8 chars + "..." */
  keyPreview: string;
  label: string;
  status: ApiKeyStatus;
  createdAt: number;
  lastUsedAt?: number;
  requestCount: number;
  lastSourceIp?: string;
  lastUserAgent?: string;
}

/** A pending (unapproved) device that attempted to use the scoring API without a valid key. */
export interface PendingDevice {
  /** Unique identifier for this pending entry. */
  id: string;
  /** Source IP of the request. */
  sourceIp: string;
  /** User-Agent header, if present. */
  userAgent?: string;
  /** The key that was presented (masked), if any. */
  presentedKey?: string;
  /** Timestamp of the first rejected request from this device. */
  firstSeen: number;
  /** Timestamp of the most recent rejected request. */
  lastSeen: number;
  /** Number of rejected requests from this device. */
  requestCount: number;
  /** The URL path that was last requested (e.g. "/api/score"). */
  lastPath?: string;
}

/** Broadcast state for the API key management system. */
export interface ApiKeyState {
  type: 'apiKeyState';
  /** All registered keys (full key value is never included). */
  keys: ApiKeySummary[];
  /** Devices waiting for approval. */
  pendingDevices: PendingDevice[];
  /** Whether the scoring API currently requires authentication. */
  authRequired: boolean;
}

export function isApiKeyState(msg: unknown): msg is ApiKeyState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ApiKeyState).type === 'apiKeyState';
}

/** Server → requesting client only: newly created key with the full key value (shown once). */
export interface ApiKeyCreated {
  type: 'apiKeyCreated';
  /** The full API key — copy this now, it will not be shown again. */
  key: string;
  id: string;
  label: string;
}

export function isApiKeyCreated(msg: unknown): msg is ApiKeyCreated {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ApiKeyCreated).type === 'apiKeyCreated';
}

// ── API Key Admin Commands (WebSocket client → server) ──────────────

/** Create a new API key. */
export interface CreateApiKey {
  type: 'createApiKey';
  label: string;
}

export function isCreateApiKey(msg: unknown): msg is CreateApiKey {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as CreateApiKey;
  return m.type === 'createApiKey' && typeof m.label === 'string' && m.label.length > 0;
}

/** Revoke an active API key. */
export interface RevokeApiKey {
  type: 'revokeApiKey';
  id: string;
}

export function isRevokeApiKey(msg: unknown): msg is RevokeApiKey {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RevokeApiKey;
  return m.type === 'revokeApiKey' && typeof m.id === 'string';
}

/** Reactivate a revoked API key. */
export interface ReactivateApiKey {
  type: 'reactivateApiKey';
  id: string;
}

export function isReactivateApiKey(msg: unknown): msg is ReactivateApiKey {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as ReactivateApiKey;
  return m.type === 'reactivateApiKey' && typeof m.id === 'string';
}

/** Permanently delete an API key. */
export interface DeleteApiKey {
  type: 'deleteApiKey';
  id: string;
}

export function isDeleteApiKey(msg: unknown): msg is DeleteApiKey {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as DeleteApiKey;
  return m.type === 'deleteApiKey' && typeof m.id === 'string';
}

/** Approve a pending device (generates a key for it). */
export interface ApprovePendingDevice {
  type: 'approvePendingDevice';
  id: string;
  label: string;
}

export function isApprovePendingDevice(msg: unknown): msg is ApprovePendingDevice {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as ApprovePendingDevice;
  return m.type === 'approvePendingDevice' && typeof m.id === 'string' && typeof m.label === 'string';
}

/** Dismiss/reject a pending device. */
export interface DismissPendingDevice {
  type: 'dismissPendingDevice';
  id: string;
}

export function isDismissPendingDevice(msg: unknown): msg is DismissPendingDevice {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as DismissPendingDevice;
  return m.type === 'dismissPendingDevice' && typeof m.id === 'string';
}

/** Reset scores via WebSocket (replaces the HTTP fetch from admin UI). */
export interface ScoreReset {
  type: 'scoreReset';
}

export function isScoreReset(msg: unknown): msg is ScoreReset {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ScoreReset).type === 'scoreReset';
}

export interface StopCast {
  type: 'stopCast';
  /** If set, stop only this specific receiver. If omitted, stop all. */
  receiverId?: string;
}

export function isStopCast(msg: unknown): msg is StopCast {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StopCast).type === 'stopCast';
}

/** Sent by a cast receiver (TV) to register itself with the backend. */
export interface CastReceiverRegister {
  type: 'castReceiverRegister';
  /** Human-readable name for the display (e.g. "Warehouse TV") */
  name: string;
  swapped: boolean;
  /** True if this display's match audio is muted (optional for old clients). */
  muted?: boolean;
}

export function isCastReceiverRegister(msg: unknown): msg is CastReceiverRegister {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as CastReceiverRegister).type === 'castReceiverRegister';
}

/** Sent by admin to swap a specific receiver's display orientation. */
export interface CastReceiverSwap {
  type: 'castReceiverSwap';
  receiverId: string;
  swapped: boolean;
}

export function isCastReceiverSwap(msg: unknown): msg is CastReceiverSwap {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as CastReceiverSwap).type === 'castReceiverSwap';
}

/** Sent by the match page to play the "get ready" attention sound on the
 *  field speaker and every un-muted display. Re-broadcast to all clients. */
export interface PlayGetReady {
  type: 'playGetReady';
}

export function isPlayGetReady(msg: unknown): msg is PlayGetReady {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as PlayGetReady).type === 'playGetReady';
}

/** Sent by admin to mute/unmute match audio on a specific receiver. */
export interface CastReceiverMute {
  type: 'castReceiverMute';
  receiverId: string;
  muted: boolean;
}

export function isCastReceiverMute(msg: unknown): msg is CastReceiverMute {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as CastReceiverMute).type === 'castReceiverMute';
}

/** Broadcast to all clients: current state of all cast receivers. */
export interface CastReceiverList {
  type: 'castReceiverList';
  receivers: { id: string; name: string; swapped: boolean; muted: boolean }[];
}

export function isCastReceiverList(msg: unknown): msg is CastReceiverList {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as CastReceiverList).type === 'castReceiverList';
}

// ── Physical Port Bridging ──────────────────────────────────────────

/** Configuration for a physical Ethernet port available for bridging. */
export interface PortConfig {
  vlanId: number;
  name: string; // Display name, e.g., "Port A"
}

/** Sent from server to client: current port bridge state. */
export interface PortBridgeState {
  type: 'portBridgeState';
  /** Available physical ports (from server config). Empty = port bridging disabled. */
  ports: PortConfig[];
  /** Active bridges: portVlanId → stationName */
  activeBridges: Record<number, StationName>;
}

export function isPortBridgeState(msg: unknown): msg is PortBridgeState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as PortBridgeState).type === 'portBridgeState';
}

/** Sent from client to server: request to bridge or unbind a port. */
export interface PortBridgeRequest {
  type: 'portBridge';
  station: StationName;
  /** VLAN ID of the port to bridge, or null to unbind all ports from this station. */
  portVlanId: number | null;
}

export function isPortBridgeRequest(msg: unknown): msg is PortBridgeRequest {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as PortBridgeRequest;
  if (m.type !== 'portBridge') return false;
  if (!StationNameRegex.test(m.station)) return false;
  if (m.portVlanId !== null && typeof m.portVlanId !== 'number') return false;
  return true;
}

// ── Support System Types ────────────────────────────────────────────

/** Issue report submitted by a user from the /support page. */
export interface SupportIssue {
  id: string;
  createdAt: number;
  /** What the user was trying to do. */
  tryingToDo: string;
  /** What buttons/actions they took. */
  stepsPerformed: string;
  /** What they expected to happen. */
  expected: string;
  /** What actually happened. */
  actual: string;
  /** Auto-captured browser/station metadata. */
  metadata: SupportMetadata;
  /** Optional screenshot (base64 PNG data URL). */
  screenshotDataUrl?: string;
  /** Recent app logs captured at time of report. */
  recentLogs: string[];
  /** If a chat was started from this issue, the chat session ID. */
  chatSessionId?: string;
  /** Slack thread timestamp (if forwarded to Slack). */
  slackThreadTs?: string;
  /** Current status. */
  status: 'open' | 'in-chat' | 'closed';
}

export interface SupportMetadata {
  /** Browser user agent string. */
  userAgent: string;
  /** Current page URL. */
  pageUrl: string;
  /** Client IP (filled in by server). */
  clientIp?: string;
  /** Screen resolution. */
  screenSize?: string;
  /** Current timestamp. */
  timestamp: number;
}

/** Chat message in a support chat session. */
export interface SupportChatMessage {
  id: string;
  sessionId: string;
  /** Who sent this message: 'user' (web UI) or 'admin' (Slack). */
  sender: 'user' | 'admin';
  /** Display name of the sender. */
  senderName: string;
  /** Message text content. */
  text: string;
  /** Optional screenshot attachment (base64 PNG data URL). */
  screenshotDataUrl?: string;
  timestamp: number;
}

/** A support chat session, bridged to a single Slack thread. */
export interface SupportChatSession {
  id: string;
  createdAt: number;
  /** The issue this chat was started from (if any). */
  issueId?: string;
  /** Slack thread timestamp for this chat session. */
  slackThreadTs?: string;
  /** Display name of the user who started this session. */
  senderName?: string;
  /** Messages in this session. */
  messages: SupportChatMessage[];
  /** Whether this session is still active. */
  active: boolean;
}

/** Broadcast state for the support system. */
export interface SupportState {
  type: 'supportState';
  issues: SupportIssue[];
  /** Active chat sessions for this client (filtered server-side). */
  activeSessions: SupportChatSession[];
}

export function isSupportState(msg: unknown): msg is SupportState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as SupportState).type === 'supportState';
}

/** Incoming chat message from Slack (server → client). */
export interface SupportChatIncoming {
  type: 'supportChatMessage';
  message: SupportChatMessage;
}

export function isSupportChatIncoming(msg: unknown): msg is SupportChatIncoming {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as SupportChatIncoming).type === 'supportChatMessage';
}

/** Client → Server: submit an issue report. */
export interface SubmitSupportIssue {
  type: 'submitSupportIssue';
  tryingToDo: string;
  stepsPerformed: string;
  expected: string;
  actual: string;
  metadata: SupportMetadata;
  screenshotDataUrl?: string;
  recentLogs: string[];
}

export function isSubmitSupportIssue(msg: unknown): msg is SubmitSupportIssue {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as SubmitSupportIssue;
  if (m.type !== 'submitSupportIssue') return false;
  if (typeof m.tryingToDo !== 'string') return false;
  if (typeof m.actual !== 'string') return false;
  return true;
}

/** Client → Server: start a chat session (optionally from an issue). */
export interface StartSupportChat {
  type: 'startSupportChat';
  issueId?: string;
  senderName?: string;
}

export function isStartSupportChat(msg: unknown): msg is StartSupportChat {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StartSupportChat).type === 'startSupportChat';
}

/** Client → Server: send a chat message. */
export interface SendSupportChatMessage {
  type: 'sendSupportChatMessage';
  sessionId: string;
  text: string;
  screenshotDataUrl?: string;
  senderName?: string;
}

export function isSendSupportChatMessage(msg: unknown): msg is SendSupportChatMessage {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as SendSupportChatMessage;
  if (m.type !== 'sendSupportChatMessage') return false;
  if (typeof m.sessionId !== 'string') return false;
  if (typeof m.text !== 'string') return false;
  return true;
}

/** Client → Server: end a chat session. */
export interface EndSupportChat {
  type: 'endSupportChat';
  sessionId: string;
}

export function isEndSupportChat(msg: unknown): msg is EndSupportChat {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as EndSupportChat;
  if (m.type !== 'endSupportChat') return false;
  if (typeof m.sessionId !== 'string') return false;
  return true;
}

/** Client → Server: create an issue from a chat session. */
export interface CreateIssueFromChat {
  type: 'createIssueFromChat';
  sessionId: string;
  tryingToDo: string;
  actual: string;
}

export function isCreateIssueFromChat(msg: unknown): msg is CreateIssueFromChat {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as CreateIssueFromChat;
  if (m.type !== 'createIssueFromChat') return false;
  if (typeof m.sessionId !== 'string') return false;
  return true;
}

// ── Admin Auth Types ────────────────────────────────────────────────

/** Client → Server: log in to admin with passphrase. */
export interface AdminLogin {
  type: 'adminLogin';
  passphrase: string;
}

export function isAdminLogin(msg: unknown): msg is AdminLogin {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as AdminLogin;
  if (m.type !== 'adminLogin') return false;
  if (typeof m.passphrase !== 'string') return false;
  return true;
}

/** Client → Server: check if an existing token is still valid. */
export interface AdminCheckAuth {
  type: 'adminCheckAuth';
  token: string;
}

export function isAdminCheckAuth(msg: unknown): msg is AdminCheckAuth {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as AdminCheckAuth;
  if (m.type !== 'adminCheckAuth') return false;
  if (typeof m.token !== 'string') return false;
  return true;
}

/** Client → Server: set the admin passphrase (first-time setup only). */
export interface AdminSetPassphrase {
  type: 'adminSetPassphrase';
  passphrase: string;
}

export function isAdminSetPassphrase(msg: unknown): msg is AdminSetPassphrase {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as AdminSetPassphrase;
  if (m.type !== 'adminSetPassphrase') return false;
  if (typeof m.passphrase !== 'string') return false;
  return true;
}

/** Server → Client: admin auth result. */
export interface AdminAuthResult {
  type: 'adminAuthResult';
  authenticated: boolean;
  /** Admin session token to store in localStorage (only on successful login). */
  token?: string;
  /** Whether a passphrase has been configured. */
  passphraseConfigured: boolean;
  /** External access token — fetch /admin/auth/<token> to set the cookie. */
  externalAccessToken?: string;
}

export function isAdminAuthResult(msg: unknown): msg is AdminAuthResult {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as AdminAuthResult).type === 'adminAuthResult';
}

// ── Slack Config Types ──────────────────────────────────────────────

/** Client → Server: save Slack configuration. */
export interface SaveSlackConfig {
  type: 'saveSlackConfig';
  botToken: string;
  appToken: string;
  channelId: string;
}

export function isSaveSlackConfig(msg: unknown): msg is SaveSlackConfig {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as SaveSlackConfig;
  if (m.type !== 'saveSlackConfig') return false;
  if (typeof m.botToken !== 'string') return false;
  if (typeof m.appToken !== 'string') return false;
  if (typeof m.channelId !== 'string') return false;
  return true;
}

/** Client → Server: test the current Slack connection. */
export interface TestSlackConnection {
  type: 'testSlackConnection';
}

export function isTestSlackConnection(msg: unknown): msg is TestSlackConnection {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TestSlackConnection).type === 'testSlackConnection';
}

/** Server → Client: Slack configuration state. */
export interface SlackConfigState {
  type: 'slackConfigState';
  configured: boolean;
  connected: boolean;
  channelName?: string;
  error?: string;
}

export function isSlackConfigState(msg: unknown): msg is SlackConfigState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as SlackConfigState).type === 'slackConfigState';
}

// ── External Access Tokens ──────────────────────────────────────────

/** Summary of an external access token (no raw token or hash). */
export interface ExternalAccessTokenSummary {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** Broadcast state for external access token management. */
export interface ExternalAccessState {
  type: 'externalAccessState';
  tokens: ExternalAccessTokenSummary[];
}

export function isExternalAccessState(msg: unknown): msg is ExternalAccessState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ExternalAccessState).type === 'externalAccessState';
}

/** Server → requesting client only: newly created token with the raw value (shown once). */
export interface ExternalAccessTokenCreated {
  type: 'externalAccessTokenCreated';
  /** The raw token — share this in the auth URL. Will not be shown again. */
  token: string;
  id: string;
  label: string;
}

export function isExternalAccessTokenCreated(msg: unknown): msg is ExternalAccessTokenCreated {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ExternalAccessTokenCreated).type === 'externalAccessTokenCreated';
}

// ── External Access Admin Commands (WebSocket client → server) ──────

/** Create a new external access token. */
export interface CreateExternalAccessToken {
  type: 'createExternalAccessToken';
  label: string;
}

export function isCreateExternalAccessToken(msg: unknown): msg is CreateExternalAccessToken {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as CreateExternalAccessToken;
  return m.type === 'createExternalAccessToken' && typeof m.label === 'string' && m.label.length > 0;
}

/** Revoke (delete) an external access token. */
export interface RevokeExternalAccessToken {
  type: 'revokeExternalAccessToken';
  id: string;
}

export function isRevokeExternalAccessToken(msg: unknown): msg is RevokeExternalAccessToken {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RevokeExternalAccessToken;
  return m.type === 'revokeExternalAccessToken' && typeof m.id === 'string';
}

// ── Station Test Port Mode ─────────────────────────────────────────

export interface WpaKeyCheckResult {
  band: '6GHz' | '2.4GHz';
  status: 'pass' | 'mismatch' | 'unknown';
  message: string;
}

/** Per-station test port mode state, wrapping the underlying RobotTestState. */
export interface StationTestState {
  type: 'stationTestState';
  station: StationName;
  /** The underlying robot test state (without the top-level type discriminator). */
  testState: Omit<RobotTestState, 'type'>;
  /** VLAN ID of the port being used. */
  portVlanId: number;
  /** Human-readable port name (e.g. "Port A"). */
  portName: string;
  /** Per-band WPA key check results — populated once radio checks complete. */
  wpaKeyChecks?: WpaKeyCheckResult[];
  /** Seconds remaining before test mode auto-exits due to inactivity. */
  timeoutRemaining: number;
  /** Epoch ms when test mode was started. */
  startedAt: number;
}

export function isStationTestState(msg: unknown): msg is StationTestState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationTestState).type === 'stationTestState';
}

/** Client → server: request to start test port mode for a station. */
export interface StationTestModeRequest {
  type: 'stationTestModeRequest';
  station: StationName;
  portVlanId: number;
}

export function isStationTestModeRequest(msg: unknown): msg is StationTestModeRequest {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationTestModeRequest;
  return (
    m.type === 'stationTestModeRequest' &&
    typeof m.station === 'string' &&
    StationNameList.includes(m.station) &&
    typeof m.portVlanId === 'number'
  );
}

/** Client → server: request to stop test port mode for a station. */
export interface StationTestModeStop {
  type: 'stationTestModeStop';
  station: StationName;
}

export function isStationTestModeStop(msg: unknown): msg is StationTestModeStop {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationTestModeStop;
  return m.type === 'stationTestModeStop' && typeof m.station === 'string' && StationNameList.includes(m.station);
}

/** Client → server: configure a robot radio via station test port mode. */
export interface StationRadioConfigureRequest {
  type: 'stationRadioConfigureRequest';
  station: StationName;
  teamNumber: number;
  /** WPA passphrase for the 6 GHz band. */
  wpaKey6: string;
  /** WPA passphrase for the 2.4 GHz band. Defaults to wpaKey6 if omitted. */
  wpaKey24?: string;
  /** SSID suffix appended after the team number. */
  ssidSuffix?: string;
}

export function isStationRadioConfigureRequest(msg: unknown): msg is StationRadioConfigureRequest {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationRadioConfigureRequest;
  return (
    m.type === 'stationRadioConfigureRequest' &&
    typeof m.station === 'string' &&
    StationNameList.includes(m.station) &&
    typeof m.teamNumber === 'number' &&
    typeof m.wpaKey6 === 'string'
  );
}

/** Client → server: firmware update via station test port mode. */
export interface StationFirmwareUpdateRequest {
  type: 'stationFirmwareUpdateRequest';
  station: StationName;
  wpaKey?: string;
  wpaKey24?: string;
  skipReconfigure?: boolean;
}

export function isStationFirmwareUpdateRequest(msg: unknown): msg is StationFirmwareUpdateRequest {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationFirmwareUpdateRequest;
  return (
    m.type === 'stationFirmwareUpdateRequest' && typeof m.station === 'string' && StationNameList.includes(m.station)
  );
}

// ── Audio Device Management ────────────────────────────────────────

/** Info about an available ALSA audio device. */
export interface AudioDeviceInfo {
  /** Card index (e.g. 1) */
  cardIndex: number;
  /** Short name in brackets from /proc/asound/cards (e.g. "Audio") */
  shortName: string;
  /** Driver name (e.g. "USB-Audio") */
  driver: string;
  /** Long descriptive name (e.g. "AB13X USB Audio") */
  name: string;
  /** ALSA device string for playback (e.g. "plughw:1,0") */
  alsaDevice: string;
}

/** Server → Client: audio device state broadcast. */
export interface AudioDeviceState {
  type: 'audioDeviceState';
  /** All currently available audio devices */
  available: AudioDeviceInfo[];
  /** The device name the user has locked to (null = disabled) */
  selectedDeviceName: string | null;
  /** Resolved ALSA device string if the selected device is currently connected */
  resolvedDevice: string | null;
  /** Current status */
  status: 'active' | 'disconnected' | 'disabled';
}

export function isAudioDeviceState(msg: unknown): msg is AudioDeviceState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as AudioDeviceState).type === 'audioDeviceState';
}

/** Client → Server: select an audio device by name (null to disable). */
export interface SaveAudioDeviceConfig {
  type: 'saveAudioDeviceConfig';
  deviceName: string | null;
}

export function isSaveAudioDeviceConfig(msg: unknown): msg is SaveAudioDeviceConfig {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as SaveAudioDeviceConfig;
  return m.type === 'saveAudioDeviceConfig' && (m.deviceName === null || typeof m.deviceName === 'string');
}

/** Client → Server: play a test sound. */
export interface TestAudioDevice {
  type: 'testAudioDevice';
}

export function isTestAudioDevice(msg: unknown): msg is TestAudioDevice {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TestAudioDevice).type === 'testAudioDevice';
}

/** Client → Server: refresh the list of available audio devices. */
export interface RefreshAudioDevices {
  type: 'refreshAudioDevices';
}

export function isRefreshAudioDevices(msg: unknown): msg is RefreshAudioDevices {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RefreshAudioDevices).type === 'refreshAudioDevices';
}

// ── Match History ──────────────────────────────────────────────────

export interface MatchHistoryTeam {
  station: StationName;
  teamNumber: number;
  alliance: Alliance;
  matchSlot: MatchSlot | null;
}

/** Final score for one alliance as determined by a human reviewing the match video. */
export interface MatchReviewResult {
  /** Total balls scored, as counted by the reviewer. */
  score: number;
  /** Portion of the score from the autonomous period (if the reviewer split it out). */
  autoScore?: number;
  /** Display name of the human reviewer. */
  reviewer: string;
  /** When the review was submitted (ms since epoch). */
  reviewedAt: number;
}

export interface MatchHistoryEntry {
  matchNumber: number;
  /** Unique id linking this match to external recordings/reviews. Absent on pre-upgrade entries. */
  matchId?: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  endReason: MatchEndReason;
  autoWinner: Alliance | null;
  teams: MatchHistoryTeam[];
  redScore: number;
  blueScore: number;
  /** Human-reviewed final scores per alliance (from video review). Live scores above are never overwritten. */
  review?: Partial<Record<Alliance, MatchReviewResult>>;
  /** URL of the external video-review page for this match, registered when a recording is available. */
  reviewUrl?: string;
}

export interface MatchHistoryState {
  type: 'matchHistoryState';
  matches: MatchHistoryEntry[];
}

export function isMatchHistoryState(msg: unknown): msg is MatchHistoryState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MatchHistoryState).type === 'matchHistoryState';
}

/** HTTP body for POST /api/match-review — a human reviewer's final score for one alliance. */
export interface MatchReviewSubmission {
  matchId: string;
  alliance: Alliance;
  score: number;
  autoScore?: number;
  reviewer: string;
}

export function isMatchReviewSubmission(msg: unknown): msg is MatchReviewSubmission {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchReviewSubmission;
  if (typeof m.matchId !== 'string' || !m.matchId) return false;
  if (m.alliance !== 'red' && m.alliance !== 'blue') return false;
  if (typeof m.score !== 'number' || !Number.isFinite(m.score) || m.score < 0) return false;
  if (
    m.autoScore !== undefined &&
    (typeof m.autoScore !== 'number' || !Number.isFinite(m.autoScore) || m.autoScore < 0)
  )
    return false;
  if (typeof m.reviewer !== 'string' || !m.reviewer) return false;
  return true;
}

/** HTTP body for POST /api/match-review/recording — an external system registering
 *  the video-review page URL for a recorded match. */
export interface MatchRecordingRegistration {
  matchId: string;
  url: string;
}

export function isMatchRecordingRegistration(msg: unknown): msg is MatchRecordingRegistration {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchRecordingRegistration;
  if (typeof m.matchId !== 'string' || !m.matchId) return false;
  if (typeof m.url !== 'string' || !/^https?:\/\//.test(m.url)) return false;
  return true;
}

/** Client → Server: clear match history. */
export interface ClearMatchHistory {
  type: 'clearMatchHistory';
}

export function isClearMatchHistory(msg: unknown): msg is ClearMatchHistory {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ClearMatchHistory).type === 'clearMatchHistory';
}

// ── Field Usage Tracking ───────────────────────────────────────────

export interface UsageSession {
  team: number;
  station: StationName;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
}

export interface UsageState {
  type: 'usageState';
  sessions: UsageSession[];
}

export function isUsageState(msg: unknown): msg is UsageState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as UsageState).type === 'usageState';
}
