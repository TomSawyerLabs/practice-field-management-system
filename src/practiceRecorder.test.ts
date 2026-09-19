import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PracticeRecorder, practiceRunId } from './practiceRecorder.js';
import { PracticeStore, practiceDayEnd, practiceDayOf } from './practiceStore.js';
import { SessionMetadataCollector } from './sessionMetadata.js';
import type { ProcessedScoreEvent, RecordingMetadata, TelemetryUpdate } from './types.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';

function ffmpegAvailable(): boolean {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('practiceDayOf', () => {
  test('a day rolls over at 04:00 local, not midnight', () => {
    const lateNight = new Date(2026, 8, 18, 1, 30).getTime(); // 01:30 on the 18th
    expect(practiceDayOf(lateNight)).toBe('2026-09-17');
    const morning = new Date(2026, 8, 18, 4, 0).getTime();
    expect(practiceDayOf(morning)).toBe('2026-09-18');
    expect(practiceDayEnd('2026-09-17')).toBe(morning);
  });
  test('run ids sort by time', () => {
    expect(practiceRunId(new Date(2026, 8, 18, 19, 4, 30).getTime())).toMatch(/^practice-20260918-190430-[0-9a-f]{4}$/);
  });
});

describe('PracticeStore', () => {
  test('opt-in and day tokens persist and reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfms-practice-store-'));
    const file = join(dir, 'practice.json');
    const store = new PracticeStore(file);
    store.setOptIn(5940, true);
    const day = store.getOrCreateDayToken(5940, '2026-09-18');
    expect(store.getOrCreateDayToken(5940, '2026-09-18').token).toBe(day.token);
    store.markSlackPosted(day.token, 123);
    const again = new PracticeStore(file);
    expect(again.isOptedIn(5940)).toBe(true);
    expect(again.findByToken(day.token)?.slackPostedAt).toBe(123);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('PracticeRecorder', () => {
  if (!ffmpegAvailable()) {
    test.skip('needs ffmpeg on PATH', () => {});
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'pfms-practice-'));
  const source = join(dir, 'source.ts');
  let recorder: PracticeRecorder;
  let store: PracticeStore;
  let metadata: SessionMetadataCollector;
  const events: ProcessedScoreEvent[] = [];

  beforeAll(() => {
    // 40 s of test pattern with a tone, 1 s GOP, so segments are 1 s each.
    execFileSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '40',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '30',
        '-keyint_min',
        '30',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-f',
        'mpegts',
        source,
      ],
      { stdio: 'inherit' },
    );
    store = new PracticeStore(join(dir, 'practice.json'));
    metadata = new SessionMetadataCollector({ getTeamForStation: s => (s === 'slot1' ? 5940 : undefined) });
    recorder = new PracticeRecorder({
      directory: dir,
      ffmpegPath: ffmpeg,
      ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
      getStreams: () => [{ name: 'All field', url: source, enabled: true }],
      store,
      metadata,
      getTeamForStation: s => (s === 'slot1' ? 5940 : undefined),
      isAvailable: () => true,
      // Play the file at real time, forever, as a live source would.
      inputPrefixArgs: ['-re', '-stream_loop', '-1'],
    });
    recorder.start();
  });

  afterAll(async () => {
    await recorder.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a segment briefly; the temp dir is disposable.
    }
  });

  const telemetry = (enabled: boolean, voltage = 12.5): TelemetryUpdate => ({
    type: 'telemetry',
    station: 'slot1',
    timestamp: Date.now(),
    batteryVoltage: voltage,
    dsStatus: { eStop: false, aStop: false, robotComms: true, radioPing: true, rioPing: true, enabled, mode: 'teleOp' },
  });

  test('an enable outside a match becomes a padded clip with its metadata', async () => {
    // Not opted in: telemetry does not start the buffer.
    recorder.onTelemetry(telemetry(false));
    await sleep(1500);
    expect(recorder.getState().buffering).toBe(false);

    store.setOptIn(5940, true);
    recorder.onOptInChanged();
    await sleep(1200);
    expect(recorder.getState().buffering).toBe(true);
    // Let the buffer fill past the pre-roll.
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      recorder.onTelemetry(telemetry(false));
      metadata.onTelemetry(telemetry(false));
    }

    const enabledAt = Date.now();
    recorder.onTelemetry(telemetry(true));
    metadata.onTelemetry(telemetry(true, 12.1));
    expect(recorder.getState().activeRun?.teams).toEqual([5940]);
    const ball: ProcessedScoreEvent = {
      id: 'evt-1',
      source: 'test',
      alliance: 'red',
      element: 'ball',
      count: 1,
      pointValue: 1,
      awardedTo: 'red',
      timestamp: Date.now() + 50,
      occurredAt: Date.now(),
      lagMs: 50,
      timing: 'age',
      deduplicated: false,
    };
    metadata.onScoreEvent(ball);
    events.push(ball);
    for (let i = 0; i < 4; i++) {
      await sleep(1000);
      recorder.onTelemetry(telemetry(true, 11.8 + i * 0.1));
      metadata.onTelemetry(telemetry(true, 11.8 + i * 0.1));
    }
    const disabledAt = Date.now();
    recorder.onTelemetry(telemetry(false));
    metadata.onTelemetry(telemetry(false));

    // Keep the station "present" while the run closes and finalizes.
    const deadline = Date.now() + 25_000;
    while (store.getRuns().length === 0 && Date.now() < deadline) {
      await sleep(500);
      recorder.onTelemetry(telemetry(false));
    }
    const runs = store.getRuns();
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run.teams).toEqual([{ station: 'slot1', teamNumber: 5940 }]);
    expect(run.startedAt).toBeLessThanOrEqual(enabledAt - 3000 + 50);
    expect(run.endedAt).toBeGreaterThanOrEqual(disabledAt + 3000 - 50);
    expect(run.recordings).toHaveLength(1);
    const rec = run.recordings[0];
    expect(rec.status).toBe('ok');
    expect(rec.file).toBe('all-field.mp4');
    // ~4 s enabled + 3 s either side, give or take a segment.
    expect(rec.durationSeconds).toBeGreaterThanOrEqual(9);
    expect(rec.durationSeconds).toBeLessThanOrEqual(13);
    const runDir = join(dir, run.id);
    expect(existsSync(join(runDir, 'all-field.mp4'))).toBe(true);
    expect(existsSync(join(runDir, 'recording.json'))).toBe(true);
    expect(run.hasMetadata).toBe(true);
    const meta = JSON.parse(readFileSync(join(runDir, 'metadata.json'), 'utf-8')) as RecordingMetadata;
    expect(meta.kind).toBe('practice');
    expect(meta.scoreEvents.map(e => e.id)).toEqual(['evt-1']);
    expect(meta.telemetry.length).toBeGreaterThanOrEqual(5);
    expect(meta.telemetry.some(s => s.batteryVoltage === 12.1 && s.enabled)).toBe(true);
    const csv = readFileSync(join(runDir, 'telemetry.csv'), 'utf-8');
    expect(csv.split('\n')[0]).toContain('battery_v');
    expect(csv).toContain('5940');
    // The day link exists from the first run on.
    expect(store.findDay(5940, practiceDayOf(run.startedAt))?.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Nothing but the clip directory and the buffer under the root.
    expect(readdirSync(dir).filter(n => n.startsWith('practice-'))).toEqual([run.id]);

    // The buffer keeps running while the team is still present, and stops
    // once it has gone quiet.
    expect(recorder.getState().buffering).toBe(true);
  }, 60_000);

  test('the buffer stops when no opted-in robot has been heard from', async () => {
    const deadline = Date.now() + 25_000;
    while (recorder.getState().buffering && Date.now() < deadline) await sleep(500);
    expect(recorder.getState().buffering).toBe(false);
  }, 30_000);
});
