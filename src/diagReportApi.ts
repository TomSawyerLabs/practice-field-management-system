import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { json } from './httpApiUtils.js';

/**
 * Driver Station laptop Wi-Fi diagnostics.
 *
 *   GET  /api/diag/wifi.ps1            the collector, with this pFMS's address
 *                                      baked in, as text
 *   GET  /api/diag/wifi.ps1?download   the same, as pfms-wifi-check.ps1 to
 *                                      save and "Run with PowerShell"
 *   POST /api/diag/wifi-report         where the collector sends its report
 *
 * No `irm | iex` one-liner and no .cmd wrapper around one: Microsoft
 * Defender blocks `powershell -Command "irm <url> | iex"` as
 * Trojan:Win32/Commando.A!ml (2026-09-28), so on a team laptop it would
 * never run.
 *
 * Reports land as one JSON file per upload under
 * `<reportsDir>/wifi/<YYYY-MM-DD>/`, wrapped with what pFMS knows about the
 * sender (address, the team its Driver Station last said it was). Nothing
 * reads them back over HTTP: they carry laptop names and user names, so
 * review happens on the host (see docs/ds-wifi-check.md).
 *
 * Same trust as the rest of `/api/*`: open on the field network, gated by
 * Caddy's cookie check from outside. The upload is unauthenticated because
 * the people running it are teams at the field; the size cap, per-address
 * rate limit and per-day file cap keep a misbehaving client from filling
 * the disk.
 */

export const DIAG_SCRIPT_NAME = 'ds-wifi-report.ps1';
const SERVER_PLACEHOLDER = '__PFMS_SERVER__';
const DOWNLOAD_NAME = 'pfms-wifi-check.ps1';
const SCHEMA_PREFIX = 'pfms-ds-wifi-report/';
/** Event logs plus up to 6 MB of Driver Station event files, base64'd. */
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MIN_UPLOAD_INTERVAL_MS = 10_000;
const MAX_REPORTS_PER_DAY = 500;

export interface DiagReportOptions {
  /** Directory holding ds-wifi-report.ps1, or undefined if it wasn't shipped. */
  scriptDir: string | undefined;
  /** Where reports are written. */
  reportsDir: string;
  /** The requester's address, after trusted-proxy handling. */
  clientIp: (req: IncomingMessage) => string;
  /** The team whose Driver Station last spoke from this address, if known. */
  teamForIp?: (ip: string) => number | undefined;
  now?: () => Date;
}

