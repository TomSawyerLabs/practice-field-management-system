import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DS_CONTROL_QUIET_MS,
  healthReport,
  MatchEngine,
  RESTORED_STOP_QUIET_MS,
  stopCut,
  type TeamResolver,
} from './matchEngine.js';
import { stationsCutAtStart, StopStore } from './stopStore.js';
import { StationNameList } from './types.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pfms-stops-'));
  file = join(dir, 'estop-state.json');
});

afterEach(() => {
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

/** A running pFMS and its saved stops, as index.ts wires them. */
function start(team: TeamResolver = () => 8) {
  const store = new StopStore(file);
  const saved = store.load();
  const engine = new MatchEngine(team);
  engine.trackStops(saved, stops => store.save(stops));
  return engine;
}

const station = (engine: MatchEngine, s: 'slot1' | 'slot2' | 'slot3') => engine.getState().stationStates[s]!;

describe('a restart', () => {
  test('keeps the field E-Stop, and when it was latched', () => {
    const before = start();
    before.fieldEStop();
    const since = before.getState().fieldEStop?.since;

    const after = start();
    expect(after.isFieldEStopped()).toBe(true);
    expect(after.getState().fieldEStop?.since).toBe(since);
    expect(StationNameList.every(s => after.isEStopped(s))).toBe(true);
  });

  test('keeps each station’s e-stop and who pressed it', () => {
    const before = start();
    before.stationEStop('slot1', 'staff');
    before.stationEStop('slot2', 'team');

    const after = start();
    expect(after.isFieldEStopped()).toBe(false);
    expect(station(after, 'slot1').eStopBy).toBe('staff');
    expect(station(after, 'slot2').eStopBy).toBe('team');
    expect(station(after, 'slot3').eStop).toBe(false);
  });

  test('keeps a robot’s e-stop reported by its Driver Station', () => {
    const before = start();
    before.dsReportedStatus('slot1', false, true, false);
    expect(station(start(), 'slot1').eStopBy).toBe('ds');
  });

  test('keeps a team Stop, whose cut it used to lift', () => {
    start().teamStop('slot1', true);
    const after = start();
    expect(station(after, 'slot1').teamStopped).toBe(true);
    expect(stopCut(station(after, 'slot1'))).toBe(true);
  });

  test('keeps nothing that was cleared', () => {
    const before = start();
    before.stationEStop('slot1', 'staff');
    before.noteDsControl('slot1', false);
    before.clearEStop('slot1');
    expect(start().isEStopped('slot1')).toBe(false);
  });

  test('keeps nothing a new match took with it, and leaves the field latch', () => {
    const before = start();
    before.stationEStop('slot1', 'staff');
    before.fieldEStop();
    before.createMatch();

    const after = start();
    expect(after.isFieldEStopped()).toBe(true);
    expect(station(after, 'slot1').eStopBy).toBeUndefined();
  });

  test('no match can start through a restored latch, and it clears like any other', () => {
    start().fieldEStop();
    const after = start();
    after.createMatch();
    after.startMatch();
    expect(after.getState().phase).toBe('created');
    for (const s of StationNameList) after.noteDsControl(s, false);
    after.clearFieldEStop();
    expect(after.isFieldEStopped()).toBe(false);
    expect(start().isFieldEStopped()).toBe(false);
  });

  test('takes a Driver Station still set to Enabled back off its robot', () => {
    start().stationEStop('slot1', 'staff');
    const after = start();
    expect(stopCut(station(after, 'slot1'))).toBe(true);
    after.noteDsControl('slot1', true);
    expect(stopCut(station(after, 'slot1'))).toBe(true);
    after.clearEStop('slot1');
    expect(after.isEStopped('slot1')).toBe(true);
    after.noteDsControl('slot1', false);
    expect(stopCut(station(after, 'slot1'))).toBe(false);
    expect(after.isEStopped('slot1')).toBe(true);
  });

  test('gives a Driver Station time to be heard before silence counts', async () => {
    start().stationEStop('slot1', 'staff');
    const begin = Date.now();
    setSystemTime(begin);
    const after = start();
    setSystemTime(begin + DS_CONTROL_QUIET_MS + 100);
    await Bun.sleep(150);
    expect(stopCut(station(after, 'slot1'))).toBe(true);
    setSystemTime(begin + RESTORED_STOP_QUIET_MS + 100);
    await Bun.sleep(150);
    expect(stopCut(station(after, 'slot1'))).toBe(false);
    expect(after.isEStopped('slot1')).toBe(true);
  });

  test('a stop on an empty slot holds nothing up', () => {
    start().fieldEStop();
    const after = start(() => null);
    expect(station(after, 'slot1').stopWaiting).toBeUndefined();
    expect(after.isFieldEStopped()).toBe(true);
  });
});

describe('what is on disk', () => {
  test('nothing saved means nothing stopped', () => {
    expect(new StopStore(file).load()).toBeNull();
    expect(start().isFieldEStopped()).toBe(false);
  });

  test('leaves no temporary file behind', () => {
    start().fieldEStop();
    expect(readdirSync(dir)).toEqual(['estop-state.json']);
  });

  test('a damaged file stops nothing and starts anyway', () => {
    writeFileSync(file, '{"fieldEStopSince": 17');
    expect(start().isFieldEStopped()).toBe(false);
  });

  test('junk for a station is dropped, and an unknown source goes with it', () => {
    writeFileSync(
      file,
      JSON.stringify({
        fieldEStopSince: 'soon',
        stations: { slot1: { eStopBy: 'gremlin' }, slot9: { teamStopped: true } },
      }),
    );
    const stops = new StopStore(file).load();
    expect(stops).toEqual({ fieldEStopSince: null, stations: { slot1: {} } });
  });

  test('only what is stopped is cut at the next start', () => {
    expect(stationsCutAtStart(null)).toEqual([]);
    expect(stationsCutAtStart({ fieldEStopSince: null, stations: { slot2: { eStopBy: 'staff' } } })).toEqual(['slot2']);
    expect(stationsCutAtStart({ fieldEStopSince: 1, stations: {} })).toEqual([...StationNameList]);
  });
});

describe('/health', () => {
  const eStopped = (engine: MatchEngine) => healthReport(engine.getState(), 'abc123').eStopped;

  test('says what it always said, and whether anything is e-stopped', () => {
    const engine = start();
    expect(healthReport(engine.getState(), 'abc123')).toEqual({ phase: 'idle', version: 'abc123', eStopped: false });
  });

  test('counts a field E-Stop', () => {
    const engine = start();
    engine.fieldEStop();
    expect(eStopped(engine)).toBe(true);
  });

  test('counts one robot’s e-stop', () => {
    const engine = start();
    engine.stationEStop('slot3', 'team');
    expect(eStopped(engine)).toBe(true);
  });

  test('doesn’t count a team Stop, which a reload keeps and a team can leave on all day', () => {
    const engine = start();
    engine.teamStop('slot1', true);
    expect(eStopped(engine)).toBe(false);
  });
});
