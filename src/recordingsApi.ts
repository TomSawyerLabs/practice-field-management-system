import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecordingFileName, type MatchRecorder } from './matchRecorder.js';
import { json, serveSidecar } from './httpApiUtils.js';
import { METADATA_FILE, SCORES_CSV, TELEMETRY_CSV } from './sessionMetadata.js';

/** Metadata files an admin can pull straight out of a recording directory. */
const SIDECARS = new Set([METADATA_FILE, SCORES_CSV, TELEMETRY_CSV]);

/**
 * Serve pFMS's own match recordings.
 *
 *   GET /api/recordings                      recorder status (same as the WS state)
 *   GET /api/recordings/<matchId>/<file>     the MP4, with Range support so a
 *                                            browser can scrub; `?download=1`
 *                                            sends it as an attachment with a
 *                                            friendly name
 *   GET /api/recordings/<matchId>/<file>?thumb=1
 *                                            a JPEG poster frame for that
 *                                            video, made on first use
 *   GET /api/recordings/<matchId>/metadata.json|scores.csv|telemetry.csv
 *                                            the sidecars written beside the
 *                                            videos (`?download=1` likewise)
 *
 * No API key: drive teams on the field network fetch these straight from the
 * station page. Externally, Caddy's cookie check already guards /api/*.
 */
export function handleRecordingsRequest(req: IncomingMessage, res: ServerResponse, recorder: MatchRecorder): boolean {
  const [path] = (req.url ?? '').split('?');
  if (!path.startsWith('/api/recordings')) return false;
  const method = req.method ?? 'GET';

  if (path === '/api/recordings' || path === '/api/recordings/') {
    if (method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    json(res, 200, recorder.getState());
    return true;
  }

  const m = /^\/api\/recordings\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) {
    json(res, 404, { error: 'Unknown recordings route' });
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const matchId = decodeURIComponent(m[1]);
  const file = decodeURIComponent(m[2]);

  if (SIDECARS.has(file)) {
    const dir = recorder.matchDirectory(matchId);
    if (!dir) {
      json(res, 404, { error: 'No such recording' });
      return true;
    }
    serveSidecar(req, res, join(dir, file), file, `${matchId}_${file}`);
    return true;
  }

  if (/(^|&)thumb=1(&|$)/.test((req.url ?? '').split('?')[1] ?? '')) {
    void serveThumbnail(req, res, recorder, matchId, file);
    return true;
  }

  serveRecordingFile(req, res, recorder, matchId, file);
  return true;
}

/** A poster frame for one video, generated on first request and cached on
 *  disk. 404 when the file has no frame to give (a failed capture, or a host
 *  without ffmpeg) so the page can fall back to a placeholder. */
async function serveThumbnail(
  req: IncomingMessage,
  res: ServerResponse,
  recorder: MatchRecorder,
  matchId: string,
  file: string,
): Promise<void> {
  let path: string | undefined;
  try {
    path = await recorder.thumbnail(matchId, file);
  } catch (err) {
    console.warn(`Recordings: thumbnail for ${matchId}/${file} failed: ${(err as Error).message}`);
  }
  if (!path) {
    json(res, 404, { error: 'No thumbnail' });
    return;
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    json(res, 404, { error: 'No thumbnail' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': String(size),
    // The frame never changes once made, and the directory is deleted whole.
    'Cache-Control': 'private, max-age=86400',
  });
  if ((req.method ?? 'GET') === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Stream one recording with Range support; `?download=1` sends an attachment
 *  with a friendly name. Shared by the LAN route and the share-token route. */
export function serveRecordingFile(
  req: IncomingMessage,
  res: ServerResponse,
  recorder: MatchRecorder,
  matchId: string,
  file: string,
): void {
  const query = (req.url ?? '').split('?')[1] ?? '';
  const method = req.method ?? 'GET';
  const dir = recorder.matchDirectory(matchId);
  // Only plain MP4 names inside the match directory — no traversal, no sidecars.
  if (!dir || !isRecordingFileName(file)) {
    json(res, 404, { error: 'No such recording' });
    return;
  }
  const full = join(dir, file);
  let size: number;
  try {
    const st = statSync(full);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    json(res, 404, { error: 'No such recording' });
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };
  if (/(^|&)download=1(&|$)/.test(query)) {
    headers['Content-Disposition'] = `attachment; filename="${friendlyName(recorder, matchId, file)}"`;
  }

  // Range: bytes=start-end (either side optional). Anything unparsable falls
  // back to the whole file, as browsers expect.
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && size > 0) {
    const s = range[1] === '' ? undefined : Number(range[1]);
    const e = range[2] === '' ? undefined : Number(range[2]);
    if (s === undefined && e !== undefined) {
      start = Math.max(0, size - e);
    } else if (s !== undefined) {
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
  if (method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(full, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** match-12_2026-09-13_14-05_all-field.mp4 */
function friendlyName(recorder: MatchRecorder, matchId: string, file: string): string {
  const manifest = recorder.readManifest(matchId);
  const slug = file.replace(/\.mp4$/, '').replace(/\.part\d+$/, '');
  if (!manifest) return `match_${slug}.mp4`;
  const d = new Date(manifest.startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const n = manifest.matchNumber !== undefined ? `match-${manifest.matchNumber}` : 'match';
  return `${n}_${stamp}_${slug}.mp4`;
}
