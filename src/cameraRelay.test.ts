import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CameraRelay, MjpegFrameParser, RELAY_BOUNDARY, type Upstream } from './cameraRelay.js';
import { handleCameraRequest, type CameraVerdict } from './cameraRelayApi.js';

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, n, n, 0xff, 0xd9]);

/** What CameraServer sends: HTTP headers, then parts with Content-Length. */
const httpHead = (boundary = 'boundarydonotcross', status = 200) =>
  Buffer.from(
    `HTTP/1.0 ${status} OK\r\nConnection: close\r\nContent-Type: multipart/x-mixed-replace;boundary=${boundary}\r\n\r\n`,
  );
const part = (frame: Buffer, { boundary = 'boundarydonotcross', length = true } = {}) =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: image/jpeg\r\n${length ? `Content-Length: ${frame.length}\r\n` : ''}\r\n`,
    ),
    frame,
    Buffer.from('\r\n'),
  ]);

describe('reading an MJPEG stream', () => {
  test('frames come out whole, however the bytes are split', () => {
    const all = Buffer.concat([httpHead(), part(jpeg(1)), part(jpeg(2)), part(jpeg(3))]);
    for (const size of [1, 3, 17, all.length]) {
      const parser = new MjpegFrameParser();
      const frames: Buffer[] = [];
      for (let i = 0; i < all.length; i += size) frames.push(...parser.push(all.subarray(i, i + size)));
      expect(frames).toEqual([jpeg(1), jpeg(2), jpeg(3)]);
      expect(parser.status).toBe(200);
    }
  });

  test('parts without Content-Length end at the next boundary', () => {
    const parser = new MjpegFrameParser();
    const frames = parser.push(
      Buffer.concat([
        httpHead('"--frame"'),
        part(jpeg(1), { boundary: 'frame', length: false }),
        part(jpeg(2), { boundary: 'frame', length: false }),
      ]),
    );
    // The last one waits for the boundary after it
    expect(frames).toEqual([jpeg(1)]);
  });

  test('an error page is reported by status, with no frames', () => {
    const parser = new MjpegFrameParser();
    expect(parser.push(Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\n<html>'))).toEqual([]);
    expect(parser.status).toBe(404);
  });

  test('something that never becomes frames is given up on', () => {
    const parser = new MjpegFrameParser();
    parser.push(httpHead());
    expect(() => parser.push(Buffer.alloc(MjpegFrameParser.MAX_PENDING + 1))).toThrow();
  });
});

class FakeUpstream implements Upstream {
  data: ((chunk: Buffer) => void)[] = [];
  ends: ((why: string) => void)[] = [];
  stopped = 0;
  onData(fn: (chunk: Buffer) => void) {
    this.data.push(fn);
  }
  onEnd(fn: (why: string) => void) {
    this.ends.push(fn);
  }
  stop() {
    this.stopped++;
  }
  send(chunk: Buffer) {
    for (const fn of this.data) fn(chunk);
  }
  end(why: string) {
    for (const fn of this.ends) fn(why);
  }
}

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  ended = false;
  writableLength = 0;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
  }
  write(chunk: string | Buffer) {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return true;
  }
  end(chunk?: string | Buffer) {
    if (chunk) this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    this.ended = true;
  }
  /** The JPEGs this viewer was sent, read back with pFMS's boundary. */
  frames(): Buffer[] {
    const parser = new MjpegFrameParser();
    parser.push(httpHead(RELAY_BOUNDARY));
    return parser.push(Buffer.concat([...this.chunks, Buffer.from(`--${RELAY_BOUNDARY}\r\n\r\n`)]));
  }
}

const key = { ifname: 'br-slot1', ip: '10.28.54.2', port: 1181 };
const asResponse = (r: FakeResponse) => r as unknown as ServerResponse;

describe('relaying a camera', () => {
  const timers: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const t of timers.splice(0)) t.mockRestore();
  });

  function setup(options: ConstructorParameters<typeof CameraRelay>[0] = {}) {
    const upstreams: FakeUpstream[] = [];
    const urls: string[] = [];
    const relay = new CameraRelay({
      start: (ifname, url) => {
        urls.push(`${ifname} ${url}`);
        const u = new FakeUpstream();
        upstreams.push(u);
        return u;
      },
      graceMs: 0,
      ...options,
    });
    return { relay, upstreams, urls };
  }

  test('two viewers share one upstream, pinned to the bridge, and a late one starts on the last frame', () => {
    const { relay, upstreams, urls } = setup();
    const a = new FakeResponse();
    const b = new FakeResponse();
    relay.watch(key, asResponse(a));
    upstreams[0].send(Buffer.concat([httpHead(), part(jpeg(1))]));
    relay.watch(key, asResponse(b));
    upstreams[0].send(part(jpeg(2)));

    expect(urls).toEqual(['br-slot1 http://10.28.54.2:1181/?action=stream']);
    expect(a.status).toBe(200);
    expect(a.headers['Content-Type']).toBe(`multipart/x-mixed-replace; boundary=${RELAY_BOUNDARY}`);
    expect(a.frames()).toEqual([jpeg(1), jpeg(2)]);
    expect(b.frames()).toEqual([jpeg(1), jpeg(2)]);
    expect(relay.activity).toEqual({ streams: 1, viewers: 2 });
    relay.stop();
  });

  test('a viewer that falls behind skips frames instead of piling them up', () => {
    const { relay, upstreams } = setup({ maxViewerBacklog: 100 });
    const slow = new FakeResponse();
    relay.watch(key, asResponse(slow));
    upstreams[0].send(Buffer.concat([httpHead(), part(jpeg(1))]));
    slow.writableLength = 101;
    upstreams[0].send(part(jpeg(2)));
    slow.writableLength = 0;
    upstreams[0].send(part(jpeg(3)));
    expect(slow.frames()).toEqual([jpeg(1), jpeg(3)]);
    relay.stop();
  });

  test('the upstream stops once the last viewer has gone', async () => {
    const { relay, upstreams } = setup();
    const a = new FakeResponse();
    relay.watch(key, asResponse(a));
    a.emit('close');
    await Bun.sleep(5);
    expect(upstreams[0].stopped).toBe(1);
    expect(relay.activity.streams).toBe(0);
  });

  test('a viewer returning within the grace period keeps the same upstream', async () => {
    const { relay, upstreams } = setup({ graceMs: 50 });
    const a = new FakeResponse();
    relay.watch(key, asResponse(a));
    a.emit('close');
    relay.watch(key, asResponse(new FakeResponse()));
    await Bun.sleep(80);
    expect(upstreams.length).toBe(1);
    expect(upstreams[0].stopped).toBe(0);
    relay.stop();
  });

  test('the camera going away ends every viewer, and the next viewer starts afresh', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    timers.push(log);
    const { relay, upstreams } = setup();
    const a = new FakeResponse();
    relay.watch(key, asResponse(a));
    upstreams[0].end('connection refused');
    expect(a.ended).toBe(true);
    relay.watch(key, asResponse(new FakeResponse()));
    expect(upstreams.length).toBe(2);
    relay.stop();
  });

  test('an error page from the camera ends the stream', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    timers.push(log);
    const { relay, upstreams } = setup();
    const a = new FakeResponse();
    relay.watch(key, asResponse(a));
    upstreams[0].send(Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\n'));
    expect(a.ended).toBe(true);
    expect(upstreams[0].stopped).toBe(1);
  });

  test('stills: one frame, then the camera is hung up on', async () => {
    const { relay, upstreams } = setup();
    const got = relay.still(key);
    upstreams[0].send(Buffer.concat([httpHead(), part(jpeg(1)), part(jpeg(2))]));
    expect(await got).toEqual(jpeg(1));
    expect(upstreams[0].stopped).toBe(1);
    relay.stop();
  });

  test('stills: viewers polling together cost one fetch per interval', async () => {
    const { relay, upstreams } = setup({ stillIntervalMs: 4_000 });
    const a = relay.still(key);
    const b = relay.still(key);
    upstreams[0].send(Buffer.concat([httpHead(), part(jpeg(1))]));
    expect([await a, await b]).toEqual([jpeg(1), jpeg(1)]);
    expect(await relay.still(key, Date.now() + 3_000)).toEqual(jpeg(1));
    expect(upstreams.length).toBe(1);
    const later = relay.still(key, Date.now() + 4_100);
    expect(upstreams.length).toBe(2);
    upstreams[1].send(Buffer.concat([httpHead(), part(jpeg(2))]));
    expect(await later).toEqual(jpeg(2));
    relay.stop();
  });

  test('stills: a camera already relayed live gives its latest frame without a fetch', async () => {
    const { relay, upstreams } = setup();
    relay.watch(key, asResponse(new FakeResponse()));
    upstreams[0].send(Buffer.concat([httpHead(), part(jpeg(7))]));
    expect(await relay.still(key)).toEqual(jpeg(7));
    expect(upstreams.length).toBe(1);
    relay.stop();
  });

  test('stills: a dead or silent camera fails with the reason', async () => {
    const { relay, upstreams } = setup({ stillTimeoutMs: 20 });
    const dead = relay.still(key);
    upstreams[0].end('Failed to connect: Connection refused');
    await expect(dead).rejects.toThrow('Connection refused');
    await expect(relay.still({ ...key, port: 1182 })).rejects.toThrow('no picture within');
    await Bun.sleep(40);
    expect(upstreams[1].stopped).toBe(1);
    relay.stop();
  });

  test('viewer and camera limits are refused, not queued', () => {
    const { relay } = setup({ maxViewers: 1, maxStreams: 1 });
    relay.watch(key, asResponse(new FakeResponse()));
    const second = new FakeResponse();
    relay.watch(key, asResponse(second));
    expect(second.status).toBe(503);
    const other = new FakeResponse();
    relay.watch({ ...key, port: 1182 }, asResponse(other));
    expect(other.status).toBe(503);
    relay.stop();
  });
});

describe('GET /api/camera', () => {
  function call(url: string, verdict: CameraVerdict = { ok: true, key }, refuse = false) {
    const res = new FakeResponse();
    const watched: unknown[] = [];
    const asked: unknown[] = [];
    const handled = handleCameraRequest(
      { url, method: 'GET' } as IncomingMessage,
      asResponse(res),
      { watch: k => void watched.push(k), still: () => Promise.resolve(jpeg(9)) },
      { readRefusal: () => (refuse ? { status: 403, error: 'This only works from the field network' } : null) },
      (station, ip, port) => {
        asked.push([station, ip, port]);
        return verdict;
      },
    );
    const body = res.chunks.length ? JSON.parse(Buffer.concat(res.chunks).toString()) : undefined;
    return { handled, status: res.status, body, watched, asked };
  }

  test('a camera the scan found is relayed', () => {
    const r = call('/api/camera?station=slot1&ip=10.28.54.2&port=1181');
    expect(r.asked).toEqual([['slot1', '10.28.54.2', 1181]]);
    expect(r.watched).toEqual([key]);
  });

  test("refused with the verdict's reason", () => {
    const r = call('/api/camera?station=slot1&ip=10.28.54.2&port=1181', {
      ok: false,
      status: 404,
      error: "pFMS hasn't found a camera stream there",
    });
    expect(r).toMatchObject({ status: 404, body: { error: "pFMS hasn't found a camera stream there" }, watched: [] });
  });

  test('a robot with a bandwidth limit gets stills, not the live stream', async () => {
    const limited: CameraVerdict = { ok: true, key, stillsOnly: 'QoS BW Limit is on' };
    const live = call('/api/camera?station=slot1&ip=10.28.54.2&port=1181', limited);
    expect(live).toMatchObject({ status: 409, body: { error: 'QoS BW Limit is on', still: true }, watched: [] });

    const res = new FakeResponse();
    handleCameraRequest(
      { url: '/api/camera?station=slot1&ip=10.28.54.2&port=1181&still=1', method: 'GET' } as IncomingMessage,
      asResponse(res),
      { watch: () => {}, still: () => Promise.resolve(jpeg(9)) },
      { readRefusal: () => null },
      () => limited,
    );
    await Bun.sleep(0);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(Buffer.concat(res.chunks)).toEqual(jpeg(9));
  });

  test('bad parameters and off-site requests never reach the verdict', () => {
    expect(call('/api/camera?station=slot9&ip=10.28.54.2&port=1181')).toMatchObject({ status: 400, asked: [] });
    expect(call('/api/camera?station=slot1&ip=evil.example&port=1181')).toMatchObject({ status: 400, asked: [] });
    expect(call('/api/camera?station=slot1&ip=10.28.54.2&port=1181', undefined, true)).toMatchObject({
      status: 403,
      asked: [],
    });
    expect(call('/api/cameras').handled).toBe(false);
  });
});
