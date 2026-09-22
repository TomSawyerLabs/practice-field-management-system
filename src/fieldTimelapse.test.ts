import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldTimelapse, localDay, slotTime } from './fieldTimelapse.js';
import {
  isTimelapseConfig,
  isTimelapseLights,
  TIMELAPSE_RESTORE_SCENE,
  redactSetupSettings,
  restoreSetupSecrets,
  SECRET_KEPT,
  TIMELAPSE_DEFAULTS,
  type MatchState,
  type SetupSettings,
  type TimelapseAction,
  type TimelapseConfig,
  type TimelapseLights,
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
  const http = (preActions: TimelapseAction[]): TimelapseLights => ({ mode: 'http', preActions });

  test('a custom call needs a real http(s) URL and a known method', () => {
    expect(ok({ lights: http([{ method: 'POST', url: 'http://ha.local/api/services/light/turn_on' }]) })).toBe(true);
    expect(ok({ lights: http([{ method: 'DELETE' as 'POST', url: 'http://ha.local/x' }]) })).toBe(false);
    expect(ok({ lights: http([{ method: 'POST', url: 'file:///etc/passwd' }]) })).toBe(false);
  });
  test('a slot takes a short list of calls, not an unbounded one', () => {
    const call = { method: 'POST' as const, url: 'http://ha.local/x' };
    expect(ok({ lights: http([call, call]) })).toBe(true);
    expect(ok({ lights: http([call, call, call, call]) })).toBe(true);
    expect(ok({ lights: http([call, call, call, call, call]) })).toBe(false);
  });
  test('header values may not smuggle in extra headers', () => {
    expect(ok({ lights: http([{ method: 'GET', url: 'http://x/y', headers: { Authorization: 'Bearer t' } }]) })).toBe(
      true,
    );
    expect(
      ok({ lights: http([{ method: 'GET', url: 'http://x/y', headers: { Authorization: 'a\r\nX-Evil: 1' } }]) }),
    ).toBe(false);
    expect(ok({ lights: http([{ method: 'GET', url: 'http://x/y', headers: { 'Bad Name': 'v' } }]) })).toBe(false);
  });
  test('the Home Assistant mode wants a base URL and real entity ids', () => {
    const ha = (patch: Partial<Extract<TimelapseLights, { mode: 'homeAssistant' }>>): TimelapseLights => ({
      mode: 'homeAssistant',
      baseUrl: 'http://homeassistant.local:8123',
      entityIds: ['light.all_lights'],
      ...patch,
    });
    expect(isTimelapseLights(ha({}))).toBe(true);
    expect(isTimelapseLights(ha({ token: 'abc' }))).toBe(true);
    expect(isTimelapseLights(ha({ baseUrl: 'homeassistant.local' }))).toBe(false);
    expect(isTimelapseLights(ha({ entityIds: ['not an entity'] }))).toBe(false);
    expect(isTimelapseLights({ mode: 'nope' })).toBe(false);
    expect(isTimelapseLights({ mode: 'none' })).toBe(true);
  });
  test('quality and retention are bounded', () => {
    expect(ok({ activeCrf: 13 })).toBe(false);
    expect(ok({ activeCrf: 41 })).toBe(false);
    expect(ok({ activeRetentionDays: 0 })).toBe(false);
    expect(ok({ frameRetentionDays: 0 })).toBe(true); // 0 = keep forever
  });
});

