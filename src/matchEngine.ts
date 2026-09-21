import dgram from 'dgram';
import { randomBytes, randomUUID } from 'node:crypto';
import { makeDSPacket, Control, UdpSendPort, type OutboundTag, type DsProtocol } from './fmsServer.js';
import {
  Alliance,
  MatchPhase,
  MatchConfig,
  MatchSlot,
  MatchState,
  MatchEndReason,
  StationName,
  StationNameList,
  StationNumber,
  StationControlState,
  StaffRole,
  StaffRoleList,
  StaffRoleState,
  defaultSlotToRadio,
} from './types.js';
import { appWarn, appError } from './appLogger.js';
import { getAllianceShiftState, getMatchSubPeriod } from './shiftState.js';

const TICK_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 200;
/** A DS counts as FMS-attached if a UDP status heartbeat (2 Hz) arrived this
 *  recently. Only an attached DS obeys match control, so Ready is gated on it. */
const DS_ATTACHED_TIMEOUT_MS = 5_000;
/** After the FMS enables a station, ignore DS "disabled" status reports for
 *  this long. The DS status heartbeat is 2 Hz, so right after an enable a
 *  stale packet still carrying the pre-enable state can arrive — without the
 *  grace it would instantly re-latch the disable that was just cleared. */
const FMS_ENABLE_GRACE_MS = 2_000;
/** A staff role counts as connected if its page sent a heartbeat this recently.
 *  Staff pages heartbeat every ~2s, so this tolerates a couple of missed beats. */
const STAFF_CONNECTED_TIMEOUT_MS = 6_000;
/** Post-match scoring delay for balls in flight (up to 3s per rules) */
const POST_MATCH_COUNT_SECONDS = 3;
/** Warning countdown before a paused match re-enables robots. Must match the
 *  cue timing baked into sounds/resume321.wav (tones at 0/1/2s, "live" tone
 *  at 3s) and the browser mirror in frontend/src/hooks/useMatchAudio.ts. */
const RESUME_COUNTDOWN_SECONDS = 3;
/** How long a finished match lingers in postMatch before auto-clearing to idle.
 *  Self-service practice matches are often started and abandoned; without this,
 *  the field (and scoring, which follows the postMatch→idle transition) stays
 *  stuck in match mode until someone clicks "clear". E-stop endings are exempt —
 *  those require a human to clear. */
const POST_MATCH_AUTO_CLEAR_MS = 2 * 60_000;

// Official 2026 REBUILT match timing (fixed — not user-adjustable)
// Teleop = transition (10s) + 4 shifts (25s each) + endgame (30s) = 140s
const OFFICIAL_CONFIG: MatchConfig = {
  autoDuration: 20,
  teleopDuration: 140,
  endgameDuration: 30,
  pauseDuration: 3,
  skipAuto: false,
  autoWinner: 'scores',
};

export type TeamResolver = (station: StationName) => number | null;

