import { createReadStream, statSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import CIDRMatcher from 'cidr-matcher';
import { ApiKeyStore } from './apiKeyStore.js';
import { getRealClientIp, normalizeIp } from './utils.js';

/** Read the full request body as a string. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 64 * 1024; // 64 KB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  });
  res.end(data);
}

/** Extract the API key from the request (header or query param). */
export function extractKey(req: IncomingMessage): string | undefined {
  // Check X-API-Key header
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey) return headerKey;

  // Check ?key= query parameter (convenient for tiny devices like ESP32/Arduino)
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const queryKey = url.searchParams.get('key');
    if (queryKey) return queryKey;
  } catch {
    // Malformed URL — no key
  }

  return undefined;
}

/**
 * Whether the scoring API refuses unauthenticated writes even with no keys
 * configured. Read per-call rather than cached so it can be flipped without a
 * rebuild, and so tests can exercise both modes.
 */
export function scoringRequiresKey(): boolean {
  return process.env.SCORING_REQUIRE_KEY === 'true';
}

/**
 * Check authentication for an API request.
 * Returns true if the request is authorized.
 * On failure, records the device as pending for admin approval.
 */
export function checkAuth(req: IncomingMessage, apiKeyStore: ApiKeyStore, trustedProxyMatcher?: CIDRMatcher): boolean {
  // Open until the first key exists, so a new scoring device works without
  // setup — that's deliberate. SCORING_REQUIRE_KEY=true closes the door for
  // anyone who'd rather not run a field that accepts scores from anybody:
  // with it set and no keys created, nothing can write at all.
  if (!apiKeyStore.hasAnyActiveKeys() && !scoringRequiresKey()) return true;

  const presentedKey = extractKey(req);
  if (presentedKey) {
    const sourceIp = normalizeIp(getRealClientIp(req.socket.remoteAddress, req.headers, trustedProxyMatcher));
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    const entry = apiKeyStore.validateKey(presentedKey, sourceIp, userAgent);
    if (entry) return true;
  }

  // Auth failed — record as pending device for auto-discovery
  const sourceIp = normalizeIp(getRealClientIp(req.socket.remoteAddress, req.headers, trustedProxyMatcher));
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  apiKeyStore.recordPendingDevice(sourceIp, userAgent, presentedKey, req.url);

  return false;
}

/**
 * Send one recording sidecar (`metadata.json`, `scores.csv`,
 * `telemetry.csv`) — small enough to read in one go, so no Range support.
 * `?download=1` sends it as an attachment named `downloadName`.
 *
 * Shared by the team's practice-day link and the admin's recordings table,
 * which reach the same files by different credentials.
 */
export function serveSidecar(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  file: string,
  downloadName: string,
): void {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    json(res, 404, { error: 'No such file' });
    return;
  }
  const query = (req.url ?? '').split('?')[1] ?? '';
  const headers: Record<string, string> = {
    'Content-Type': file.endsWith('.json') ? 'application/json' : 'text/csv; charset=utf-8',
    'Content-Length': String(size),
    'Cache-Control': 'private, max-age=60',
    'Access-Control-Allow-Origin': '*',
  };
  if (/(^|&)download=1(&|$)/.test(query)) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
