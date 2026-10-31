import type { IncomingHttpHeaders } from 'node:http';
import type { DsClientMatch, StationName } from './types.js';

/**
 * Who may send a WebSocket message:
 *
 * - `anyone`: team pages and everything else. Team pages have no login, so
 *   nothing a team page sends may ever move out of this tier.
 * - `staff`: any device that isn't a Driver Station, because a laptop driving
 *   a robot shouldn't also be running the field. Once the field has an operator
 *   code or paired devices, it must also be logged in as an operator. An admin
 *   login overrides both.
 * - `operator`: like `staff` for an operator login, but with none it falls back
 *   to `admin`. For actions that were admin-only before operator logins, so a
 *   field without them doesn't lose its guard.
 * - `admin`: an admin login, or anyone until the field has a passphrase (the
 *   setup wizard's trust-on-first-use window).
 * - `adminOnly`: an admin login, always.
 */
export type MessageAccess = 'anyone' | 'staff' | 'operator' | 'admin' | 'adminOnly';

/** Every message the server acts on. Missing from here means refused. */
const MESSAGE_ACCESS: Record<string, MessageAccess> = {
  // ── Sent by team pages ──────────────────────────────────────────────
  station: 'anyone',
  cancelStationChange: 'anyone',
  internetToggle: 'anyone',
  drive: 'anyone',
  routePreference: 'anyone',
  robotWifiTest: 'anyone',
  saveSavedTeam: 'anyone',
  enableSavedRobot: 'anyone',
  portBridge: 'anyone',
  runTeamChecks: 'anyone',
  queueJoinLine: 'anyone',
  queueLeaveLine: 'anyone',
  teamPrefsGet: 'anyone',
  teamPrefsSet: 'anyone',
  pushSubscribe: 'anyone',
  pushUnsubscribe: 'anyone',
  pushTest: 'anyone',
  setPracticeRecording: 'anyone',
  requestPracticeDayLink: 'anyone',
  stationJoinAlliance: 'anyone',
  stationLeave: 'anyone',
  stationReady: 'anyone',
  stationClearEmptyMatch: 'anyone',
  stationSelfDisable: 'anyone',
  stationSelfUndisable: 'anyone',
  stationSelfEStop: 'anyone',
  stationTeamStop: 'anyone',
  stationSelfAStop: 'anyone',
  stationClearAStop: 'anyone',

  // ── Stops, and clearing them: never refused. A false Driver Station match
  //    must not get in the way of one, and a team may clear its own e-stop
  //    from its Driver Station. ──────────────────────────────────────────
  adminStopMatch: 'anyone',
  matchAbortCountdown: 'anyone',
  stationPauseMatch: 'anyone',
  adminStationDisable: 'anyone',
  adminGlobalEStop: 'anyone',
  adminStationEStop: 'anyone',
  adminClearFieldEStop: 'anyone',
  adminClearEStop: 'anyone',

  // ── Every page ──────────────────────────────────────────────────────
  subscribe: 'anyone',
  unsubscribe: 'anyone',
  submitSupportIssue: 'anyone',
  startSupportChat: 'anyone',
  sendSupportChatMessage: 'anyone',
  endSupportChat: 'anyone',
  createIssueFromChat: 'anyone',
  adminLogin: 'anyone',
  adminCheckAuth: 'anyone',
  adminSetPassphrase: 'anyone', // has its own check: first use, then admin
  operatorLogin: 'anyone', // rate limited in OperatorAuth
  operatorCheckAuth: 'anyone',
  operatorLogout: 'anyone',
  operatorPairRedeem: 'anyone',
  dsClientDismiss: 'anyone',
  requestRecordingsInventory: 'anyone',
  requestSetupProbe: 'anyone',
  castReceiverRegister: 'anyone', // TVs on the leaderboard page use this socket

  // ── Match control and field staff ───────────────────────────────────
  matchCreate: 'staff',
  matchCancel: 'staff',
  matchClear: 'staff',
  matchSwapStation: 'staff',
  matchKickStation: 'staff',
  matchForceStationReady: 'staff',
  matchSetAutoWinner: 'staff',
  matchChallengeAdjust: 'staff',
  matchChallengeFinish: 'staff',
  matchRelayAdvance: 'staff',
  matchRequestReady: 'staff',
  matchStaffIgnore: 'staff',
  matchHoldWifi: 'staff',
  stationStartMatch: 'staff',
  stationResumeMatch: 'staff',
  updateMatchConfig: 'staff',
  adminStationEnable: 'staff',
  staffReady: 'staff',
  staffHeartbeat: 'staff',
  playGetReady: 'staff',
  challengeLeaderboardOnTv: 'staff',
  challengeLeaderboardScope: 'staff',
  applyConfig: 'staff',
  cancelPendingChange: 'staff',

  // ── CSA tools: these reprogram robot radios ─────────────────────────
  stationTestModeRequest: 'staff',
  stationTestModeStop: 'staff',
  stationRadioConfigureRequest: 'staff',
  stationFirmwareUpdateRequest: 'staff',
  firmwareUpdateRequest: 'staff',
  radioConfigureRequest: 'staff',

  // ── The queue card on /match, and adding a device ───────────────────
  queueSetupNext: 'operator',
  queueSkip: 'operator',
  queueReplaceTeam: 'operator',
  queueForm: 'operator',
  operatorPairStart: 'operator',

  // ── Admin and queue pages, and setup ────────────────────────────────
  createApiKey: 'admin',
  revokeApiKey: 'admin',
  reactivateApiKey: 'admin',
  deleteApiKey: 'admin',
  approvePendingDevice: 'admin',
  dismissPendingDevice: 'admin',
  scoreReset: 'admin',
  removeSavedTeam: 'admin',
  testSlackConnection: 'admin',
  stopCast: 'admin',
  castReceiverSwap: 'admin',
  castReceiverMute: 'admin',
  castReceiverView: 'admin',
  castReceiverChecks: 'admin',
  adminClearAllStations: 'admin',
  adminRestart: 'admin',
  selfUpdateCheck: 'admin',
  selfUpdateApply: 'admin',
  wifiTestJoin: 'admin',
  installSystemdService: 'admin',
  installHostTools: 'admin',
  updateSetupSettings: 'admin',
  markSetupStep: 'admin',
  testRecordingStream: 'admin',
  queueAdd: 'admin',
  queueUpdate: 'admin',
  queueRemove: 'admin',
  queueReorder: 'admin',
  queueRequeue: 'admin',
  queueSettings: 'admin',
  queueLineRemove: 'admin',
  queueLineMove: 'admin',
  queueClear: 'admin',
  queueImport: 'admin',

  // ── Always a login, even before the field has a passphrase ──────────
  saveSlackConfig: 'adminOnly',
  operatorSetCode: 'adminOnly',
  operatorRevokeDevice: 'adminOnly',
  createExternalAccessToken: 'adminOnly',
  revokeExternalAccessToken: 'adminOnly',
  saveAudioDeviceConfig: 'adminOnly',
  testAudioDevice: 'adminOnly',
  refreshAudioDevices: 'adminOnly',
  clearMatchHistory: 'adminOnly',
  deleteRecording: 'adminOnly',
  deleteRecordingsBefore: 'adminOnly',
  captureTimelapseFrame: 'adminOnly',
  renderTimelapse: 'adminOnly',
  testTimelapseLights: 'adminOnly',
  deleteTimelapseRender: 'adminOnly',
};

