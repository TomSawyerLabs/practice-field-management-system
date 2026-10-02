import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { matchFromHistory, type FieldActivityLog } from './fieldActivityLog.js';
import type { FieldTimelapse } from './fieldTimelapse.js';
import { json, readBody } from './httpApiUtils.js';
import { backfillActivity, mergeMatches, placeSegments, summarizeDays } from './timelapseTimeline.js';
import type { MatchHistoryEntry, PracticeRunEntry, TimelapseDays, TimelapseTimeline, UsageSession } from './types.js';

/** What the viewer's timeline is drawn from, besides the footage. */
export interface TimelineSources {
  activity: FieldActivityLog;
  historyMatches: () => MatchHistoryEntry[];
  usageSessions: () => UsageSession[];
  practiceRuns: () => PracticeRunEntry[];
}

/** Longest range one timeline request may cover. The viewer asks for a
 *  practice day at a time; this only stops a runaway scan. */
const MAX_RANGE_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Serve what the field timelapse has collected.
 *
 *   GET /api/timelapse                         current state (same as the WS message)
 *   GET /api/timelapse/list?from=&to=          what is on disk, day by day
 *   GET /api/timelapse/frame/<day>/<name>.jpg  one archival frame
 *   GET /api/timelapse/active/<day>/<name>.mp4 one robots-present chunk
 *   GET /api/timelapse/render/<name>.mp4       a finished film; `?download=1`
 *                                              sends it as an attachment
 *   GET /api/timelapse/timeline?from=&to=&stream=
 *                                              the viewer's one logical
 *                                              timeline for a range (epoch ms):
 *                                              segments, stills, matches,
 *                                              robots, enables
 *   GET /api/timelapse/days?stream=            practice days with footage
 *   GET /api/timelapse/scrub/<day>/<name>.scrub.jpg
 *                                              a chunk's scrub sheet
 *   GET /api/timelapse/proxy/<day>/<name>.scrub.m4v
 *                                              a chunk's scrub copy (small,
 *                                              every frame a keyframe)
 *   POST /api/timelapse/lights-ready           Home Assistant saying the
 *                                              lights are on (see below)
 *
 * Same trust as `/api/recordings`: no API key, because these are pictures of
 * the field that anyone on the field network can already see, and Caddy's
 * cookie check gates `/api/*` from outside.
 *
 * `lights-ready` is the one write, and it is unauthenticated on purpose: the
 * whole point of the webhook light mode is that neither side stores a
 * credential. Its credential is the nonce pFMS just minted — 128 bits, single
 * use, and only accepted while a capture is actually waiting for it. The most
 * a caller can do with a lucky guess is make one archival frame fire a few
 * seconds early.
 */
