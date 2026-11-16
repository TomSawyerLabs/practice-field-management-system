import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamAuth } from './teamAuth.js';
import { createLockPortal, createTeamAuthHandler, deviceNameOf, teamOfHost } from './teamAuthApi.js';

const dir = mkdtempSync(join(tmpdir(), 'pfms-team-auth-api-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('team login API', () => {
  let auth: TeamAuth;
  let server: Server;
  let base: string;
  let clientIp = '192.168.3.10';
  let alerts: { team: number; address: string }[] = [];
  let settled = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!handler(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  let handler: ReturnType<typeof createTeamAuthHandler>;
  beforeEach(() => {
    auth = new TeamAuth(join(dir, `${Math.random()}.json`));
    clientIp = '192.168.3.10';
    alerts = [];
    settled = 0;
    handler = createTeamAuthHandler({
      auth,
      clientIp: () => clientIp,
      isOnSite: ip => ip.startsWith('192.168.'),
      networkSettled: async () => {
        settled++;
      },
      alertForgot: async (team, address) => {
        alerts.push({ team, address });
        return { slack: true, push: 1 };
      },
    });
  });

  const post = (path: string, body: object, cookie?: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0];

  test('a team with no password says so', async () => {
    const res = await get('/api/team-auth/1234');
    expect(await res.json()).toMatchObject({ team: 1234, passwordSet: false, loggedIn: false, address: clientIp });
  });

  test('setting the first password logs this browser in with a year-long cookie', async () => {
    const res = await post('/api/team-auth/1234/password', { password: 'gearbox42!' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('pfms_team_1234=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=31536000');
    expect(setCookie).not.toContain('Secure'); // plain-HTTP field address
    const body = await res.json();
    expect(body).toMatchObject({ passwordSet: true, loggedIn: true });
    expect(typeof body.token).toBe('string');

    const again = await get('/api/team-auth/1234', cookieOf(res));
    expect(await again.json()).toMatchObject({ loggedIn: true, devices: [expect.anything()] });
    // The visit binds the address the field sees it at.
    expect(auth.allowedAddresses(1234)).toEqual([clientIp]);
  });

  test("changing a password, or the lock, takes the team's login", async () => {
    await auth.setPassword(1234, 'gearbox42!');
    expect((await post('/api/team-auth/1234/password', { password: 'something-else' })).status).toBe(401);
    expect((await post('/api/team-auth/1234/lock', { lock: true })).status).toBe(401);
    expect(auth.isLocked(1234)).toBe(false);
  });

  test('logging in, locking, and logging out', async () => {
    await auth.setPassword(1234, 'gearbox42!');
    expect((await post('/api/team-auth/1234/login', { password: 'nope-nope' })).status).toBe(401);

    const login = await post('/api/team-auth/1234/login', { password: 'gearbox42!' });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login)!;

    const locked = await post('/api/team-auth/1234/lock', { lock: true }, cookie);
    expect(await locked.json()).toMatchObject({ lock: true });
    expect(settled).toBeGreaterThan(0);
    expect(auth.allowedAddresses(1234)).toEqual([clientIp]);

    const out = await post('/api/team-auth/1234/logout', {}, cookie);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await out.json()).toMatchObject({ loggedIn: false });
    expect(auth.allowedAddresses(1234)).toEqual([]);
  });

  test('a form on another site, or a non-JSON post, is refused', async () => {
    await auth.setPassword(1234, 'gearbox42!');
    const cross = await post('/api/team-auth/1234/login', { password: 'gearbox42!' }, undefined, {
      origin: 'http://evil.example',
      host: 'pfms.tsl',
    });
    expect(cross.status).toBe(403);
    const form = await fetch(`${base}/api/team-auth/1234/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=gearbox42!',
    });
    expect(form.status).toBe(403);
  });

  test('from the internet, nothing works', async () => {
    clientIp = '203.0.113.9';
    expect((await get('/api/team-auth/1234')).status).toBe(403);
  });

  test('forgot password tells admin once per ten minutes', async () => {
    await auth.setPassword(1234, 'gearbox42!');
    expect(await (await post('/api/team-auth/1234/forgot', {})).json()).toEqual({ ok: true, slack: true, push: 1 });
    expect(await (await post('/api/team-auth/1234/forgot', {})).json()).toEqual({ ok: true, already: true });
    expect(alerts).toEqual([{ team: 1234, address: clientIp }]);
  });

  test('unrelated URLs are left for other handlers', async () => {
    expect((await get('/api/team-auth/1234/nope')).status).toBe(404);
    expect((await get('/api/other')).status).toBe(404);
  });
});

describe('the login portal', () => {
  let portal: Server;
  let port: number;
  beforeAll(async () => {
    portal = createLockPortal({ loginBase: () => 'http://pfms.tsl' });
    await new Promise<void>(r => portal.listen(0, '127.0.0.1', r));
    port = (portal.address() as AddressInfo).port;
  });
  afterAll(() => portal.close());

  test('sends any robot URL to the login page and back, uncached', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard?x=1`, {
      headers: { host: '10.12.34.2:5800' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('http://pfms.tsl/login');
    expect(location.searchParams.get('team')).toBe('1234');
    expect(location.searchParams.get('return')).toBe('http://10.12.34.2:5800/dashboard?x=1');
  });
});

describe('helpers', () => {
  test('teamOfHost reads robot addresses and names', () => {
    expect(teamOfHost('10.12.34.2')).toBe(1234);
    expect(teamOfHost('10.0.5.2:80')).toBe(5);
    expect(teamOfHost('roboRIO-1678-FRC.local')).toBe(1678);
    expect(teamOfHost('systemcore-254-frc.local')).toBe(254);
    expect(teamOfHost('example.com')).toBeUndefined();
    expect(teamOfHost(undefined)).toBeUndefined();
  });

  test('deviceNameOf names the browser', () => {
    expect(
      deviceNameOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML) Chrome/130.0 Safari/537.36'),
    ).toBe('Chrome on Windows');
    expect(deviceNameOf('anything', ' Drive laptop ')).toBe('Drive laptop');
  });
});
