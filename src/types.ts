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
  /** Video streams pFMS records for every match (see MatchRecorder). */
  recordingStreams?: RecordingStreamConfig[];
  /** Days to keep match recordings before the sweep deletes them. */
  recordingRetentionDays?: number;
  /** Whether robots NOT in a match can be enabled from their own Driver
   *  Station (pFMS sends a "not in match" release so the DS keeps local
   *  control). Absent/true = on; set false via the admin switch to hold
   *  not-in-match robots disabled. */
  outOfMatchControl?: boolean;
  /** Field policy on robot control systems. 'none' (default) says nothing to
   *  teams; 'preferSystemCore' warns roboRIO teams; the block modes fail the
   *  robot check for the disallowed control system. */
  controllerPolicy?: ControllerPolicy;
  /** Address this field is reachable at from anywhere, e.g.
   *  `https://pfms.example.org` — used to build the post-match QR link. */
  publicUrl?: string;
  /** Long-term timelapse of the field: a few archival frames a day, plus a
   *  fast timelapse while robots are here. Absent = off. */
  timelapse?: TimelapseConfig;
}

/** One video source pFMS records during matches. Anything ffmpeg can read
 *  (RTSP from the field's stitchd/MediaMTX, an HLS or HTTP stream, …). */
export interface RecordingStreamConfig {
  /** Short label, also used in file names ("all-field", "Field cam"). */
  name: string;
  url: string;
  enabled: boolean;
}

export function isRecordingStreamConfig(v: unknown): v is RecordingStreamConfig {
  const c = v as RecordingStreamConfig;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.name === 'string' &&
    c.name.trim().length > 0 &&
    c.name.length <= 40 &&
    typeof c.url === 'string' &&
    isStreamSourceUrl(c.url) &&
    typeof c.enabled === 'boolean'
  );
}

// ── Long-term timelapse ─────────────────────────────────────────────

/**
 * An HTTP call pFMS makes either side of a scheduled timelapse frame, so the
 * field can be lit the same way in every archival frame.
 *
 * Deliberately generic rather than a Home Assistant integration: the pre
 * action drives the lights to a known level, the post action puts them back,
 * and pFMS does not need to know which of Home Assistant, Hue, Shelly or a
 * shop-specific endpoint is on the other end. `headers` is where a bearer
 * token goes, so header values are treated as secrets: they are replaced with
 * `SECRET_KEPT` on the way out to clients and restored on the way back in
 * (see `redactSetupSettings`). Without that they would ride along in the
 * `setupConfigState` every station page receives on connect.
 */
export interface TimelapseAction {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  /** Request body, sent as `application/json` unless `headers` says otherwise. */
  body?: string;
}

export function isTimelapseAction(v: unknown): v is TimelapseAction {
  const a = v as TimelapseAction;
  if (typeof a !== 'object' || a === null) return false;
  if (a.method !== 'GET' && a.method !== 'POST' && a.method !== 'PUT') return false;
  if (typeof a.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(a.url) || a.url.length > 500) return false;
  if (a.headers !== undefined) {
    if (typeof a.headers !== 'object' || a.headers === null || Array.isArray(a.headers)) return false;
    const entries = Object.entries(a.headers);
    if (entries.length > 10) return false;
    // A header name with a newline in it would let one setting inject others.
    if (!entries.every(([k, v]) => /^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)))
      return false;
  }
  if (a.body !== undefined && (typeof a.body !== 'string' || a.body.length > 4000)) return false;
  return true;
}

/**
 * How the lights are driven around an archival frame.
 *
 * Two ways in, because they suit different people:
 *
 *  - `homeAssistant` is the managed one. Point pFMS at Home Assistant, give
 *    it a token, tick the lights you want on, and it builds the calls: it
 *    snapshots the current state, turns your entities on, and restores the
 *    snapshot afterwards. It expands light *groups* to their members for the
 *    snapshot, because a group's state is derived — restoring the group
 *    would turn on members that were deliberately off.
 *  - `http` is the escape hatch: your own list of calls, run in order. Hue,
 *    Shelly, a relay board, a shell script behind a webhook — anything that
 *    answers HTTP, with no support needed from pFMS.
 */
export type TimelapseLights =
  | { mode: 'none' }
  | { mode: 'http'; preActions?: TimelapseAction[]; postActions?: TimelapseAction[] }
  | {
      /**
       * Home Assistant owns the whole sequence; pFMS holds no credential.
       *
       * pFMS posts to `startWebhookId` with a nonce; the automation records
       * the light state, turns the lights on, waits for them to report on,
       * and calls pFMS back at `/api/timelapse/lights-ready` with that nonce.
       * pFMS shoots the moment the callback lands (or after
       * `readyTimeoutSeconds`, recording the lights as failed), then posts to
       * `doneWebhookId` so the automation restores what it recorded.
       *
       * The webhook ids are the only secret, and each is a capability for one
       * automation rather than a key to the whole house — so they are masked
       * on the way out to clients exactly like a token.
       */
      mode: 'haWebhook';
      baseUrl: string;
      /**
       * Connect to this address instead of resolving `baseUrl`'s host —
       * curl's `--resolve`. TLS is still verified against the hostname, so
       * an `https://` URL stays a real certificate check.
       *
       * Why it exists: Home Assistant decides a webhook is "local" from the
       * client address, and only private/loopback/link-local count. A LAN
       * that runs IPv6 hands out globally-scoped addresses, so a request
       * from the next rack over is judged remote and dropped — with a 200
       * and nothing but a line in HA's log. Pinning the connection to the
       * v4 address keeps the pretty https:// name and lands the request
       * from a private address.
       */
      connectAddress?: string;
      startWebhookId: string;
      doneWebhookId?: string;
      /** How long to wait for "the lights are on" before shooting anyway. */
      readyTimeoutSeconds: number;
      /** Where HA should call back. Not used by the server — it only fills in
       *  the ready-to-paste YAML in the admin panel. */
      callbackUrl?: string;
    }
  | {
      mode: 'homeAssistant';
      /** Base URL, e.g. `http://homeassistant.local:8123`. */
      baseUrl: string;
      /** Long-lived access token. Masked on the way out to clients, like any
       *  other secret in the settings. */
      token?: string;
      /** What to turn on. Groups are fine — they are expanded for the
       *  snapshot so per-fixture state survives the restore. */
      entityIds: string[];
    };

