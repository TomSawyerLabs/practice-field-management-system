import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MatchRecorder } from './matchRecorder.js';

/** Stands in for ffmpeg: every thumbnail the recorder starts is held here
 *  until the test finishes it, so the slot rules can be watched. */
class FakeFfmpeg {
  started: string[] = [];
  private pending = new Map<string, (path: string | undefined) => void>();

  make = (_source: string, out: string): Promise<string | undefined> => {
    // "<dir>/<slug>.thumb.jpg" → "<dir name>/<slug>", which reads better in assertions.
    const id = `${basename(dirname(out))}/${basename(out, '.thumb.jpg')}`;
    this.started.push(id);
    return new Promise(resolve => this.pending.set(id, resolve));
  };

  /** Finish one generation; resolves once the recorder has had a chance to
   *  start whatever was waiting behind it. */
  async finish(id: string, ok = true): Promise<void> {
    const resolve = this.pending.get(id);
    if (!resolve) throw new Error(`${id} is not running`);
    this.pending.delete(id);
    resolve(ok ? `${id}.thumb.jpg` : undefined);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  get running(): string[] {
    return [...this.pending.keys()];
  }
}

describe('match recorder thumbnails', () => {
  let root: string;
  let recorder: MatchRecorder;
  let ffmpeg: FakeFfmpeg;

  /** A recording directory with empty stand-in videos; finished (it has a
   *  manifest) unless said otherwise. */
  function recording(id: string, files: string[], { finished = true } = {}): void {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), '');
    if (finished) writeFileSync(join(dir, 'recording.json'), JSON.stringify({ matchId: id, recordings: [] }));
  }

  function setSession(dir: string | null): void {
    (recorder as unknown as { session: { dir: string } | null }).session = dir ? { dir: join(root, dir) } : null;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pfms-thumbs-'));
    recorder = new MatchRecorder({ directory: root, getStreams: () => [], getRetentionDays: () => 30 });
    ffmpeg = new FakeFfmpeg();
    (recorder as unknown as { makeThumbnail: FakeFfmpeg['make'] }).makeThumbnail = ffmpeg.make;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('a page asking for many thumbnails gets two ffmpegs at a time, not one per row', async () => {
    for (const id of ['m1', 'm2', 'm3', 'm4']) recording(id, ['all-field.mp4']);
    const asked = ['m1', 'm2', 'm3', 'm4'].map(id => recorder.thumbnail(id, 'all-field.mp4'));

    expect(ffmpeg.running).toEqual(['m1/all-field', 'm2/all-field']);
    await ffmpeg.finish('m1/all-field');
    expect(ffmpeg.running).toEqual(['m2/all-field', 'm3/all-field']);
    await ffmpeg.finish('m2/all-field');
    await ffmpeg.finish('m3/all-field');
    await ffmpeg.finish('m4/all-field');
    expect(await Promise.all(asked)).toEqual([
      'm1/all-field.thumb.jpg',
      'm2/all-field.thumb.jpg',
      'm3/all-field.thumb.jpg',
      'm4/all-field.thumb.jpg',
    ]);
  });

  test('the warm-up queues only finished recordings that have no thumbnail yet', () => {
    recording('match-1', ['all-field.mp4', 'side.mp4']);
    recording('match-2', ['all-field.mp4', 'all-field.thumb.jpg']); // already done
    recording('practice-20261005-183527-7677', ['all-field.mp4']);
    recording('unfinished', ['all-field.mp4'], { finished: false }); // no manifest yet
    recording('pending-123', ['all-field.part0.mp4']); // an orphaned pre-roll
    recording('.practice-buffer', ['seg-0001.mp4']);
    recording('match-live', ['all-field.mp4']);
    setSession('match-live');

    // While a match is being recorded nothing starts, but the work is queued.
    expect(recorder.warmThumbnails()).toBe(3);
    expect(ffmpeg.started).toEqual([]);
  });

  test('the warm-up runs one at a time, waits for the match, and gives way to a page', async () => {
    recording('match-1', ['all-field.mp4']);
    recording('match-2', ['all-field.mp4']);
    recording('match-3', ['all-field.mp4']);
    recording('match-4', ['all-field.mp4']);
    setSession('match-live');
    expect(recorder.warmThumbnails()).toBe(4);
    expect(ffmpeg.started).toEqual([]);

    // A page asks for one mid-match: it does not wait for the match to end.
    const asked = recorder.thumbnail('match-3', 'all-field.mp4');
    expect(ffmpeg.running).toEqual(['match-3/all-field']);
    await ffmpeg.finish('match-3/all-field');
    expect(await asked).toBe('match-3/all-field.thumb.jpg');
    expect(ffmpeg.running).toEqual([]);

    // The match ends: the rest go one by one.
    setSession(null);
    (recorder as unknown as { pumpThumbs(): void }).pumpThumbs();
    expect(ffmpeg.running).toEqual(['match-1/all-field']);
    await ffmpeg.finish('match-1/all-field');
    expect(ffmpeg.running).toEqual(['match-2/all-field']);
    await ffmpeg.finish('match-2/all-field');
    expect(ffmpeg.running).toEqual(['match-4/all-field']);
    await ffmpeg.finish('match-4/all-field');
    expect(ffmpeg.started).toHaveLength(4);
  });

  test('a page request goes ahead of the warm-up backlog', async () => {
    for (const id of ['a', 'b', 'c']) recording(id, ['all-field.mp4']);
    recording('wanted', ['all-field.mp4']);
    recorder.warmThumbnails();
    // The warm-up has started its first; the rest wait behind it.
    expect(ffmpeg.running).toHaveLength(1);
    const first = ffmpeg.running[0];

    const asked = recorder.thumbnail('wanted', 'all-field.mp4');
    // Started straight away in the second slot, not after the backlog.
    expect(ffmpeg.running).toEqual([first, 'wanted/all-field']);
    await ffmpeg.finish('wanted/all-field');
    expect(await asked).toBe('wanted/all-field.thumb.jpg');
  });

  test('a failed thumbnail is not queued again by the next warm-up', async () => {
    recording('broken', ['all-field.mp4']);
    expect(recorder.warmThumbnails()).toBe(1);
    await ffmpeg.finish('broken/all-field', false);
    expect(recorder.warmThumbnails()).toBe(0);
  });
});
