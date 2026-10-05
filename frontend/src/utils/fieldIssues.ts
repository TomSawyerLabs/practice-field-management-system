/**
 * Field-network triage: turn everything the frontend already knows about the
 * field into a short list of *problems*, each with the evidence and what to
 * try. The /csa page renders nothing but this list (plus a station strip), so
 * an all-green field shows almost nothing.
 *
 * Pure function of its inputs — no hooks, no time reads — so it can be unit
 * tested and so the page can re-run it every second with a fresh `now`.
 *
 * Thresholds and wording come from what has actually gone wrong on the field
 * (see plans/blue-ds-dropout-2026-09-27.md, plans/ready-requires-ds-link.md,
 * plans/match-roster-team-identity.md, docs/network.md "Host tuning").
 */
import type {
  DriveSessionState,
  MatchPhase,
  MatchState,
  StationControlState,
  NetworkStats,
  PendingCommitState,
  RobotWifiScanState,
  SixGhzWatchState,
  RoutePreferenceState,
  StationName,
  StatusEntry,
  SubnetScanResults,
  TeamCheckResults,
  TelemetryUpdate,
} from '../../../src/types';
import { StationNameList } from '../../../src/types';
import { prettyStationName, teamOfSsid } from '../../../src/utils';
import { robotWifiStaffIssues } from './robotWifi';
import { isSixGhzWatching, sixGhzStaffIssues } from './sixGhzWatch';

export type IssueSeverity = 'critical' | 'warning' | 'info';

/** Something staff can do about an issue, from this page. The page maps the
 *  kind to the websocket call; the detector only says which ones apply. */
export type IssueAction =
  | { kind: 'applyWifi' }
  | { kind: 'reenable'; station: StationName }
  | { kind: 'readyAnyway'; station: StationName }
  | { kind: 'kick'; station: StationName }
  | { kind: 'release'; station: StationName }
  | { kind: 'runChecks'; station: StationName };

export interface FieldIssue {
  /** Stable id (kind + station) so React keys and de-duplication work. */
  id: string;
  severity: IssueSeverity;
  /** Undefined for field-wide problems. */
  station?: StationName;
  /** Team the issue is about, when known. */
  team?: number | null;
  /** What is wrong, in one line, for someone standing at the field. */
  title: string;
  /** The evidence: addresses, ages, counts. Optional. */
  detail?: string;
  /** Shorter evidence for when several robots share one card ("never
   *  linked", "last heard 12 s ago from …"). Falls back to `detail`. */
  evidence?: string;
  /** What to try, in order. Optional. */
  fix?: string;
  actions?: IssueAction[];
}

/** What the page renders: an issue on its own, or several stations with the
 *  same problem folded into one card so six dead robots do not need six
 *  cards (that is exactly what an AP reboot or the start of the day looks
 *  like, and the page must not scroll on a tablet). */
export type IssueRow =
  | { type: 'one'; issue: FieldIssue }
  | {
      type: 'group';
      key: string;
      severity: IssueSeverity;
      title: string;
      members: FieldIssue[];
      fix?: string;
      actions: IssueAction[];
    };

/** Plural headlines for the per-station issues worth folding. Keyed by the
 *  issue kind (its id without the station). Kinds not listed never fold. */
const GROUP_TITLES: Record<string, (n: number, sample: FieldIssue) => string> = {
  'robot-not-linked': (n, s) =>
    s.title.endsWith('dropped off the field Wi-Fi')
      ? `${n} robots dropped off the field Wi-Fi`
      : `${n} robots have not joined the field Wi-Fi`,
  'ds-missing': (n, s) =>
    s.title.endsWith('has gone quiet')
      ? `${n} Driver Stations have gone quiet`
      : `${n} robots in the match have no Driver Station`,
  'no-robot-comms': n => `${n} Driver Stations have no robot communication`,
  'weak-signal': n => `${n} robots have a weak Wi-Fi signal`,
  'marginal-signal': n => `${n} robots with a marginal Wi-Fi signal`,
  'radio-data-stale': n => `${n} robot radios have gone silent to the AP`,
  bandwidth: n => `${n} robots near the Wi-Fi bandwidth cap`,
  'rio-missing': n => `${n} robots on Wi-Fi whose roboRIO is not answering`,
  'ds-absent': n => `${n} robots on the field with nobody driving`,
  'team-checks': n => `${n} robots failed field checks`,
  brownout: n => `${n} robots are browning out`,
};

const STATION_SUFFIX = /-slot[1-6]$/;

/** Fold same-kind, same-severity, same-fix station issues into one row.
 *  Order is preserved: a group sits where its first member was. */