/** Scene pFMS creates to hold the pre-capture light state. */
export const TIMELAPSE_RESTORE_SCENE = 'pfms_timelapse_restore';

export function isTimelapseLights(v: unknown): v is TimelapseLights {
  const l = v as TimelapseLights;
  if (typeof l !== 'object' || l === null) return false;
  if (l.mode === 'none') return true;
  if (l.mode === 'http') {
    const ok = (a: unknown[] | undefined) =>
      a === undefined || (Array.isArray(a) && a.length <= 4 && a.every(isTimelapseAction));
    return ok(l.preActions) && ok(l.postActions);
  }
  if (l.mode === 'haWebhook') {
    const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
    return (
      typeof l.baseUrl === 'string' &&
      /^https?:\/\/[^\s]+$/.test(l.baseUrl) &&
      l.baseUrl.length <= 300 &&
      id(l.startWebhookId) &&
      (l.doneWebhookId === undefined || id(l.doneWebhookId)) &&
      (l.connectAddress === undefined ||
        (typeof l.connectAddress === 'string' && /^[0-9a-fA-F.:]{3,45}$/.test(l.connectAddress))) &&
      typeof l.readyTimeoutSeconds === 'number' &&
      l.readyTimeoutSeconds >= 1 &&
      l.readyTimeoutSeconds <= 120 &&
      (l.callbackUrl === undefined ||
        (typeof l.callbackUrl === 'string' && /^https?:\/\/[^\s]+$/.test(l.callbackUrl) && l.callbackUrl.length <= 300))
    );
  }
  if (l.mode === 'homeAssistant') {
    return (
      typeof l.baseUrl === 'string' &&
      /^https?:\/\/[^\s]+$/.test(l.baseUrl) &&
      l.baseUrl.length <= 300 &&
      (l.token === undefined || (typeof l.token === 'string' && l.token.length <= 2000 && !/[\r\n]/.test(l.token))) &&
      Array.isArray(l.entityIds) &&
      l.entityIds.length <= 100 &&
      l.entityIds.every(e => typeof e === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(e))
    );
  }
  return false;
}

/** How the fast (robots-present) timelapse samples the stream. `keyframes`
 *  decodes only keyframes — a fifth of the CPU of `everySecond`, at whatever
 *  rate the source's GOP gives (0.5 fps on the stitched field stream). */
export type TimelapseActiveMode = 'keyframes' | 'everySecond';

export interface TimelapseConfig {
  enabled: boolean;
  /** Local clock times ("HH:MM") for the daily archival frames. */
  dailyTimes: string[];
  /** Also run the fast timelapse while robots are on the field. */
  captureWhileRobotsPresent: boolean;
  activeMode: TimelapseActiveMode;
  /** x264 quality for the fast timelapse: lower is better and bigger. */
  activeCrf: number;
  /** Width the fast timelapse is scaled to; height follows the aspect. */
  activeWidth: number;
  /** Days to keep the fast-timelapse chunks. */
  activeRetentionDays: number;
  /** Days to keep the daily archival frames; 0 keeps them forever. */
  frameRetentionDays: number;
  /** How the lights are driven around each archival frame. */
  lights: TimelapseLights;
  /** Seconds between turning the lights on and the shutter, for them to
   *  settle (and for a fluorescent to come up to colour). */
  settleSeconds: number;
}

/**
 * Stand-in for a stored secret in settings sent to clients.
 *
 * `setupConfigState` goes to every internal client on connect — station pages
 * included, and those are not authenticated. Anything secret in the settings
 * therefore has to be masked on the way out. A client that sends this value
 * back is saying "leave that one alone", which is what lets the admin page
 * edit the rest of an action without ever holding the token.
 */
export const SECRET_KEPT = '••• unchanged •••';

/** The settings with every secret masked, safe to send to clients. */
export function redactSetupSettings(settings: SetupSettings): SetupSettings {
  const lights = settings.timelapse?.lights;
  if (!lights || lights.mode === 'none') return settings;

  let masked: TimelapseLights;
  if (lights.mode === 'haWebhook') {
    masked = {
      ...lights,
      startWebhookId: SECRET_KEPT,
      doneWebhookId: lights.doneWebhookId === undefined ? undefined : SECRET_KEPT,
    };
  } else if (lights.mode === 'homeAssistant') {
    if (lights.token === undefined) return settings;
    masked = { ...lights, token: SECRET_KEPT };
  } else {
    const maskAction = (action: TimelapseAction): TimelapseAction => {
      if (!action.headers) return action;
      const headers: Record<string, string> = {};
      for (const name of Object.keys(action.headers)) headers[name] = SECRET_KEPT;
      return { ...action, headers };
    };
    const anySecret = [...(lights.preActions ?? []), ...(lights.postActions ?? [])].some(a => a.headers !== undefined);
    if (!anySecret) return settings;
    masked = {
      ...lights,
      preActions: lights.preActions?.map(maskAction),
      postActions: lights.postActions?.map(maskAction),
    };
  }
  return { ...settings, timelapse: { ...settings.timelapse!, lights: masked } };
}

/**
 * Put the real secrets back into a patch from a client, matching them up with
 * what is already stored. A masked value with nothing stored behind it is
 * dropped rather than saved as the mask — the alternative is sending
 * `••• unchanged •••` to Home Assistant as a bearer token.
 */
