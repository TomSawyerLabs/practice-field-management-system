import type { MatchPhase, MatchState, StationName } from '../../../src/types';

/**
 * Getting a stop from a press to the field, or saying plainly that it didn't.
 *
 * A socket can't be trusted to say it delivered anything. A closed one drops a
 * send, a connecting one throws, and a half-dead one takes it and delivers
 * nothing for up to 30 s, until the watchdog notices. So a press isn't done
 * when it's sent, it's done when the field's own state shows the stop: until
 * then it stays here, is sent again on every new socket, and the page says it
 * hasn't landed. Every stop is safe to repeat, and none needs a login.
 */

/** How long the field gets to show a stop before the page says it can't tell.
 *  A reply takes well under a second, even over the field's Wi-Fi. */
export const STOP_CONFIRM_MS = 2_000;

/** How long a press stays alive. Long enough for a backend restart; short
 *  enough that it can't fire after someone has dealt with what prompted it. */
export const STOP_QUEUE_MAX_MS = 30_000;

export type StopMessage =
  | { type: 'adminGlobalEStop' }
  | { type: 'adminStationEStop'; station: StationName }
  | { type: 'stationSelfEStop'; station: StationName }
  | { type: 'stationSelfAStop'; station: StationName }
  | { type: 'stationTeamStop'; station: StationName; stop: true }
  | { type: 'stationSelfDisable'; station: StationName }
  | { type: 'adminStationDisable'; station: StationName }
  | { type: 'adminStopMatch' }
  | { type: 'stationPauseMatch' }
  | { type: 'matchAbortCountdown' };

/** - `queued`: no working socket, so it hasn't reached the field.
 *  - `sent`: on a socket, and the field has a moment to show it.
 *  - `unconfirmed`: sent, and the field hasn't shown it.
 *  - `dropped`: given up on, and left on screen until it's dismissed. */
export type StopStage = 'queued' | 'sent' | 'unconfirmed' | 'dropped';

export type StopPress = {
  key: string;
  /** What was pressed, for a person. */
  label: string;
  station?: StationName;
  pressedAt: number;
  stage: StopStage;
  /** Last put on a socket, if ever. */
  sentAt?: number;
  droppedAt?: number;
};

const LABELS: Record<StopMessage['type'], string> = {
  adminGlobalEStop: 'Field E-Stop',
  adminStationEStop: 'E-Stop',
  stationSelfEStop: 'E-Stop',
  stationSelfAStop: 'A-Stop',
  stationTeamStop: 'Stop',
  stationSelfDisable: 'Disable',
  adminStationDisable: 'Disable',
  adminStopMatch: 'Cancel match',
  stationPauseMatch: 'Pause',
  matchAbortCountdown: 'Cancel countdown',
};

const ROBOTS_RUNNING: readonly MatchPhase[] = ['countdown', 'auto', 'autoPause', 'paused', 'teleop', 'endgame'];

/** Whether the field's state shows this stop has taken. */
export function stopConfirmed(message: StopMessage, state: MatchState): boolean {
  const station = 'station' in message ? state.stationStates[message.station] : undefined;
  switch (message.type) {
    case 'adminGlobalEStop':
      return !!state.fieldEStop;
    case 'adminStationEStop':
    case 'stationSelfEStop':
      return !!station?.eStop;
    case 'stationSelfAStop':
      return !!station?.aStop;
    case 'stationTeamStop':
      return !!station?.teamStopped;
    case 'stationSelfDisable':
    case 'adminStationDisable':
      return !station?.enabled;
    case 'adminStopMatch':
      return !ROBOTS_RUNNING.includes(state.phase);
    case 'stationPauseMatch':
      return state.phase === 'paused' || !ROBOTS_RUNNING.includes(state.phase);
    case 'matchAbortCountdown':
      return state.phase !== 'countdown';
  }
}

export interface StopTransport {
  /** A socket that says it's connected. */
  isOpen(): boolean;
  send(text: string): void;
  /** Abandon this socket and open another. */
  reconnect(): void;
}

type Entry = StopPress & { message: StopMessage; reconnected: boolean };

