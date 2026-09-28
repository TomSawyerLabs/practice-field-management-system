import {
  SETUP_CHECK_MIN_BATTERY_VOLTS,
  StationNameList,
  type Alliance,
  type MatchState,
  type RadioUpdate,
  type SetupCheckLevel,
  type StationChecksState,
  type StationName,
  type StationSetupChecks,
} from './types.js';

/**
 * Per-robot setup checks for the scoreboard: the ladder a team works through
 * before a match (DS → FMS, radio link, robot comms, joysticks, battery,
 * Ready). Derived here rather than in the browser because the scoreboard sits
 * on the public socket, which never sees radio link state, and because the
 * two telemetry producers (DS status and sniffed robot packets) look the same
 * once they reach a client.
 */

/** How recent an observation must be to count. DS status arrives at 2 Hz and
 *  robot/DS packets at ~50 Hz, so a few seconds of silence means it stopped. */
export const CHECK_FRESH_MS = {
  dsStatus: 3_000,
  robotPacket: 3_000,
  joysticks: 3_000,
  battery: 5_000,
  /** The radio is polled every few seconds; much older than this and the
   *  link state is no longer worth showing. */
  radio: 30_000,
} as const;

/** Everything the verdicts are computed from, for one station. */
export interface StationCheckInputs {
  /** Team whose Wi-Fi is configured on the station (null = empty station) */
  team: number | null;
  alliance: Alliance | null;
  joined: boolean;
  ready: boolean;
  readyRequested: boolean;
  /** DS status heartbeats flowing (FMS mode) */
  dsAttached: boolean;
  /** DS known to the FMS over TCP */
  dsConnected: boolean;
  /** Robot radio linked to the field radio; null = no current radio status */
  radioLinked: boolean | null;
  /** Robot/DS packet capture is running, so silence from a robot means something */
  captureActive: boolean;
  /** Latest DS status (UDP 1160): when, and whether the DS has robot comms */
  dsStatus?: { at: number; robotComms: boolean };
  /** Latest robot→DS packet seen (UDP 1150) */
  robotPacketAt?: number;
  /** Latest DS→robot packet seen (UDP 1110) and the joysticks it carried */
  joysticks?: { at: number; count: number };
  battery?: { at: number; volts: number };
}

const fresh = (at: number | undefined, windowMs: number, now: number) => at !== undefined && now - at <= windowMs;

export function evaluateStationChecks(
  station: StationName,
  input: StationCheckInputs,
  now: number,
): StationSetupChecks | null {
  if (input.team === null) return null;

  const ds: SetupCheckLevel = input.dsAttached ? 'ok' : input.dsConnected ? 'partial' : 'bad';

  const radio: SetupCheckLevel = input.radioLinked === null ? 'unknown' : input.radioLinked ? 'ok' : 'bad';

  // The DS's own report wins. Without it (a DS not in FMS mode sends no
  // status), a robot answering its DS proves comms: the roboRIO only sends
  // status in reply to DS packets, and those replies always cross pFMS as the
  // robot's gateway — so with the capture running, their absence is a failure.
  let robotComms: SetupCheckLevel;
  if (input.dsStatus && fresh(input.dsStatus.at, CHECK_FRESH_MS.dsStatus, now)) {
    robotComms = input.dsStatus.robotComms ? 'ok' : 'bad';
  } else if (fresh(input.robotPacketAt, CHECK_FRESH_MS.robotPacket, now)) {
    robotComms = 'ok';
  } else if (input.radioLinked === false || input.captureActive) {
    robotComms = 'bad';
  } else {
    robotComms = 'unknown';
  }

  // DS→robot traffic only sometimes crosses pFMS, so no packets means we
  // can't tell — not that there are no joysticks.
  const sticks = input.joysticks && fresh(input.joysticks.at, CHECK_FRESH_MS.joysticks, now) ? input.joysticks : null;
  const joysticks: SetupCheckLevel = sticks ? (sticks.count > 0 ? 'ok' : 'bad') : 'unknown';

  const volts = input.battery && fresh(input.battery.at, CHECK_FRESH_MS.battery, now) ? input.battery.volts : null;
  const battery: SetupCheckLevel = volts === null ? 'unknown' : volts >= SETUP_CHECK_MIN_BATTERY_VOLTS ? 'ok' : 'bad';

  const ready: SetupCheckLevel = !input.joined || !input.readyRequested ? 'waiting' : input.ready ? 'ok' : 'bad';

  return {
    station,
    team: input.team,
    alliance: input.alliance,
    ds,
    radio,
    robotComms,
    joysticks,
    ...(sticks && { joystickCount: sticks.count }),
    battery,
    // One decimal: the display shows no more, and it keeps the broadcast from
    // changing on every millivolt of noise.
    ...(volts !== null && { batteryVoltage: Math.round(volts * 10) / 10 }),
    ready,
  };
}