/** 24 random bytes as base64url (32 chars): unguessable, URL- and QR-safe. */
export function mintShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export class MatchEngine {
  private phase: MatchPhase = 'idle';
  private config: MatchConfig | null = null;
  private pendingConfig: MatchConfig = { ...OFFICIAL_CONFIG };
  private remainingTime = 0;
  private totalMatchTime = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private autoClearTimer: NodeJS.Timeout | null = null;
  private lastTickTime = 0;
  private prePausePhase: MatchPhase | null = null;
  /** Epoch ms when a pending resume completes, or null when not resuming. */
  private resumeAt: number | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  /** True once the host opens the ready check — no station/staff may ready before it. */
  private readyRequested = false;
  /** Per-role staff readiness (ready + host "ignore" flag) for the current match. */
  private staffReady = new Map<StaffRole, { ready: boolean; ignored: boolean }>();
  /** Last presence heartbeat per staff role — drives the connected flag. */
  private lastStaffHeartbeat = new Map<StaffRole, number>();
  /** Match starts are rejected until this time (see holdStart) */
  private startHoldUntil = 0;
  private sequenceNumbers = new Map<StationName, number>();
  private stationStates = new Map<StationName, StationControlState>();
  private dsConnections = new Map<StationName, { ip: string; lastSeen: number }>();
  /** Per-DS-address control endpoint, learned from the TCP handshake. The 2027
   *  DS names an ephemeral UDP port (new one on every reconnect); the legacy
   *  DS is addressed at the fixed UdpSendPort. Absent = legacy. */
  private dsEndpoints = new Map<string, { protocol: DsProtocol; udpPort: number }>();
  /** Dampens the per-reconnect control-port change log for the 2027 DS */
  private endpointChurn = new Map<string, { count: number; lastReport: number }>();
  /** Last "ip:port/protocol" match control was sent to, per station, so the
   *  first packet to a new destination is logged (proves the FMS→DS path). */
  private lastControlTarget = new Map<StationName, string>();
  /** Last FMS UDP status heartbeat per station — only an FMS-attached DS sends these */
  private lastDsHeartbeat = new Map<StationName, number>();
  /** When the FMS last enabled each station — gates the DS-disable re-latch grace */
  private lastFmsEnable = new Map<StationName, number>();
  /** Whether the DS has reported itself enabled since the last FMS enable.
   *  The 2027 DS does not set the status "enabled" bit the way the NI DS
   *  does (2026-09-12: 5940's robot ran, yet every status said disabled),
   *  so for it a "disabled" report only counts as the team pressing Disable
   *  if the DS reported enabled first — a real enabled→disabled transition. */
  private dsEnabledSeen = new Map<StationName, boolean>();
  /** Stations whose comms-loss "disabled" report has been logged this match (log once, not at 2 Hz). */
  private commsLossLogged = new Set<StationName>();
  /** Which FMS enable (timestamp) the first-status diagnostic was logged for */
  private dsStatusLoggedFor = new Map<StationName, number>();
  /** Socket control packets are sent from. Replaced by the FMS server's
   *  10.0.100.5:1160 listener at startup (see setUdpSocket); the initial
   *  ephemeral-port socket only exists so tests can run without the server. */
  private udpSocket: dgram.Socket;
  private listeners: ((state: MatchState) => void)[] = [];
  private matchNumber = 0;
  /** Unique id for the current match — assigned at startMatch, cleared when the field returns to idle/created. */
  private matchId: string | null = null;
  /** Share token for the current match's public summary page (see publicMatchApi). */
  private shareToken: string | null = null;
  private endReason: MatchEndReason | undefined;
  private teamResolver: TeamResolver;
  /** When each station's team took the slot, supplied by index.ts from the
   *  radio's active config. Null = no team, or a config that predates this. */
  private connectedAtResolver?: (station: StationName) => number | null;
  /** Why a station's robot may not be enabled (field control-system policy),
   *  supplied by index.ts. Null/undefined = allowed. */
  private enableBlocked?: (station: StationName) => string | null;
  /** Maps physical station → alliance match slot during an active match */
  private portToSlot = new Map<StationName, MatchSlot>();
  /** Which alliance won auto (computed after auto ends) */
  private autoWinnerAlliance: Alliance | null = null;
  /** Optional callback to get auto-period scores for auto winner determination.
   *  Returns { red: number, blue: number } totals. */
  private autoScoreResolver?: () => { red: number; blue: number };

  constructor(teamResolver?: TeamResolver) {
    this.teamResolver = teamResolver ?? (() => null);
    this.udpSocket = dgram.createSocket('udp4');
    for (const station of StationNameList) {
      this.stationStates.set(station, {
        teamNumber: null,
        enabled: false,
        eStop: false,
        aStop: false,
        mode: 'teleOp',
        joined: false,
        ready: false,
        alliance: null,
        matchSlot: null,
        disabledBy: null,
      });
      this.sequenceNumbers.set(station, 0);
    }
    for (const role of StaffRoleList) {
      this.staffReady.set(role, { ready: false, ignored: false });
    }
    setInterval(() => this.sendJoinedHeartbeat(), HEARTBEAT_INTERVAL_MS);

    // Sweep stale staff presence — a role whose page closed drops to
    // disconnected, and if it was required-but-ready its stale ready is cleared.
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const role of StaffRoleList) {
        const last = this.lastStaffHeartbeat.get(role);
        const connected = last !== undefined && now - last < STAFF_CONNECTED_TIMEOUT_MS;
        if (!connected && this.lastStaffHeartbeat.has(role)) {
          this.lastStaffHeartbeat.delete(role);
          const s = this.staffReady.get(role)!;
          if (s.ready) {
            s.ready = false;
            console.log(`Staff ${role} disconnected — ready cleared`);
          }
          changed = true;
        }
      }
      if (changed) this.broadcast();
    }, 2_000);

    // Sweep stale DS connections — if no packet in 20s (~3 missed heartbeats), clear
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [station, conn] of this.dsConnections) {
        if (now - conn.lastSeen > 20_000) {
          this.dsConnections.delete(station);
          changed = true;
          console.log(`DS stale: ${station} (last seen ${Math.round((now - conn.lastSeen) / 1000)}s ago)`);
        }
      }
      if (changed) this.broadcast();
    }, 5_000);
  }

  /** Send control packets from the FMS server's UDP 1160 socket so they
   *  arrive from 10.0.100.5:1160 — the 2027 DS ignores them otherwise. */
  setUdpSocket(socket: dgram.Socket) {
    if (socket === this.udpSocket) return;
    const old = this.udpSocket;
    this.udpSocket = socket;
    try {
      old.close();
    } catch {
      // already closed
    }
    console.log('Match control packets now sent from the FMS UDP 1160 socket');
  }

  setDSAddress(station: StationName, ip: string) {
    const now = Date.now();
    const existing = this.dsConnections.get(station);
    const ipChanged = !existing || existing.ip !== ip;
    // Always update lastSeen, but only broadcast when the IP changed or
    // enough time has passed to warrant a UI heartbeat update (~2s debounce).
    this.dsConnections.set(station, { ip, lastSeen: now });
    if (ipChanged || !existing || now - existing.lastSeen >= 2_000) {
      this.broadcast();
    }
  }

  /** Record which DS generation (and, for the 2027 DS, which UDP control port)
   *  lives at a DS address. Called on every team-number handshake. */
  setDsEndpoint(ip: string, protocol: DsProtocol, udpPort: number) {
    const existing = this.dsEndpoints.get(ip);
    if (existing?.protocol === protocol && existing.udpPort === udpPort) return;
    this.dsEndpoints.set(ip, { protocol, udpPort });
    if (existing?.protocol !== protocol) {
      console.log(
        `DS ${ip} is a ${protocol === 'ds2027' ? '2027 (SystemCore)' : 'legacy NI'} Driver Station, control UDP ${udpPort}`,
      );
      this.broadcast();
    } else {
      // The 2027 DS picks a new port on every TCP reconnect (~6 s while it
      // is not assigned a station). Summarize instead of logging each one.
      const d = this.endpointChurn.get(ip) ?? { count: 0, lastReport: 0 };
      d.count++;
      if (Date.now() - d.lastReport >= 60_000) {
        console.log(`DS ${ip} control UDP port now ${udpPort} (${d.count} change(s) in the last minute)`);
        d.count = 0;
        d.lastReport = Date.now();
      }
      this.endpointChurn.set(ip, d);
    }
  }

  /** UDP destination + protocol for control packets to a DS address. */
  private endpointFor(ip: string): { protocol: DsProtocol; udpPort: number } {
    return this.dsEndpoints.get(ip) ?? { protocol: 'legacy', udpPort: UdpSendPort };
  }

  clearDSAddress(station: StationName) {
    if (!this.dsConnections.has(station)) return;
    this.dsConnections.delete(station);
    this.broadcast();
  }

  /** True when the station's DS is attached to the FMS: its UDP status
   *  heartbeats (sent only in FMS mode) have been arriving recently. */
  isDsAttached(station: StationName): boolean {
    const last = this.lastDsHeartbeat.get(station);
    return last !== undefined && Date.now() - last < DS_ATTACHED_TIMEOUT_MS;
  }

  /** The alliance match slot to advertise to a station's DS — this is the byte
   *  that tells the DS which side of the field it is on. During an active match
   *  it is the assigned portToSlot mapping; before the match starts it is
   *  derived from the alliance the station joined, so a blue-alliance DS is told
   *  it is on the blue side as soon as it attaches (portToSlot is only populated
   *  at startMatch — the old 'red1' fallback put every joined DS on red until
   *  the match began). Falls back to the physical default slot when the station
   *  has no alliance. */
  slotForStation(station: StationName): MatchSlot {
    const assigned = this.portToSlot.get(station);
    if (assigned) return assigned;
    const state = this.stationStates.get(station);
    if (state?.joined && state.alliance) {
      const peers = StationNameList.filter(s => {
        const p = this.stationStates.get(s)!;
        return p.joined && p.alliance === state.alliance;
      });
      const position = Math.min(Math.max(peers.indexOf(station), 0) + 1, 3) as StationNumber;
      return `${state.alliance}${position}` as MatchSlot;
    }
    return defaultSlotToRadio[station];
  }

  /** Gate every enable on the field's control-system policy. A blocked robot
   *  is never enabled, in a match or out of one. */
  setEnableBlocked(resolver: (station: StationName) => string | null) {
    this.enableBlocked = resolver;
  }

  /** Set callback used to determine auto winner from scoring data. */
  setAutoScoreResolver(resolver: () => { red: number; blue: number }) {
    this.autoScoreResolver = resolver;
  }

  /** Supply when each station's team took its slot, for clients that order
   *  teams by how long they have been on the field. */
  setConnectedAtResolver(resolver: (station: StationName) => number | null) {
    this.connectedAtResolver = resolver;
  }

  // ── Match lifecycle (controller actions) ────────────────────────────

  /** Create a new match — transitions to 'created' phase where stations can join. */
  createMatch() {
    if (this.phase !== 'idle' && this.phase !== 'postMatch') {
      appWarn(`Cannot create match in phase ${this.phase}`);
      return;
    }
    this.cancelPostMatchAutoClear();
    // Reset all station states
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
      state.enabled = false;
      state.eStop = false;
      state.aStop = false;
      state.disabledBy = null;
    }
    this.pendingConfig = { ...OFFICIAL_CONFIG };
    this.config = null;
    this.portToSlot.clear();
    this.autoWinnerAlliance = null;
    this.endReason = undefined;
    this.resetReadyCheckAndStaff();
    this.phase = 'created';
    console.log('Match created — waiting for stations to join');
    this.broadcast();
  }

  /** Cancel a created match — back to idle. */
  cancelMatch() {
    if (this.phase !== 'created') {
      appWarn(`Cannot cancel match in phase ${this.phase}`);
      return;
    }
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
      state.aStop = false;
    }
    this.resetReadyCheckAndStaff();
    this.phase = 'idle';
    console.log('Match cancelled');
    this.broadcast();
  }

  /** Swap a station to the opposite alliance (controller only, pre-match). */
  swapStationAlliance(station: StationName) {
    if (this.phase !== 'created') {
      appWarn(`Cannot swap station alliance in phase ${this.phase}`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined || !state.alliance) {
      appWarn(`Station ${station} is not joined to an alliance`);
      return;
    }
    const newAlliance: Alliance = state.alliance === 'red' ? 'blue' : 'red';
    // Enforce max 3 per alliance
    const allianceCount = [...this.stationStates.values()].filter(s => s.joined && s.alliance === newAlliance).length;
    if (allianceCount >= 3) {
      appWarn(`Cannot swap ${station} to ${newAlliance}: alliance already has 3 stations`);
      return;
    }
    state.alliance = newAlliance;
    state.ready = false;
    this.closeReadyCheck();
    console.log(`Station ${station} swapped to ${newAlliance} alliance`);
    this.broadcast();
  }

  /** Kick a station from the match (controller only, pre-match). */
  kickStation(station: StationName) {
    if (this.phase !== 'created') {
      appWarn(`Cannot kick station in phase ${this.phase}`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined) {
      appWarn(`Station ${station} is not joined`);
      return;
    }
    state.joined = false;
    state.ready = false;
    state.alliance = null;
    state.matchSlot = null;
    state.aStop = false;
    this.closeReadyCheck();
    console.log(`Station ${station} kicked from match`);
    this.broadcast();
  }

  /** Set the auto winner manually — used for 'pause' mode during autoPause or skip-auto pre-set. */
  setAutoWinner(winner: Alliance) {
    this.autoWinnerAlliance = winner;
    console.log(`Auto winner set: ${winner}`);

    // If we're in autoPause awaiting a winner, resume the pause countdown
    if (this.phase === 'autoPause' && this.config?.autoWinner === 'pause') {
      // The tick was frozen while waiting — restart it so the pause countdown runs
      this.lastTickTime = Date.now();
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
      console.log(`Auto pause countdown resumed (${this.remainingTime.toFixed(1)}s remaining)`);
    }
    this.broadcast();
  }

  // ── Station self-service ──────────────────────────────────────────

  /** @deprecated Use joinStationAlliance() instead. Kept for backward compatibility.
   *  With slot-based naming, defaults to 'red' since alliance can't be inferred from slot name. */
  joinStation(station: StationName) {
    appWarn(`joinStation() is deprecated — use joinStationAlliance() with an explicit alliance`);
    this.joinStationAlliance(station, 'red');
  }

  /** Join a station to a specific alliance (decoupled from physical port). */
  joinStationAlliance(station: StationName, alliance: Alliance) {
    // Only allow joining during 'created' phase
    if (this.phase !== 'created') {
      appWarn(`Cannot join station ${station}: no match created (phase=${this.phase})`);
      return;
    }
    // Enforce max 3 per alliance
    const allianceCount = [...this.stationStates.values()].filter(s => s.joined && s.alliance === alliance).length;
    if (allianceCount >= 3) {
      appWarn(`Cannot join ${station} to ${alliance}: alliance already has 3 stations`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (state.joined) {
      // Already joined — allow changing alliance if not ready
      if (state.alliance !== alliance) {
        state.alliance = alliance;
        state.ready = false;
        state.matchSlot = null;
        this.closeReadyCheck();
        console.log(`Station ${station} switched to ${alliance} alliance`);
        this.broadcast();
      }
      return;
    }
    state.joined = true;
    state.ready = false;
    state.alliance = alliance;
    state.matchSlot = null;
    this.closeReadyCheck();
    console.log(`Station ${station} joined ${alliance} alliance`);
    this.broadcast();
  }

  /** Leave the match. Allowed at any time — during active match, disables robot and returns to free-drive. */
  leaveStation(station: StationName) {
    const state = this.stationStates.get(station)!;
    if (!state.joined) return;

    const wasMatchActive = this.isMatchActive();

    // If match is active, disable the robot immediately
    if (wasMatchActive) {
      state.enabled = false;
      this.sendDSPacket(station);
    }

    state.joined = false;
    state.ready = false;
    state.alliance = null;
    state.matchSlot = null;
    state.aStop = false;
    this.portToSlot.delete(station);
    console.log(`Station ${station} left match${wasMatchActive ? ' (mid-match)' : ''}`);

    // If all stations have left during an active match, end it automatically
    if (wasMatchActive && this.getJoinedCount() === 0) {
      this.endMatchEmpty();
      return; // endMatchEmpty broadcasts
    }

    // A pre-match departure changes the roster — re-close the ready check.
    if (this.phase === 'created') this.closeReadyCheck();
    this.broadcast();
  }

  setReady(station: StationName, ready: boolean) {
    // A joined team backing out during the pre-start countdown cancels the
    // start: abort back to setup and mark them un-ready, so the match can't
    // restart until they ready up again.
    if (this.phase === 'countdown' && !ready) {
      const state = this.stationStates.get(station)!;
      if (!state.joined) {
        appWarn(`Station ${station} is not joined, cannot set ready`);
        return;
      }
      this.abortCountdown();
      state.ready = false;
      console.log(`Station ${station} un-readied during countdown — countdown aborted`);
      this.broadcast();
      return;
    }
    if (this.phase !== 'created') {
      appWarn(`Cannot change ready state for ${station} in phase ${this.phase}`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined) {
      appWarn(`Station ${station} is not joined, cannot set ready`);
      return;
    }
    // Teams can't ready up until the host opens the ready check.
    if (ready && !this.readyRequested) {
      appWarn(`Station ${station} cannot ready: the host has not opened the ready check`);
      return;
    }
    // NOTE: Ready is intentionally NOT gated on isDsAttached(). The
    // dsAttached signal proved unreliable in the field (2026-07-18: it stayed
    // false for DSes that were heartbeating fine, because it only stamps when
    // getStationForTeam resolves) and blocked every team from readying. It is
    // now advisory only (shown in the UI); revisit gating once the attachment
    // signal is trustworthy.
    state.ready = ready;
    console.log(`Station ${station} ready: ${ready}`);
    this.broadcast();
  }

  /** Update match config — only skipAuto and autoWinner are user-settable. Durations are fixed. */
  updateMatchConfig(config: MatchConfig) {
    if (this.phase !== 'created') {
      appWarn(`Cannot update match config in phase ${this.phase}`);
      return;
    }
    // Only accept skipAuto and autoWinner — durations are official
    this.pendingConfig = {
      ...OFFICIAL_CONFIG,
      skipAuto: config.skipAuto ?? false,
      autoWinner: config.autoWinner ?? 'scores',
    };
    // Changing config invalidates the whole ready check
    this.closeReadyCheck();
    console.log('Match config updated:', this.pendingConfig);
    this.broadcast();
  }

  /** Close the ready check: no one is "ready" and the host must re-open it.
   *  Called whenever the roster changes (join/leave/swap/kick/config) so a match
   *  can't start against a stale readiness snapshot. Keeps staff "ignore"
   *  choices — those are the host's per-match intent, not readiness. */
  private closeReadyCheck() {
    this.readyRequested = false;
    for (const state of this.stationStates.values()) state.ready = false;
    for (const s of this.staffReady.values()) s.ready = false;
  }

  /** Reset the ready check + staff readiness for a brand-new (or torn-down)
   *  match. The host's "ignore" choices intentionally PERSIST across matches so
   *  a self-service field (no staff) is configured once, not re-ignored every
   *  match; a staffed event likewise stays "required". They reset only on a
   *  server restart. */
  private resetReadyCheckAndStaff() {
    this.readyRequested = false;
    for (const s of this.staffReady.values()) s.ready = false;
  }

  /** Host opens (or retracts) the ready check. Only meaningful during setup. */
  setReadyRequested(requested: boolean) {
    if (this.phase !== 'created') {
      appWarn(`Cannot change ready check in phase ${this.phase}`);
      return;
    }
    if (this.readyRequested === requested) {
      // Asking again while the check is already open is a nudge: everyone
      // has to confirm again (a driver who readied five minutes ago may have
      // walked off), but the check itself stays open.
      if (requested) this.clearTeamReadiness('ready check re-requested');
      return;
    }
    this.readyRequested = requested;
    if (!requested) {
      // Retracting clears everyone's ready so re-opening starts clean.
      for (const state of this.stationStates.values()) state.ready = false;
      for (const s of this.staffReady.values()) s.ready = false;
    }
    console.log(requested ? 'Ready check opened' : 'Ready check retracted');
    this.broadcast();
  }

  /** Un-ready every station without closing the ready check, so each drive
   *  team has to press Ready again. Used by the host's "Get Ready" call: the
   *  point of the call is a fresh confirmation, not a stale one. Staff
   *  readiness is left alone — the call is addressed to the teams. */
  clearTeamReadiness(reason: string) {
    if (this.phase !== 'created') return;
    let changed = false;
    for (const state of this.stationStates.values()) {
      if (state.ready) {
        state.ready = false;
        changed = true;
      }
    }
    if (changed) {
      console.log(`Station readiness cleared (${reason})`);
      this.broadcast();
    }
  }

  /** A staff role readies / un-readies. Gated exactly like station ready. */
  setStaffReady(role: StaffRole, ready: boolean) {
    if (this.phase !== 'created') {
      appWarn(`Cannot change staff ready for ${role} in phase ${this.phase}`);
      return;
    }
    const s = this.staffReady.get(role)!;
    if (ready && !this.readyRequested) {
      appWarn(`Staff ${role} cannot ready: the host has not opened the ready check`);
      return;
    }
    if (ready && s.ignored) {
      appWarn(`Staff ${role} cannot ready: role is marked not required for this match`);
      return;
    }
    if (s.ready === ready) return;
    s.ready = ready;
    console.log(`Staff ${role} ready: ${ready}`);
    this.broadcast();
  }

  /** Host marks a staff role required / not required for this match. Ignoring a
   *  role clears its ready so it drops out of the start gate immediately. */
  setStaffIgnored(role: StaffRole, ignored: boolean) {
    if (this.phase !== 'created') {
      appWarn(`Cannot change staff requirement for ${role} in phase ${this.phase}`);
      return;
    }
    const s = this.staffReady.get(role)!;
    if (s.ignored === ignored) return;
    s.ignored = ignored;
    if (ignored) s.ready = false;
    console.log(`Staff ${role} ${ignored ? 'ignored (not required)' : 'required'} for this match`);
    this.broadcast();
  }

  /** Presence heartbeat from an open staff page — drives the connected flag. */
  staffHeartbeat(role: StaffRole) {
    const wasConnected = this.isStaffConnected(role);
    this.lastStaffHeartbeat.set(role, Date.now());
    if (!wasConnected) this.broadcast();
  }

  private isStaffConnected(role: StaffRole): boolean {
    const last = this.lastStaffHeartbeat.get(role);
    return last !== undefined && Date.now() - last < STAFF_CONNECTED_TIMEOUT_MS;
  }

  /** Briefly block match starts, e.g. while the get-ready announcement plays —
   *  a countdown started mid-announcement finds the exclusive audio device
   *  busy and the 3-2-1 clip is silently dropped. */
  holdStart(ms: number) {
    this.startHoldUntil = Math.max(this.startHoldUntil, Date.now() + ms);
  }

  startMatch() {
    if (this.phase !== 'created') {
      appWarn(`Cannot start match in phase ${this.phase}`);
      return;
    }
    if (Date.now() < this.startHoldUntil) {
      appWarn('Match start is held for a moment while the get-ready announcement finishes');
      return;
    }

    if (!this.readyRequested) {
      appWarn('Cannot start match: the host has not opened the ready check');
      return;
    }
    const joinedStations = StationNameList.filter(s => this.stationStates.get(s)!.joined);
    if (joinedStations.length === 0) {
      appWarn('No stations have joined, cannot start match');
      return;
    }
    if (!joinedStations.every(s => this.stationStates.get(s)!.ready)) {
      appWarn('Not all joined stations are ready, cannot start match');
      return;
    }
    const staffBlocking = StaffRoleList.filter(r => {
      const s = this.staffReady.get(r)!;
      return !s.ignored && !s.ready;
    });
    if (staffBlocking.length > 0) {
      appWarn(`Cannot start match: staff not ready (${staffBlocking.join(', ')})`);
      return;
    }

    // If skipAuto, auto winner must be pre-set
    if (this.pendingConfig.skipAuto) {
      if (
        this.pendingConfig.autoWinner !== 'red' &&
        this.pendingConfig.autoWinner !== 'blue' &&
        !this.autoWinnerAlliance
      ) {
        appWarn('Cannot start match with skipAuto unless auto winner is set to red or blue');
        return;
      }
      // Pre-set the auto winner for skip-auto
      if (this.pendingConfig.autoWinner === 'red' || this.pendingConfig.autoWinner === 'blue') {
        this.autoWinnerAlliance = this.pendingConfig.autoWinner;
      }
    }

    this.config = { ...this.pendingConfig };
    this.matchNumber++;
    this.matchId = randomUUID();
    this.shareToken = mintShareToken();
    this.totalMatchTime = 0;
    this.endReason = undefined;

    // If auto winner was pre-set by 'red'/'blue' mode AND not skipping, clear it (will be computed after auto)
    if (!this.config.skipAuto && (this.config.autoWinner === 'red' || this.config.autoWinner === 'blue')) {
      // Pre-set auto winner is known at start — it'll be applied in computeAutoWinner()
      this.autoWinnerAlliance = null;
    }

    // Compute portToSlot mapping: assign each joined station to an alliance slot
    this.portToSlot.clear();
    const redStations = joinedStations.filter(s => this.stationStates.get(s)!.alliance === 'red');
    const blueStations = joinedStations.filter(s => this.stationStates.get(s)!.alliance === 'blue');
    for (let i = 0; i < redStations.length; i++) {
      const slot = `red${(i + 1) as StationNumber}` as MatchSlot;
      this.portToSlot.set(redStations[i], slot);
      this.stationStates.get(redStations[i])!.matchSlot = slot;
    }
    for (let i = 0; i < blueStations.length; i++) {
      const slot = `blue${(i + 1) as StationNumber}` as MatchSlot;
      this.portToSlot.set(blueStations[i], slot);
      this.stationStates.get(blueStations[i])!.matchSlot = slot;
    }

    // Handle skipAuto: if enabled, start directly in countdown → teleop
    const effectiveAutoDuration = this.config.skipAuto ? 0 : this.config.autoDuration;

    this.phase = 'countdown';
    this.remainingTime = 3;

    for (const station of StationNameList) {
      const teamNumber = this.teamResolver(station);
      const state = this.stationStates.get(station)!;
      state.teamNumber = teamNumber;
      state.enabled = false;
      state.eStop = false;
      state.disabledBy = null;
      // Keep pre-armed A-Stops for participating stations — teams that know
      // their auto won't run can A-Stop during match setup.
      if (!state.joined) state.aStop = false;
      state.mode = joinedStations.includes(station) ? (effectiveAutoDuration > 0 ? 'auto' : 'teleOp') : 'teleOp';
    }

    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);

    console.log(
      `Match ${this.matchNumber} started with stations: ${joinedStations.join(', ')} ` +
        `(red: ${redStations.join(',')}, blue: ${blueStations.join(',')})`,
    );
    this.broadcast();
  }

  /** Abort the countdown and return to the created (pre-match) phase. */
  abortCountdown() {
    if (this.phase !== 'countdown') {
      appWarn(`Cannot abort countdown in phase ${this.phase}`);
      return;
    }
    this.phase = 'created';
    this.remainingTime = 0;
    // This match never happened — a re-start gets a fresh id
    this.matchId = null;
    this.shareToken = null;
    this.stopTick();
    // Keep stations joined and ready so the operator can re-start immediately
    for (const state of this.stationStates.values()) {
      if (state.joined) {
        state.enabled = false;
        state.mode = 'teleOp';
      }
    }
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} countdown aborted — back to setup`);
    this.broadcast();
  }

  stopMatch() {
    if (!this.isMatchActive()) return;
    this.cancelResumeCountdown();
    this.disableAll();
    this.endReason = 'stopped';
    this.phase = 'postMatch';
    this.remainingTime = 0;
    this.stopTick();
    this.schedulePostMatchAutoClear();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} stopped early`);
    this.broadcast();
  }

  pauseMatch() {
    // Pausing during a resume countdown cancels the resume instead — the
    // robots are still disabled, so this just puts the field back on hold.
    if (this.phase === 'paused' && this.resumeAt !== null) {
      this.cancelResumeCountdown();
      console.log(`Match ${this.matchNumber} resume cancelled — still paused`);
      this.broadcast();
      return;
    }
    if (this.phase !== 'auto' && this.phase !== 'teleop' && this.phase !== 'endgame') {
      appWarn(`Cannot pause match in phase ${this.phase}`);
      return;
    }
    this.prePausePhase = this.phase;
    this.phase = 'paused';
    this.stopTick();
    this.disableAll();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} paused (was in ${this.prePausePhase})`);
    this.broadcast();
  }

  /**
   * Begin resuming: robots stay disabled for a 3-second "3… 2… 1…" countdown
   * so drive teams get warning before their robot comes back alive, matching
   * the pre-start countdown. The clip's final tone lands exactly when
   * `completeResume()` re-enables. Pausing again during the countdown cancels
   * it; a stop/abandon/e-stop cancels it implicitly.
   */
  resumeMatch() {
    if (this.phase !== 'paused') {
      appWarn('Cannot resume: match is not paused');
      return;
    }
    if (this.resumeAt !== null) return; // already counting down

    this.resumeAt = Date.now() + RESUME_COUNTDOWN_SECONDS * 1000;
    this.resumeTimer = setTimeout(() => this.completeResume(), RESUME_COUNTDOWN_SECONDS * 1000);
    console.log(`Match ${this.matchNumber} resuming in ${RESUME_COUNTDOWN_SECONDS}s`);
    // The 200ms joined-heartbeat keeps streaming disable packets while the
    // tick is stopped, so the field stays actively held during the countdown.
    this.broadcast();
  }

  /** Drop a pending resume, leaving the match paused. */
  private cancelResumeCountdown() {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.resumeAt = null;
  }

  /** Countdown finished — actually re-enable and restart the match clock. */
  private completeResume() {
    this.cancelResumeCountdown();
    if (this.phase !== 'paused') return; // stopped/abandoned mid-countdown

    this.phase = this.prePausePhase ?? 'teleop';
    this.prePausePhase = null;
    this.enableParticipating(this.phase === 'auto' ? 'auto' : 'teleOp');
    this.sendPacketsToAll();
    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log(`Match ${this.matchNumber} resumed (phase: ${this.phase})`);
    this.broadcast();
  }

  abandonMatch() {
    if (this.phase !== 'paused') {
      appWarn('Cannot abandon: match is not paused');
      return;
    }
    this.cancelResumeCountdown();
    this.disableAll();
    this.endReason = 'abandoned';
    this.prePausePhase = null;
    this.config = null;
    this.phase = 'idle';
    this.portToSlot.clear();
    this.autoWinnerAlliance = null;
    this.resetReadyCheckAndStaff();
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
    }
    console.log(`Match ${this.matchNumber} abandoned`);
    this.broadcast();
  }

  globalEStop() {
    this.cancelResumeCountdown();
    for (const station of StationNameList) {
      const state = this.stationStates.get(station)!;
      state.eStop = true;
      state.enabled = false;
    }
    this.endReason = 'estop';
    this.phase = 'postMatch';
    this.remainingTime = 0;
    this.stopTick();
    // E-stop endings must be cleared by a human — cancel any pending auto-clear
    this.cancelPostMatchAutoClear();
    // Send e-stop packets to ALL stations with known DS addresses, not just joined
    for (const station of StationNameList) {
      this.sendDSPacket(station);
    }
    console.log('Global E-Stop triggered');
    this.broadcast();
  }

  stationEStop(station: StationName) {
    const state = this.stationStates.get(station)!;
    state.eStop = true;
    state.enabled = false;
    console.log(`E-Stop: ${station}`);
    this.sendDSPacket(station);
    this.broadcast();
  }

  /** True when an A-Stop request is currently meaningful: any time before or
   *  during the autonomous period (including match setup and a pause taken
   *  during auto). */
  private canAStop(): boolean {
    return (
      this.phase === 'created' ||
      this.phase === 'countdown' ||
      this.phase === 'auto' ||
      (this.phase === 'paused' && this.prePausePhase === 'auto')
    );
  }

  /** A-Stop: stop the robot for the remainder of the autonomous period.
   *  Can be armed as early as match setup (for teams that know their auto
   *  won't run). Automatically released when teleop starts. Like e-stop,
   *  this is a backend-only state — the DS just sees disable packets. */
  stationAStop(station: StationName) {
    if (!this.canAStop()) {
      appWarn(`A-Stop ignored for ${station} in phase ${this.phase} — only available before/during auto`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined) {
      appWarn(`A-Stop ignored for ${station} — station has not joined the match`);
      return;
    }
    if (state.aStop) return;
    state.aStop = true;
    state.enabled = false;
    console.log(`A-Stop: ${station}`);
    this.sendDSPacket(station);
    this.broadcast();
  }

  /** Cancel a pre-armed A-Stop. Only allowed during match setup — once the
   *  countdown begins, A-Stop latches for the rest of auto (official FMS
   *  behavior). */
  stationClearAStop(station: StationName) {
    if (this.phase !== 'created') {
      appWarn(`Cannot cancel A-Stop for ${station} in phase ${this.phase} — latched once the match starts`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.aStop) return;
    state.aStop = false;
    console.log(`A-Stop cancelled: ${station}`);
    this.broadcast();
  }

  stationDisable(station: StationName, source: 'admin' | 'self' = 'admin') {
    const state = this.stationStates.get(station)!;
    state.enabled = false;
    state.disabledBy = source;
    console.log(`Disabled: ${station} (by ${source})`);
    this.sendDSPacket(station);
    this.broadcast();
  }

  /** Re-enable a station stopped mid-match — the recovery path for a team
   *  that accidentally disabled (DS Enter key or console button), or whose
   *  e-stop was just cleared by staff. Only meaningful in the phases where
   *  robots run; every other phase disables everyone by design. Teams cannot
   *  override a staff disable; the admin console can override anything. */
  undisable(station: StationName, byAdmin = false) {
    const state = this.stationStates.get(station)!;
    const blocked = this.enableBlocked?.(station);
    if (blocked) {
      appWarn(`Cannot enable ${station}: ${blocked}`);
      return;
    }
    if (this.phase !== 'auto' && this.phase !== 'teleop' && this.phase !== 'endgame') {
      appWarn(`Cannot re-enable ${station} in phase ${this.phase} — robots only run during auto/teleop/endgame`);
      return;
    }
    if (!state.joined) {
      appWarn(`Cannot re-enable ${station}: station has not joined the match`);
      return;
    }
    if (state.eStop || state.aStop) {
      appWarn(`Cannot re-enable ${station}: ${state.eStop ? 'e-stop' : 'a-stop'} is latched`);
      return;
    }
    if (state.disabledBy === 'admin' && !byAdmin) {
      appWarn(`Cannot re-enable ${station}: disabled by field staff — clear it from the admin console`);
      return;
    }
    if (state.enabled) return;
    // Re-stamp the mode: a robot stopped during auto still carries mode
    // 'auto', and re-enabling it in teleop with that mode would re-run its
    // auto routine on the open field.
    state.mode = this.phase === 'auto' ? 'auto' : 'teleOp';
    state.enabled = true;
    state.disabledBy = null;
    this.markFmsEnabled(station);
    console.log(`Re-enabled: ${station}${byAdmin ? ' (admin)' : ' (self)'}`);
    this.sendDSPacket(station);
    this.broadcast();
  }

  /** Called when a DS reports disable, e-stop, or a-stop in its UDP heartbeat.
   *  The team always has the right to disable/e-stop their robot. A-stop
   *  reports are only honored before/during auto — a DS that keeps asserting
   *  the bit into teleop cannot keep the station down. */
  private markFmsEnabled(station: StationName) {
    this.lastFmsEnable.set(station, Date.now());
    this.dsEnabledSeen.set(station, false);
    this.commsLossLogged.delete(station);
  }

  dsReportedStatus(
    station: StationName,
    dsEnabled: boolean,
    dsEStop: boolean,
    dsAStop: boolean,
    rawStatus?: number,
    robotComms?: boolean,
  ) {
    const state = this.stationStates.get(station);
    if (!state) return;
    const ip = this.dsConnections.get(station)?.ip;
    const protocol = ip ? this.endpointFor(ip).protocol : 'legacy';
    if (dsEnabled) this.dsEnabledSeen.set(station, true);
    // Diagnostic: the first status after each FMS enable, with the raw byte,
    // so a DS generation's enable semantics can be read off the journal.
    const enabledAt = this.lastFmsEnable.get(station);
    if (enabledAt !== undefined && state.enabled && this.dsStatusLoggedFor.get(station) !== enabledAt) {
      this.dsStatusLoggedFor.set(station, enabledAt);
      const raw = rawStatus === undefined ? '?' : `0x${rawStatus.toString(16).padStart(2, '0')}`;
      console.log(
        `DS status after FMS enable: ${station} (${protocol}) raw=${raw} enabled=${dsEnabled} ` +
          `${Math.round(Date.now() - enabledAt)}ms after enable`,
      );
    }
    // Stamp FMS attachment (UDP heartbeats only flow in FMS mode); broadcast
    // the flip so ready gates update promptly when a DS attaches.
    const wasAttached = this.isDsAttached(station);
    this.lastDsHeartbeat.set(station, Date.now());
    if (!wasAttached) {
      const ip = this.dsConnections.get(station)?.ip;
      console.log(`DS attached to FMS: ${station}${ip ? ` (${ip}, ${this.endpointFor(ip).protocol})` : ''}`);
      this.broadcast();
    }
    let changed = false;
    if (dsEStop && !state.eStop) {
      state.eStop = true;
      state.enabled = false;
      console.log(`DS e-stop reported: ${station}`);
      changed = true;
    } else if (dsAStop && !state.aStop && state.joined && this.canAStop()) {
      state.aStop = true;
      state.enabled = false;
      console.log(`DS a-stop reported: ${station}`);
      changed = true;
    } else if (!dsEnabled && state.enabled) {
      // Grace window: right after the FMS enables a station, the DS's 2 Hz
      // status can still carry the pre-enable "disabled" state — honoring it
      // would instantly undo the enable (and make undisable silently fail).
      // For the 2027 DS additionally require a real enabled→disabled
      // transition (see dsEnabledSeen); E-stop/A-stop above are unaffected.
      const transition = protocol === 'legacy' || this.dsEnabledSeen.get(station) === true;
      if (transition && (enabledAt === undefined || Date.now() - enabledAt > FMS_ENABLE_GRACE_MS)) {
        if (robotComms === false) {
          // "Disabled" with no robot link is the DS reacting to a comms
          // drop, not the driver pressing Disable. Keep the station enabled
          // so the DS re-enables on its own when the link returns — the
          // official FMS does the same. (2026-09-13: three legacy DSes were
          // latched off in the same second by a network blip on the host.)
          if (!this.commsLossLogged.has(station)) {
            this.commsLossLogged.add(station);
            const raw = rawStatus === undefined ? '?' : `0x${rawStatus.toString(16).padStart(2, '0')}`;
            console.log(
              `DS lost robot comms: ${station} (raw=${raw}) — keeping the field enable, not a driver disable`,
            );
          }
        } else {
          state.enabled = false;
          state.disabledBy = 'ds';
          const raw = rawStatus === undefined ? '?' : `0x${rawStatus.toString(16).padStart(2, '0')}`;
          console.log(`DS disable reported: ${station} (raw=${raw})`);
          changed = true;
        }
      }
    }
    if (changed) {
      // No packet sent here: the DS already stopped itself before reporting,
      // and the periodic tick/heartbeat transmits the latched state anyway.
      this.broadcast();
    }
  }

  clearEStop(station?: StationName) {
    if (station) {
      const state = this.stationStates.get(station)!;
      state.eStop = false;
      console.log(`E-Stop cleared: ${station}`);
    } else {
      for (const s of StationNameList) {
        this.stationStates.get(s)!.eStop = false;
      }
      console.log('All E-Stops cleared');
    }
    this.broadcast();
  }

  isMatchActive(): boolean {
    return this.phase !== 'idle' && this.phase !== 'created' && this.phase !== 'postMatch';
  }

  addStateListener(fn: (state: MatchState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getState(): MatchState {
    const stationStates: Partial<Record<StationName, StationControlState>> = {};
    for (const station of StationNameList) {
      const blockedReason = this.enableBlocked?.(station) ?? undefined;
      const connectedAt = this.connectedAtResolver?.(station) ?? undefined;
      const state = {
        ...this.stationStates.get(station)!,
        dsAttached: this.isDsAttached(station),
        ...(blockedReason ? { blockedReason } : {}),
        ...(connectedAt !== undefined ? { connectedAt } : {}),
        // Kept after the disable so clients can show "last drove at"
        lastEnabledAt: this.lastFmsEnable.get(station),
      };
      // When not in active match or postMatch, resolve live team numbers; during a match, use the snapshot
      if (!this.isMatchActive() && this.phase !== 'postMatch') state.teamNumber = this.teamResolver(station);
      stationStates[station] = state;
    }

    const awaitingAutoWinner =
      this.phase === 'autoPause' && this.config?.autoWinner === 'pause' && !this.autoWinnerAlliance;

    const staffStates = {} as Record<StaffRole, StaffRoleState>;
    for (const role of StaffRoleList) {
      const s = this.staffReady.get(role)!;
      staffStates[role] = { ready: s.ready, ignored: s.ignored, connected: this.isStaffConnected(role) };
    }

    // Shift scoring state — computed from the game phase, which survives
    // pauses (a paused match stays in its pre-pause sub-period)
    const effectivePhase = this.phase === 'paused' ? (this.prePausePhase ?? undefined) : this.phase;
    const subPeriod = this.config
      ? getMatchSubPeriod(effectivePhase, this.remainingTime, this.config.teleopDuration)
      : null;
    const inactiveGoalAlliance = this.config
      ? getAllianceShiftState(
          effectivePhase,
          this.remainingTime,
          this.config.teleopDuration,
          this.config.endgameDuration,
          this.autoWinnerAlliance,
        )
      : null;

    return {
      type: 'matchState',
      // Kept after the match ends (postMatch/idle) so late consumers can still link to it
      matchId: this.matchId ?? undefined,
      shareToken: this.shareToken ?? undefined,
      matchNumber: this.matchNumber || undefined,
      subPeriod,
      inactiveGoalAlliance,
      phase: this.phase,
      remainingTime: Math.max(0, this.remainingTime),
      totalMatchTime: this.totalMatchTime,
      // Always expose config so clients can show/edit pending timing
      config: this.config ?? this.pendingConfig,
      stationStates,
      connectedStations: Object.fromEntries(
        [...this.dsConnections].map(([station, conn]) => [station, { ...conn, ...this.endpointFor(conn.ip) }]),
      ),
      endReason: this.phase === 'postMatch' ? this.endReason : undefined,
      portToSlot: this.portToSlot.size > 0 ? Object.fromEntries(this.portToSlot) : undefined,
      autoWinnerAlliance: this.autoWinnerAlliance,
      awaitingAutoWinner: awaitingAutoWinner || undefined,
      pausedFrom: this.phase === 'paused' ? (this.prePausePhase ?? undefined) : undefined,
      resumeAt: this.resumeAt ?? undefined,
      readyRequested: this.readyRequested,
      staffStates,
    };
  }

  // ── Private ───────────────────────────────────────────────────────

  private getJoinedCount(): number {
    let count = 0;
    for (const state of this.stationStates.values()) {
      if (state.joined) count++;
    }
    return count;
  }

  /** End match because all stations left. */
  private endMatchEmpty() {
    this.cancelResumeCountdown();
    this.disableAll();
    this.endReason = 'abandoned';
    this.phase = 'postMatch';
    this.remainingTime = 0;
    this.stopTick();
    this.schedulePostMatchAutoClear();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} ended — all stations left`);
    this.broadcast();
  }

  private tick() {
    const now = Date.now();
    const elapsed = (now - this.lastTickTime) / 1000;
    this.lastTickTime = now;

    this.remainingTime -= elapsed;
    this.totalMatchTime += elapsed;

    this.transition();
    this.sendPacketsToAll();
    this.broadcast();
  }

  private transition() {
    if (!this.config) return;

    // Handle postMatch counting period (balls in flight)
    if (this.phase === 'postMatch') {
      if (this.remainingTime <= 0) {
        this.remainingTime = 0;
        this.stopTick();
        // Release stations so teams regain DS control
        for (const state of this.stationStates.values()) {
          state.joined = false;
          state.ready = false;
          state.alliance = null;
          state.matchSlot = null;
        }
        this.broadcast();
        console.log('Post-match counting period complete — stations released');
      }
      return;
    }

    if (this.remainingTime > 0) {
      // Check for endgame transition (within teleop)
      if (this.phase === 'teleop' && this.remainingTime <= this.config.endgameDuration) {
        this.phase = 'endgame';
        console.log('Endgame started');
      }
      return;
    }

    // Phase expired — move to next
    switch (this.phase) {
      case 'countdown':
        if (this.config.skipAuto || this.config.autoDuration <= 0) {
          // Skip auto — go straight to teleop
          this.phase = 'teleop';
          this.remainingTime = this.config.teleopDuration;
          this.enableParticipating('teleOp');
          this.sendPacketsToAll();
          console.log('Teleop period started (auto skipped)');
        } else {
          this.phase = 'auto';
          this.remainingTime = this.config.autoDuration;
          this.enableParticipating('auto');
          this.sendPacketsToAll();
          console.log('Autonomous period started');
        }
        break;

      case 'auto':
        if (this.config.pauseDuration > 0 || this.config.autoWinner === 'pause') {
          // Enter pause — auto winner computed at end of pause so late-arriving
          // auto-period balls are included in the winner calculation.
          this.phase = 'autoPause';
          this.remainingTime = this.config.pauseDuration;
          this.disableAll();
          this.sendPacketsToAll();

          // If awaiting manual winner selection, freeze the countdown
          if (this.config.autoWinner === 'pause' && !this.autoWinnerAlliance) {
            this.stopTick();
            console.log('Auto pause — awaiting manual winner selection (countdown frozen)');
          } else {
            console.log('Auto-to-teleop pause');
          }
        } else {
          // Skip pause — compute auto winner now and go straight to teleop
          this.computeAutoWinner();
          this.phase = 'teleop';
          this.remainingTime = this.config.teleopDuration;
          this.enableParticipating('teleOp');
          this.sendPacketsToAll();
          console.log('Teleop period started (pause skipped)');
        }
        break;

      case 'autoPause':
        // Compute auto winner at end of pause — all auto-period balls are now counted.
        // For 'pause' mode this is a no-op (winner was set manually during pause).
        this.computeAutoWinner();
        this.phase = 'teleop';
        this.remainingTime = this.config.teleopDuration;
        this.enableParticipating('teleOp');
        this.sendPacketsToAll();
        console.log('Teleop period started');
        break;

      case 'teleop':
      case 'endgame':
        this.endReason = 'normal';
        this.phase = 'postMatch';
        this.remainingTime = POST_MATCH_COUNT_SECONDS;
        this.disableAll();
        this.schedulePostMatchAutoClear();
        // Keep tick running for the counting period
        console.log(`Match complete — ${POST_MATCH_COUNT_SECONDS}s counting period`);
        break;
    }
  }

  /** Determine which alliance won the autonomous period. */
  private computeAutoWinner() {
    if (!this.config) return;
    const mode = this.config.autoWinner ?? 'scores';

    if (mode === 'red') {
      this.autoWinnerAlliance = 'red';
      console.log('Auto winner: RED (manual override)');
    } else if (mode === 'blue') {
      this.autoWinnerAlliance = 'blue';
      console.log('Auto winner: BLUE (manual override)');
    } else if (mode === 'pause') {
      // Don't compute — will be set manually by the match controller
      console.log('Auto winner: awaiting manual selection');
    } else {
      // 'scores' mode — use scoring engine
      if (this.autoScoreResolver) {
        try {
          const scores = this.autoScoreResolver();
          if (scores.red > scores.blue) {
            this.autoWinnerAlliance = 'red';
          } else if (scores.blue > scores.red) {
            this.autoWinnerAlliance = 'blue';
          } else {
            // Tie — REBUILT picks randomly
            this.autoWinnerAlliance = Math.random() < 0.5 ? 'red' : 'blue';
          }
          const tieNote = scores.red === scores.blue ? ', random tiebreak' : '';
          console.log(
            `Auto winner: ${this.autoWinnerAlliance} (scores: red=${scores.red}, blue=${scores.blue}${tieNote})`,
          );
        } catch (err) {
          appError(`Auto score resolver failed: ${err}`);
          this.autoWinnerAlliance = Math.random() < 0.5 ? 'red' : 'blue';
        }
      } else {
        this.autoWinnerAlliance = Math.random() < 0.5 ? 'red' : 'blue';
        console.log(`Auto winner: ${this.autoWinnerAlliance} (random — no score resolver)`);
      }
    }
  }

  /** Schedule the automatic postMatch → idle transition. No-op for e-stop endings. */
  private schedulePostMatchAutoClear() {
    this.cancelPostMatchAutoClear();
    if (this.endReason === 'estop') return;
    this.autoClearTimer = setTimeout(() => {
      this.autoClearTimer = null;
      if (this.phase === 'postMatch') {
        console.log(`Post-match auto-clear after ${POST_MATCH_AUTO_CLEAR_MS / 1000}s — returning to idle`);
        this.clearMatch();
      }
    }, POST_MATCH_AUTO_CLEAR_MS);
  }

  private cancelPostMatchAutoClear() {
    if (this.autoClearTimer) {
      clearTimeout(this.autoClearTimer);
      this.autoClearTimer = null;
    }
  }

  /** Clear the match — transitions from postMatch → idle. Called manually or by the auto-clear timer. */
  clearMatch() {
    if (this.phase !== 'postMatch') {
      appWarn(`Cannot clear match in phase ${this.phase}`);
      return;
    }
    this.cancelPostMatchAutoClear();
    this.stopTick(); // In case counting period is still running
    this.config = null;
    this.phase = 'idle';
    this.remainingTime = 0;
    this.portToSlot.clear();
    this.autoWinnerAlliance = null;
    this.endReason = undefined;
    this.resetReadyCheckAndStaff();
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
    }
    console.log('Match cleared');
    this.broadcast();
  }

  private sendJoinedHeartbeat() {
    // The 250ms match tick is the transmitter while it runs. This heartbeat
    // covers every state where the tick is stopped — including a paused match
    // and an autoPause frozen awaiting a winner. The stream must never go
    // silent mid-match: a pause used to send a single disable packet and stop,
    // so if that one datagram was lost the DS kept the pre-pause enabled state
    // and the robot could still drive "while paused" (2026-07-23 incident).
    if (this.tickTimer) return;
    for (const station of StationNameList) {
      if (this.stationStates.get(station)!.joined) {
        this.sendDSPacket(station);
      }
    }
  }

  private enableParticipating(mode: 'auto' | 'teleOp') {
    for (const station of StationNameList) {
      const state = this.stationStates.get(station)!;
      // A-Stop only lasts through the autonomous period — release it at teleop
      if (mode === 'teleOp' && state.aStop) {
        state.aStop = false;
        console.log(`A-Stop released for teleop: ${station}`);
      }
      const blocked = this.enableBlocked?.(station);
      if (blocked) {
        // Field policy forbids this control system — hold it disabled for the
        // whole match rather than enabling with everyone else.
        state.enabled = false;
        console.log(`Not enabling ${station}: ${blocked}`);
        continue;
      }
      if (state.joined && !state.eStop && !state.aStop) {
        state.enabled = true;
        state.mode = mode;
        state.disabledBy = null;
        this.markFmsEnabled(station);
      }
    }
  }

  /** Send a raw control packet to an arbitrary IP. Used for duplicate DS blocking. */
  sendRawControlPacket(ip: string, station: StationName, tags: OutboundTag[] = []) {
    const seq = (this.sequenceNumbers.get(station) ?? 0) + 1;
    this.sequenceNumbers.set(station, seq);

    const control = new Control(false, false, 'teleOp'); // disabled, not e-stopped

    // Alliance-aware slot (falls back to the physical default for unjoined
    // stations, e.g. duplicate DS blocking outside of match context).
    const allianceStation = this.slotForStation(station);
    const endpoint = this.endpointFor(ip);
    const packet = makeDSPacket({
      sequence: seq & 0xffff,
      control,
      allianceStation,
      tournamentLevel: 'Practice',
      matchNumber: 0,
      playNumber: 0,
      matchTime: new Date(),
      remainingTime: 0,
      tags,
      protocol: endpoint.protocol,
    });

    this.udpSocket.send(packet, 0, packet.length, endpoint.udpPort, ip, err => {
      if (err) appError(`Failed to send control packet to ${ip}: ${err.message}`);
    });
  }

  private disableAll() {
    for (const station of StationNameList) {
      this.stationStates.get(station)!.enabled = false;
    }
  }

  private stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private sendPacketsToAll() {
    for (const station of StationNameList) {
      if (this.stationStates.get(station)!.joined) {
        this.sendDSPacket(station);
      }
    }
  }

  private sendDSPacket(station: StationName) {
    const ip = this.dsConnections.get(station)?.ip;
    if (!ip) return;

    const state = this.stationStates.get(station)!;
    const seq = (this.sequenceNumbers.get(station) ?? 0) + 1;
    this.sequenceNumbers.set(station, seq);

    // Never send the e-stop or a-stop bits to the DS — always use disable.
    // Both are backend-only states that prevent re-enabling.
    const control = new Control(false, state.enabled && !state.eStop && !state.aStop, state.mode);

    // Alliance station byte — which side of the field the DS shows. Derived from
    // the joined alliance before the match starts, then the assigned match slot
    // once it does. This is the critical decoupling: the DS sees the alliance
    // position, not the physical port.
    const allianceStation = this.slotForStation(station);

    // Build game data tags — during teleop/endgame, send the auto winner character
    // per REBUILT game rules: 'R' = red's goal inactive first, 'B' = blue's goal inactive first
    const tags: OutboundTag[] = [];
    if (
      this.autoWinnerAlliance &&
      (this.phase === 'teleop' || this.phase === 'endgame' || this.phase === 'autoPause')
    ) {
      tags.push({ type: 'gameData', data: this.autoWinnerAlliance === 'red' ? 'R' : 'B' });
    }

    const endpoint = this.endpointFor(ip);
    const target = `${ip}:${endpoint.udpPort}/${endpoint.protocol}`;
    if (this.lastControlTarget.get(station) !== target) {
      this.lastControlTarget.set(station, target);
      console.log(`Match control for ${station} now sent to ${target} as ${allianceStation}`);
    }
    const packet = makeDSPacket({
      sequence: seq & 0xffff,
      control,
      allianceStation,
      tournamentLevel: 'Practice',
      matchNumber: this.matchNumber,
      playNumber: 1,
      matchTime: new Date(),
      remainingTime: Math.max(0, Math.round(this.remainingTime)),
      tags,
      protocol: endpoint.protocol,
    });

    this.udpSocket.send(packet, 0, packet.length, endpoint.udpPort, ip, err => {
      if (err) appError(`Failed to send DS packet to ${station} (${ip}): ${err.message}`);
    });
  }

  private broadcast() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in match state listener:', err);
      }
    }
  }
}
