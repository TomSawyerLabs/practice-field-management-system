import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureSnapshot,
  isSnapshotRequest,
  SlackSnapshots,
  SNAPSHOT_COOLDOWN_MS,
  type SlackSnapshotDeps,
} from './slackSnapshots.js';

const BOT = 'U0BOT';

describe('isSnapshotRequest', () => {
  test('a mention of the bot with a word for a picture', () => {
    expect(isSnapshotRequest(`<@${BOT}> snapshot`, BOT)).toBe(true);
    expect(isSnapshotRequest(`hey <@${BOT}> can we get a photo of the field?`, BOT)).toBe(true);
    expect(isSnapshotRequest(`<@${BOT}> pic please`, BOT)).toBe(true);
  });

  test('a mention about something else is not a request', () => {
    expect(isSnapshotRequest(`<@${BOT}> is the field free tonight?`, BOT)).toBe(false);
    expect(isSnapshotRequest(`<@U0SOMEONE> send me that photo`, BOT)).toBe(false);
  });

  test('a message that is nothing but the request', () => {
    for (const text of ['!snapshot', 'snapshot', 'Snapshot please', 'field snapshot', '!photo', ' !snapshot. ']) {
      expect(isSnapshotRequest(text, BOT)).toBe(true);
    }
  });

  test('talking about snapshots is not asking for one', () => {
    for (const text of [
      'did anyone get a snapshot of the bracket?',
      'photo of our robot attached',
      'the snapshot feature is neat',
      'snap',
    ]) {
      expect(isSnapshotRequest(text, BOT)).toBe(false);
    }
  });
});

describe('SlackSnapshots', () => {
  const setup = (over: Partial<SlackSnapshotDeps> = {}) => {
    const state = {
      now: 1_000_000,
      enabled: true,
      uploads: [] as { threadTs: string; comment: string }[],
      replies: [] as string[],
      captures: 0,
    };
    const snapshots = new SlackSnapshots({
      isEnabled: () => state.enabled,
      getStreams: () => [
        { name: 'off', url: 'rtsp://off', enabled: false },
        { name: 'all-field', url: 'rtsp://field', enabled: true },
      ],
      isAvailable: () => true,
      capture: async url => {
        state.captures++;
        expect(url).toBe('rtsp://field');
        return Buffer.from('jpeg');
      },
      slack: {
        getBotUserId: () => BOT,
        uploadImageInThread: async (threadTs, _image, _name, _title, comment) => {
          state.uploads.push({ threadTs, comment });
          return true;
        },
        replyInThread: async (_ts, text) => {
          state.replies.push(text);
          return true;
        },
      },
      now: () => state.now,
      ...over,
    });
    const ask = (text = '!snapshot') => snapshots.onChannelMessage({ user: 'U0ASKER', text, ts: '1.1' });
    return { state, ask };
  };

  test('off by default means silence, even when asked', async () => {
    const { state, ask } = setup();
    state.enabled = false;
    expect(await ask()).toBe('ignored');
    expect(state.captures).toBe(0);
    expect(state.replies).toEqual([]);
  });

  test('a request gets one picture from the first enabled camera, as a reply to it', async () => {
    const { state, ask } = setup();
    expect(await ask(`<@${BOT}> photo please`)).toBe('posted');
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.threadTs).toBe('1.1');
    expect(state.uploads[0]!.comment).toContain('The field at');
    expect(await ask('how is everyone')).toBe('ignored');
    expect(state.captures).toBe(1);
  });

  test('one every 5 minutes for the whole channel, and it says when to try again', async () => {
    const { state, ask } = setup();
    expect(SNAPSHOT_COOLDOWN_MS).toBe(5 * 60_000);
    expect(await ask()).toBe('posted');
    state.now += 90_000;
    expect(await ask()).toBe('refused');
    expect(state.replies[0]).toContain('every 5 minutes');
    expect(state.replies[0]).toContain('try again in 4 min');
    state.now += SNAPSHOT_COOLDOWN_MS - 90_000 - 20_000;
    expect(await ask()).toBe('refused');
    expect(state.replies[1]).toContain('try again in 20 s');
    state.now += 20_000;
    expect(await ask()).toBe('posted');
    expect(state.captures).toBe(2);
  });

  test('a camera that will not answer is said so, and does not start the wait', async () => {
    let broken = true;
    const { state, ask } = setup({
      capture: async () => {
        if (broken) throw new Error('rtsp timeout');
        return Buffer.from('jpeg');
      },
    });
    expect(await ask()).toBe('failed');
    expect(state.replies[0]).toContain('Could not get a picture');
    broken = false;
    expect(await ask()).toBe('posted');
  });

  test('no enabled camera: refused with the reason', async () => {
    const { state, ask } = setup({ getStreams: () => [{ name: 'off', url: 'rtsp://off', enabled: false }] });
    expect(await ask()).toBe('refused');
    expect(state.replies[0]).toContain('no camera stream is enabled');
  });
});

describe('captureSnapshot', () => {
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  let available = true;
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  } catch {
    available = false;
  }
  if (!available) {
    test.skip('needs ffmpeg on PATH', () => {});
    return;
  }

  test('one JPEG frame, scaled down to the posting width', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfms-snapshot-'));
    const source = join(dir, 'wide.ts');
    // Wider than the posting width, like the real 12 MP field stream.
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=2560x1440:rate=5',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-f',
      'mpegts',
      source,
    ]);
    const image = await captureSnapshot(ffmpeg, source);
    rmSync(dir, { recursive: true, force: true });
    // JPEG magic, and the SOF0 marker carries the dimensions.
    expect(image.subarray(0, 2).toString('hex')).toBe('ffd8');
    const sof = image.indexOf(Buffer.from([0xff, 0xc0]));
    expect(image.readUInt16BE(sof + 7)).toBe(1920);
    expect(image.readUInt16BE(sof + 5)).toBe(1080);
  }, 30_000);
});
