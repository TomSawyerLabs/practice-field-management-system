import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FieldTimelapse } from './fieldTimelapse.js';
import { json } from './httpApiUtils.js';

/**
 * Serve what the field timelapse has collected.
 *
 *   GET /api/timelapse                         current state (same as the WS message)
 *   GET /api/timelapse/list?from=&to=          what is on disk, day by day
 *   GET /api/timelapse/frame/<day>/<name>.jpg  one archival frame
 *   GET /api/timelapse/active/<day>/<name>.mp4 one robots-present chunk
 *   GET /api/timelapse/render/<name>.mp4       a finished film; `?download=1`
 *                                              sends it as an attachment
 *
 * Same trust as `/api/recordings`: no API key, because these are pictures of
 * the field that anyone on the field network can already see, and Caddy's
 * cookie check gates `/api/*` from outside.
 */
export function handleTimelapseRequest(req: IncomingMessage, res: ServerResponse, timelapse: FieldTimelapse): boolean {
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

  const m = /^\/api\/timelapse\/(frame|active|render)\/(.+)$/.exec(path);
  if (!m) {
    json(res, 404, { error: 'Unknown timelapse route' });
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const kind = m[1] as 'frame' | 'active' | 'render';
  const file = timelapse.filePath(kind, decodeURIComponent(m[2]));
  if (!file) {
    json(res, 404, { error: 'No such timelapse file' });
    return true;
  }
  serveFile(req, res, file, kind === 'frame' ? 'image/jpeg' : 'video/mp4');
  return true;
}

/** Stream a file with Range support, so a browser can scrub a film. */
function serveFile(req: IncomingMessage, res: ServerResponse, full: string, contentType: string): void {
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
    // Frames and chunks never change once written.
    'Cache-Control': 'private, max-age=86400',
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
