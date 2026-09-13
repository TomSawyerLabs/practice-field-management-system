import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MatchHistoryStore } from './matchHistoryStore.js';
import type { MatchRecorder } from './matchRecorder.js';
import { serveRecordingFile } from './recordingsApi.js';
import { getTeamAvatar } from './teamAvatarCache.js';
import { json } from './httpApiUtils.js';
import type { MatchHistoryEntry, PublicMatchSummary } from './types.js';

/**
 * Share-token access to one match: the summary a drive team scans off the
 * scoreboard after a match, plus that match's video.
 *
 *   GET /api/public/match/<token>                  summary JSON
 *   GET /api/public/match/<token>/video/<file>     the MP4 (Range; ?download=1)
 *   GET /api/public/match/<token>/avatar/<team>    cached team avatar PNG
 *
 * The token is the whole credential: 32 random base64url characters minted
 * at match start, known only to whoever saw the QR code or was given the
 * link. No API key, no cookie — a phone on cellular has neither. Nothing
 * here reveals any other match, and nothing is writable.
 */
export function handlePublicMatchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  historyStore: MatchHistoryStore,
  recorder: MatchRecorder,
): boolean {
  const [path] = (req.url ?? '').split('?');
  const m = /^\/api\/public\/match\/([^/]+)(?:\/(video|avatar)\/([^/]+))?\/?$/.exec(path);
  if (!path.startsWith('/api/public/')) return false;
  if (!m) {
    json(res, 404, { error: 'Unknown public route' });
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const token = decodeURIComponent(m[1]);
  if (!isShareToken(token)) {
    json(res, 404, { error: 'No such match' });
    return true;
  }
  const entry = historyStore.findByToken(token);
  if (!entry) {
    json(res, 404, { error: 'No such match' });
    return true;
  }

  if (!m[2]) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    json(res, 200, summarize(entry, token));
    return true;
  }

  if (m[2] === 'video') {
    if (!entry.matchId) {
      json(res, 404, { error: 'No recording' });
      return true;
    }
    const file = decodeURIComponent(m[3]);
    // Only files the history entry actually lists — the token grants this
    // match's recordings, not arbitrary reads of the recordings directory.
    if (!entry.recordings?.some(r => r.file === file)) {
      json(res, 404, { error: 'No such recording' });
      return true;
    }
    serveRecordingFile(req, res, recorder, entry.matchId, file);
    return true;
  }

  // avatar
  const team = Number.parseInt(decodeURIComponent(m[3]).replace(/\.png$/, ''), 10);
  if (!Number.isInteger(team) || !entry.teams.some(t => t.teamNumber === team)) {
    json(res, 404, { error: 'No such team in this match' });
    return true;
  }
  getTeamAvatar(team)
    .then(png => {
      if (!png) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : png);
    })
    .catch(() => {
      res.writeHead(404);
      res.end();
    });
  return true;
}

export function isShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(token);
}

function summarize(entry: MatchHistoryEntry, token: string): PublicMatchSummary {
  const base = `/api/public/match/${encodeURIComponent(token)}`;
  return {
    matchNumber: entry.matchNumber,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationSeconds: entry.durationSeconds,
    endReason: entry.endReason,
    autoWinner: entry.autoWinner,
    teams: entry.teams.map(t => ({ ...t, avatarUrl: `${base}/avatar/${t.teamNumber}.png` })),
    redScore: entry.redScore,
    blueScore: entry.blueScore,
    review: entry.review,
    reviewUrl: entry.reviewUrl,
    recordings: (entry.recordings ?? [])
      .filter(r => r.status !== 'failed')
      .map(r => ({
        name: r.name,
        file: r.file,
        bytes: r.bytes,
        durationSeconds: r.durationSeconds,
        status: r.status === 'partial' ? 'partial' : 'ok',
        url: `${base}/video/${encodeURIComponent(r.file)}`,
        downloadUrl: `${base}/video/${encodeURIComponent(r.file)}?download=1`,
      })),
  };
}