describe('timelapse light secrets', () => {
  // setupConfigState reaches every internal client, station pages included,
  // so a token must never ride along in it — in either mode.
  const storedHttp = (): SetupSettings => ({
    timelapse: {
      ...TIMELAPSE_DEFAULTS,
      lights: {
        mode: 'http',
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
    },
  });

  const storedHa = (): SetupSettings => ({
    timelapse: {
      ...TIMELAPSE_DEFAULTS,
      lights: {
        mode: 'homeAssistant',
        baseUrl: 'http://homeassistant.tsl:8123',
        token: 'real-token',
        entityIds: ['light.all_lights'],
      },
    },
  });

  const httpLights = (settings: SetupSettings) =>
    settings.timelapse!.lights as Extract<TimelapseLights, { mode: 'http' }>;
  const haLights = (settings: SetupSettings) =>
    settings.timelapse!.lights as Extract<TimelapseLights, { mode: 'homeAssistant' }>;

  test('custom header values are masked on the way out, everything else kept', () => {
    const out = redactSetupSettings(storedHttp());
    expect(httpLights(out).preActions![0].headers).toEqual({ Authorization: SECRET_KEPT, 'X-Other': SECRET_KEPT });
    expect(httpLights(out).preActions![0].url).toBe('http://homeassistant.tsl:8123/api/services/light/turn_on');
    expect(httpLights(out).preActions![0].body).toBe('{"entity_id":"light.all_lights"}');
    expect(JSON.stringify(out)).not.toContain('real-token');
  });

  test('the Home Assistant token is masked, the rest of the config is not', () => {
    const out = redactSetupSettings(storedHa());
    expect(haLights(out).token).toBe(SECRET_KEPT);
    expect(haLights(out).baseUrl).toBe('http://homeassistant.tsl:8123');
    expect(haLights(out).entityIds).toEqual(['light.all_lights']);
    expect(JSON.stringify(out)).not.toContain('real-token');
  });

  test('settings with no light control are passed through untouched', () => {
    const plain: SetupSettings = { publicUrl: 'https://pfms.example.org' };
    expect(redactSetupSettings(plain)).toBe(plain);
    expect(redactSetupSettings({ timelapse: TIMELAPSE_DEFAULTS })).toEqual({ timelapse: TIMELAPSE_DEFAULTS });
  });

  test('a masked value coming back keeps the stored secret', () => {
    for (const current of [storedHttp(), storedHa()]) {
      const saved = restoreSetupSecrets(redactSetupSettings(current), current);
      expect(JSON.stringify(saved)).toContain('real-token');
    }
  });

  test('a newly typed token replaces the stored one', () => {
    const current = storedHa();
    const patch = redactSetupSettings(current);
    haLights(patch).token = 'brand-new';
    expect(haLights(restoreSetupSecrets(patch, current) as SetupSettings).token).toBe('brand-new');
  });

  test('a masked secret with nothing stored behind it is dropped, not saved as the mask', () => {
    const patch: Partial<SetupSettings> = {
      timelapse: {
        ...TIMELAPSE_DEFAULTS,
        lights: {
          mode: 'http',
          preActions: [{ method: 'GET', url: 'http://x/y', headers: { Authorization: SECRET_KEPT } }],
        },
      },
    };
    const saved = restoreSetupSecrets(patch, {}) as SetupSettings;
    expect(httpLights(saved).preActions![0].headers).toBeUndefined();

    const haPatch: Partial<SetupSettings> = {
      timelapse: {
        ...TIMELAPSE_DEFAULTS,
        lights: { mode: 'homeAssistant', baseUrl: 'http://ha/', token: SECRET_KEPT, entityIds: [] },
      },
    };
    expect(haLights(restoreSetupSecrets(haPatch, {}) as SetupSettings).token).toBeUndefined();
  });
});

describe('FieldTimelapse light handshake over webhooks', () => {
  if (!ffmpegAvailable()) {
    test.skip('needs ffmpeg on PATH', () => {});
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'pfms-hook-'));
  const source = join(dir, 'source.ts');

  beforeAll(() => {
    execFileSync(
      ffmpeg,
      // prettier-ignore
      [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
        '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-f', 'mpegts', source,
      ],
      { stdio: 'inherit' },
    );
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the temp dir is disposable.
    }
  });

  /** `onStart` lets a test decide how Home Assistant behaves. */
  function instance(onStart: (nonce: string, tl: FieldTimelapse) => void, readyTimeoutSeconds = 2) {
    const posted: { url: string; nonce: string }[] = [];
    const timelapse: FieldTimelapse = new FieldTimelapse({
      directory: dir,
      ffmpegPath: ffmpeg,
      getStreams: () => [{ name: 'All field', url: source, enabled: true }],
      getConfig: () => ({
        ...TIMELAPSE_DEFAULTS,
        enabled: true,
        lights: {
          mode: 'haWebhook',
          baseUrl: 'http://homeassistant.tsl:8123',
          startWebhookId: 'pfms_lights_start_abcdefgh',
          doneWebhookId: 'pfms_lights_done_abcdefgh',
          readyTimeoutSeconds,
        },
      }),
      isAvailable: () => true,
      isFieldBusy: () => false,
      inputPrefixArgs: ['-re', '-stream_loop', '-1'],
      tickMs: 60_000,
      fetchImpl: async (url, init) => {
        const nonce = String(JSON.parse(String(init.body ?? '{}')).nonce ?? '');
        posted.push({ url, nonce });
        if (url.includes('pfms_lights_start')) onStart(nonce, timelapse);
        return { ok: true, status: 200, text: async () => '' };
      },
    });
    return { timelapse, posted };
  }

  test('the callback releases the shutter, and both webhooks are called', async () => {
    // Home Assistant answers a moment later, as it would after the lights
    // report on.
    const { timelapse, posted } = instance((nonce, tl) => {
      setTimeout(() => tl.notifyLightsReady(nonce), 150);
    });
    const started = Date.now();
    const entry = await timelapse.captureFrame('manual', true);
    await timelapse.stop();

    expect(entry.lights).toBe('ran');
    expect(entry.lightsError).toBeUndefined();
    expect(entry.files).toHaveLength(1);
    // Shot on the callback, not on a timeout.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(posted.map(p => p.url.split('/').pop())).toEqual([
      'pfms_lights_start_abcdefgh',
      'pfms_lights_done_abcdefgh',
    ]);
    // Same nonce both ways, so the automation can match them up.
    expect(posted[0].nonce).toBe(posted[1].nonce);
    expect(posted[0].nonce).toMatch(/^[0-9a-f]{32}$/);
  }, 30_000);

  test('no callback still takes the frame, and says the lights failed', async () => {
    const { timelapse, posted } = instance(() => {
      // Home Assistant never answers.
    }, 1);
    const entry = await timelapse.captureFrame('manual', true);
    await timelapse.stop();

    expect(entry.lights).toBe('failed');
    expect(entry.lightsError).toContain('did not confirm');
    // The frame is what matters — it is still taken.
    expect(entry.files).toHaveLength(1);
    // And the automation is still released, so the lights are not left up.
    expect(posted.map(p => p.url.split('/').pop())).toContain('pfms_lights_done_abcdefgh');
  }, 30_000);

  test('a wrong or stale nonce is refused', async () => {
    let captured = '';
    const { timelapse } = instance((nonce, tl) => {
      captured = nonce;
      expect(tl.notifyLightsReady('not-the-nonce')).toBe(false);
      setTimeout(() => tl.notifyLightsReady(nonce), 100);
    });
    const entry = await timelapse.captureFrame('manual', true);

    expect(entry.lights).toBe('ran');
    // Once used, the same nonce is dead — a replay cannot trip a later frame.
    expect(timelapse.notifyLightsReady(captured)).toBe(false);
    await timelapse.stop();
  }, 30_000);

  test('nobody is listening between captures', async () => {
    const { timelapse } = instance((nonce, tl) => tl.notifyLightsReady(nonce));
    expect(timelapse.notifyLightsReady('anything')).toBe(false);
    await timelapse.stop();
  });
});