export function restoreSetupSecrets(patch: Partial<SetupSettings>, stored: SetupSettings): Partial<SetupSettings> {
  const lights = patch.timelapse?.lights;
  if (!lights || lights.mode === 'none') return patch;
  const old = stored.timelapse?.lights;

  let restored: TimelapseLights;
  if (lights.mode === 'haWebhook') {
    const previous = old?.mode === 'haWebhook' ? old : undefined;
    const keep = (incoming: string | undefined, stored: string | undefined) =>
      incoming === SECRET_KEPT ? stored : incoming;
    restored = {
      ...lights,
      startWebhookId: keep(lights.startWebhookId, previous?.startWebhookId) ?? '',
      doneWebhookId: keep(lights.doneWebhookId, previous?.doneWebhookId),
    };
  } else if (lights.mode === 'homeAssistant') {
    const oldToken = old?.mode === 'homeAssistant' ? old.token : undefined;
    restored = lights.token === SECRET_KEPT ? { ...lights, token: oldToken } : lights;
  } else {
    const unmask = (incoming: TimelapseAction, previous: TimelapseAction | undefined): TimelapseAction => {
      if (!incoming.headers) return incoming;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== SECRET_KEPT) headers[name] = value;
        else if (previous?.headers?.[name] !== undefined) headers[name] = previous.headers[name];
      }
      return { ...incoming, headers: Object.keys(headers).length > 0 ? headers : undefined };
    };
    // Matched up by position: the admin page edits a list in place, so call n
    // of the patch is call n of what is stored.
    const oldHttp = old?.mode === 'http' ? old : undefined;
    restored = {
      ...lights,
      preActions: lights.preActions?.map((a, i) => unmask(a, oldHttp?.preActions?.[i])),
      postActions: lights.postActions?.map((a, i) => unmask(a, oldHttp?.postActions?.[i])),
    };
  }
  return { ...patch, timelapse: { ...patch.timelapse!, lights: restored } };
}

export const TIMELAPSE_DEFAULTS: TimelapseConfig = {
  enabled: false,
  dailyTimes: ['09:00', '13:00', '17:00'],
  captureWhileRobotsPresent: true,
  activeMode: 'keyframes',
  activeCrf: 30,
  activeWidth: 1920,
  activeRetentionDays: 60,
  frameRetentionDays: 0,
  lights: { mode: 'none' },
  settleSeconds: 5,
};

/** "HH:MM" on a 24-hour clock. */
export function isTimeOfDay(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export function isTimelapseConfig(v: unknown): v is TimelapseConfig {
  const c = v as TimelapseConfig;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.enabled === 'boolean' &&
    Array.isArray(c.dailyTimes) &&
    c.dailyTimes.length <= 24 &&
    c.dailyTimes.every(isTimeOfDay) &&
    typeof c.captureWhileRobotsPresent === 'boolean' &&
    (c.activeMode === 'keyframes' || c.activeMode === 'everySecond') &&
    typeof c.activeCrf === 'number' &&
    Number.isInteger(c.activeCrf) &&
    c.activeCrf >= 14 &&
    c.activeCrf <= 40 &&
    typeof c.activeWidth === 'number' &&
    Number.isInteger(c.activeWidth) &&
    c.activeWidth >= 320 &&
    c.activeWidth <= 3840 &&
    typeof c.activeRetentionDays === 'number' &&
    Number.isInteger(c.activeRetentionDays) &&
    c.activeRetentionDays >= 1 &&
    c.activeRetentionDays <= 3650 &&
    typeof c.frameRetentionDays === 'number' &&
    Number.isInteger(c.frameRetentionDays) &&
    c.frameRetentionDays >= 0 &&
    c.frameRetentionDays <= 3650 &&
    isTimelapseLights(c.lights) &&
    typeof c.settleSeconds === 'number' &&
    c.settleSeconds >= 0 &&
    c.settleSeconds <= 120
  );
}

/**
 * URLs a match recording may be pulled from. Unlike `isPrivateHostUrl` this
 * accepts hostnames: the setting is admin-gated, and the only thing pFMS does
 * with it is open an outbound ffmpeg pull — nothing secret is sent to it.
 * Non-network schemes (file:, pipe:, concat:) are refused so a stream entry
 * can't be turned into a local file read.
 */
export function isStreamSourceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['rtsp:', 'rtsps:', 'http:', 'https:', 'rtmp:', 'srt:', 'udp:'].includes(url.protocol)) return false;
  if (!url.hostname) return false;
  return value.length <= 512;
}

/** What this field wants teams to run. Advisory: it drives the robot check's
 *  verdict, it does not stop a robot from connecting. */
/** Which control system answered on a team's subnet. */
export type RobotController = 'roboRIO' | 'systemcore';

export type ControllerPolicy = 'none' | 'preferSystemCore' | 'blockRoboRIO' | 'blockSystemCore';

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
  recordingStreams: v => Array.isArray(v) && v.length <= 8 && v.every(isRecordingStreamConfig),
  recordingRetentionDays: v => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365,
  outOfMatchControl: v => typeof v === 'boolean',
  controllerPolicy: v => v === 'none' || v === 'preferSystemCore' || v === 'blockRoboRIO' || v === 'blockSystemCore',
  publicUrl: v => typeof v === 'string' && /^https?:\/\/[^\s/]+$/.test(v),
  timelapse: isTimelapseConfig,
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

/** What kind of thing the field is running.
 *  - `official` — a REBUILT match on official timing. The only format whose
 *    durations are fixed and non-negotiable.
 *  - `challenge` — a field event ("speed challenge", obstacle course): robots
 *    are enabled for a host-chosen window with no auto, no shifts and no
 *    endgame. Laps and penalties are tallied by hand. */
export type MatchFormat = 'official' | 'challenge';

/** How a challenge run is timed.
 *  - `window` — the clock counts down from the configured duration and the
 *    buzzer ends it. "How many laps in X seconds."
 *  - `stopwatch` — the clock counts up and staff press Finish; the duration
 *    is a cap, and running it out is a DNF. */
export type ChallengeTiming = 'window' | 'stopwatch';

/** Bounds on a challenge window. Long enough to be a real run, short enough
 *  that a forgotten stopwatch run doesn't hold the field all afternoon. */
export const CHALLENGE_MIN_DURATION = 10;
export const CHALLENGE_MAX_DURATION = 300;
export const CHALLENGE_DEFAULT_DURATION = 60;

/** What one penalty costs when nobody has said otherwise: a lap in window
 *  timing, five seconds on the clock in stopwatch timing. Both are settable
 *  per run — see `challengePenaltyLaps` / `challengePenaltySeconds`. */
export const CHALLENGE_PENALTY_LAPS = 1;
export const CHALLENGE_PENALTY_SECONDS = 5;

/** Bounds on the penalty cost. Zero is deliberately allowed: staff may want to
 *  count fouls without them changing the result. */
export const CHALLENGE_MAX_PENALTY_LAPS = 10;
export const CHALLENGE_MAX_PENALTY_SECONDS = 60;

/** The cost of one penalty, in each timing's own unit. */
export type ChallengePenalties = {
  penaltyLaps: number;
  penaltySeconds: number;
};