export function groupIssues(issues: readonly FieldIssue[]): IssueRow[] {
  const rows: IssueRow[] = [];
  const groups = new Map<string, Extract<IssueRow, { type: 'group' }>>();
  for (const issue of issues) {
    const kind = issue.station ? issue.id.replace(STATION_SUFFIX, '') : undefined;
    const titleFor = kind && GROUP_TITLES[kind];
    if (!titleFor) {
      rows.push({ type: 'one', issue });
      continue;
    }
    const key = `${kind}|${issue.severity}|${issue.fix ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(issue);
      existing.actions.push(...(issue.actions ?? []));
      existing.title = titleFor(existing.members.length, issue);
      continue;
    }
    const group: Extract<IssueRow, { type: 'group' }> = {
      type: 'group',
      key,
      severity: issue.severity,
      title: issue.title,
      members: [issue],
      fix: issue.fix,
      actions: [...(issue.actions ?? [])],
    };
    groups.set(key, group);
    rows.push(group);
  }
  // A group of one is just its issue.
  return rows.map(r => (r.type === 'group' && r.members.length === 1 ? { type: 'one', issue: r.members[0] } : r));
}

export interface FieldIssueInputs {
  /** Server-clock "now" (see getServerTime) — every timestamp below is server time. */
  now: number;
  wsConnected: boolean;
  /** Latest radio status entry; `radioUpdate` undefined = the AP is not answering. */
  latest: StatusEntry | undefined;
  matchState: MatchState | null;
  driveSession: DriveSessionState | null;
  pending: PendingCommitState | null;
  networkStats: NetworkStats | null;
  routeState: RoutePreferenceState | null;
  subnetScan: SubnetScanResults | null;
  telemetry: Partial<Record<StationName, TelemetryUpdate>>;
  lastLinked: Partial<Record<StationName, number>>;
  teamChecks: Partial<Record<StationName, TeamCheckResults>>;
  /** Resolved names for guest-network hosts (DS laptops), keyed by IP. */
  hostnames: Record<string, string>;
  /** Robots' 2.4 GHz networks heard nearby, when the scan is set up. */
  robotWifi?: RobotWifiScanState | null;
  /** Other access points using teams' network names on 6 GHz, when the
   *  watch is set up. */
  sixGhzWatch?: SixGhzWatchState | null;
}

// ── Thresholds ───────────────────────────────────────────────────────

/** A telemetry sample older than this says nothing about the present. */
const TELEMETRY_FRESH_MS = 10_000;
/** DS heartbeats are 2 Hz; pFMS calls a DS "attached" within 5 s of one. */
const DS_STALE_MS = 5_000;
/** Radio status is re-broadcast at least every 15 s; twice that is a stall. */
const RADIO_STATUS_STALE_MS = 45_000;
/** A linked robot whose radio data hasn't refreshed in this long is suspect. */
const RADIO_DATA_AGE_WARN_MS = 30_000;
/** roboRIO (10.TE.AM.2) silent for this long while the radio is linked. */
const RIO_MISSING_MS = 60_000;
/** FRC caps a robot at 4 Mbps; control packets start dropping near it. */
const BANDWIDTH_WARN_MBPS = 3.5;
/** DS↔robot round trip; the DS itself flags trip time above ~20 ms. */
const RTT_WARN_MS = 50;
/** Share of control packets the robot leaves unanswered before it is worth a look. */
const LINK_LOSS_WARN_PCT = 10;
/** ARP table fill: warn / critical, matching the /network gauge. */
const ARP_WARN_PCT = 70;
const ARP_CRIT_PCT = 90;
/** Team checks older than this are about some earlier visit. */
const TEAM_CHECKS_MAX_AGE_MS = 30 * 60_000;

// ── Helpers ──────────────────────────────────────────────────────────

/** Phases during which robots are (or are about to be) under field control:
 *  everything between the countdown and the end of the match. */
const RUNNING_PHASES: ReadonlySet<MatchPhase> = new Set<MatchPhase>([
  'countdown',
  'auto',
  'autoPause',
  'teleop',
  'endgame',
  'paused',
]);

export function isMatchRunning(phase: MatchPhase | undefined): boolean {
  return phase !== undefined && RUNNING_PHASES.has(phase);
}

/** "12 s", "3 min", "2 h" — short, for detail lines. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

function hostLabel(ip: string, hostnames: Record<string, string>): string {
  const name = hostnames[ip];
  return name ? `${name} (${ip})` : ip;
}

function teamLabel(team: number | null | undefined, ssid?: string): string {
  if (ssid) return ssid;
  return team ? `team ${team}` : 'this robot';
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Stations in "longest on the field first" order: by the time each team's
 *  SSID became the station's active config. A missing timestamp sorts as
 *  the oldest (a config restored from before pFMS tracked this has, in fact,
 *  been here a while), ties by slot number. Slots themselves are not shown
 *  to staff — a CSA thinks in robots, not slot numbers. */
export function stationOrder(matchState: MatchState | null): StationName[] {
  const at = (s: StationName) => matchState?.stationStates[s]?.connectedAt ?? 0;
  return [...StationNameList].sort((a, b) => at(a) - at(b) || StationNameList.indexOf(a) - StationNameList.indexOf(b));
}

/** How a station is named to staff: its robot's SSID, else "team N", else
 *  "this robot". The same words the issues use. */
export function stationLabel(input: Pick<FieldIssueInputs, 'latest' | 'matchState'>, station: StationName): string {
  const ssid = input.latest?.radioUpdate?.stationStatuses[station]?.ssid || undefined;
  const team = input.matchState?.stationStates[station]?.teamNumber ?? teamOfSsid(ssid);
  return teamLabel(team, ssid);
}

// ── Detector ─────────────────────────────────────────────────────────

/** Who decides whether a robot may drive right now, from the field's side. */
export type FieldControlKind =
  | 'estop' // e-stopped: the field cuts the DS's control of the robot until staff clear it
  | 'stopped' // out of a match, stopped from the team's page: the field cuts the DS's control
  | 'blocked' // field policy forbids this control system; held disabled
  | 'held' // out of a match, held disabled (freeplay held by staff)
  | 'matchEnabled' // joined, and the field has it enabled
  | 'matchDisabled' // joined, and the field has it disabled
  | 'team'; // out of a match: the team's own Driver Station Enable/Disable

export interface FieldControl {
  kind: FieldControlKind;
  /** A few words for a station tile. */
  short: string;
  /** One line for the station dialog. */
  label: string;
  /** Why, when there is more to say. */
  why?: string;
  /** What the robot itself reports in its own packets (fresh only). */
  robot?: 'enabled' | 'disabled' | 'eStop';
  /** The robot is enabled while the field holds it disabled. */
  mismatch: boolean;
  /** Out of a match, but the DS still streams status to the field — it
   *  still believes it is under field control (Enable hidden). pFMS drops its
   *  connection when this lasts; a moment of it after leaving a match is
   *  normal. */
  dsUnderField: boolean;
}

const DISABLED_BY_WHY: Record<NonNullable<StationControlState['disabledBy']>, string> = {
  ds: 'their Driver Station disabled it',
  self: 'the team disabled it from their station page',
  admin: 'field staff disabled it',
  relay: 'its relay leg is over',
};

/** The field's side of "can this robot drive", plus the robot's own word for
 *  it. Pure: everything comes from `input`. */
export function fieldControlOf(input: FieldIssueInputs, station: StationName): FieldControl {
  const { now, matchState } = input;
  const control = matchState?.stationStates[station];
  const tele = input.telemetry[station];
  const teleFresh = tele !== undefined && now - tele.timestamp <= TELEMETRY_FRESH_MS;
  const robot: FieldControl['robot'] =
    teleFresh && tele.dsStatus
      ? tele.dsStatus.eStop
        ? 'eStop'
        : tele.dsStatus.enabled
          ? 'enabled'
          : 'disabled'
      : undefined;
  const joined = control?.joined ?? false;
  const phase = matchState?.phase;

  let kind: FieldControlKind;
  let short: string;
  let label: string;
  let why: string | undefined;
  if (control?.eStop) {
    kind = 'estop';
    short = 'E-STOP';
    label = 'E-stopped';
    why = 'The field is cutting the Driver Station’s control of the robot until staff clear the e-stop.';
  } else if (!joined && control?.teamStopped) {
    kind = 'stopped';
    short = 'Stopped';
    label = 'Stopped from the team’s page';
    why = 'The field is cutting the Driver Station’s control of the robot until the team lets it drive again.';
  } else if (control?.blockedReason) {
    kind = 'blocked';
    short = 'Blocked';
    label = 'Held disabled by field policy';
    why = control.blockedReason;
  } else if (!joined && control?.heldReason) {
    kind = 'held';
    short = 'Held';
    label = 'Held disabled by the field';
    why = control.heldReason;
  } else if (joined && control?.enabled) {
    kind = 'matchEnabled';
    short = 'Match: on';
    label = 'In a match — the field has it enabled';
  } else if (joined) {
    kind = 'matchDisabled';
    short = 'Match: off';
    label = 'In a match — the field has it disabled';
    why = control?.aStop
      ? 'A-Stop until teleop.'
      : control?.disabledBy
        ? `Because ${DISABLED_BY_WHY[control.disabledBy]}.`
        : phase === 'created'
          ? 'Waiting for the match to start.'
          : phase === 'postMatch'
            ? 'The match is over.'
            : phase === 'paused' || phase === 'autoPause'
              ? 'The match is paused.'
              : undefined;
  } else {
    kind = 'team';
    short = 'Team control';
    label = 'Team’s own control — Enable/Disable on their Driver Station';
  }

  const holdsDisabled =
    kind === 'estop' || kind === 'stopped' || kind === 'blocked' || kind === 'held' || kind === 'matchDisabled';
  return {
    kind,
    short,
    label,
    why,
    robot,
    mismatch: holdsDisabled && robot === 'enabled',
    // Right after a match the released DS keeps reporting for a few seconds
    // until its forced reconnect; don't call that stuck.
    dsUnderField: kind === 'team' && control?.dsAttached === true && phase !== 'postMatch',
  };
}

export function detectFieldIssues(input: FieldIssueInputs): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const push = (issue: FieldIssue) => issues.push(issue);

  const { now, latest, matchState, driveSession, pending, networkStats, routeState, subnetScan, hostnames } = input;
  const phase = matchState?.phase;
  const running = isMatchRunning(phase);
  const inSetup = phase === 'created';

  // ── Field-wide ─────────────────────────────────────────────────────

  if (!input.wsConnected) {
    push({
      id: 'pfms-disconnected',
      severity: 'critical',
      title: 'This page has lost pFMS',
      detail: 'Nothing below is live until it reconnects.',
      fix: 'Check this device is on the field Wi-Fi and can reach pFMS. If other pages are down too, check the pFMS host.',
    });
    // Everything else would be stale; still report it, marked by the banner above.
  }

  if (latest && latest.radioUpdate === undefined) {
    push({
      id: 'radio-unreachable',
      severity: 'critical',
      title: 'Field radio (access point) is not answering pFMS',
      detail: `No status from the AP for ${shortAge(now - latest.timestamp)}. Robots cannot join or stay on the field Wi-Fi.`,
      fix: 'Check the AP has power and its trunk cable is seated. If it was just power-cycled, allow about two minutes.',
    });
  } else if (latest && input.wsConnected && now - latest.timestamp > RADIO_STATUS_STALE_MS) {
    push({
      id: 'radio-status-stale',
      severity: 'warning',
      title: 'Radio status has stopped updating',
      detail: `Last update ${shortAge(now - latest.timestamp)} ago; pFMS normally hears from the AP every few seconds.`,
      fix: 'pFMS may be stuck polling the AP. Check the logs page; a pFMS restart clears it.',
    });
  } else if (latest?.radioUpdate) {
    const status = latest.radioUpdate.status;
    // CONFIGURING and BOOTING are not issues: the page shows them as a live
    // readout with a countdown (RadioReconfigBanner), and the per-station
    // Wi-Fi link checks below stay quiet until the AP is ACTIVE again.
    if (status === 'ERROR') {
      push({
        id: 'radio-error',
        severity: 'critical',
        title: 'Radio reports an error',
        detail: `AP firmware ${latest.radioUpdate.version} reports status ERROR.`,
        fix: 'Power-cycle the AP. If it comes back in ERROR, its configuration may need reprogramming.',
      });
    }
  }

  const arp = networkStats?.neighborTable;
  if (arp && arp.limit > 0) {
    const pct = Math.round((arp.entries / arp.limit) * 100);
    if (pct >= ARP_WARN_PCT || arp.overflows > 0) {
      const full = pct >= ARP_CRIT_PCT;
      push({
        id: 'arp-table',
        severity: full ? 'critical' : 'warning',
        title: full
          ? 'ARP table nearly full — robots will silently lose their Driver Stations'
          : 'ARP table filling up',
        detail:
          `${arp.entries} of ${arp.limit} entries (${pct}%)` +
          (arp.overflows > 0 ? `; overflowed ${arp.overflows}× since pFMS started` : ''),
        fix: 'Above the limit the kernel drops packets to any host without an entry. Find the chatty VLAN on /network; a pFMS restart clears the table.',
      });
    }
  }

  if (pending?.pending) {
    const radioSsid = (s: string) => latest?.radioUpdate?.stationStatuses[s as StationName]?.ssid || undefined;
    const describeChange = (change: { ssid: string } | null | undefined, current: string | undefined) =>
      change ? `${change.ssid} joins` : current ? `${current} leaves` : 'a release';
    const held = Object.keys(pending.stagedChanges ?? {});
    const deferred = Object.keys(pending.deferredChanges ?? {});
    if (held.length > 0) {
      const why =
        pending.hold === 'admin'
          ? '"Hold Wi-Fi changes" is on in admin.'
          : pending.hold === 'pending'
            ? 'Waiting for staff to apply them.'
            : 'A match is set up; apply them between matches.';
      push({
        id: 'wifi-held',
        severity: 'warning',
        title: `${held.length} Wi-Fi change${held.length === 1 ? '' : 's'} waiting on hold`,
        detail: `${why} Waiting: ${held.map(s => describeChange(pending.stagedChanges![s], radioSsid(s))).join('; ')}.`,
        fix: running
          ? 'Apply now becomes available when the match ends.'
          : 'Apply now if the robots concerned are not about to play — the AP reconfigures for ~30 s.',
        actions: running ? undefined : [{ kind: 'applyWifi' }],
      });
    }
    if (deferred.length > 0) {
      const enabled = StationNameList.filter(s => matchState?.stationStates[s]?.enabled);
      push({
        id: 'wifi-deferred',
        severity: 'info',
        title: 'Applied Wi-Fi changes are waiting for every robot to be disabled',
        detail:
          `Waiting: ${deferred.map(s => describeChange(pending.deferredChanges![s], radioSsid(s))).join('; ')}.` +
          (enabled.length > 0
            ? ` Still enabled: ${enabled.map(s => stationLabel(input, s)).join(', ')}.`
            : ' No robot is enabled; the AP should reconfigure momentarily.'),
      });
    }
  }

  if (routeState) {
    for (const [team, stations] of Object.entries(routeState.conflictingTeams)) {
      if (stations.length < 2) continue;
      push({
        id: `duplicate-team-${team}`,
        severity: 'warning',
        team: parseInt(team, 10) || null,
        title: `Team ${team} is on ${stations.length} stations at once`,
        detail: `${stations.map(s => prettyStationName(s)).join(' and ')}. Their laptops cannot tell which robot to drive.`,
        fix: 'Release the slot they are not using. The team can also pick one on /route.',
        actions: stations.map(s => ({ kind: 'release', station: s }) as IssueAction),
      });
    }
  }

  // ── Per station ────────────────────────────────────────────────────

  for (const station of StationNameList) {
    const radio = latest?.radioUpdate?.stationStatuses[station] ?? null;
    const ssid = radio?.ssid || undefined;
    const control = matchState?.stationStates[station];
    const team = control?.teamNumber ?? teamOfSsid(ssid);
    const label = teamLabel(team, ssid);
    const joined = control?.joined ?? false;
    const dsConn = matchState?.connectedStations[station];
    const session = driveSession?.sessions?.[station];
    const blocked = driveSession?.blockedDs?.[station] ?? [];
    const tele = input.telemetry[station];
    const teleFresh = tele !== undefined && now - tele.timestamp <= TELEMETRY_FRESH_MS;
    const dsAttached = control?.dsAttached ?? (dsConn ? now - dsConn.lastSeen <= DS_STALE_MS : false);

    // pFMS and the AP disagree about who is on this slot.
    const radioSettled = latest?.radioUpdate?.status === 'ACTIVE';
    if (control?.teamNumber && teamOfSsid(ssid) !== control.teamNumber) {
      if (joined) {
        // The team pressed Join / Enable Robot but the AP still has someone else: a held change.
        push({
          id: `team-mismatch-${station}`,
          severity: 'info',
          station,
          team: control.teamNumber,
          title: `Team ${control.teamNumber} joined, but the radio ${ssid ? `still has ${ssid}` : 'has nothing for it'}`,
          detail: 'Their Wi-Fi change is held (see above). The robot cannot connect until it is applied.',
        });
      } else if (radioSettled) {
        // Unjoined, the config's team *is* what the AP should have. A wiped or
        // stale radio (2026-07-24) looks like this; pFMS re-applies within 15 s.
        push({
          id: `radio-out-of-sync-${station}`,
          severity: 'warning',
          station,
          team: control.teamNumber,
          title: `pFMS expects team ${control.teamNumber}, but the radio ${ssid ? `has ${ssid}` : 'has nothing for it'}`,
          detail: 'The AP is not carrying the configuration pFMS applied, so that robot cannot connect.',
          fix: 'pFMS re-applies its config on its own within about 15 s. If this stays, the AP may have been reset or power-cycled — check the logs page for "out of sync".',
        });
      }
    }

    if (!ssid) {
      // Empty slot. A joined station with no radio config is covered above.
      continue;
    }

    // ── Robot ↔ AP link ──
    if (!radioSettled) {
      // Every robot is off Wi-Fi while the AP reconfigures or boots; that is
      // expected and the banner says so. Nothing here would be actionable.
    } else if (!radio?.isLinked) {
      const last = input.lastLinked[station];
      const everLinked = last !== undefined;
      const inMatch = joined && (running || inSetup);
      push({
        id: `robot-not-linked-${station}`,
        severity: inMatch ? 'critical' : 'warning',
        station,
        team,
        title: everLinked ? `${label} dropped off the field Wi-Fi` : `${label} has not joined the field Wi-Fi`,
        detail: everLinked
          ? `Last linked ${shortAge(now - last)} ago.`
          : 'Its Wi-Fi is on the field, but its radio has never associated.',
        evidence: everLinked ? `last linked ${shortAge(now - last)} ago` : 'never linked',
        fix: everLinked
          ? 'Robot power? A brownout reboots the radio (about a minute). If it stays off, check the radio’s power lead and Ethernet to the roboRIO.'
          : 'Radio still booting (up to 2 min after power-on)? Otherwise the robot radio is programmed for a different SSID or key — re-program it, or verify it on the robot tester (/test).',
        actions: inSetup && joined ? [{ kind: 'kick', station }] : undefined,
      });
    } else {
      if (radio.connectionQuality === 'warning') {
        push({
          id: `weak-signal-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label} has a weak Wi-Fi signal`,
          detail: `${radio.signalDbm} dBm, SNR ${radio.signalNoiseRatio} dB, ${radio.rxRateMbps}/${radio.txRateMbps} Mbps.`,
          fix: 'Radio buried in metal or antenna loose? Ask the team to check the radio’s mounting; keep the robot off the far corners while diagnosing.',
        });
      } else if (radio.connectionQuality === 'caution') {
        push({
          id: `marginal-signal-${station}`,
          severity: 'info',
          station,
          team,
          title: `${label}: marginal Wi-Fi signal`,
          detail: `${radio.signalDbm} dBm, SNR ${radio.signalNoiseRatio} dB.`,
        });
      }
      if (radio.dataAgeMs > RADIO_DATA_AGE_WARN_MS) {
        push({
          id: `radio-data-stale-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label}: the AP has not heard from the robot radio for ${shortAge(radio.dataAgeMs)}`,
          detail: 'The AP still lists it as linked, but its stats have stopped updating.',
          fix: 'Usually the robot is powering down or rebooting. If it persists, the radio may have hung — power-cycle the robot.',
        });
      }
      if (radio.bandwidthUsedMbps >= BANDWIDTH_WARN_MBPS) {
        push({
          id: `bandwidth-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label} is using ${radio.bandwidthUsedMbps.toFixed(1)} Mbps of Wi-Fi`,
          detail:
            'The field caps each robot at 4 Mbps; near the cap, control packets get dropped and the DS shows lag.',
          fix: 'Camera streams are the usual cause — lower the resolution or frame rate on the dashboard.',
        });
      }

      // roboRIO reachability from the field: the scanner pings 10.TE.AM.2.
      const scan = subnetScan?.stations[station];
      const rio = scan?.hosts.find(h => h.source !== 'conntrack' && h.ip.endsWith('.2'));
      const rioDownFor = rio && !rio.alive ? now - rio.lastSeen : undefined;
      if (
        scan &&
        scan.team === team &&
        (rio === undefined || (rioDownFor !== undefined && rioDownFor > RIO_MISSING_MS))
      ) {
        const legacy = dsConn?.protocol === 'legacy';
        const linkedFor = now - (input.lastLinked[station] ?? now);
        // Only speak up once the radio has had time to hand the RIO an address.
        if (linkedFor > RIO_MISSING_MS) {
          push({
            id: `rio-missing-${station}`,
            severity: legacy ? 'warning' : 'info',
            station,
            team,
            title: `${label}: radio is on Wi-Fi but the roboRIO is not answering`,
            detail:
              (rio
                ? `10.x.x.2 last answered ${shortAge(rioDownFor!)} ago.`
                : `Nothing at ${scan.subnet.replace(/0(\/\d+)?$/, '2')} yet.`) +
              (legacy ? '' : ' (A SystemCore robot may use a different address — ignore if the DS shows robot comms.)'),
            fix: 'roboRIO still booting (about 40 s)? Check the Ethernet between radio and roboRIO, and that the roboRIO is not on a static IP from another team.',
          });
        }
      }
    }

    // ── Driver Station ↔ field ──
    if (joined) {
      if (!dsAttached) {
        const lastSeen = dsConn?.lastSeen ?? session?.lastActivity;
        const sev = running || inSetup ? 'critical' : 'warning';
        const readied = control?.ready ?? false;
        push({
          id: `ds-missing-${station}`,
          severity: sev,
          station,
          team,
          title: lastSeen !== undefined ? `${label}’s Driver Station has gone quiet` : `No Driver Station for ${label}`,
          detail:
            (lastSeen !== undefined
              ? `Last heard ${shortAge(now - lastSeen)} ago${dsConn ? ` from ${hostLabel(dsConn.ip, hostnames)}` : ''}.`
              : 'It is in the match, but no Driver Station has attached to the field for it.') +
            (running
              ? ' The robot will not respond to match control.'
              : inSetup
                ? readied
                  ? ' It was readied anyway; the match can start without it.'
                  : ' The team cannot press Ready until it does.'
                : ''),
          evidence:
            lastSeen !== undefined
              ? `last heard ${shortAge(now - lastSeen)} ago${dsConn ? ` from ${hostLabel(dsConn.ip, hostnames)}` : ''}`
              : readied
                ? 'never attached, readied anyway'
                : 'never attached',
          fix:
            lastSeen !== undefined
              ? 'Laptop fell off the site Wi-Fi? Check its Wi-Fi icon and that it is on the field network, not a hotspot. It re-attaches by itself when the link is back.'
              : 'Is the DS open with this team number, and the laptop on the field Wi-Fi? If the team was just moved from another slot, restart the Driver Station: it can hold the old slot assignment.',
          actions: [
            ...(inSetup && !readied ? [{ kind: 'readyAnyway', station } as IssueAction] : []),
            ...(inSetup ? [{ kind: 'kick', station } as IssueAction] : []),
          ],
        });
      } else if (running && control && !control.enabled && control.disabledBy === 'ds') {
        push({
          id: `disabled-by-ds-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label} is disabled by its own Driver Station`,
          detail:
            'The DS reported "disabled" while the field wanted it enabled. Either the driver pressed Enter, or the laptop briefly lost the field and the DS disabled itself.',
          fix: 'If the team did not disable on purpose, re-enable it. pFMS re-enables on its own when a DS comes back after dropping off.',
          actions: [{ kind: 'reenable', station }],
        });
      }
    } else if (driveSession && radio?.isLinked && !session && !dsConn) {
      // Out of a match a DS still shows up as a drive session once it talks to
      // the field. Drive-session state arrives a few seconds after connecting;
      // until it does (null) we cannot tell absent from unknown, so stay quiet.
      push({
        id: `ds-absent-${station}`,
        severity: 'info',
        station,
        team,
        title: `${label} is on the field with no Driver Station talking to it`,
        detail: 'Fine if the team is not at their station yet.',
      });
    }

    if (blocked.length > 0) {
      const accepted = session?.dsIp ?? dsConn?.ip;
      push({
        id: `ds-blocked-${station}`,
        severity: 'warning',
        station,
        team,
        title: `A second Driver Station is trying to drive ${label}`,
        detail:
          `Blocked: ${blocked.map(ip => hostLabel(ip, hostnames)).join(', ')}.` +
          (accepted
            ? ` Only ${hostLabel(accepted, hostnames)} can control this station${session ? ` (times out in ${session.timeoutRemaining} s if it goes quiet)` : ''}.`
            : ''),
        fix: 'Two laptops open with the same team number: close one. If the accepted laptop belongs to the team that had this slot before, have them close their Driver Station; the slot frees when their session times out.',
      });
    }

    // ── Who controls the robot ──
    const fc = fieldControlOf(input, station);
    if (fc.mismatch) {
      push({
        id: `enabled-while-held-${station}`,
        severity: 'critical',
        station,
        team,
        title: `${label} is enabled while the field holds it disabled`,
        detail: `Field: ${fc.label.toLowerCase()}${fc.why ? ` (${fc.why})` : ''}. The robot’s own packets say it is enabled.`,
        fix: 'E-stop it now if it is moving. Then check this station’s Driver Station is the one the field is controlling (a second laptop?).',
      });
    } else if (fc.dsUnderField) {
      push({
        id: `ds-under-field-${station}`,
        severity: 'warning',
        station,
        team,
        title: `${label}’s Driver Station still thinks the field controls it`,
        detail:
          'It is not in a match, so the team should have its own Enable/Disable, but the DS keeps reporting to the field (its Enable button is probably hidden).',
        fix: 'pFMS drops its connection on its own so it comes back under the team’s control. If Enable stays hidden for more than a minute, restart the Driver Station.',
      });
    }

    // ── DS ↔ robot, as the DS itself reports it ──
    if (teleFresh && tele.dsStatus && dsAttached) {
      const ds = tele.dsStatus;
      if (!ds.robotComms) {
        const what = !ds.radioPing
          ? 'cannot even ping the robot radio'
          : !ds.rioPing
            ? 'pings the radio but not the roboRIO'
            : 'pings the roboRIO but has no robot code communication';
        push({
          id: `no-robot-comms-${station}`,
          severity: running || inSetup ? 'critical' : 'warning',
          station,
          team,
          title: `${label}’s Driver Station has no robot communication`,
          detail: `The DS is talking to the field but ${what}.`,
          fix: !ds.radioPing
            ? 'The laptop cannot reach 10.TE.AM.x: wrong team number in the DS, or the laptop is on a network without the field route (hotspot?). Compare with the robot’s link above.'
            : !ds.rioPing
              ? 'Radio is up, roboRIO is not: check its power and the Ethernet from the radio. Boot takes about 40 s.'
              : 'roboRIO answers but robot code is not running or is crashing: check the DS diagnostics tab for the code light.',
        });
      } else if (tele.rttMs !== undefined && tele.rttMs > RTT_WARN_MS) {
        push({
          id: `high-rtt-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label}: ${Math.round(tele.rttMs)} ms round trip between Driver Station and robot`,
          detail: 'Normal is under 20 ms. Control will feel laggy and packets may drop.',
          fix: 'Weak signal or a bandwidth hog (see other issues for this robot)? A busy laptop CPU also does this — close the video stream.',
        });
      }
      if (tele.brownout) {
        push({
          id: `brownout-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label} is browning out`,
          detail: `Battery ${tele.batteryVoltage?.toFixed(1) ?? '?'} V. A deep brownout reboots the radio and drops the robot off the field.`,
          fix: 'Fresh battery.',
        });
      }
    }

    // ── Robot link, timed by pFMS from the DS's control packets and the
    //    robot's replies (works out of a match, unlike the DS's own report) ──
    const cutByField = fc.kind === 'estop' || fc.kind === 'stopped';
    if (teleFresh && !cutByField) {
      if (tele.robotLinkLossPct !== undefined && tele.robotLinkLossPct >= LINK_LOSS_WARN_PCT) {
        push({
          id: `robot-link-loss-${station}`,
          severity: tele.robotLinkLossPct >= 50 ? 'critical' : 'warning',
          station,
          team,
          title: `${label} is missing ${Math.round(tele.robotLinkLossPct)}% of its Driver Station’s control packets`,
          detail:
            'Measured by the field: control packets that reached the robot’s network but got no reply within 1 s.',
          fix: 'Weak signal or a bandwidth hog (see other issues for this robot)? A robot that is rebooting or has lost robot code also stops answering.',
        });
      } else if (
        tele.robotLinkRttMs !== undefined &&
        tele.robotLinkRttMs > RTT_WARN_MS &&
        !(dsAttached && tele.rttMs !== undefined)
      ) {
        push({
          id: `robot-link-rtt-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label}: ${Math.round(tele.robotLinkRttMs)} ms round trip from the field to the robot`,
          detail: 'Measured by the field on the robot’s Wi-Fi leg. Normal is a few ms.',
          fix: 'Weak signal or a bandwidth hog (see other issues for this robot)?',
        });
      }
    }

    // ── Team checks (robot tester / on-field checks) ──
    const checks = input.teamChecks[station];
    if (checks && checks.team === team && now - checks.timestamp <= TEAM_CHECKS_MAX_AGE_MS) {
      const failing = checks.checks.filter(c => c.status === 'fail');
      if (failing.length > 0) {
        push({
          id: `team-checks-${station}`,
          severity: 'warning',
          station,
          team,
          title: `${label} failed ${failing.length} field check${failing.length === 1 ? '' : 's'}`,
          detail: failing.map(c => c.name + (c.actual ? `: ${c.actual}` : '')).join('; '),
          fix: 'Open the team’s page for the details and fix links, then re-run.',
          actions: [{ kind: 'runChecks', station }],
        });
      }
    }

    if (control?.blockedReason) {
      push({
        id: `policy-blocked-${station}`,
        severity: 'warning',
        station,
        team,
        title: `${label} is blocked by field policy`,
        detail: control.blockedReason,
      });
    }
  }

  // ── Robots heard on 2.4 GHz (robot Wi-Fi scan) ──────────────────────
  // Per team, not per station: a robot that never connects has no station.
  const sixGhzWatching = isSixGhzWatching(input.sixGhzWatch);
  for (const w of robotWifiStaffIssues(input.robotWifi, input.now, { sixGhzWatching })) {
    push({
      id: w.id,
      severity: w.severity,
      team: w.team || undefined,
      title: w.title,
      detail: w.detail,
      fix: w.fix,
    });
  }

  // ── Other access points with a team's network name (6 GHz watch) ────
  for (const w of sixGhzStaffIssues(input.sixGhzWatch)) {
    push({
      id: w.id,
      severity: w.severity,
      ...(w.station && { station: w.station }),
      team: w.team,
      title: w.title,
      detail: w.detail,
      fix: w.fix,
    });
  }

  const rank = new Map(stationOrder(matchState).map((s, i) => [s, i]));
  return issues.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    // Field-wide before per-station, then longest on the field first.
    if (!a.station !== !b.station) return a.station ? 1 : -1;
    return (rank.get(a.station!) ?? 0) - (rank.get(b.station!) ?? 0);
  });
}

/** Worst severity among a list, or undefined when it is empty. */
export function worstSeverity(issues: readonly FieldIssue[]): IssueSeverity | undefined {
  let worst: IssueSeverity | undefined;
  for (const i of issues) {
    if (!worst || SEVERITY_RANK[i.severity] < SEVERITY_RANK[worst]) worst = i.severity;
  }
  return worst;
}
