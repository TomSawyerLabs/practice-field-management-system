/**
 * A live picture of the field, on request, in Slack.
 *
 * Someone asks in the support channel — where everyone can see who asked —
 * and pFMS takes one frame off the field camera and posts it there. Off
 * until an admin switches it on, and only answerable when a camera stream
 * is enabled and ffmpeg works.
 *
 * On request rather than on a schedule: a photo every hour is two dozen
 * pictures a day of a mostly empty shop in a channel meant for support, and
 * a person asking is a person choosing to take a picture with people in it.
 *
 * Asking is a top-level channel message that either mentions the bot with a
 * word for a picture ("@pFMS snapshot", "@pFMS can I get a photo?") or is
 * nothing but the request ("!snapshot", "field snapshot please"). Threads
 * belong to the support chat, and DMs and other channels never reach here.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputArgs, runCommand } from './matchRecorder.js';
import type { RecordingStreamConfig } from './types.js';

/** One snapshot per this long, for the whole channel. */
export const SNAPSHOT_COOLDOWN_MS = 60_000;
/** Posted at this width: enough to read the field, a sixth of the bytes of
 *  the 12 MP frame. */
export const SNAPSHOT_WIDTH = 1920;
const CAPTURE_TIMEOUT_MS = 30_000;

const PICTURE_WORD = /\b(snapshot|snap|photo|picture|pic)\b/i;
const BARE_REQUEST = /^!?\s*(field\s+)?(snapshot|photo)(\s+please)?[\s.!?]*$/i;

/** Is this channel message asking for a snapshot? */
export function isSnapshotRequest(text: string, botUserId?: string): boolean {
  const trimmed = text.trim();
  if (botUserId && trimmed.includes(`<@${botUserId}>`)) return PICTURE_WORD.test(trimmed);
  return BARE_REQUEST.test(trimmed);
}

/** One frame off a stream as a JPEG, scaled down to `width` if wider. */
export async function captureSnapshot(ffmpegPath: string, url: string, width = SNAPSHOT_WIDTH): Promise<Buffer> {
  const out = join(tmpdir(), `pfms-snapshot-${randomBytes(6).toString('hex')}.jpg`);
  try {
    await runCommand(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        ...inputArgs(url),
        '-frames:v',
        '1',
        '-vf',
        // Quoted min(…) so a narrower source is not blown up.
        `scale='min(${width},iw)':-2`,
        '-q:v',
        '4',
        '-y',
        out,
      ],
      CAPTURE_TIMEOUT_MS,
    );
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

export interface SlackSnapshotDeps {
  /** The admin switch. */
  isEnabled: () => boolean;
  /** Enabled camera streams, in the admin's order; the first is used. */
  getStreams: () => RecordingStreamConfig[];
  /** ffmpeg works on this host. */
  isAvailable: () => boolean;
  capture: (url: string) => Promise<Buffer>;
  slack: {
    getBotUserId(): string | undefined;
    uploadImageToChannel(image: Buffer, filename: string, title: string, comment: string): Promise<boolean>;
    replyInThread(threadTs: string, text: string): Promise<boolean>;
  };
  now?: () => number;
}

/** Why a snapshot cannot be offered at all, or undefined when it can. The
 *  admin page shows this next to the switch. */
export function snapshotUnavailableReason(
  deps: Pick<SlackSnapshotDeps, 'getStreams' | 'isAvailable'>,
): string | undefined {
  if (!deps.isAvailable()) return 'ffmpeg is not available on this host';
  if (!deps.getStreams().some(s => s.enabled)) return 'no camera stream is enabled';
  return undefined;
}

export class SlackSnapshots {
  private readonly now: () => number;
  private lastAt = 0;
  private busy = false;

  constructor(private readonly deps: SlackSnapshotDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A top-level message in the support channel. Resolves to what was done
   *  with it (for tests and the log). */
  async onChannelMessage(msg: {
    user: string;
    text: string;
    ts: string;
  }): Promise<'ignored' | 'posted' | 'refused' | 'failed'> {
    if (!this.deps.isEnabled()) return 'ignored';
    if (!isSnapshotRequest(msg.text, this.deps.slack.getBotUserId())) return 'ignored';

    const unavailable = snapshotUnavailableReason(this.deps);
    if (unavailable) {
      await this.deps.slack.replyInThread(msg.ts, `📷 No snapshot: ${unavailable}.`);
      return 'refused';
    }
    const now = this.now();
    const wait = this.lastAt + SNAPSHOT_COOLDOWN_MS - now;
    if (this.busy || wait > 0) {
      await this.deps.slack.replyInThread(
        msg.ts,
        this.busy
          ? '📷 One is already on its way.'
          : `📷 One snapshot a minute — try again in ${Math.ceil(wait / 1000)} s.`,
      );
      return 'refused';
    }

    this.busy = true;
    this.lastAt = now;
    try {
      const stream = this.deps.getStreams().find(s => s.enabled)!;
      const image = await this.deps.capture(stream.url);
      const at = new Date(now);
      const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const ok = await this.deps.slack.uploadImageToChannel(
        image,
        `field-${stamp}.jpg`,
        `The field at ${time}`,
        `📸 The field at ${time}, asked for by <@${msg.user}>.`,
      );
      if (!ok) throw new Error('Slack would not take the upload');
      console.log(`Slack snapshot posted (${Math.round(image.length / 1024)} kB, asked for by ${msg.user})`);
      return 'posted';
    } catch (err) {
      console.warn(`Slack snapshot failed: ${(err as Error).message}`);
      // A failure does not use up the minute.
      this.lastAt = 0;
      await this.deps.slack.replyInThread(msg.ts, `📷 Could not get a picture from the camera just now.`);
      return 'failed';
    } finally {
      this.busy = false;
    }
  }
}
