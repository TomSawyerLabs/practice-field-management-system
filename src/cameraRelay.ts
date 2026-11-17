/**
 * Robot camera streams (CameraServer MJPEG, 1181+), relayed through pFMS so a
 * browser can watch one inline.
 *
 * Why relay instead of linking: the site is https, and a page there can't show
 * an `http://10.TE.AM.x` image (mixed content). A relay is also one copy of the
 * stream over the robot's Wi-Fi however many people watch, where direct links
 * cost a copy per viewer, and it is pinned to the station's bridge like every
 * other pFMS request to a robot (a team on two stations has its subnet twice).
 *
 * One upstream per camera, started by the first viewer and stopped a few
 * seconds after the last one leaves. The upstream is split into JPEG frames
 * and each viewer gets whole frames with pFMS's own boundary, so a viewer can
 * join mid-stream. A viewer that can't keep up skips frames rather than
 * buffering them.
 *
 * A robot whose radio caps its bandwidth gets stills instead (`still()`): one
 * frame at most every few seconds per camera, however many people ask.
 */
import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';

/** The boundary pFMS's own multipart stream uses. */
export const RELAY_BOUNDARY = 'pfmsframe';

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * Splits an MJPEG HTTP response (headers included, as `curl --include` prints
 * it) into JPEG frames. Uses each part's Content-Length when it has one
 * (CameraServer sends it), and otherwise the next boundary.
 */
export class MjpegFrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private boundary: Buffer | null = null;
  /** Too much data with no frame in it: not an MJPEG stream. */
  static readonly MAX_PENDING = 4 * 1024 * 1024;

  /** The HTTP status of the reply, once its headers have arrived. */
  status: number | null = null;
  contentType: string | null = null;

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.status === null && !this.readHttpHeaders()) return [];
    if (!this.boundary) return [];
    const frames: Buffer[] = [];
    for (;;) {
      const frame = this.nextFrame();
      if (!frame) break;
      frames.push(frame);
    }
    if (this.buf.length > MjpegFrameParser.MAX_PENDING) throw new Error('No frames in the stream');
    return frames;
  }

  private readHttpHeaders(): boolean {
    const end = this.buf.indexOf(HEADER_END);
    if (end === -1) {
      if (this.buf.length > 64 * 1024) throw new Error('No HTTP headers');
      return false;
    }
    const lines = this.buf.subarray(0, end).toString('latin1').split('\r\n');
    this.buf = this.buf.subarray(end + HEADER_END.length);
    this.status = Number(lines[0].split(' ')[1]) || 0;
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === 'content-type') {
        this.contentType = line.slice(colon + 1).trim();
      }
    }
    const boundary = this.contentType?.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary) this.boundary = Buffer.from(`--${boundary.replace(/^--/, '')}`);
    return true;
  }

  private nextFrame(): Buffer | null {
    const boundary = this.boundary!;
    const start = this.buf.indexOf(boundary);
    if (start === -1) return null;
    const headersAt = start + boundary.length;
    const headersEnd = this.buf.indexOf(HEADER_END, headersAt);
    if (headersEnd === -1) return null;
    const headers = this.buf.subarray(headersAt, headersEnd).toString('latin1');
    const bodyAt = headersEnd + HEADER_END.length;
    const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
    let bodyEnd: number;
    if (Number.isInteger(length) && length > 0) {
      bodyEnd = bodyAt + length;
      if (this.buf.length < bodyEnd) return null;
    } else {
      const next = this.buf.indexOf(boundary, bodyAt);
      if (next === -1) return null;
      bodyEnd = next;
      // The CRLF before the next boundary belongs to the boundary
      if (this.buf.subarray(bodyEnd - 2, bodyEnd).equals(CRLF)) bodyEnd -= 2;
    }
    const frame = Buffer.from(this.buf.subarray(bodyAt, bodyEnd));
    this.buf = this.buf.subarray(bodyEnd);
    return frame;
  }
}

/** A running upstream: curl's stdout, and a way to stop it. */
export interface Upstream {
  onData(fn: (chunk: Buffer) => void): void;
  onEnd(fn: (why: string) => void): void;
  stop(): void;
}

export type StartUpstream = (ifname: string, url: string) => Upstream;