/** Resolve the penalty costs in force, from a config or a recorded run.
 *  Anything absent or nonsensical falls back to the default, so a record
 *  written before these were settable still scores the way it did then. */
export function challengePenalties(source: Partial<ChallengePenalties> | undefined): ChallengePenalties {
  const clamp = (value: number | undefined, fallback: number, max: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value!))) : fallback;
  return {
    penaltyLaps: clamp(source?.penaltyLaps, CHALLENGE_PENALTY_LAPS, CHALLENGE_MAX_PENALTY_LAPS),
    penaltySeconds: clamp(source?.penaltySeconds, CHALLENGE_PENALTY_SECONDS, CHALLENGE_MAX_PENALTY_SECONDS),
  };
}

export type MatchConfig = {
  autoDuration: number;
  teleopDuration: number;
  endgameDuration: number;
  pauseDuration: number;
  skipAuto?: boolean;
  autoWinner?: AutoWinnerMode;
  /** Absent means `official` — every match that predates the challenge format. */
  format?: MatchFormat;
  /** Only meaningful when `format` is `challenge`. Absent means `window`. */
  challengeTiming?: ChallengeTiming;
  /** What one penalty costs a window run, in laps. Absent means the default. */
  challengePenaltyLaps?: number;
  /** What one penalty costs a stopwatch run, in seconds. Absent means the default. */
  challengePenaltySeconds?: number;
};

/** True for anything that isn't a regulation match. Centralised so the
 *  display code never has to spell out the default-is-official rule. */
export function isChallengeConfig(config: Pick<MatchConfig, 'format'> | undefined): boolean {
  return config?.format === 'challenge';
}

/** One alliance's challenge run, as tallied by field staff. */
export type ChallengeTally = {
  laps: number;
  penalties: number;
  /** Seconds into the run when staff pressed Finish (stopwatch timing only).
   *  Absent means still running, or — once the run is over — a DNF. */
  finishedAt?: number;
};

/** What an alliance's run is worth, for ranking and display. Window runs
 *  score in laps (higher is better); stopwatch runs score in seconds (lower
 *  is better), and an unfinished one has no time at all. */
export function challengeScore(
  tally: ChallengeTally | undefined,
  timing: ChallengeTiming | undefined,
  /** The costs in force for this run — its own recorded ones for a finished
   *  run, the live config for one still going. */
  costs?: Partial<ChallengePenalties>,
): { laps: number; seconds: number | null } {
  const { penaltyLaps, penaltySeconds } = challengePenalties(costs);
  const laps = (tally?.laps ?? 0) - (tally?.penalties ?? 0) * penaltyLaps;
  if (timing !== 'stopwatch') return { laps, seconds: null };
  if (tally?.finishedAt === undefined) return { laps, seconds: null };
  return { laps, seconds: tally.finishedAt + (tally.penalties ?? 0) * penaltySeconds };
}

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
  /** Set when the field's control-system policy forbids this robot: why it
   *  cannot be enabled. The field holds it disabled in and out of matches. */
  blockedReason?: string;
  /** Epoch ms when this team took this station — when its SSID became the
   *  station's active radio config. Unlike the DS/radio heartbeats this is a
   *  connect *time*, so it survives a robot dropping and coming back, which
   *  makes it the stable sort key for "who has been on the field longest".
   *  Undefined for an empty slot, or for a config restored from a file
   *  written before pFMS tracked this. */
  connectedAt?: number;
  /** Epoch ms the field last enabled this station (match start, resume, or an
   *  admin/self re-enable). Stays set after the robot is disabled again, so
   *  it reads as "last drove at". Undefined if never enabled. */
  lastEnabledAt?: number;
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
  /** UDP port match control packets are sent to (1121 for the legacy DS; the
   *  2027 DS names its own, changing on every reconnect) */
  udpPort?: number;
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
  /** Share token for this match's public summary/video page (see
   *  publicMatchApi). Minted with matchId; the scoreboard shows it as a QR
   *  code after the match. */
  shareToken?: string;
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
  /** Live lap/penalty tally, present only while the field is set up for or
   *  running a challenge. Both alliances are always present, even when only
   *  one is on the field — the host page decides what to show. */
  challenge?: Record<Alliance, ChallengeTally>;
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
  if (m.config.format !== undefined && !['official', 'challenge'].includes(m.config.format)) return false;
  if (m.config.challengeTiming !== undefined && !['window', 'stopwatch'].includes(m.config.challengeTiming))
    return false;
  if (m.config.challengePenaltyLaps !== undefined && !Number.isFinite(m.config.challengePenaltyLaps)) return false;
  if (m.config.challengePenaltySeconds !== undefined && !Number.isFinite(m.config.challengePenaltySeconds))
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

/** Staff adjust an alliance's challenge tally: laps completed, penalties
 *  taken. Deltas, not totals — two people may be tapping at once, and a
 *  delta can't clobber the other's count. */
export type MatchChallengeAdjust = {
  type: 'matchChallengeAdjust';
  alliance: Alliance;
  laps?: number;
  penalties?: number;
};
export function isMatchChallengeAdjust(msg: unknown): msg is MatchChallengeAdjust {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchChallengeAdjust;
  if (m.type !== 'matchChallengeAdjust') return false;
  if (m.alliance !== 'red' && m.alliance !== 'blue') return false;
  if (m.laps !== undefined && !Number.isFinite(m.laps)) return false;
  if (m.penalties !== undefined && !Number.isFinite(m.penalties)) return false;
  return true;
}

/** Staff stop the clock for one alliance in a stopwatch challenge. */
export type MatchChallengeFinish = { type: 'matchChallengeFinish'; alliance: Alliance };
export function isMatchChallengeFinish(msg: unknown): msg is MatchChallengeFinish {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as MatchChallengeFinish;
  return m.type === 'matchChallengeFinish' && (m.alliance === 'red' || m.alliance === 'blue');
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
  /** Kernel neighbor (ARP) table occupancy — a full table silently drops
   *  packets to any host without an entry (2026-09-13 scrimmage). */
  neighborTable?: NeighborTableStats;
}

