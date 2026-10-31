import { describe, expect, test } from 'bun:test';
import type { MatchState, StationControlState } from '../../../src/types';
import {
  describeStopPress,
  STOP_CONFIRM_MS,
  STOP_QUEUE_MAX_MS,
  StopDelivery,
  stopConfirmed,
  type StopMessage,
} from './stopDelivery';

const FIELD: StopMessage = { type: 'adminGlobalEStop' };
const T = 1_000_000;

function setup(open = true) {
  const sent: string[] = [];
  const socket = { open, reconnects: 0 };
  const stops = new StopDelivery({
    isOpen: () => socket.open,
    send: text => {
      if (!socket.open) throw new Error('send on a socket that is not open');
      sent.push(text);
    },
    reconnect: () => socket.reconnects++,
  });
  const stage = () => stops.list()[0]?.stage;
  return { stops, sent, socket, stage };
}

const state = (over: Partial<MatchState> = {}, slot1: Partial<StationControlState> = {}) =>
  ({ phase: 'idle', stationStates: { slot1 }, ...over }) as unknown as MatchState;

const LATCHED = state({ fieldEStop: { since: T } });

describe('a press with a working socket', () => {
  test('goes straight out, and is done when the field shows it', () => {
    const { stops, sent, stage } = setup();
    stops.press(FIELD, T);
    expect(sent).toEqual(['{"type":"adminGlobalEStop"}']);
    expect(stage()).toBe('sent');
    stops.noteState(LATCHED);
    expect(stops.list()).toEqual([]);
  });

  test('a state that doesn’t show it changes nothing', () => {
    const { stops, stage } = setup();
    stops.press(FIELD, T);
    stops.noteState(state());
    expect(stage()).toBe('sent');
  });

  test('a stop the field already shows leaves nothing waiting', () => {
    const { stops, sent } = setup();
    stops.noteState(LATCHED);
    stops.press(FIELD, T);
    expect(sent).toHaveLength(1);
    expect(stops.list()).toEqual([]);
  });
});

describe('a half-dead socket', () => {
  test('says "not confirmed" after a short wait, and tries a fresh socket once', () => {
    const { stops, socket, stage } = setup();
    stops.press(FIELD, T);
    stops.review(T + STOP_CONFIRM_MS - 1);
    expect(stage()).toBe('sent');
    stops.review(T + STOP_CONFIRM_MS);
    expect(stage()).toBe('unconfirmed');
    expect(socket.reconnects).toBe(1);
    stops.review(T + STOP_CONFIRM_MS + 1000);
    expect(socket.reconnects).toBe(1);
  });

  test('a new socket gets it again, and the state confirming it ends it', () => {
    const { stops, sent, socket, stage } = setup();
    stops.press(FIELD, T);
    stops.review(T + STOP_CONFIRM_MS);
    socket.open = false;
    stops.socketLost();
    expect(stage()).toBe('queued');
    socket.open = true;
    stops.socketOpened(T + 3000);
    expect(sent).toHaveLength(2);
    stops.noteState(LATCHED);
    expect(stops.list()).toEqual([]);
  });

  test('a stop the field ignores stays unconfirmed, then drops', () => {
    const { stops, stage } = setup();
    stops.press({ type: 'stationSelfAStop', station: 'slot1' }, T);
    stops.review(T + STOP_CONFIRM_MS);
    stops.socketOpened(T + 2500);
    stops.review(T + 2500 + STOP_CONFIRM_MS);
    expect(stage()).toBe('unconfirmed');
    stops.review(T + STOP_QUEUE_MAX_MS);
    expect(stage()).toBe('dropped');
  });
});

describe('a press with no working socket', () => {
  test('neither throws nor sends, and goes out on reconnect', () => {
    const { stops, sent, socket, stage } = setup(false);
    expect(() => stops.press(FIELD, T)).not.toThrow();
    expect(sent).toEqual([]);
    expect(stage()).toBe('queued');
    socket.open = true;
    stops.socketOpened(T + 5000);
    expect(sent).toEqual(['{"type":"adminGlobalEStop"}']);
    expect(stage()).toBe('sent');
  });

  test('stale state can’t pass for confirmation before anything was sent', () => {
    const { stops, stage } = setup(false);
    stops.noteState(LATCHED);
    stops.press(FIELD, T);
    expect(stage()).toBe('queued');
  });

  test('every stop still waiting goes, each once', () => {
    const { stops, sent, socket } = setup(false);
    stops.press(FIELD, T);
    stops.press({ type: 'adminStationEStop', station: 'slot1' }, T);
    stops.press(FIELD, T + 10);
    socket.open = true;
    stops.socketOpened(T + 20);
    expect(sent.sort()).toEqual(['{"type":"adminGlobalEStop"}', '{"type":"adminStationEStop","station":"slot1"}']);
  });
});

