import { IncomingMessage, ServerResponse } from 'http';
import type CIDRMatcher from 'cidr-matcher';
import type { ExternalAccessStore } from './externalAccessStore.js';
import type { OnLinkChecker } from './onLink.js';
import { getRealClientIp } from './utils.js';

export interface ExternalAccessAuthOptions {
  /** Which peers may vouch for a client address via X-Forwarded-For (the reverse proxy). */
  trustedProxyMatcher?: CIDRMatcher;
  /** Answers "is this address on one of this host's own networks?" */
  onLink?: OnLinkChecker;
}

const COOKIE_NAME = 'pfms_access';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 365 days in seconds

/** Parse a named cookie value from a Cookie header string. */
function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function buildCookie(token: string): string {
  return [`${COOKIE_NAME}=${token}`, 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'HttpOnly', 'Secure', 'SameSite=Lax'].join(
    '; ',
  );
}

/**
 * HTTP handler for external access authentication.
 *
 * Two endpoints:
 *
 * GET /admin/auth/<token>
 *   Validates the URL token against the ExternalAccessStore, sets an HttpOnly
 *   cookie (365 days), and redirects to /. Share this URL with trusted users
 *   to grant them access from outside the local network.
 *
 * GET /api/auth/check
 *   Used by the reverse proxy to gate anyone it does not already treat as
 *   local. Returns 200 when the pfms_access cookie is valid (plus a Set-Cookie
 *   that rolls the expiry forward), or when the client's address is on one of
 *   this host's own networks (see onLink.ts — this is how devices on the
 *   field network that arrive over IPv6 get the internal UI). 401 otherwise.
 *
 *   The client address comes from X-Forwarded-For only when the socket peer
 *   is a trusted proxy; the proxy in turn replaces any X-Forwarded-For a
 *   client sent unless it came from its own trusted upstream. A stranger
 *   cannot claim an on-link address.
 */
export function handleExternalAccessAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: ExternalAccessStore,
  options: ExternalAccessAuthOptions = {},
): boolean {
  const url = req.url;
  if (!url) return false;

  // ── Token auth endpoint: validate token and set cookie ───────────────
  if (url.startsWith('/admin/auth/')) {
    const providedToken = decodeURIComponent(url.slice('/admin/auth/'.length).split('?')[0]);

    if (!store.validateToken(providedToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return true;
    }

    res.writeHead(302, {
      'Set-Cookie': buildCookie(providedToken),
      Location: '/',
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  // ── Cookie validation endpoint (Caddy forward_auth) ──────────────────
  if (url === '/api/auth/check' || url.startsWith('/api/auth/check?')) {
    const cookieValue = getCookieValue(req.headers.cookie, COOKIE_NAME);

    if (cookieValue && store.validateToken(cookieValue)) {
      // Refresh the cookie — Caddy relays this Set-Cookie to the client via
      // handle_response, so the 365-day expiration rolls forward on every page load.
      res.writeHead(200, { 'Set-Cookie': buildCookie(cookieValue), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    if (options.onLink) {
      const clientIp = getRealClientIp(req.socket.remoteAddress, req.headers, options.trustedProxyMatcher);
      if (options.onLink.isOnLink(clientIp)) {
        noteOnLinkGrant(clientIp);
        res.writeHead(200, { 'X-Pfms-Access': 'on-link', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
    }

    res.writeHead(401, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  return false;
}

// One log line per address, so the journal shows which devices needed the
// on-link rule (the proxy handles private IPv4 itself, so in practice: IPv6).
const onLinkGrantsLogged = new Set<string>();
function noteOnLinkGrant(ip: string) {
  if (onLinkGrantsLogged.has(ip)) return;
  if (onLinkGrantsLogged.size >= 1000) onLinkGrantsLogged.clear();
  onLinkGrantsLogged.add(ip);
  console.log(`External access: ${ip} is on one of our own networks — serving the internal UI without a cookie`);
}