export interface NeighborTableStats {
  /** IPv4 entries currently in the table (all states). */
  entries: number;
  /** Hard ceiling (`net.ipv4.neigh.default.gc_thresh3`); new entries fail above it. */
  limit: number;
  /** Entries per interface, largest first. The device scanner accounts for
   *  ~250 per configured team slot; a slot far above that has a chatty network. */
  byInterface: Record<string, number>;
  /** Times the kernel reported "neighbor table overflow" since pFMS started. */
  overflows: number;
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
  /** Staged changes per station. null = staged clear, absent = no staged change.
   *  Deliberately carries no WPA key — clients only need to describe the change. */
  stagedChanges?: Record<string, StagedStationChange | null>;
  /** True when an immediate change was held back (e.g. a match was running)
   *  and the current configuration still needs to be re-applied to the radio. */
  deferred?: boolean;
};

export type StagedStationChange = {
  ssid: string;
  internetAccess?: boolean;
  /** A WPA key is staged with it (the key itself never leaves the server). */
  secured: boolean;
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
  /** Which control system answered, so the field can enforce its policy. */
  controller?: RobotController | null;
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
  /** Public address of this field (PUBLIC_URL / setup `publicUrl`), for share links. */
  publicUrl?: string;
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
   * How long before this request was sent the score actually happened, in
   * milliseconds. The preferred way to report timing: it needs no clock
   * agreement between device and server, and a device that queues or retries
   * just recomputes it at each send. The server attributes the score to the
   * match phase, sub-period and goal-active state at `receiveTime - ageMs`.
   */
  ageMs?: number;
  /**
   * Device-side time the score happened (ms since epoch). Used only when
   * `ageMs` is absent, and only if it is plausible against the server clock
   * (not in the future, not absurdly old); otherwise the receive time is used.
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
  if (m.ageMs !== undefined && typeof m.ageMs !== 'number') return false;
  if (m.timestamp !== undefined && typeof m.timestamp !== 'number') return false;
  return true;
}

/** How a score event's occurrence time was established. */
export type ScoreTiming = 'age' | 'timestamp' | 'receive';

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
  /** Server receive time (ms since epoch) */
  timestamp: number;
  /** Best estimate of when the score actually happened (server clock, ms since epoch).
   *  Drives phase/sub-period/goal-active attribution, dedup, and the free-play window. */
  occurredAt: number;
  /** timestamp − occurredAt: how late the report was */
  lagMs: number;
  /** Where occurredAt came from */
  timing: ScoreTiming;
  /** Device-reported time (ms since epoch), if provided */
  deviceTimestamp?: number;
  matchPhase?: MatchPhase;
  /** Sub-period within the match (auto, transition, shift1-4, endgame) */
  matchSubPeriod?: string;
  /** True if this event was deduplicated (not counted) */
  deduplicated: boolean;
  /** True if the element is restricted to other match phases than the one the ball scored in (not counted) */
  phaseRestricted?: boolean;
  /** True if the alliance's goal was off (shift or pause, past the grace) when the ball scored */
  goalInactive?: boolean;
  /** True if the ball scored before the match started (idle/created/countdown) — not part of the match at all */
  outsideMatch?: boolean;
}

/** Per-event outcome returned from POST /api/score so devices can see how each report was attributed. */
export interface ScoreEventReceipt {
  status: 'accepted' | 'deduplicated' | 'rejected';
  /** Server-side event id (accepted/deduplicated only) */
  id?: string;
  occurredAt?: number;
  lagMs?: number;
  timing?: ScoreTiming;
  matchPhase?: MatchPhase;
  matchSubPeriod?: string;
  /** Whether the event contributes to the score shown */
  counted?: boolean;
  /** Why it didn't count / was rejected */
  reason?: string;
}

export interface ScoreSubmitResult {
  accepted: number;
  rejected: number;
  deduplicated: number;
  errors: string[];
  /** One entry per submitted event, in order */
  events: ScoreEventReceipt[];
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
  /** How late the most recent event from this source was reported (ms) */
  lastLagMs?: number;
  /** How the most recent event's timing was established */
  lastTiming?: ScoreTiming;
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
  /** Video files pFMS itself recorded for this match (one per configured stream). */
  recordings?: MatchRecording[];
  /** Capability token for the public summary page (`/matches/<token>`)
   *  and `/api/public/match/<token>/…`. Backfilled for older entries. */
  shareToken?: string;
  /** Final per-period points per alliance (auto/teleop/endgame or shift
   *  periods), snapshotted from the scoring engine at match end. */
  periodBreakdown?: Record<string, { red: number; blue: number }>;
  /** Running total score sampled through the match, for the summary chart.
   *  `t` is seconds since the match started. */
  scoreTimeline?: ScoreSample[];
  /** Present only for a speed challenge: how the run was timed and what each
   *  alliance managed. Drives the leaderboard, which is a view over history
   *  rather than a store of its own. */
  challenge?: {
    timing: ChallengeTiming;
    /** The penalty costs in force when this run happened. Recorded rather
     *  than looked up, so changing them mid-event doesn't silently re-score
     *  the morning's runs. Absent on runs from before they were settable. */
    penaltyLaps?: number;
    penaltySeconds?: number;
    tally: Partial<Record<Alliance, ChallengeTally>>;
  };
}

export interface ScoreSample {
  t: number;
  red: number;
  blue: number;
}

/** What `/api/public/match/<token>` returns — everything the post-match
 *  summary page shows, with token-scoped URLs for video and avatars. */
export interface PublicMatchSummary {
  matchNumber: number;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  endReason: MatchEndReason;
  autoWinner: Alliance | null;
  teams: (MatchHistoryTeam & { avatarUrl: string })[];
  redScore: number;
  blueScore: number;
  review?: Partial<Record<Alliance, MatchReviewResult>>;
  reviewUrl?: string;
  periodBreakdown?: Record<string, { red: number; blue: number }>;
  scoreTimeline?: ScoreSample[];
  recordings: {
    name: string;
    file: string;
    bytes: number;
    durationSeconds?: number;
    status: 'ok' | 'partial';
    url: string;
    downloadUrl: string;
  }[];
}

/** One recorded video file for a match, produced by MatchRecorder. */
export interface MatchRecording {
  /** Stream name from RecordingStreamConfig at the time of recording. */
  name: string;
  /** File name inside the match's recording directory (`<slug>.mp4`). */
  file: string;
  bytes: number;
  /** Media duration as reported by ffprobe, when it could be read. */
  durationSeconds?: number;
  startedAt: number;
  endedAt: number;
  /** ok = clean capture; partial = the source dropped at least once mid-match
   *  (parts were joined); failed = nothing usable was captured. */
  status: 'ok' | 'partial' | 'failed';
  error?: string;
}