/** The tier of a message, by its `type`. Anything unlisted is refused, so a
 *  new message fails loudly until someone decides who may send it. */
export function accessOf(type: unknown): MessageAccess {
  if (typeof type === 'string' && Object.hasOwn(MESSAGE_ACCESS, type)) return MESSAGE_ACCESS[type];
  return 'adminOnly';
}

/** Every message type in the table. */
export const messageTypes = (): string[] => Object.keys(MESSAGE_ACCESS);

/**
 * What a connection from outside the field may send with no credential. It's
 * checked before the tiers, so `anyone` means anyone on site. Missing from here
 * means refused from the internet, stops and their clears included.
 *
 * The public pages need only this: /scores has its own socket, and /matches and
 * /practice send nothing, they fetch /api/public. See plans/ws-internet-guard.md.
 */
const OPEN_TO_OUTSIDERS: ReadonlySet<string> = new Set([
  'adminLogin', // the external login: it's how a visitor gets the access cookie
  'adminCheckAuth',
  'operatorCheckAuth', // every page presents a stored token on connecting
  'operatorPairRedeem', // the secret is itself a one-time credential
  'dsClientDismiss', // sets a flag on this socket and nothing else
  'castReceiverRegister', // already open to everyone on /ws/scores
]);

export function isOpenToOutsiders(type: unknown): boolean {
  return typeof type === 'string' && OPEN_TO_OUTSIDERS.has(type);
}

/**
 * Whether a browser opened this socket from another site's page. WebSockets
 * aren't bound by the same-origin policy, so any page open on a laptop at the
 * field could otherwise reach the field from that laptop's address. Tools send
 * no `Origin`, and are judged on their address alone.
 */
export function isCrossSite(headers: IncomingHttpHeaders): boolean {
  if (!headers.origin) return false;
  const hostname = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null; // `Origin: null` comes from sandboxed pages and files
    }
  };
  const origin = hostname(headers.origin);
  if (!origin) return true;
  // A proxy that rewrites `Host` leaves the name the browser used here.
  const forwarded = [headers['x-forwarded-host']].flat()[0]?.split(',')[0];
  return ![headers.host, forwarded].some(host => host && hostname(`http://${host.trim()}`) === origin);
}

/**
 * The Driver Station this client appears to be, if any.
 *
 * An address match is certain. A hostname match catches a laptop wired to the
 * field for its DS but browsing over guest Wi-Fi, which has a different address
 * on each interface; it is only a hint, because teams do reuse names like
 * DRIVERSTATION. Names compare without case: NetBIOS answers in capitals.
 */
export function dsClientMatch(
  clientIp: string,
  connected: Partial<Record<StationName, { ip: string }>>,
  hostnames: Record<string, string>,
): DsClientMatch | null {
  const stations = Object.entries(connected) as [StationName, { ip: string }][];
  for (const [station, conn] of stations) {
    if (conn.ip === clientIp) return { station, by: 'ip' };
  }
  const name = hostnames[clientIp]?.toLowerCase();
  if (!name) return null;
  for (const [station, conn] of stations) {
    if (hostnames[conn.ip]?.toLowerCase() === name) return { station, by: 'hostname' };
  }
  return null;
}