describe('FieldTimelapse talking to Home Assistant', () => {
  // The shape of TSL's shop: a group of groups, with leaf fixtures at the
  // bottom, some of which are deliberately off.
  const tree: Record<string, { state: string; members?: string[]; name?: string }> = {
    'light.all_lights': { state: 'on', members: ['light.main_lights', 'light.edge_lights'], name: 'All Lights' },
    'light.main_lights': { state: 'on', members: ['light.bay_1', 'light.bay_2'] },
    'light.edge_lights': { state: 'on', members: ['light.bay_3'] },
    'light.bay_1': { state: 'on' },
    'light.bay_2': { state: 'off' },
    'light.bay_3': { state: 'on' },
  };

  function haInstance(dir: string) {
    const requests: { url: string; method: string; body?: string; auth?: string }[] = [];
    const timelapse = new FieldTimelapse({
      directory: dir,
      ffmpegPath: 'ffmpeg-not-used-here',
      getStreams: () => [],
      getConfig: () => ({
        ...TIMELAPSE_DEFAULTS,
        lights: {
          mode: 'homeAssistant',
          baseUrl: 'http://homeassistant.tsl:8123/',
          token: 'tok',
          entityIds: ['light.all_lights'],
        },
      }),
      isAvailable: () => true,
      isFieldBusy: () => false,
      tickMs: 60_000,
      fetchImpl: async (url, init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        requests.push({
          url,
          method: String(init.method),
          body: init.body as string | undefined,
          auth: headers.Authorization,
        });
        const state = /\/api\/states\/(.+)$/.exec(url);
        if (state) {
          const entity = tree[decodeURIComponent(state[1])];
          if (!entity) return { ok: false, status: 404, text: async () => 'not found' };
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                entity_id: decodeURIComponent(state[1]),
                state: entity.state,
                attributes: entity.members ? { entity_id: entity.members } : {},
              }),
          };
        }
        if (url.endsWith('/api/')) return { ok: true, status: 200, text: async () => '{"message":"API running."}' };
        if (url.endsWith('/api/config')) return { ok: true, status: 200, text: async () => '{"version":"2026.9.1"}' };
        if (url.endsWith('/api/states')) {
          const all = Object.entries(tree).map(([entity_id, e]) => ({
            entity_id,
            state: e.state,
            attributes: { friendly_name: e.name, ...(e.members ? { entity_id: e.members } : {}) },
          }));
          return { ok: true, status: 200, text: async () => JSON.stringify([...all, { entity_id: 'sensor.temp' }]) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    return { timelapse, requests };
  }

  test('a frame snapshots the leaf fixtures, turns the group on, and restores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfms-ha-'));
    const { timelapse, requests } = haInstance(dir);
    // No streams configured, so no ffmpeg runs — the light calls are the
    // whole point of this test.
    await timelapse.captureFrame('manual', true);
    await timelapse.stop();

    const services = requests.filter(r => r.url.includes('/api/services/'));
    expect(services.map(r => r.url.replace('http://homeassistant.tsl:8123/api/services/', ''))).toEqual([
      'scene/create',
      'light/turn_on',
      'scene/turn_on',
    ]);
    // The group was expanded to its leaves — snapshotting the group itself
    // would restore light.bay_2 as on, and it is deliberately off.
    expect(JSON.parse(services[0].body!)).toEqual({
      scene_id: TIMELAPSE_RESTORE_SCENE,
      snapshot_entities: ['light.bay_1', 'light.bay_2', 'light.bay_3'],
    });
    expect(JSON.parse(services[1].body!)).toEqual({ entity_id: ['light.all_lights'] });
    expect(JSON.parse(services[2].body!)).toEqual({ entity_id: `scene.${TIMELAPSE_RESTORE_SCENE}` });
    // Every call carries the token, and the doubled slash is not.
    expect(services.every(r => r.auth === 'Bearer tok')).toBe(true);
    expect(services.every(r => !r.url.includes('8123//'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  test('the picker lists lights and reports the version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfms-ha-'));
    const { timelapse } = haInstance(dir);
    const probe = await timelapse.probeLights('http://homeassistant.tsl:8123', 'tok');
    await timelapse.stop();

    expect(probe.ok).toBe(true);
    expect(probe.version).toBe('2026.9.1');
    // Lights only — the sensor is not offered — and groups say so.
    expect(probe.lights.map(l => l.entityId).sort()).toEqual([
      'light.all_lights',
      'light.bay_1',
      'light.bay_2',
      'light.bay_3',
      'light.edge_lights',
      'light.main_lights',
    ]);
    expect(probe.lights.find(l => l.entityId === 'light.all_lights')?.members).toEqual([
      'light.main_lights',
      'light.edge_lights',
    ]);
    expect(probe.lights.find(l => l.entityId === 'light.bay_2')?.state).toBe('off');
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  test('a refused token is reported, not thrown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfms-ha-'));
    const timelapse = new FieldTimelapse({
      directory: dir,
      ffmpegPath: 'ffmpeg-not-used-here',
      getStreams: () => [],
      getConfig: () => TIMELAPSE_DEFAULTS,
      isAvailable: () => true,
      isFieldBusy: () => false,
      tickMs: 60_000,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '401: Unauthorized' }),
    });
    const probe = await timelapse.probeLights('http://homeassistant.tsl:8123', 'wrong');
    await timelapse.stop();

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('401');
    expect(probe.lights).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
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
        return { ok: true, status: 200, text: async () => '{}' };
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
    // The custom-calls mode: two before the shutter, one after.
    config.lights = {
      mode: 'http',
      preActions: [
        { method: 'POST', url: 'http://lights.invalid/snapshot', body: '{"scene_id":"pfms_restore"}' },
        { method: 'POST', url: 'http://lights.invalid/on', body: '{"entity_id":"light.all_lights"}' },
      ],
      postActions: [{ method: 'POST', url: 'http://lights.invalid/restore' }],
    };
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
        return { ok: true, status: 200, text: async () => '{}' };
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
    const good = config.lights;
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
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    const entry = await broken.captureFrame('manual', true);
    await broken.stop();
    config.lights = good;

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
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    });
    const entry = await failing.captureFrame('manual', true);
    await failing.stop();

    expect(entry.lights).toBe('failed');
    expect(entry.lightsError).toContain('503');
    expect(entry.files).toHaveLength(1);
  });

  test('robots showing up start a timelapse that plays back at 30 fps', async () => {
    config.lights = { mode: 'none' };
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