/** Live status of the match recorder, broadcast to internal clients. */
export interface MatchRecordingState {
  type: 'matchRecordingState';
  /** Recorder available at all (ffmpeg found on this host). */
  available: boolean;
  /** Why the recorder is unavailable, when it is. */
  unavailableReason?: string;
  /** Match currently being recorded, if any. */
  activeMatchId?: string;
  streams: MatchRecordingStreamStatus[];
  retentionDays: number;
  /** Free space on the recordings volume, when readable. */
  diskFreeBytes?: number;
  /** Total size of everything under the recordings directory. */
  usedBytes?: number;
  directory: string;
}

export interface MatchRecordingStreamStatus {
  name: string;
  url: string;
  enabled: boolean;
  status: 'idle' | 'recording' | 'finalizing' | 'error';
  /** Bytes written so far for the active match (recording) or last match. */
  bytes?: number;
  /** Last error from ffmpeg for this stream (cleared on the next clean start). */
  error?: string;
  /** How many times the source dropped and was reconnected in the active match. */
  reconnects?: number;
}

export function isMatchRecordingState(msg: unknown): msg is MatchRecordingState {
  if (!msg || typeof msg !== 'object') return false;
  return (msg as MatchRecordingState).type === 'matchRecordingState';
}

/** Admin asks the server to ffprobe a candidate stream URL before saving it. */
export interface TestRecordingStream {
  type: 'testRecordingStream';
  url: string;
}

export function isTestRecordingStream(msg: unknown): msg is TestRecordingStream {
  const m = msg as TestRecordingStream;
  return m?.type === 'testRecordingStream' && typeof m.url === 'string' && isStreamSourceUrl(m.url);
}

export interface RecordingStreamTestResult {
  type: 'recordingStreamTestResult';
  url: string;
  ok: boolean;
  /** Video codec / size / frame rate when the probe succeeded. */
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** ffprobe's complaint when it failed. */
  error?: string;
  /** How long the probe took — a slow first frame hints at a slow match start. */
  ms: number;
}

export function isRecordingStreamTestResult(msg: unknown): msg is RecordingStreamTestResult {
  if (!msg || typeof msg !== 'object') return false;
  return (msg as RecordingStreamTestResult).type === 'recordingStreamTestResult';
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

// ── Recording metadata (what was happening while a video ran) ──────

/** One robot telemetry sample kept alongside a recording. `t` is server
 *  epoch ms; the fields mirror TelemetryUpdate with the DS status flattened. */
export interface TelemetrySample {
  t: number;
  station: StationName;
  teamNumber?: number;
  batteryVoltage?: number;
  batteryVoltageMin?: number;
  rttMs?: number;
  lostPackets?: number;
  canUtil?: number;
  dsCpuPercent?: number;
  brownout?: boolean;
  enabled?: boolean;
  mode?: 'teleOp' | 'test' | 'auto';
  eStop?: boolean;
  aStop?: boolean;
  robotComms?: boolean;
}

/** `metadata.json` written next to every recording (match or practice run):
 *  every score event the goal sensors reported for the window and the
 *  telemetry of every robot on the field during it. */
export interface RecordingMetadata {
  version: 1;
  kind: 'match' | 'practice';
  /** Directory name under the recordings root (match id or practice run id). */
  id: string;
  matchNumber?: number;
  startedAt: number;
  endedAt: number;
  teams: { station: string; teamNumber: number | null; alliance: string | null }[];
  /** Balls scored while the recording ran, as the scoring engine judged them. */
  scoreEvents: ProcessedScoreEvent[];
  telemetry: TelemetrySample[];
}

// ── Practice recording (record while enabled) ───────────────────────

/** How many seconds of footage to keep before the first enable and after
 *  the last disable of a practice run. */
export const PRACTICE_PAD_SECONDS = 3;

/** A recorded practice run: the field video from a few seconds before one
 *  robot was enabled outside a match to a few seconds after it was
 *  disabled. One robot, one clip — six robots running at once make six. */
export interface PracticeRunEntry {
  /** Directory name under the recordings root (`practice-…`). */
  id: string;
  station: StationName;
  teamNumber: number;
  /** Window the clip covers (enable − pad … disable + pad). */
  startedAt: number;
  endedAt: number;
  recordings: MatchRecording[];
  /** `metadata.json` (score events + telemetry) was written for this run. */
  hasMetadata?: boolean;
}

/** Capability token for one team's practice day (`/practice/<token>`). */
export interface PracticeDayToken {
  token: string;
  teamNumber: number;
  /** Local practice day, `YYYY-MM-DD` (a day rolls over at 04:00, not midnight). */
  day: string;
  createdAt: number;
  /** When the link was posted to the team's Slack contact, if it was. */
  slackPostedAt?: number;
  /** A note that nobody in Slack claims this team was posted to the support channel. */
  noMembersNotedAt?: number;
}

/** Live practice-recording status, broadcast to internal clients. */
export interface PracticeRecordingState {
  type: 'practiceRecordingState';
  /** Teams that ticked "record while enabled". */
  optIn: number[];
  /** ffmpeg is pulling the streams into the ring buffer (an opted-in team is on the field). */
  buffering: boolean;
  /** Robots being recorded right now, one run each. */
  activeRuns: { station: StationName; teamNumber: number; startedAt: number }[];
  /** Why practice recording can't work, when it can't (no streams, no ffmpeg). */
  unavailableReason?: string;
  /** Recent runs, newest last. */
  runs: PracticeRunEntry[];
}

export function isPracticeRecordingState(msg: unknown): msg is PracticeRecordingState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as PracticeRecordingState).type === 'practiceRecordingState';
}

/** Client → Server: a station page ticks/unticks "record while enabled" for its team. */
export interface SetPracticeRecording {
  type: 'setPracticeRecording';
  teamNumber: number;
  enabled: boolean;
}