export class StopDelivery {
  private entries = new Map<string, Entry>();
  private state: MatchState | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly transport: StopTransport) {}

  /** A person pressed a stop. Pressing one that's waiting starts it over. */
  press(message: StopMessage, now = Date.now()): void {
    const station = 'station' in message ? message.station : undefined;
    const key = station ? `${message.type}:${station}` : message.type;
    const entry: Entry = {
      key,
      label: LABELS[message.type],
      station,
      pressedAt: now,
      stage: 'queued',
      message,
      reconnected: false,
    };
    this.entries.set(key, entry);
    if (this.transport.isOpen()) {
      this.send(entry, now);
      // An open socket's state is current, and it won't change to tell us.
      if (this.state && stopConfirmed(message, this.state)) this.entries.delete(key);
    }
    this.changed();
  }

  /** A new socket: everything not yet shown by the field goes on it. */
  socketOpened(now = Date.now()): void {
    for (const entry of this.entries.values()) {
      if (entry.stage !== 'dropped') this.send(entry, now);
    }
    this.changed();
  }

  /** The socket went: whatever was on it can't be counted on. */
  socketLost(): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.stage !== 'sent' && entry.stage !== 'unconfirmed') continue;
      entry.stage = 'queued';
      changed = true;
    }
    if (changed) this.changed();
  }

  /** The field's state arrived. */
  noteState(state: MatchState): void {
    this.state = state;
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (stopConfirmed(entry.message, state)) changed = this.entries.delete(key) || changed;
    }
    if (changed) this.changed();
  }

  /** Call a few times a second: nothing else moves a press on when nothing arrives. */
  review(now = Date.now()): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.stage === 'dropped') continue;
      if (now - entry.pressedAt >= STOP_QUEUE_MAX_MS) {
        entry.stage = 'dropped';
        entry.droppedAt = now;
        changed = true;
      } else if (entry.stage === 'sent' && now - entry.sentAt! >= STOP_CONFIRM_MS) {
        entry.stage = 'unconfirmed';
        changed = true;
        // Likely half dead. Don't wait 30 s for the watchdog: a fresh socket
        // gets this sent again, and shows at once whether it was the socket.
        if (!entry.reconnected && this.transport.isOpen()) {
          entry.reconnected = true;
          this.transport.reconnect();
        }
      }
    }
    if (changed) this.changed();
  }

  dismiss(key: string): void {
    if (this.entries.delete(key)) this.changed();
  }

  list(): StopPress[] {
    return [...this.entries.values()].map(({ message: _, reconnected: __, ...press }) => press);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private send(entry: Entry, now: number): void {
    this.transport.send(JSON.stringify(entry.message));
    entry.stage = 'sent';
    entry.sentAt = now;
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** What to tell whoever pressed it, or null while it's only just been sent. */
export function describeStopPress(press: StopPress, who = ''): { title: string; detail: string } | null {
  // Sent the moment it was pressed: the field gets its moment. Sent again
  // later, it has already had one, so the warning mustn't lapse meanwhile.
  if (press.stage === 'sent' && press.sentAt === press.pressedAt) return null;
  const what = who ? `${press.label} for ${who}` : press.label;
  switch (press.stage) {
    case 'sent':
    case 'unconfirmed':
      return {
        title: `${what} NOT CONFIRMED`,
        detail:
          `Sent at ${clock(press.sentAt!)}, but the field doesn't show it yet. Treat the robot as still running ` +
          'until it does.',
      };
    case 'queued':
      return {
        title: `${what} has NOT reached the field`,
        detail:
          `This page isn't connected. It goes as soon as the page reconnects, for ${STOP_QUEUE_MAX_MS / 1000} s after ` +
          `the press at ${clock(press.pressedAt)}. If a robot is moving, stop it another way now.`,
      };
    case 'dropped':
      return {
        title: `${what} DROPPED at ${clock(press.droppedAt!)}`,
        detail:
          `${press.sentAt ? 'The field never showed this stop' : 'It never reached the field'}, and a stop this old ` +
          'is not sent any more. If it’s still needed, press it again.',
      };
  }
}