export function handleTimelapseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  timelapse: FieldTimelapse,
  sources?: TimelineSources,
): boolean {
  const [path] = (req.url ?? '').split('?');
  if (!path.startsWith('/api/timelapse')) return false;
  const method = req.method ?? 'GET';

  if (path === '/api/timelapse' || path === '/api/timelapse/') {
    if (method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    json(res, 200, timelapse.getState());
    return true;
  }

  if (path === '/api/timelapse/list') {
    if (method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    json(res, 200, timelapse.listing({ from: day(params.get('from')), to: day(params.get('to')) }));
    return true;
  }

  if ((path === '/api/timelapse/timeline' || path === '/api/timelapse/days') && sources) {
    if (method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const stream = params.get('stream') ?? undefined;
    if (path === '/api/timelapse/days') {
      json(res, 200, buildDays(timelapse, stream));
      return true;
    }
    const from = Number(params.get('from'));
    const to = Number(params.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_RANGE_MS) {
      json(res, 400, { error: 'from and to must be epoch ms, from < to, at most 8 days apart' });
      return true;
    }
    json(res, 200, buildTimeline(timelapse, sources, from, to, stream));
    return true;
  }

  if (path === '/api/timelapse/lights-ready') {
    if (method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    void handleLightsReady(req, res, timelapse);
    return true;
  }

  const m = /^\/api\/timelapse\/(frame|active|scrub|proxy|render)\/(.+)$/.exec(path);
  if (!m) {
    json(res, 404, { error: 'Unknown timelapse route' });
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const kind = m[1] as 'frame' | 'active' | 'scrub' | 'proxy' | 'render';
  const rel = decodeURIComponent(m[2]);
  const file = timelapse.filePath(kind, rel);
  if (!file) {
    json(res, 404, { error: 'No such timelapse file' });
    return true;
  }
  // A chunk that is still growing, or about to be remuxed in place, must not
  // be cached: see FieldTimelapse.isChunkFinal.
  const cacheable = kind !== 'active' || timelapse.isChunkFinal(rel);
  serveFile(req, res, file, kind === 'frame' || kind === 'scrub' ? 'image/jpeg' : 'video/mp4', cacheable);
  return true;
}

/** Pick the stream to show: the one asked for if it has footage in range,
 *  else the primary stream, else whatever has footage. */
function chooseStream(available: string[], asked: string | undefined, primary: string | undefined): string | null {
  if (asked && available.includes(asked)) return asked;
  if (primary && (available.length === 0 || available.includes(primary))) return primary;
  return available[0] ?? primary ?? null;
}

/** The viewer's one logical timeline for [from, to]. */
export function buildTimeline(
  timelapse: FieldTimelapse,
  sources: TimelineSources,
  from: number,
  to: number,
  askedStream?: string,
): TimelapseTimeline {
  const chunks = timelapse.chunkInfos(from, to);
  const frames = timelapse.framesBetween(from, to);
  const streams = [...new Set([...chunks.map(c => c.stream), ...frames.map(f => f.stream)])].sort();
  const stream = chooseStream(streams, askedStream, timelapse.primaryStream());

  const inRange = (m: { start: number; end: number }) => m.end >= from && m.start <= to;
  const matches = mergeMatches(
    sources.activity.matches(from, to),
    sources.historyMatches().map(matchFromHistory).filter(inRange),
  );
  const since = sources.activity.loggedSince();
  const { robots, enables } = backfillActivity({
    from,
    to,
    logged: sources.activity.spans(from, to),
    since,
    usage: sources.usageSessions(),
    practiceRuns: sources.practiceRuns(),
  });

  return {
    type: 'timelapseTimeline',
    from,
    to,
    now: Date.now(),
    stream,
    streams,
    segments: placeSegments(chunks.filter(c => c.stream === stream)),
    frames: frames.filter(f => f.stream === stream).map(({ at, file, thumb }) => ({ at, file, thumb })),
    matches,
    robots,
    enables,
    ...(since !== undefined ? { activityLoggedSince: since } : {}),
  };
}

/** Practice days with footage for the day picker. */
export function buildDays(timelapse: FieldTimelapse, askedStream?: string): TimelapseDays {
  const all = { from: 0, to: Date.now() + 24 * 60 * 60 * 1000 };
  const chunks = timelapse.chunkInfos(all.from, all.to);
  const frames = timelapse.framesBetween(all.from, all.to);
  const streams = [...new Set([...chunks.map(c => c.stream), ...frames.map(f => f.stream)])].sort();
  const stream = chooseStream(streams, askedStream, timelapse.primaryStream());
  return {
    type: 'timelapseDays',
    days: summarizeDays(
      placeSegments(chunks.filter(c => c.stream === stream)),
      frames.filter(f => f.stream === stream),
    ),
  };
}

/** Stream a file with Range support, so a browser can scrub a film. */
function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  full: string,
  contentType: string,
  cacheable = true,
): void {
  let size: number;
  try {
    const st = statSync(full);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    json(res, 404, { error: 'No such timelapse file' });
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // Frames, finished chunks and scrub sheets never change once written.
    'Cache-Control': cacheable ? 'private, max-age=86400' : 'no-store',
  };
  if (/(^|&)download=1(&|$)/.test((req.url ?? '').split('?')[1] ?? '')) {
    headers['Content-Disposition'] = `attachment; filename="${full.split(/[\\/]/).pop()}"`;
  }

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && size > 0) {
    const s = range[1] === '' ? undefined : Number(range[1]);
    const e = range[2] === '' ? undefined : Number(range[2]);
    if (s === undefined && e !== undefined) start = Math.max(0, size - e);
    else if (s !== undefined) {
      start = s;
      if (e !== undefined) end = Math.min(e, size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if ((req.method ?? 'GET') === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(full, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** `{"nonce":"…"}` in the body, or `?nonce=…` for a caller that finds a JSON
 *  body awkward. Answers 409 when nobody is waiting, so a misconfigured
 *  automation shows up as an error in Home Assistant rather than silence. */
async function handleLightsReady(req: IncomingMessage, res: ServerResponse, timelapse: FieldTimelapse): Promise<void> {
  let nonce = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('nonce') ?? '';
  if (!nonce) {
    try {
      const body = await readBody(req);
      if (body) nonce = String((JSON.parse(body) as { nonce?: unknown }).nonce ?? '');
    } catch {
      // Not JSON, or too big — treated as no nonce at all.
    }
  }
  if (nonce && timelapse.notifyLightsReady(nonce)) {
    json(res, 200, { ok: true });
    return;
  }
  json(res, 409, { error: 'No capture is waiting for that nonce' });
}
