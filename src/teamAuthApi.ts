import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIPv4 } from 'node:net';
import { readBody } from './httpApiUtils.js';
import { MIN_TEAM_PASSWORD_LENGTH, TEAM_DEVICE_TTL_MS, type TeamAuth, type TeamDevice } from './teamAuth.js';
import { isCrossSite } from './wsAccess.js';

/**
 * HTTP side of team logins: /api/team-auth/<team>[/action].
 *
 * A login is a cookie, not page storage, because Safari wipes a site's script
 * storage after 7 days without a visit, and a team's laptop should still be
 * logged in when it comes back next season. The cookie is HttpOnly; GET hands
 * the page the token once so it can present it on its socket (which gates
 * the team's settings), the same way admin pages present theirs.
 *
 * Every visit by a logged-in device also tells the network lock where that
 * device is now (bindAddress). That is all it takes for a returning laptop to
 * reach its robot again: open any pFMS page, or browse to the robot.
 */

const COOKIE_PREFIX = 'pfms_team_';
const COOKIE_MAX_AGE_S = Math.floor(TEAM_DEVICE_TTL_MS / 1000);
const FORGOT_INTERVAL_MS = 10 * 60_000;
const ROUTE = /^\/api\/team-auth\/(\d{1,5})(?:\/(login|logout|password|lock|forgot))?$/;

export interface TeamAuthApiDeps {
  auth: TeamAuth;
  /** The client's real address (through a trusted proxy). */
  clientIp: (req: IncomingMessage) => string;
  /** IPv4 for an address seen over IPv6, if the neighbour table knows it. */
  ipv4Of?: (ip: string) => Promise<string | undefined>;
  /** On the field's own networks, not the internet. */
  isOnSite: (ip: string) => boolean;
  /** Let the firewall catch up before answering, so a page that sends the
   *  laptop on to its robot finds the way open. */
  networkSettled: () => Promise<void>;
  /** Tell admin a team forgot its password. Resolves to what was reached. */
  alertForgot: (team: number, address: string) => Promise<{ slack: boolean; push: number }>;
  now?: () => number;
}

export interface TeamAuthStatusResponse {
  team: number;
  passwordSet: boolean;
  lock: boolean;
  minLength: number;
  loggedIn: boolean;
  /** This browser, when logged in. */
  device?: TeamDevice;
  /** For the page to present on its socket. Only to a logged-in browser. */
  token?: string;
  /** Every logged-in device of the team, for a logged-in browser. */
  devices?: TeamDevice[];
  /** The address the field sees this browser at. */
  address: string;
}

function cookieName(team: number) {
  return `${COOKIE_PREFIX}${team}`;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}

function isHttps(req: IncomingMessage): boolean {
  const proto = [req.headers['x-forwarded-proto']].flat()[0];
  return proto === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;
}