export function isSetPracticeRecording(msg: unknown): msg is SetPracticeRecording {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as SetPracticeRecording;
  return (
    m.type === 'setPracticeRecording' &&
    Number.isInteger(m.teamNumber) &&
    m.teamNumber > 0 &&
    typeof m.enabled === 'boolean'
  );
}

/** Client → Server: a station page asks for its team's link for today. The
 *  reply is a PracticeDayLink to that client only — tokens are never
 *  broadcast. */
export interface RequestPracticeDayLink {
  type: 'requestPracticeDayLink';
  teamNumber: number;
}

export function isRequestPracticeDayLink(msg: unknown): msg is RequestPracticeDayLink {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RequestPracticeDayLink;
  return m.type === 'requestPracticeDayLink' && Number.isInteger(m.teamNumber) && m.teamNumber > 0;
}

/** Server → one client: the team's practice-day link, or `token: null`
 *  when nothing has been recorded for that team today. */
export interface PracticeDayLink {
  type: 'practiceDayLink';
  teamNumber: number;
  day: string;
  token: string | null;
  /** Recordings (matches + runs) filed under the day so far. */
  count: number;
}

export function isPracticeDayLink(msg: unknown): msg is PracticeDayLink {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as PracticeDayLink).type === 'practiceDayLink';
}

/** What `/api/public/practice/<token>` returns: one team's practice day. */
export interface PublicPracticeDay {
  teamNumber: number;
  day: string;
  /** Human label for the day in the field's local time, e.g. "Fri, Sep 18". */
  dayLabel: string;
  /** Days recordings are kept before the sweep deletes them. */
  retentionDays: number;
  /** Everything in one zip (videos + metadata). */
  zipUrl: string;
  /** Rough size of that zip (sum of the files). */
  zipBytes: number;
  items: PublicPracticeItem[];
}

/** Where the action is inside one recording, for the list's activity strip:
 *  how many balls scored in each slice of the video, and when this team's
 *  robot was actually enabled. Small enough to ship with the listing (a
 *  couple of hundred numbers), so the strip needs no extra fetch. */
export interface RecordingActivity {
  /** Seconds of video each bin covers. */
  binSeconds: number;
  /** Balls that counted in each bin, per alliance. Both are `bins` long. */
  red: number[];
  blue: number[];
  /** Spans (seconds into the video) when this team's robot was enabled. */
  enabled: { from: number; to: number }[];
}

export interface PublicPracticeItem {
  kind: 'match' | 'practice';
  id: string;
  /** Match number for matches; run number within the day for practice. */
  number: number;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  /** Teams on the field during this recording (this one included). */
  teams: { station: string; teamNumber: number; alliance?: Alliance | null }[];
  /** Match result, for matches. */
  redScore?: number;
  blueScore?: number;
  /** Link to the match summary page, for matches. */
  summaryUrl?: string;
  /** Balls counted per alliance during the window, when metadata exists. */
  scored?: Record<Alliance, number>;
  /** Battery range seen for this team during the window, when telemetry was available. */
  battery?: { min: number; max: number };
  /** Scoring density and enabled spans across the video, when metadata exists. */
  activity?: RecordingActivity;
  recordings: {
    name: string;
    file: string;
    bytes: number;
    durationSeconds?: number;
    status: 'ok' | 'partial';
    url: string;
    downloadUrl: string;
  }[];
  /** Token-scoped URLs of the sidecars, when they exist. */
  metadataUrl?: string;
  telemetryCsvUrl?: string;
  scoresCsvUrl?: string;
}

// ── Recordings on disk (admin inventory + eviction) ────────────────

/** One directory under the recordings root, as the admin page lists it. */
export interface RecordingInventoryEntry {
  id: string;
  kind: 'match' | 'practice' | 'other';
  matchNumber?: number;
  startedAt?: number;
  endedAt?: number;
  /** Team numbers this recording is filed under. */
  teams: number[];
  bytes: number;
  /** Stream files that captured something (status ok/partial). */
  videos: number;
  /** The video files in this directory, so an admin can watch or download
   *  them. From the manifest when there is one; otherwise whatever `.mp4`s
   *  are on disk, so an interrupted recording is still reachable. */
  files: RecordingInventoryFile[];
  /** Which of `metadata.json` / `scores.csv` / `telemetry.csv` are present. */
  sidecars: string[];
}

/** One video file inside a recording directory, as listed to an admin. */
export interface RecordingInventoryFile {
  /** Stream name from the recorder's config (`all-field`), or the file's
   *  own slug when there is no manifest to name it. */
  name: string;
  file: string;
  bytes: number;
  durationSeconds?: number;
  status: 'ok' | 'partial' | 'failed';
  /** Why the capture is partial or failed, when the manifest says. */
  error?: string;
}

/** Everything under the recordings root, sent to an admin on request. */
export interface RecordingsInventory {
  type: 'recordingsInventory';
  entries: RecordingInventoryEntry[];
  usedBytes?: number;
  diskFreeBytes?: number;
  retentionDays: number;
  directory: string;
  scannedAt: number;
}

export function isRecordingsInventory(msg: unknown): msg is RecordingsInventory {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RecordingsInventory).type === 'recordingsInventory';
}

/** Admin asks for the inventory (it is scanned on demand, not broadcast). */
export interface RequestRecordingsInventory {
  type: 'requestRecordingsInventory';
}

export function isRequestRecordingsInventory(msg: unknown): msg is RequestRecordingsInventory {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RequestRecordingsInventory).type === 'requestRecordingsInventory';
}

/** Admin deletes one recording directory (match or practice run). */
export interface DeleteRecording {
  type: 'deleteRecording';
  id: string;
}

export function isDeleteRecording(msg: unknown): msg is DeleteRecording {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as DeleteRecording;
  return m.type === 'deleteRecording' && typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(m.id);
}

/** Admin deletes every recording that started before `before` (epoch ms). */
export interface DeleteRecordingsBefore {
  type: 'deleteRecordingsBefore';
  before: number;
}

export function isDeleteRecordingsBefore(msg: unknown): msg is DeleteRecordingsBefore {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as DeleteRecordingsBefore;
  return m.type === 'deleteRecordingsBefore' && Number.isFinite(m.before) && m.before > 0;
}

// ── Long-term timelapse state (admin) ───────────────────────────────

