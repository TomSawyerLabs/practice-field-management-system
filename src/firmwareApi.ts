import { IncomingMessage, ServerResponse } from 'http';
import { FirmwareUploadRefused, type FirmwareStore } from './firmwareStore.js';
import type { StaffHttpCheck } from './staffHttp.js';

const MAX_FIRMWARE_SIZE = 100 * 1024 * 1024; // 100 MB

/** Goes into a filename, so nothing here can leave the firmware directory. */
const VERSION_FORMAT = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
/** The radio's checksum of the decrypted image. It can't be compared to the
 *  upload, so its shape is all there is to check here (see addManualFirmware). */
const CHECKSUM_FORMAT = /^[0-9a-fA-F]{64}$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBinaryBody(req: IncomingMessage, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * HTTP handler for firmware management API. Writes are the `staff` tier, like
 * the WebSocket messages that flash radios from this store, so with no operator
 * code a field's /test works with no login. There are no CORS headers: only the
 * field's own pages use this.
 * - GET  /api/firmware          → list firmware entries and their status
 * - POST /api/firmware/upload   → upload a firmware file manually
 * - POST /api/firmware/download → trigger background download of known firmware
 */
export function handleFirmwareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: FirmwareStore,
  access: StaffHttpCheck,
): boolean {
  const url = req.url;
  if (!url) return false;
  const parsed = new URL(url, 'http://localhost');
  const path = parsed.pathname;
  if (path !== '/api/firmware' && path !== '/api/firmware/upload' && path !== '/api/firmware/download') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const refused = req.method === 'POST' ? access.staffRefusal(req) : access.readRefusal(req);
  if (refused) {
    // The body is never read, so close rather than leave an upload to drain.
    res.setHeader('Connection', 'close');
    json(res, refused.status, { error: refused.error });
    return true;
  }

  if (path === '/api/firmware' && req.method === 'GET') {
    json(res, 200, { entries: store.getEntries() });
    return true;
  }

  if (path === '/api/firmware/upload' && req.method === 'POST') {
    // Expect multipart or raw binary with query params for metadata
    // Simple approach: raw binary body with checksum/version/upgradeFrom in query string
    const checksum = parsed.searchParams.get('checksum');
    const version = parsed.searchParams.get('version');
    const upgradeFrom = parsed.searchParams.get('upgradeFrom') as 'from12x' | 'pre12x' | null;

    if (!checksum || !version || !upgradeFrom || !['from12x', 'pre12x'].includes(upgradeFrom)) {
      json(res, 400, { error: 'Missing required query params: checksum, version, upgradeFrom (from12x|pre12x)' });
      return true;
    }
    if (!VERSION_FORMAT.test(version)) {
      json(res, 400, { error: 'version may only use letters, digits and . + _ -' });
      return true;
    }
    if (!CHECKSUM_FORMAT.test(checksum)) {
      json(res, 400, { error: 'checksum must be a SHA-256 in hex' });
      return true;
    }

    readBinaryBody(req, MAX_FIRMWARE_SIZE)
      .then(data => {
        if (data.length === 0) {
          json(res, 400, { error: 'The firmware file is empty' });
          return;
        }
        const entry = store.addManualFirmware(data, checksum, version, upgradeFrom);
        json(res, 200, { message: 'Firmware uploaded', entry });
      })
      .catch(err => {
        json(res, err instanceof FirmwareUploadRefused ? 400 : 500, { error: err.message });
      });
    return true;
  }

  if (path === '/api/firmware/download' && req.method === 'POST') {
    store.startBackgroundDownloads();
    json(res, 202, { message: 'Background download started' });
    return true;
  }

  return false;
}
