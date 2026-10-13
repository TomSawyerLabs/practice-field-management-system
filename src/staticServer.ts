/**
 * Serve the built frontend and match sounds straight from the backend.
 *
 * Without this, a deployment needs Caddy or nginx in front just to hand out
 * HTML — and getting that wrong is the single most common way a new install
 * half-works: the proxy serves a stale directory so updates never appear, or
 * `/sounds/*.wav` 404s so browsers are silent while the field speaker is fine.
 * Serving them here means `bun src/index.ts` alone is a working field.
 *
 * A reverse proxy is still worth having for TLS (casting the scoreboard needs
 * a secure origin) and for the internal/external split — it just isn't
 * required to get started, and it can proxy everything to one port.
 *
 * URL mapping matches what the proxy configs do, so both paths behave the
 * same: clean URLs get `.html` appended, and a team number goes to the team
 * control page.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { normalize, resolve, sep, extname, join } from 'node:path';
import { bundledPath } from './assetRoot.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Find a bundled asset directory (repo-relative names, first that exists).
 *
 * Never via `__dirname` alone: `bun build --compile` keeps each module's
 * *build-time* `__dirname`, so a binary built here and copied elsewhere
 * would read the build machine's repo — appearing to work right up until it
 * runs on a different computer. `bundledPath` looks in the binary's
 * unpacked bundle when there is one, else the checkout.
 */
export function findAssetDir(names: string[], override?: string): string | undefined {
  const candidates = [override, ...names.map(name => bundledPath(name))].filter((c): c is string => c !== undefined);

  return candidates.find(c => existsSync(c));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Team-number URLs (`/1234`, `/1234-Bot`) are the team control page. */
const TEAM_URL = /^\/\d/;

export interface StaticServerOptions {
  /** Built frontend (`frontend/dist`). Serving is skipped if absent. */
  webRoot: string;
  /** Match audio, served at `/sounds/*` so browsers can play it. */
  soundsDir?: string;
}

function resolveWithin(root: string, urlPath: string): string | null {
  // decodeURIComponent can throw on malformed escapes — a bad URL is just a 404.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const candidate = resolve(root, '.' + normalize(decoded));
  // Containment check: `..` segments must not escape the root.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function sendFile(res: ServerResponse, filePath: string): void {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // Hashed asset filenames can cache hard; everything else must revalidate
    // or an update leaves stale HTML pointing at assets that no longer exist.
    'Cache-Control': filePath.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

/**
 * Returns a handler that serves static files, or null when there's no built
 * frontend to serve (development, where Vite handles it).
 */
export function createStaticHandler(
  opts: StaticServerOptions,
): ((req: IncomingMessage, res: ServerResponse) => boolean) | null {
  const webRoot = resolve(opts.webRoot);
  const soundsDir = opts.soundsDir ? resolve(opts.soundsDir) : null;

  if (!existsSync(webRoot)) return null;

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const urlPath = (req.url ?? '/').split('?')[0];

    // Sounds live outside the web root, so they're mapped explicitly.
    if (soundsDir && urlPath.startsWith('/sounds/')) {
      const file = resolveWithin(soundsDir, urlPath.slice('/sounds'.length));
      if (file && existsSync(file) && statSync(file).isFile()) {
        sendFile(res, file);
        return true;
      }
      return false;
    }

    const candidates: string[] = [];
    if (urlPath === '/') {
      candidates.push(join(webRoot, 'index.html'));
    } else if (TEAM_URL.test(urlPath)) {
      candidates.push(join(webRoot, 'control.html'));
    } else if (urlPath.startsWith('/matches/') || urlPath.startsWith('/practice/')) {
      // Post-match summary (/matches/<token>) and a team's practice day
      // (/practice/<token>) both live in the scores bundle
      candidates.push(join(webRoot, 'scores.html'));
    } else {
      const direct = resolveWithin(webRoot, urlPath);
      if (!direct) return false;
      candidates.push(direct);
      // Clean URLs: /admin → admin.html
      if (!extname(urlPath)) candidates.push(direct + '.html');
    }

    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        sendFile(res, candidate);
        return true;
      }
    }

    // Unknown path with no extension — the SPA's own 404 page, if it built one.
    if (!extname(urlPath)) {
      const notFound = join(webRoot, '404.html');
      if (existsSync(notFound)) {
        res.writeHead(404, { 'Content-Type': MIME['.html'] });
        createReadStream(notFound).pipe(res);
        return true;
      }
    }

    return false;
  };
}