function setCookie(req: IncomingMessage, team: number, token: string | null): string {
  const parts = [
    `${cookieName(team)}=${token ?? ''}`,
    'Path=/',
    `Max-Age=${token ? COOKIE_MAX_AGE_S : 0}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  // http://pfms.tsl is plain HTTP: a Secure cookie would never come back there.
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function send(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** A browser's own name for itself, shortened for the device list. */
export function deviceNameOf(userAgent: string | undefined, given?: unknown): string {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 60);
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
}

export function createTeamAuthHandler(deps: TeamAuthApiDeps) {
  const { auth } = deps;
  const now = deps.now ?? Date.now;
  const lastForgot = new Map<number, number>();

  /** Where the firewall should know this browser at: IPv4 only. */
  async function bindableAddress(ip: string): Promise<string | undefined> {
    if (isIPv4(ip)) return ip;
    return deps.ipv4Of?.(ip);
  }

  async function bind(team: number, device: TeamDevice, ip: string): Promise<void> {
    const v4 = await bindableAddress(ip);
    if (!v4) return;
    auth.bindAddress(team, device.id, v4);
    if (auth.isLocked(team)) await deps.networkSettled();
  }

  function status(team: number, ip: string, device: TeamDevice | null, token?: string): TeamAuthStatusResponse {
    const s = auth.status(team);
    return {
      team,
      passwordSet: s.passwordSet,
      lock: s.lock,
      minLength: MIN_TEAM_PASSWORD_LENGTH,
      loggedIn: !!device,
      device: device ?? undefined,
      token: device ? token : undefined,
      devices: device ? auth.listDevices(team) : undefined,
      address: ip,
    };
  }

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const match = ROUTE.exec((req.url ?? '').split('?')[0]);
    if (!match) return false;
    const team = Number(match[1]);
    const action = match[2];

    void (async () => {
      const ip = deps.clientIp(req);
      if (!deps.isOnSite(ip)) return send(res, 403, { error: 'Team logins only work at the field' });
      if (team < 1) return send(res, 404, { error: 'No such team' });

      const token = readCookie(req, cookieName(team));
      const device = auth.validate(team, token);

      if (!action) {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
        if (device) await bind(team, device, ip);
        // Each visit starts the cookie's year again, as it does the device's.
        return send(res, 200, status(team, ip, device, token), device ? setCookie(req, team, token!) : undefined);
      }

      // Everything else changes something: a form on another site mustn't
      // be able to do it with this browser's cookie.
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      if (isCrossSite(req.headers) || !/^application\/json/.test(req.headers['content-type'] ?? '')) {
        return send(res, 403, { error: 'Refused' });
      }
      const input = await body(req);
      const name = deviceNameOf(req.headers['user-agent'], input.name);

      switch (action) {
        case 'login': {
          if (typeof input.password !== 'string') return send(res, 400, { error: 'Enter the password' });
          const r = await auth.login(team, input.password, name, ip);
          if (!r.ok) {
            const error =
              r.reason === 'busy'
                ? `Too many tries. Wait ${Math.ceil((r.retryAfterMs ?? 60_000) / 1000)} s and try again.`
                : r.reason === 'noPassword'
                  ? `Team ${team} has no password`
                  : 'Wrong password';
            return send(res, r.reason === 'busy' ? 429 : 401, { error, retryAfterMs: r.retryAfterMs });
          }
          await bind(team, r.device, ip);
          return send(res, 200, status(team, ip, r.device, r.token), setCookie(req, team, r.token));
        }

        case 'password': {
          if (typeof input.password !== 'string' || input.password.length < MIN_TEAM_PASSWORD_LENGTH) {
            return send(res, 400, { error: `Use at least ${MIN_TEAM_PASSWORD_LENGTH} characters` });
          }
          // First one: whoever is on the team's page, as with the field's
          // own admin passphrase. After that, only the team.
          if (auth.hasPassword(team) && !device) return send(res, 401, { error: 'Log in first' });
          const r = await auth.setPassword(team, input.password, { keepDeviceId: device?.id, deviceName: name });
          if (!r) return send(res, 400, { error: 'Could not set that password' });
          if ('token' in r) {
            await bind(team, r.device, ip);
            return send(res, 200, status(team, ip, r.device, r.token), setCookie(req, team, r.token));
          }
          return send(res, 200, status(team, ip, r.kept, token));
        }

        case 'logout': {
          if (!device) return send(res, 200, status(team, ip, null), setCookie(req, team, null));
          const which = typeof input.deviceId === 'string' ? input.deviceId : device.id;
          auth.removeDevice(team, which);
          if (which === device.id) return send(res, 200, status(team, ip, null), setCookie(req, team, null));
          return send(res, 200, status(team, ip, device, token));
        }

        case 'lock': {
          if (!device) return send(res, 401, { error: 'Log in first' });
          if (typeof input.lock !== 'boolean') return send(res, 400, { error: 'lock must be true or false' });
          // Turning it on must never lock out the browser that did it.
          await bind(team, device, ip);
          auth.setLock(team, input.lock);
          await deps.networkSettled();
          return send(res, 200, status(team, ip, device, token));
        }

        case 'forgot': {
          if (!auth.hasPassword(team)) return send(res, 400, { error: `Team ${team} has no password` });
          const last = lastForgot.get(team) ?? 0;
          if (now() - last < FORGOT_INTERVAL_MS) {
            return send(res, 200, { ok: true, already: true });
          }
          lastForgot.set(team, now());
          const reached = await deps.alertForgot(team, ip);
          return send(res, 200, { ok: true, ...reached });
        }
      }
    })().catch(err => {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    });
    return true;
  };
}

/** The team a robot address or name belongs to: `10.TE.AM.x`, or a
 *  `roboRIO-1234-FRC.local`-style name. */
export function teamOfHost(host: string | undefined): number | undefined {
  const name = (host ?? '').replace(/:\d+$/, '').toLowerCase();
  const ip = /^10\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(name);
  if (ip) return Number(ip[1]) * 100 + Number(ip[2]) || undefined;
  const named = /^(?:roborio|systemcore)-(\d{1,5})-/.exec(name);
  return named ? Number(named[1]) || undefined : undefined;
}

/**
 * The login portal: a locked team's firewall sends plain HTTP aimed at its
 * robots here (REDIRECT). Every answer is a redirect to the login page, which
 * sends the browser back to where it was going once it is let through.
 * Never cached: the same URL works once the laptop is logged in.
 */
export function createLockPortal(opts: { loginBase: (req: IncomingMessage) => string }): Server {
  return createServer((req, res) => {
    const host = req.headers.host ?? '';
    const team = teamOfHost(host);
    const back = host ? `http://${host}${req.url ?? '/'}` : '';
    const query = new URLSearchParams();
    if (team) query.set('team', String(team));
    if (back) query.set('return', back);
    res.writeHead(302, {
      Location: `${opts.loginBase(req)}/login?${query}`,
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    res.end();
  });
}
