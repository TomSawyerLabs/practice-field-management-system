import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldTimelapse, localDay, slotTime } from './fieldTimelapse.js';
import {
  isTimelapseConfig,
  redactSetupSettings,
  restoreSetupSecrets,
  SECRET_KEPT,
  TIMELAPSE_DEFAULTS,
  type MatchState,
  type SetupSettings,
  type TimelapseConfig,
} from './types.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';

function ffmpegAvailable(): boolean {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('timelapse time helpers', () => {
  test('slotTime lands on the local wall clock of the given day', () => {
    const noon = new Date(2026, 8, 20, 12, 0).getTime();
    expect(slotTime(noon, '09:00')).toBe(new Date(2026, 8, 20, 9, 0).getTime());
    expect(slotTime(noon, '17:30')).toBe(new Date(2026, 8, 20, 17, 30).getTime());
    expect(localDay(noon)).toBe('2026-09-20');
  });
});

describe('isTimelapseConfig', () => {
  const ok = (patch: Partial<TimelapseConfig>) => isTimelapseConfig({ ...TIMELAPSE_DEFAULTS, ...patch });

  test('accepts the defaults', () => {
    expect(isTimelapseConfig(TIMELAPSE_DEFAULTS)).toBe(true);
  });
  test('times must be HH:MM on a 24-hour clock', () => {
    expect(ok({ dailyTimes: ['00:00', '23:59'] })).toBe(true);
    expect(ok({ dailyTimes: ['24:00'] })).toBe(false);
    expect(ok({ dailyTimes: ['9:00'] })).toBe(false);
    expect(ok({ dailyTimes: ['09:60'] })).toBe(false);
  });
  test('an action needs a real http(s) URL and a known method', () => {
    expect(ok({ preActions: [{ method: 'POST', url: 'http://ha.local/api/services/light/turn_on' }] })).toBe(true);
    expect(ok({ preActions: [{ method: 'DELETE' as 'POST', url: 'http://ha.local/x' }] })).toBe(false);
    expect(ok({ preActions: [{ method: 'POST', url: 'file:///etc/passwd' }] })).toBe(false);
  });
  test('a slot takes a short list of calls, not an unbounded one', () => {
    const call = { method: 'POST' as const, url: 'http://ha.local/x' };
    expect(ok({ preActions: [call, call] })).toBe(true);
    expect(ok({ preActions: [call, call, call, call] })).toBe(true);
    expect(ok({ preActions: [call, call, call, call, call] })).toBe(false);
  });
  test('header values may not smuggle in extra headers', () => {
    expect(ok({ preActions: [{ method: 'GET', url: 'http://x/y', headers: { Authorization: 'Bearer t' } }] })).toBe(
      true,
    );
    expect(
      ok({ preActions: [{ method: 'GET', url: 'http://x/y', headers: { Authorization: 'a\r\nX-Evil: 1' } }] }),
    ).toBe(false);
    expect(ok({ preActions: [{ method: 'GET', url: 'http://x/y', headers: { 'Bad Name': 'v' } }] })).toBe(false);
  });
  test('quality and retention are bounded', () => {
    expect(ok({ activeCrf: 13 })).toBe(false);
    expect(ok({ activeCrf: 41 })).toBe(false);
    expect(ok({ activeRetentionDays: 0 })).toBe(false);
    expect(ok({ frameRetentionDays: 0 })).toBe(true); // 0 = keep forever
  });
});

describe('timelapse action secrets', () => {
  // setupConfigState reaches every internal client, station pages included,
  // so a bearer token in an action header must never ride along in it.
  const stored = (): SetupSettings => ({
    timelapse: {
      ...TIMELAPSE_DEFAULTS,
      preActions: [
        {
          method: 'POST',
          url: 'http://homeassistant.tsl:8123/api/services/light/turn_on',
          headers: { Authorization: 'Bearer real-token', 'X-Other': 'plain' },
          body: '{"entity_id":"light.all_lights"}',
        },
      ],
      postActions: [{ method: 'POST', url: 'http://homeassistant.tsl:8123/api/services/scene/turn_on' }],
    },
  });

  test('header values are masked on the way out, everything else is kept', () => {
    const out = redactSetupSettings(stored());
    expect(out.timelapse!.preActions![0].headers).toEqual({ Authorization: SECRET_KEPT, 'X-Other': SECRET_KEPT });
    expect(out.timelapse!.preActions![0].url).toBe('http://homeassistant.tsl:8123/api/services/light/turn_on');
    expect(out.timelapse!.preActions![0].body).toBe('{"entity_id":"light.all_lights"}');
    expect(JSON.stringify(out)).not.toContain('real-token');
  });

  test('settings without an action are passed through untouched', () => {
    const plain: SetupSettings = { publicUrl: 'https://pfms.example.org' };
    expect(redactSetupSettings(plain)).toBe(plain);
    expect(redactSetupSettings({ timelapse: TIMELAPSE_DEFAULTS })).toEqual({ timelapse: TIMELAPSE_DEFAULTS });
  });

  test('a masked value coming back keeps the stored secret', () => {
    const current = stored();
    const patch = redactSetupSettings(current);
    const saved = restoreSetupSecrets(patch, current);
    expect(saved.timelapse!.preActions![0].headers).toEqual({ Authorization: 'Bearer real-token', 'X-Other': 'plain' });
  });

  test('a newly typed value replaces the stored one', () => {
    const current = stored();
    const patch = redactSetupSettings(current);
    patch.timelapse!.preActions![0].headers = { Authorization: 'Bearer new-token' };
    const saved = restoreSetupSecrets(patch, current);
    expect(saved.timelapse!.preActions![0].headers).toEqual({ Authorization: 'Bearer new-token' });
  });

  test('a masked header with nothing stored behind it is dropped, not saved as the mask', () => {
    const patch: Partial<SetupSettings> = {
      timelapse: {
        ...TIMELAPSE_DEFAULTS,
        preActions: [{ method: 'GET', url: 'http://x/y', headers: { Authorization: SECRET_KEPT } }],
      },
    };
    const saved = restoreSetupSecrets(patch, {});
    expect(saved.timelapse!.preActions![0].headers).toBeUndefined();
  });
});

describe('FieldTimelapse', () => {
  if (!ffmpegAvailable()) {
    test.skip('needs ffmpeg on PATH', () => {});
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'pfms-timelapse-'));
  const source = join(dir, 'source.ts');
  let config: TimelapseConfig;
  let busy = false;
  const calls: { url: string; method: string; body?: string }[] = [];
  let timelapse: FieldTimelapse;

  beforeAll(() => {
    // 20 s of test pattern with a 2 s GOP, so keyframe-only sampling yields
    // 0.5 fps exactly as the field stream does.
    execFileSync(
      ffmpeg,
      // prettier-ignore
      [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
        '-t', '20',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-f', 'mpegts', source,
      ],
      { stdio: 'inherit' },
    );
    config = { ...TIMELAPSE_DEFAULTS, enabled: true, activeWidth: 320, activeCrf: 30, settleSeconds: 0 };
    timelapse = new FieldTimelapse({
      directory: dir,
      ffmpegPath: ffmpeg,
      getStreams: () => [{ name: 'All field', url: source, enabled: true }],
      getConfig: () => config,
      isAvailable: () => true,
      isFieldBusy: () => busy,
      inputPrefixArgs: ['-re', '-stream_loop', '-1'],
      tickMs: 250,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: String(init.method), body: init.body as string | undefined });
        return { ok: true, status: 200 };
      },
    });
    timelapse.start();
  });

  afterAll(async () => {
    await timelapse.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a just-closed file briefly; the temp dir is disposable.
    }
  });

  test('an archival frame is a full-resolution JPEG per stream, with the light actions around it', async () => {
    // Home Assistant's shape: snapshot, then turn on, then restore after.
    config.preActions = [
      { method: 'POST', url: 'http://lights.invalid/snapshot', body: '{"scene_id":"pfms_restore"}' },
      { method: 'POST', url: 'http://lights.invalid/on', body: '{"entity_id":"light.all_lights"}' },
    ];
    config.postActions = [{ method: 'POST', url: 'http://lights.invalid/restore' }];
    calls.length = 0;

    const entry = await timelapse.captureFrame('manual', true);

    expect(entry.error).toBeUndefined();
    expect(entry.lights).toBe('ran');
    expect(entry.files).toHaveLength(1);
    expect(entry.files[0].bytes).toBeGreaterThan(1000);
    expect(timelapse.filePath('frame', entry.files[0].file)).toBeTruthy();
    // Both pre calls in order, then the post one — bodies passed through.
    expect(calls.map(c => c.url)).toEqual([
      'http://lights.invalid/snapshot',
      'http://lights.invalid/on',
      'http://lights.invalid/restore',
    ]);
    expect(calls[0].body).toBe('{"scene_id":"pfms_restore"}');
  });

  test('a busy field still gets its frame, but the lights are left alone', async () => {
    busy = true;
    calls.length = 0;
    const entry = await timelapse.captureFrame('manual', true);
    busy = false;

    expect(entry.lights).toBe('skipped-field-in-use');
    expect(entry.files).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test('robots on the field leave the lights alone too — they are already on', async () => {
    // Its own instance: telemetry here would otherwise start the fast
    // timelapse and leak presence into the tests that follow.
    const seen: string[] = [];
    const occupied = new FieldTimelapse({
      directory: dir,
      ffmpegPath: ffmpeg,
      getStreams: () => [{ name: 'All field', url: source, enabled: true }],
      getConfig: () => config,
      isAvailable: () => true,
      isFieldBusy: () => false,
      inputPrefixArgs: ['-re', '-stream_loop', '-1'],
      tickMs: 60_000,
      fetchImpl: async url => {
        seen.push(String(url));
        return { ok: true, status: 200 };
      },
    });
    occupied.onTelemetry();
    const entry = await occupied.captureFrame('manual', true);
    await occupied.stop();

    expect(entry.lights).toBe('skipped-field-in-use');
    expect(entry.files).toHaveLength(1);
    expect(seen).toHaveLength(0);
  }, 20_000);

  test('the lights are restored even when the capture itself fails', async () => {
    const good = config.preActions;
    calls.length = 0;
    const broken = new FieldTimelapse({
      directory: dir,
      ffmpegPath: ffmpeg,
      getStreams: () => [{ name: 'Gone', url: 'http://127.0.0.1:1/nope', enabled: true }],
      getConfig: () => config,
      isAvailable: () => true,
      isFieldBusy: () => false,
      tickMs: 60_000,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: String(init.method) });
        return { ok: true, status: 200 };
      },
    });
    const entry = await broken.captureFrame('manual', true);
    await broken.stop();
    config.preActions = good;

    expect(entry.error).toBeTruthy();
    expect(entry.files).toHaveLength(0);
    expect(calls.map(c => c.url)).toContain('http://lights.invalid/restore');
  }, 20_000);

  test('a failing light action does not cost the frame', async () => {
    const failing = new FieldTimelapse({
      directory: dir,
      ffmpegPath: ffmpeg,
      getStreams: () => [{ name: 'All field', url: source, enabled: true }],
      getConfig: () => config,
      isAvailable: () => true,
      isFieldBusy: () => false,
      inputPrefixArgs: ['-re', '-stream_loop', '-1'],
      tickMs: 60_000,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    const entry = await failing.captureFrame('manual', true);
    await failing.stop();

    expect(entry.lights).toBe('failed');
    expect(entry.lightsError).toContain('503');
    expect(entry.files).toHaveLength(1);
  });

  test('robots showing up start a timelapse that plays back at 30 fps', async () => {
    config.preActions = undefined;
    config.postActions = undefined;
    expect(timelapse.getState().capturing).toBe(false);

    timelapse.onTelemetry();
    await sleep(600);
    expect(timelapse.getState().capturing).toBe(true);
    expect(timelapse.getState().robotsPresent).toBe(true);

    // Let the encoder see several seconds of source, then close it out the way
    // a match start would.
    await sleep(6000);
    timelapse.onMatchState({ phase: 'countdown' } as MatchState);
    await sleep(1500);

    const state = timelapse.getState();
    expect(state.capturing).toBe(false);
    const session = state.recentSessions[0];
    expect(session).toBeTruthy();
    expect(session.stream).toBe('All field');
    expect(session.bytes).toBeGreaterThan(2048);

    const file = timelapse.filePath('active', session.file);
    expect(file).toBeTruthy();
    const probe = execFileSync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate,width', '-of', 'csv=p=0', file!],
      { encoding: 'utf8' },
    ).trim();
    expect(probe).toBe('320,30/1');

    timelapse.onMatchState({ phase: 'idle' } as MatchState);
  }, 40_000);

  test('a film is rendered from the archival frames', async () => {
    // captureFrame above left a handful of frames under today's date.
    const day = localDay(Date.now());
    expect(readdirSync(join(dir, '.timelapse', 'frames', day)).length).toBeGreaterThan(1);

    await timelapse.renderFilm({ source: 'frames', fps: 12, height: 240, stream: 'All field' });
    const render = timelapse.getState().render;
    expect(render?.status).toBe('done');
    expect(render?.file).toMatch(/^timelapse-\d{4}-\d{2}-\d{2}-\d{6}\.mp4$/);
    expect(timelapse.filePath('render', render!.file!)).toBeTruthy();
    // And it shows up in the list the admin page reads.
    expect(timelapse.getState().renders.map(r => r.file)).toContain(render!.file!);
  }, 30_000);

  test('every frame gets a gallery-sized copy beside it', async () => {
    const entry = await timelapse.captureFrame('manual', false);
    const file = entry.files[0];

    expect(file.thumb).toBeTruthy();
    const thumb = timelapse.filePath('frame', file.thumb!);
    expect(thumb).toBeTruthy();
    // Small enough to put a page of them on screen, and smaller than the
    // frame it came from.
    expect(statSync(thumb!).size).toBeLessThan(file.bytes);
  }, 20_000);

  test('the listing reads the disk, with thumbnails and practice chunks', () => {
    const today = localDay(Date.now());
    const listing = timelapse.listing();
    const day = listing.days.find(d => d.day === today);

    expect(day).toBeTruthy();
    expect(day!.frames.length).toBeGreaterThan(1);
    expect(day!.frames.some(f => f.thumb !== undefined)).toBe(true);
    // The thumbnails are not listed as frames in their own right.
    expect(day!.frames.some(f => f.file.endsWith('.thumb.jpg'))).toBe(false);
    expect(day!.practice.length).toBeGreaterThan(0);

    // A range that predates everything comes back empty rather than erroring.
    expect(timelapse.listing({ to: '2000-01-01' }).days).toHaveLength(0);
  });

  test('a practice film for a date range is joined from the chunks', async () => {
    await timelapse.renderFilm({ source: 'practice', fps: 30, height: 240, stream: 'All field' });
    const render = timelapse.getState().render;

    expect(render?.status).toBe('done');
    expect(render?.source).toBe('practice');
    expect(render?.file).toMatch(/^practice-\d{4}-\d{2}-\d{2}-\d{6}\.mp4$/);
    const built = timelapse.filePath('render', render!.file!);
    expect(built).toBeTruthy();

    // And it can be thrown away again.
    expect(timelapse.deleteRender(render!.file!)).toBe(true);
    expect(timelapse.filePath('render', render!.file!)).toBeUndefined();
    expect(timelapse.deleteRender('../../etc/passwd')).toBe(false);
  }, 30_000);

  test('the store sits where the match sweep will not touch it', () => {
    expect(timelapse.root.endsWith('.timelapse')).toBe(true);
    expect(existsSync(join(dir, '.timelapse', 'timelapse.json'))).toBe(true);
  });
});
