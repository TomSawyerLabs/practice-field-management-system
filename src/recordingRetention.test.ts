import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRITICAL_FREE_BYTES, describeSpaceChange, MatchRecorder } from './matchRecorder.js';

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

describe('recording retention and free space', () => {
  let dir: string;
  let free: number;
  let settings: { matchDays?: number; clipDays?: number; minFreeGb?: number };

  const recorder = () =>
    new MatchRecorder({
      directory: dir,
      getStreams: () => [],
      getRetentionDays: () => settings.matchDays,
      getPracticeRetentionDays: () => settings.clipDays,
      getMinFreeGb: () => settings.minFreeGb,
      freeBytes: async () => free,
    });

  /** A recording directory whose manifest says it ended `daysAgo` days ago. */
  const recording = (name: string, daysAgo: number) => {
    mkdirSync(join(dir, name), { recursive: true });
    const at = Date.now() - daysAgo * DAY;
    writeFileSync(
      join(dir, name, 'recording.json'),
      JSON.stringify({ matchId: name, startedAt: at - 60_000, endedAt: at, teams: [], recordings: [] }),
    );
    writeFileSync(join(dir, name, 'all-field.mp4'), 'x');
  };
  const left = (...names: string[]) => names.filter(n => existsSync(join(dir, n)));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pfms-retention-'));
    free = 300 * GB;
    settings = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("teams' practice clips go after a week, match videos after a month", () => {
    recording('practice-20260920-190000-aaaa', 8);
    recording('practice-20260925-190000-bbbb', 6);
    recording('match-old', 31);
    recording('match-8-days', 8);
    recorder().sweep();
    expect(left('practice-20260920-190000-aaaa', 'practice-20260925-190000-bbbb', 'match-old', 'match-8-days')).toEqual(
      ['practice-20260925-190000-bbbb', 'match-8-days'],
    );
  });

  test('each window is its own setting', () => {
    settings = { matchDays: 5, clipDays: 20 };
    recording('practice-old', 21);
    recording('practice-10-days', 10);
    recording('match-6-days', 6);
    recording('match-4-days', 4);
    const rec = recorder();
    rec.sweep();
    expect(left('practice-old', 'practice-10-days', 'match-6-days', 'match-4-days')).toEqual([
      'practice-10-days',
      'match-4-days',
    ]);
    expect(rec.effectiveRetentionDays()).toBe(5);
    expect(rec.effectivePracticeRetentionDays()).toBe(20);
  });

  test('finished matches are listed for catching up; team clips, failed videos and unfinished ones are not', () => {
    recording('practice-20260925-190000-bbbb', 1);
    mkdirSync(join(dir, 'match-done'));
    writeFileSync(
      join(dir, 'match-done', 'recording.json'),
      JSON.stringify({
        matchId: 'match-done',
        startedAt: 1000,
        endedAt: 200_000,
        teams: [],
        recordings: [
          { name: 'all-field', file: 'all-field.mp4', startedAt: 1000, durationSeconds: 199, status: 'ok' },
          { name: 'east', file: 'east.mp4', startedAt: 1000, status: 'failed' },
        ],
      }),
    );
    mkdirSync(join(dir, 'match-cut-off'));
    writeFileSync(
      join(dir, 'match-cut-off', 'recording.json'),
      JSON.stringify({ matchId: 'match-cut-off', startedAt: 1000, teams: [], recordings: [] }),
    );
    expect(recorder().finishedMatches()).toEqual([
      {
        matchId: 'match-done',
        recordings: [
          { name: 'all-field', path: join(dir, 'match-done', 'all-field.mp4'), startedAt: 1000, durationSeconds: 199 },
        ],
      },
    ]);
  });

  test('storage is measured by kind, however deep the files are', async () => {
    recording('match-a', 1); // 1 byte of video + its manifest
    recording('practice-20260925-190000-bbbb', 1);
    mkdirSync(join(dir, '.practice-buffer', 'all-field'), { recursive: true });
    writeFileSync(join(dir, '.practice-buffer', 'all-field', 'seg-000001.ts'), 'x'.repeat(100));
    mkdirSync(join(dir, '.timelapse', 'active', '2026-09-27'), { recursive: true });
    writeFileSync(join(dir, '.timelapse', 'active', '2026-09-27', 'all-field-120000.mp4'), 'x'.repeat(1000));
    writeFileSync(join(dir, '.timelapse', 'old-frame.jpg'), 'x'.repeat(500));
    utimesSync(
      join(dir, '.timelapse', 'old-frame.jpg'),
      new Date(Date.now() - 30 * DAY),
      new Date(Date.now() - 30 * DAY),
    );
    mkdirSync(join(dir, 'stray'));
    writeFileSync(join(dir, 'stray', 'notes.txt'), 'x'.repeat(10));

    const rec = recorder();
    await rec.checkSpace();
    const manifestBytes = (name: string) => statSync(join(dir, name, 'recording.json')).size;
    expect(rec.measureStorage()).toEqual({
      diskTotalBytes: undefined,
      diskFreeBytes: 300 * GB,
      matchBytes: 1 + manifestBytes('match-a'),
      matchCount: 1,
      clipBytes: 1 + manifestBytes('practice-20260925-190000-bbbb') + 100,
      clipCount: 1,
      timelapseBytes: 1500,
      timelapseRecentBytes: 1000,
      // The stray directory: no manifest, so not a match.
      otherBytes: 10,
    });
    expect(rec.inventory().storage.timelapseBytes).toBe(1500);
    expect(rec.getState().usedBytes).toBeGreaterThan(1500);
  });

  test('the timelapse store and the practice buffer are never swept as recordings', () => {
    for (const name of ['.timelapse', '.practice-buffer']) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'x'), 'x');
    }
    // Old by any measure the sweep has.
    recording('.timelapse', 400);
    recorder().sweep();
    expect(left('.timelapse', '.practice-buffer')).toEqual(['.timelapse', '.practice-buffer']);
  });

  test('free space: ok above the floor, low under it, critical when nearly full', async () => {
    const rec = recorder();
    expect(await rec.checkSpace()).toBe('ok');
    // Default floor is 25 GB.
    free = 24 * GB;
    expect(await rec.checkSpace()).toBe('low');
    expect(rec.getState()).toMatchObject({ space: 'low', minFreeBytes: 25 * GB, diskFreeBytes: 24 * GB });
    free = CRITICAL_FREE_BYTES - 1;
    expect(await rec.checkSpace()).toBe('critical');
    free = 30 * GB;
    expect(await rec.checkSpace()).toBe('ok');
    // The floor is the admin's to move.
    settings.minFreeGb = 50;
    expect(await rec.checkSpace()).toBe('low');
    expect(rec.inventory()).toMatchObject({ space: 'low', minFreeBytes: 50 * GB, practiceRetentionDays: 7 });
  });

  test('crossing a floor is announced once, and not again after a restart', async () => {
    const said: string[] = [];
    const listen = (rec: MatchRecorder) => rec.addSpaceListener(c => said.push(`${c.previous}→${c.space}`));
    const rec = recorder();
    listen(rec);
    free = 10 * GB;
    await rec.checkSpace();
    await rec.checkSpace();
    expect(said).toEqual(['ok→low']);

    // pFMS restarts while still low: nothing new to say.
    const again = recorder();
    listen(again);
    await again.checkSpace();
    expect(said).toEqual(['ok→low']);

    free = 1 * GB;
    await again.checkSpace();
    free = 100 * GB;
    await again.checkSpace();
    expect(said).toEqual(['ok→low', 'low→critical', 'critical→ok']);
  });

  test('the announcement says what stopped and what to do', () => {
    const change = { freeBytes: 10 * GB, minFreeBytes: 25 * GB, practiceRetentionDays: 7 };
    const low = describeSpaceChange({ ...change, space: 'low', previous: 'ok' });
    expect(low).toContain('10.0 GB free');
    expect(low).toContain('practice clips are paused');
    expect(low).toContain('matches are still recorded');
    expect(describeSpaceChange({ ...change, space: 'critical', previous: 'low', freeBytes: GB })).toContain(
      'Nothing is being recorded',
    );
    expect(describeSpaceChange({ ...change, space: 'ok', previous: 'low', freeBytes: 60 * GB })).toContain(
      'room again',
    );
  });

  test('a volume that cannot be measured does not stop recording', async () => {
    const rec = new MatchRecorder({
      directory: dir,
      getStreams: () => [],
      getRetentionDays: () => undefined,
      freeBytes: async () => {
        throw new Error('statfs failed');
      },
    });
    expect(await rec.checkSpace()).toBe('ok');
    expect(rec.getState().diskFreeBytes).toBeUndefined();
  });
});