/** The address a laptop used to reach us, so the script it gets calls back to the same place. */
export function requestBaseUrl(req: IncomingMessage): string | null {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) ?? 'http';
  const host = first(req.headers['x-forwarded-host']) ?? first(req.headers.host);
  if (proto !== 'http' && proto !== 'https') return null;
  // Goes into a PowerShell string and a .cmd file: host names, IPv4, [IPv6] and a port only.
  if (!host || !/^[A-Za-z0-9.\-]+(:\d+)?$|^\[[0-9A-Fa-f:.]+\](:\d+)?$/.test(host)) return null;
  return `${proto}://${host}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Read a request body up to `limit` bytes; null once it goes over. */
function readLimited(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createDiagReportHandler(opts: DiagReportOptions) {
  const now = opts.now ?? (() => new Date());
  const lastUpload = new Map<string, number>();

  function script(req: IncomingMessage, res: ServerResponse): void {
    const file = opts.scriptDir ? join(opts.scriptDir, DIAG_SCRIPT_NAME) : undefined;
    if (!file || !existsSync(file)) {
      json(res, 404, { error: 'The Wi-Fi check script is not installed on this pFMS' });
      return;
    }
    const base = requestBaseUrl(req);
    let text = readFileSync(file, 'utf-8');
    // Left as the placeholder when the address can't be trusted; the script
    // then asks for -Server instead of calling somewhere odd.
    if (base) text = text.split(SERVER_PLACEHOLDER).join(base);
    // A Windows file for Windows laptops.
    text = text.replace(/\r?\n/g, '\r\n');
    const download = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').has('download');
    res.writeHead(200, {
      'Content-Type': download ? 'application/octet-stream' : 'text/plain; charset=utf-8',
      ...(download ? { 'Content-Disposition': `attachment; filename="${DOWNLOAD_NAME}"` } : {}),
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : text);
  }

  async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = opts.clientIp(req).replace(/^::ffff:/, '');
    const t = now();
    const last = lastUpload.get(ip);
    if (last !== undefined && t.getTime() - last < MIN_UPLOAD_INTERVAL_MS) {
      req.resume();
      json(res, 429, { error: 'One report every 10 seconds, please' });
      return;
    }
    const body = await readLimited(req, MAX_REPORT_BYTES);
    if (body === null) {
      json(res, 413, { error: `Report is larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB` });
      return;
    }
    let report: Record<string, unknown>;
    try {
      report = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'Report is not JSON' });
      return;
    }
    if (
      typeof report !== 'object' ||
      report === null ||
      typeof report.schema !== 'string' ||
      !report.schema.startsWith(SCHEMA_PREFIX)
    ) {
      json(res, 400, { error: `Report schema must start with ${SCHEMA_PREFIX}` });
      return;
    }

    const day = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    const dir = join(opts.reportsDir, 'wifi', day);
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length >= MAX_REPORTS_PER_DAY) {
      json(res, 429, { error: 'Too many reports today' });
      return;
    }
    lastUpload.set(ip, t.getTime());

    const ds = (report.driverStation ?? {}) as { teamNumber?: unknown };
    const computer = (report.computer ?? {}) as { name?: unknown };
    const teamFromDs = typeof ds.teamNumber === 'number' ? ds.teamNumber : undefined;
    // The address the upload came from first; failing that, the laptop's own
    // addresses. A dual-stack laptop that reached pFMS over IPv6 is known to
    // its station by its IPv4 address, which it lists in the report.
    const reported = Array.isArray(report.addresses)
      ? (report.addresses as { address?: unknown }[])
          .map(a => a?.address)
          .filter((a): a is string => typeof a === 'string')
      : [];
    let teamFromIp: number | undefined;
    let teamMatchedAddress: string | undefined;
    for (const candidate of [ip, ...reported]) {
      teamFromIp = opts.teamForIp?.(candidate);
      if (teamFromIp !== undefined) {
        teamMatchedAddress = candidate;
        break;
      }
    }
    const team = teamFromIp ?? teamFromDs;
    const safeIp = ip.replace(/[^0-9A-Za-z.]/g, '_');
    const stamp = `${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    let id = `${day}_${stamp}_team${team ?? 'unknown'}_${safeIp}`;
    for (let n = 2; existsSync(join(dir, `${id}.json`)); n++)
      id = `${day}_${stamp}_team${team ?? 'unknown'}_${safeIp}_${n}`;

    const events = (report.events ?? {}) as { wlanAutoConfig?: { id?: number }[] };
    const wlan = Array.isArray(events.wlanAutoConfig) ? events.wlanAutoConfig : [];
    const disconnects = wlan.filter(e => e?.id === 8003).length;
    const envelope = {
      id,
      receivedAt: t.toISOString(),
      sourceIp: ip,
      teamFromIp: teamFromIp ?? null,
      /** Which address found `teamFromIp`: the source, or one the laptop reported. */
      teamMatchedAddress: teamMatchedAddress ?? null,
      teamFromDriverStation: teamFromDs ?? null,
      computerName: typeof computer.name === 'string' ? computer.name : null,
      wlanDisconnects: disconnects,
      report,
    };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(envelope));
    console.log(
      `Wi-Fi report ${id}: team ${team ?? '?'} (${ip}${envelope.computerName ? `, ${envelope.computerName}` : ''}), ` +
        `${disconnects} Wi-Fi disconnects in the last ${String(report.hours ?? '?')} h`,
    );
    json(res, 200, { ok: true, id, wlanDisconnects: disconnects });
  }

  return function handleDiagRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const [path] = (req.url ?? '').split('?');
    if (!path.startsWith('/api/diag/')) return false;
    const method = req.method ?? 'GET';
    if (path === '/api/diag/wifi.ps1' && (method === 'GET' || method === 'HEAD')) script(req, res);
    else if (path === '/api/diag/wifi-report' && method === 'POST') {
      upload(req, res).catch((err: unknown) => {
        console.error('Wi-Fi report upload failed:', err);
        if (!res.headersSent) json(res, 500, { error: 'Could not store the report' });
      });
    } else json(res, 404, { error: 'Unknown diagnostics route' });
    return true;
  };
}