describe('a press left too long', () => {
  test('is dropped, on screen, with when', () => {
    const { stops, stage } = setup(false);
    stops.press(FIELD, T);
    stops.review(T + STOP_QUEUE_MAX_MS - 1);
    expect(stage()).toBe('queued');
    stops.review(T + STOP_QUEUE_MAX_MS);
    expect(stage()).toBe('dropped');
    expect(stops.list()[0].droppedAt).toBe(T + STOP_QUEUE_MAX_MS);
  });

  test('never fires after that', () => {
    const { stops, sent, socket } = setup(false);
    stops.press(FIELD, T);
    stops.review(T + STOP_QUEUE_MAX_MS);
    socket.open = true;
    stops.socketOpened(T + STOP_QUEUE_MAX_MS + 1);
    expect(sent).toEqual([]);
  });

  test('stays until dismissed, or until the field shows the stop anyway', () => {
    const { stops } = setup(false);
    stops.press(FIELD, T);
    stops.review(T + STOP_QUEUE_MAX_MS);
    stops.noteState(state());
    expect(stops.list()).toHaveLength(1);
    stops.dismiss(stops.list()[0].key);
    expect(stops.list()).toEqual([]);

    stops.press(FIELD, T);
    stops.review(T + STOP_QUEUE_MAX_MS);
    stops.noteState(LATCHED);
    expect(stops.list()).toEqual([]);
  });

  test('pressing again starts it over', () => {
    const { stops, sent, socket, stage } = setup(false);
    stops.press(FIELD, T);
    stops.review(T + STOP_QUEUE_MAX_MS);
    stops.press(FIELD, T + STOP_QUEUE_MAX_MS + 5);
    expect(stage()).toBe('queued');
    socket.open = true;
    stops.socketOpened(T + STOP_QUEUE_MAX_MS + 6);
    expect(sent).toHaveLength(1);
  });
});

describe('what counts as the field showing a stop', () => {
  const station = 'slot1' as const;
  test.each<[StopMessage, MatchState, MatchState]>([
    [FIELD, state(), LATCHED],
    [{ type: 'adminStationEStop', station }, state(), state({}, { eStop: true })],
    [{ type: 'stationSelfEStop', station }, state(), state({}, { eStop: true })],
    [{ type: 'stationSelfAStop', station }, state(), state({}, { aStop: true })],
    [{ type: 'stationTeamStop', station, stop: true }, state(), state({}, { teamStopped: true })],
    [{ type: 'stationSelfDisable', station }, state({}, { enabled: true }), state({}, { enabled: false })],
    [{ type: 'adminStationDisable', station }, state({}, { enabled: true }), state({}, { enabled: false })],
    [{ type: 'adminStopMatch' }, state({ phase: 'teleop' }), state({ phase: 'postMatch' })],
    [{ type: 'stationPauseMatch' }, state({ phase: 'teleop' }), state({ phase: 'paused' })],
    [{ type: 'matchAbortCountdown' }, state({ phase: 'countdown' }), state({ phase: 'created' })],
  ])('%j', (message, before, after) => {
    expect(stopConfirmed(message, before)).toBe(false);
    expect(stopConfirmed(message, after)).toBe(true);
  });
});

describe('what the page says', () => {
  const press = (over = {}) => ({ key: 'k', label: 'E-Stop', pressedAt: T, stage: 'queued' as const, ...over });

  test('says nothing in the moment after sending', () => {
    expect(describeStopPress(press({ stage: 'sent', sentAt: T }))).toBeNull();
  });

  test('keeps warning while a stop sent again waits for the field', () => {
    expect(describeStopPress(press({ stage: 'sent', sentAt: T + 3000 }))!.title).toContain('NOT CONFIRMED');
  });

  test('says plainly a queued stop hasn’t reached the field', () => {
    const said = describeStopPress(press())!;
    expect(said.title).toBe('E-Stop has NOT reached the field');
    expect(said.detail).toContain("isn't connected");
  });

  test('names who it was for, to someone looking at several', () => {
    expect(describeStopPress(press(), 'Team 114')!.title).toContain('E-Stop for Team 114');
  });

  test('says "not confirmed" while the field doesn’t show it', () => {
    expect(describeStopPress(press({ stage: 'unconfirmed', sentAt: T }))!.title).toContain('NOT CONFIRMED');
  });

  test('tells a drop that never went from one nobody confirmed', () => {
    const dropped = { stage: 'dropped' as const, droppedAt: T + STOP_QUEUE_MAX_MS };
    expect(describeStopPress(press(dropped))!.detail).toContain('never reached the field');
    expect(describeStopPress(press({ ...dropped, sentAt: T }))!.detail).toContain('never showed this stop');
  });
});
