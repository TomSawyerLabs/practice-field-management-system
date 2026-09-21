import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { MatchRecorder, type RecordingManifest } from './matchRecorder.js';
import { handleRecordingsRequest } from './recordingsApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';

function ffmpegAvailable(): boolean {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A stand-in for the server response: a real Writable (so a piped file
 *  stream behaves), with the header bits of ServerResponse bolted on. */
class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  private chunks: Buffer[] = [];
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor() {
    super();
    this.done = new Promise<void>(r => (this.finish = r));
    this.on('finish', () => this.finish());
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    return this;
  }

  setHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = String(v);
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function fakeExchange(url: string, method = 'GET'): { req: IncomingMessage; res: FakeResponse } {
  const req = { url, method, headers: {} } as unknown as IncomingMessage;
  return { req, res: new FakeResponse() };
}

describe('recordings API', () => {
  if (!ffmpegAvailable()) {
    test.skip('needs ffmpeg on PATH', () => {});
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'pfms-recordings-api-'));
  const matchDir = join(root, 'match-7');
  const orphanDir = join(root, 'pending-123');
  let recorder: MatchRecorder;

  beforeAll(() => {
    mkdirSync(matchDir, { recursive: true });
    mkdirSync(orphanDir, { recursive: true });
    for (const out of [join(matchDir, 'all-field.mp4'), join(orphanDir, 'all-field.part0.mp4')]) {
      execFileSync(
        ffmpeg,
        // Ten seconds, so the thumbnail's seek lands well inside the file.
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x240:rate=30',
          '-t',
          '10',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          out,
        ],
        { stdio: 'inherit' },
      );
    }
    const manifest: RecordingManifest = {
      matchId: 'match-7',
      matchNumber: 7,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
      teams: [{ station: 'slot1', teamNumber: 5940, alliance: 'red' }],
      recordings: [
        { name: 'all-field', file: 'all-field.mp4', bytes: 1, startedAt: 0, endedAt: 1, status: 'ok' },
        { name: 'side', file: 'side.mp4', bytes: 0, startedAt: 0, endedAt: 1, status: 'failed', error: 'no source' },
      ],
    };
    writeFileSync(join(matchDir, 'recording.json'), JSON.stringify(manifest));
    writeFileSync(join(matchDir, 'scores.csv'), 'at,alliance\n1,red\n');
    recorder = new MatchRecorder({
      directory: root,
      ffmpegPath: ffmpeg,
      getStreams: () => [],
      getRetentionDays: () => 30,
    });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("the inventory lists each recording's files and sidecars", () => {
    const inv = recorder.inventory();
    const match = inv.entries.find(e => e.id === 'match-7')!;
    expect(match.files.map(f => f.file)).toEqual(['all-field.mp4', 'side.mp4']);
    // The manifest's byte count was written before the file settled; the
    // inventory reports what is actually on disk.
    expect(match.files[0].bytes).toBeGreaterThan(1000);
    expect(match.files[1].status).toBe('failed');
    expect(match.sidecars).toEqual(['scores.csv']);

    // A directory with no manifest still offers whatever MP4s it has.
    const orphan = inv.entries.find(e => e.id === 'pending-123')!;
    expect(orphan.kind).toBe('other');
    expect(orphan.files.map(f => f.file)).toEqual(['all-field.part0.mp4']);
    expect(orphan.sidecars).toEqual([]);
  });

  test('a thumbnail is generated once and cached beside the video', async () => {
    const path = await recorder.thumbnail('match-7', 'all-field.mp4');
    expect(path).toBe(join(matchDir, 'all-field.thumb.jpg'));
    expect(existsSync(path!)).toBe(true);
    // Asked again, the cached file comes back without another ffmpeg run.
    expect(await recorder.thumbnail('match-7', 'all-field.mp4')).toBe(path!);
    // A stream that captured nothing has no frame to give.
    expect(await recorder.thumbnail('match-7', 'side.mp4')).toBeUndefined();
    // Nor does anything outside the directory.
    expect(await recorder.thumbnail('match-7', '../secret.mp4')).toBeUndefined();
  });

  test('making a thumbnail does not make the directory look newer', async () => {
    // The retention sweep ages a directory with no manifest by its mtime, so
    // an admin looking at an orphan must not reset its clock.
    const before = statSync(orphanDir).mtimeMs;
    expect(await recorder.thumbnail('pending-123', 'all-field.part0.mp4')).toBeDefined();
    // Restored, not merely close: the slack is for the millisecond lost
    // putting the timestamp back through utimes, not for the ffmpeg run.
    expect(Math.abs(statSync(orphanDir).mtimeMs - before)).toBeLessThan(10);
  });

  test('?thumb=1 serves the JPEG, and a sidecar comes back as itself', async () => {
    const thumb = fakeExchange('/api/recordings/match-7/all-field.mp4?thumb=1');
    expect(handleRecordingsRequest(thumb.req, thumb.res as unknown as ServerResponse, recorder)).toBe(true);
    await thumb.res.done;
    expect(thumb.res.status).toBe(200);
    expect(thumb.res.headers['content-type']).toBe('image/jpeg');
    expect(thumb.res.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI

    const csv = fakeExchange('/api/recordings/match-7/scores.csv');
    expect(handleRecordingsRequest(csv.req, csv.res as unknown as ServerResponse, recorder)).toBe(true);
    await csv.res.done;
    expect(csv.res.status).toBe(200);
    expect(csv.res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.res.body.toString()).toContain('alliance');

    const missing = fakeExchange('/api/recordings/match-7/telemetry.csv');
    expect(handleRecordingsRequest(missing.req, missing.res as unknown as ServerResponse, recorder)).toBe(true);
    await missing.res.done;
    expect(missing.res.status).toBe(404);
  });

  test('a failed capture has no thumbnail to serve', async () => {
    const x = fakeExchange('/api/recordings/match-7/side.mp4?thumb=1');
    expect(handleRecordingsRequest(x.req, x.res as unknown as ServerResponse, recorder)).toBe(true);
    await x.res.done;
    expect(x.res.status).toBe(404);
  });
});