interface Observations {
  dsStatus?: { at: number; robotComms: boolean };
  robotPacketAt?: number;
  joysticks?: { at: number; count: number };
  battery?: { at: number; volts: number };
}

/** Collects the per-station observations the checks need and turns them,
 *  plus the match engine's view, into a `stationChecks` snapshot. */
export class StationChecksTracker {
  private readonly observations = new Map<StationName, Observations>();
  private radio: { update: RadioUpdate; at: number } | null = null;

  constructor(
    private readonly deps: {
      getMatchState: () => Pick<MatchState, 'stationStates' | 'connectedStations' | 'readyRequested'>;
      /** True while robot/DS packet capture is running */
      captureActive: () => boolean;
    },
  ) {}

  private obs(station: StationName): Observations {
    let o = this.observations.get(station);
    if (!o) {
      o = {};
      this.observations.set(station, o);
    }
    return o;
  }

  /** DS status heartbeat (UDP 1160). The DS reports a battery voltage even
   *  with no robot, so only trust it while the DS has robot comms. */
  noteDsStatus(station: StationName, robotComms: boolean, volts: number | undefined, now = Date.now()) {
    const o = this.obs(station);
    o.dsStatus = { at: now, robotComms };
    if (robotComms && volts !== undefined && volts > 0) o.battery = { at: now, volts };
  }

  /** Robot→DS status packet (UDP 1150). */
  noteRobotPacket(station: StationName, volts: number | undefined, now = Date.now()) {
    const o = this.obs(station);
    o.robotPacketAt = now;
    if (volts !== undefined) o.battery = { at: now, volts };
  }

  /** DS→robot control packet (UDP 1110) and how many joysticks it carried. */
  noteJoysticks(station: StationName, count: number, now = Date.now()) {
    this.obs(station).joysticks = { at: now, count };
  }

  noteRadioUpdate(update: RadioUpdate, now = Date.now()) {
    this.radio = { update, at: now };
  }

  snapshot(now = Date.now()): StationChecksState {
    const match = this.deps.getMatchState();
    const radio = this.radio && now - this.radio.at <= CHECK_FRESH_MS.radio ? this.radio.update : null;
    const captureActive = this.deps.captureActive();
    const stations: StationChecksState['stations'] = {};
    for (const station of StationNameList) {
      const control = match.stationStates[station];
      const o = this.observations.get(station) ?? {};
      const checks = evaluateStationChecks(
        station,
        {
          team: control?.teamNumber ?? null,
          alliance: control?.alliance ?? null,
          joined: control?.joined ?? false,
          ready: control?.ready ?? false,
          readyRequested: match.readyRequested,
          dsAttached: control?.dsAttached ?? false,
          dsConnected: match.connectedStations[station] !== undefined,
          radioLinked: radio ? (radio.stationStatuses[station]?.isLinked ?? false) : null,
          captureActive,
          ...o,
        },
        now,
      );
      if (checks) stations[station] = checks;
    }
    return { type: 'stationChecks', stations };
  }
}