/** curl, pinned to the station's bridge, streaming with headers included. */
export const curlUpstream: StartUpstream = (ifname, url) => {
  const child = spawn(
    'curl',
    ['--silent', '--show-error', '--no-buffer', '--include', '--noproxy', '*', '--interface', ifname].concat([
      '--connect-timeout',
      '2',
      url,
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const endListeners: ((why: string) => void)[] = [];
  let ended = false;
  const end = (why: string) => {
    if (ended) return;
    ended = true;
    for (const fn of endListeners) fn(why);
  };
  child.on('error', err =>
    end((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'curl is not installed' : err.message),
  );
  child.on('close', code => end(stderr.trim() || `the camera closed the stream (curl exit ${code})`));
  return {
    onData: fn => child.stdout.on('data', fn),
    onEnd: fn => endListeners.push(fn),
    stop: () => child.kill(),
  };
};

export interface CameraKey {
  ifname: string;
  ip: string;
  port: number;
}

interface Stream {
  upstream: Upstream;
  parser: MjpegFrameParser;
  viewers: Set<ServerResponse>;
  lastFrame: Buffer | null;
  lastFrameAt: number;
  idleTimer: NodeJS.Timeout | null;
}

export interface CameraRelayOptions {
  start?: StartUpstream;
  /** How long an upstream outlives its last viewer (a page reload rejoins it). */
  graceMs?: number;
  /** Most viewers of one camera. */
  maxViewers?: number;
  /** Most cameras relayed at once. */
  maxStreams?: number;
  /** A viewer further behind than this skips frames. */
  maxViewerBacklog?: number;
  /** An upstream that sends no frame for this long is given up on. */
  stallMs?: number;
  /** A still is fetched from a camera at most this often. */
  stillIntervalMs?: number;
  /** A still fetch that brings no frame in this long fails. */
  stillTimeoutMs?: number;
}

interface Still {
  frame: Buffer | null;
  at: number;
  pending: Promise<Buffer> | null;
}

const idOf = (key: CameraKey) => `${key.ifname}|${key.ip}|${key.port}`;
const streamUrl = (key: CameraKey) => `http://${key.ip}:${key.port}/?action=stream`;

export class CameraRelay {
  private streams = new Map<string, Stream>();
  private stills = new Map<string, Still>();
  private readonly opts: Required<CameraRelayOptions>;
  private stallTimer: NodeJS.Timeout | null = null;

  constructor(options: CameraRelayOptions = {}) {
    this.opts = {
      start: curlUpstream,
      graceMs: 5_000,
      maxViewers: 8,
      maxStreams: 6,
      maxViewerBacklog: 512 * 1024,
      stallMs: 10_000,
      stillIntervalMs: 4_000,
      stillTimeoutMs: 5_000,
      ...options,
    };
  }

  /** How many cameras are being relayed, and to how many viewers. */
  get activity(): { streams: number; viewers: number } {
    let viewers = 0;
    for (const s of this.streams.values()) viewers += s.viewers.size;
    return { streams: this.streams.size, viewers };
  }

  /** Streams `key`'s camera to `res` until either side goes away. */
  watch(key: CameraKey, res: ServerResponse): void {
    const id = idOf(key);
    let stream = this.streams.get(id);
    if (!stream) {
      if (this.streams.size >= this.opts.maxStreams) return refuse(res, 503, 'Too many cameras are being watched');
      stream = this.open(id, key);
    }
    if (stream.viewers.size >= this.opts.maxViewers)
      return refuse(res, 503, 'Too many people are watching this camera');
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = null;

    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${RELAY_BOUNDARY}`,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    stream.viewers.add(res);
    if (stream.lastFrame) sendFrame(res, stream.lastFrame);
    const current = stream;
    res.on('close', () => {
      current.viewers.delete(res);
      if (current.viewers.size === 0 && this.streams.get(id) === current) {
        current.idleTimer = setTimeout(() => this.close(id, current), this.opts.graceMs);
        current.idleTimer.unref?.();
      }
    });
  }

  /**
   * One recent frame from `key`'s camera. A camera is asked at most once per
   * `stillIntervalMs` (counted from when the last frame arrived) however many
   * viewers poll; a camera already being relayed live gives its latest frame.
   */
  still(key: CameraKey, now = Date.now()): Promise<Buffer> {
    const id = idOf(key);
    const live = this.streams.get(id)?.lastFrame;
    if (live) return Promise.resolve(live);
    for (const [other, s] of this.stills) {
      if (!s.pending && now - s.at > 60_000) this.stills.delete(other);
    }
    let entry = this.stills.get(id);
    if (!entry) this.stills.set(id, (entry = { frame: null, at: 0, pending: null }));
    if (entry.pending) return entry.pending;
    if (entry.frame && now - entry.at < this.opts.stillIntervalMs) return Promise.resolve(entry.frame);
    const fetching = [...this.stills.values()].filter(s => s.pending).length;
    if (fetching >= this.opts.maxStreams) return Promise.reject(new Error('Too many cameras are being watched'));
    const current = entry;
    current.pending = this.grabFrame(key)
      .then(frame => {
        current.frame = frame;
        current.at = Date.now();
        return frame;
      })
      .finally(() => (current.pending = null));
    return current.pending;
  }

  /** Opens the stream, keeps its first frame, and hangs up. */
  private grabFrame(key: CameraKey): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const upstream = this.opts.start(key.ifname, streamUrl(key));
      const parser = new MjpegFrameParser();
      let done = false;
      const finish = (err: Error | null, frame?: Buffer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        upstream.stop();
        if (err) reject(err);
        else resolve(frame!);
      };
      const timer = setTimeout(
        () => finish(new Error(`The camera sent no picture within ${this.opts.stillTimeoutMs / 1000} s`)),
        this.opts.stillTimeoutMs,
      );
      timer.unref?.();
      upstream.onData(chunk => {
        try {
          const frames = parser.push(chunk);
          if (parser.status !== null && parser.status !== 200) {
            finish(new Error(`The camera answered HTTP ${parser.status}`));
          } else if (frames.length) {
            finish(null, frames[0]);
          }
        } catch (err) {
          finish(err as Error);
        }
      });
      upstream.onEnd(why => finish(new Error(why)));
    });
  }

  stop(): void {
    this.stills.clear();
    for (const [id, stream] of [...this.streams]) this.close(id, stream);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private open(id: string, key: CameraKey): Stream {
    const stream: Stream = {
      upstream: this.opts.start(key.ifname, streamUrl(key)),
      parser: new MjpegFrameParser(),
      viewers: new Set(),
      lastFrame: null,
      lastFrameAt: Date.now(),
      idleTimer: null,
    };
    this.streams.set(id, stream);
    stream.upstream.onData(chunk => {
      let frames: Buffer[];
      try {
        frames = stream.parser.push(chunk);
      } catch (err) {
        return this.close(id, stream, (err as Error).message);
      }
      if (stream.parser.status !== null && stream.parser.status !== 200) {
        return this.close(id, stream, `the camera answered HTTP ${stream.parser.status}`);
      }
      for (const frame of frames) {
        stream.lastFrame = frame;
        stream.lastFrameAt = Date.now();
        for (const viewer of stream.viewers) {
          if (viewer.writableLength <= this.opts.maxViewerBacklog) sendFrame(viewer, frame);
        }
      }
    });
    stream.upstream.onEnd(why => this.close(id, stream, why));
    if (!this.stallTimer) {
      this.stallTimer = setInterval(() => this.checkStalls(), 2_000);
      this.stallTimer.unref?.();
    }
    return stream;
  }

  private checkStalls(now = Date.now()): void {
    for (const [id, stream] of [...this.streams]) {
      if (now - stream.lastFrameAt > this.opts.stallMs) this.close(id, stream, 'the camera stopped sending frames');
    }
  }

  private close(id: string, stream: Stream, why?: string): void {
    if (this.streams.get(id) !== stream) return;
    this.streams.delete(id);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.upstream.stop();
    if (why && stream.viewers.size > 0) console.log(`Camera relay ${id}: ${why}`);
    for (const viewer of stream.viewers) viewer.end();
    stream.viewers.clear();
    if (this.streams.size === 0 && this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }
}

function sendFrame(res: ServerResponse, frame: Buffer): void {
  res.write(`--${RELAY_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
}

function refuse(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
}