/** One archival frame that was taken (or attempted). */
export interface TimelapseFrameEntry {
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  /** Scheduled time that produced it, `HH:MM`, or `manual`. */
  slot: string;
  at: number;
  /** One per enabled stream. `thumb` is a small copy of the same frame,
   *  written alongside it so a gallery does not have to load 3 MB a tile. */
  files: { stream: string; file: string; thumb?: string; bytes: number }[];
  /** Whether the pre/post actions ran, and what happened if they didn't. */
  lights: 'none' | 'ran' | 'skipped-field-in-use' | 'failed';
  lightsError?: string;
  error?: string;
}

/** One stretch of fast timelapse, from robots arriving to the field going quiet. */
export interface TimelapseSessionEntry {
  day: string;
  startedAt: number;
  endedAt?: number;
  stream: string;
  file: string;
  bytes: number;
  /** Seconds of field time this chunk covers (not its playback length). */
  coveredSeconds?: number;
}

export interface TimelapseState {
  type: 'timelapseState';
  enabled: boolean;
  /** Why nothing can be captured, when that is the case. */
  unavailableReason?: string;
  /** A fast-timelapse encoder is running right now. */
  capturing: boolean;
  /** Robots have been seen recently, so capture is wanted. */
  robotsPresent: boolean;
  /** Next scheduled archival frame (epoch ms), when one is scheduled. */
  nextDailyAt?: number;
  lastFrame?: TimelapseFrameEntry;
  recentFrames: TimelapseFrameEntry[];
  recentSessions: TimelapseSessionEntry[];
  /** Totals on disk, refreshed with the sweep. */
  frameCount: number;
  frameBytes: number;
  sessionBytes: number;
  renderBytes: number;
  directory: string;
  render?: TimelapseRenderState;
  /** Films built so far, newest first. */
  renders: TimelapseRenderFile[];
}

/** A finished film sitting in `renders/`. */
export interface TimelapseRenderFile {
  file: string;
  bytes: number;
  at: number;
}

export function isTimelapseState(msg: unknown): msg is TimelapseState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TimelapseState).type === 'timelapseState';
}

/** A film being built (or the last one built) from the archival frames. */
export interface TimelapseRenderState {
  status: 'running' | 'done' | 'failed';
  /** What it was built from. */
  source?: TimelapseSource;
  file?: string;
  bytes?: number;
  frames?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** Admin takes an archival frame now, outside the schedule. */
export interface CaptureTimelapseFrame {
  type: 'captureTimelapseFrame';
  /** Run the light actions too (the point of a test capture). */
  withActions: boolean;
}

export function isCaptureTimelapseFrame(msg: unknown): msg is CaptureTimelapseFrame {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as CaptureTimelapseFrame;
  return m.type === 'captureTimelapseFrame' && typeof m.withActions === 'boolean';
}

/** What a film is built out of: the archival stills, or the chunks captured
 *  while robots were on the field. */
export type TimelapseSource = 'frames' | 'practice';

/** Admin builds a film from a date range. */
export interface RenderTimelapse {
  type: 'renderTimelapse';
  source: TimelapseSource;
  /** `YYYY-MM-DD`; omitted means "everything". */
  from?: string;
  to?: string;
  /** Frames per second of the finished film. */
  fps: number;
  /** Output height in pixels; the width follows the source aspect. */
  height: number;
  /** Which stream's frames to use (they are captured per stream). */
  stream?: string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function isRenderTimelapse(msg: unknown): msg is RenderTimelapse {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RenderTimelapse;
  return (
    m.type === 'renderTimelapse' &&
    (m.source === 'frames' || m.source === 'practice') &&
    (m.from === undefined || isDay(m.from)) &&
    (m.to === undefined || isDay(m.to)) &&
    Number.isInteger(m.fps) &&
    m.fps >= 1 &&
    m.fps <= 60 &&
    Number.isInteger(m.height) &&
    m.height >= 240 &&
    m.height <= 2160 &&
    (m.stream === undefined || (typeof m.stream === 'string' && m.stream.length <= 60))
  );
}

/** Admin deletes a film that was built earlier. */
export interface DeleteTimelapseRender {
  type: 'deleteTimelapseRender';
  file: string;
}

export function isDeleteTimelapseRender(msg: unknown): msg is DeleteTimelapseRender {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as DeleteTimelapseRender;
  return m.type === 'deleteTimelapseRender' && typeof m.file === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(m.file);
}

/** Everything the timelapse has on disk for a range of days, scanned on
 *  demand (like the recordings inventory) rather than broadcast. */
export interface TimelapseDayListing {
  day: string;
  frames: { slot: string; at: number; stream: string; file: string; thumb?: string; bytes: number }[];
  practice: { file: string; stream: string; at: number; bytes: number }[];
}

export interface TimelapseListing {
  type: 'timelapseListing';
  /** Newest day first. */
  days: TimelapseDayListing[];
  scannedAt: number;
}

export function isTimelapseListing(msg: unknown): msg is TimelapseListing {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TimelapseListing).type === 'timelapseListing';
}

/** Admin asks pFMS to reach Home Assistant and list its lights, to fill the
 *  entity picker and prove the token works. The token may be omitted, in
 *  which case the stored one is used. */
export interface TestTimelapseLights {
  type: 'testTimelapseLights';
  baseUrl: string;
  token?: string;
}

export function isTestTimelapseLights(msg: unknown): msg is TestTimelapseLights {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as TestTimelapseLights;
  return (
    m.type === 'testTimelapseLights' &&
    typeof m.baseUrl === 'string' &&
    /^https?:\/\/[^\s]+$/.test(m.baseUrl) &&
    m.baseUrl.length <= 300 &&
    (m.token === undefined || (typeof m.token === 'string' && m.token.length <= 2000))
  );
}

/** One light Home Assistant knows about, for the picker. */
export interface TimelapseLightEntity {
  entityId: string;
  name: string;
  state: string;
  /** Members, when this is a group. Picking a group is fine; pFMS expands it. */
  members?: string[];
}

export interface TimelapseLightsProbe {
  type: 'timelapseLightsProbe';
  ok: boolean;
  error?: string;
  /** Home Assistant version, when it answered. */
  version?: string;
  lights: TimelapseLightEntity[];
}

export function isTimelapseLightsProbe(msg: unknown): msg is TimelapseLightsProbe {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TimelapseLightsProbe).type === 'timelapseLightsProbe';
}
