import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import CIDRMatcher from 'cidr-matcher';
import { handleFirmwareRequest } from './firmwareApi.js';
import type { FirmwareStore } from './firmwareStore.js';
import { OnLinkChecker } from './onLink.js';
import { createStaffHttpCheck } from './staffHttp.js';

const CHECKSUM = 'ab'.repeat(32);
const UPLOAD = `/api/firmware/upload?checksum=${CHECKSUM}&version=2.0.2&upgradeFrom=from12x`;
const FIELD_IP = '10.55.65.20';
const DS_IP = '10.16.78.5';
const INTERNET_IP = '203.0.113.7';

describe('the firmware API', () => {
  let server: Server;
  let base: string;
  let added: { version: string; bytes: number }[] = [];
  let downloads = 0;
  let codeSet = false;

  const store = {
    getEntries: () => [],
    addManualFirmware: (data: Buffer, _checksum: string, version: string) => {
      added.push({ version, bytes: data.length });
      return { version };
    },
    startBackgroundDownloads: () => downloads++,
  } as unknown as FirmwareStore;

  const access = createStaffHttpCheck({
    adminAuth: { validateToken: token => token === 'admin-token' },
    operatorAuth: {
      isRequired: () => codeSet,
      validateToken: token =>
        token === 'operator-token' ? { id: 'a', name: 'CSA', via: 'code', createdAt: 0, lastSeenAt: 0 } : null,
    },
    externalAccessStore: { isValid: token => token === 'good-cookie' },
    siteNetworks: new OnLinkChecker(60_000, () => ({})),
    trustedProxyMatcher: new CIDRMatcher(['127.0.0.0/8', '::ffff:127.0.0.0/104', '::1/128']),
    isDriverStation: ip => ip === DS_IP,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (handleFirmwareRequest(req, res, store, access)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    added = [];
    downloads = 0;
    codeSet = false;
  });

  const post = (path: string, ip: string, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'x-forwarded-for': ip, ...headers },
    });

  describe('with no operator code', () => {
    test('/test uploads with no login', async () => {
      const res = await post(UPLOAD, FIELD_IP, { origin: 'http://pfms.tsl', host: 'pfms.tsl' });
      expect(res.status).toBe(200);
      expect(added).toEqual([{ version: '2.0.2', bytes: 3 }]);
    });

    test('a tool on site can start the downloads', async () => {
      expect((await post('/api/firmware/download', FIELD_IP)).status).toBe(202);
      expect(downloads).toBe(1);
    });

    test('a Driver Station is refused, as for the staff messages', async () => {
      expect((await post(UPLOAD, DS_IP)).status).toBe(403);
      expect(added).toEqual([]);
    });

    test('an admin login overrides the Driver Station guard', async () => {
      expect((await post(UPLOAD, DS_IP, { 'x-pfms-admin-token': 'admin-token' })).status).toBe(200);
    });
  });

  describe('with an operator code', () => {
    beforeEach(() => {
      codeSet = true;
    });

    test('nothing is written with no login', async () => {
      expect((await post(UPLOAD, FIELD_IP)).status).toBe(401);
      expect((await post('/api/firmware/download', FIELD_IP)).status).toBe(401);
      expect(added).toEqual([]);
      expect(downloads).toBe(0);
    });

    test('a stale token is no login', async () => {
      expect((await post(UPLOAD, FIELD_IP, { 'x-pfms-operator-token': 'old' })).status).toBe(401);
      expect((await post(UPLOAD, FIELD_IP, { 'x-pfms-admin-token': 'old' })).status).toBe(401);
    });

    test('an operator or an admin login works', async () => {
      expect((await post(UPLOAD, FIELD_IP, { 'x-pfms-operator-token': 'operator-token' })).status).toBe(200);
      expect((await post(UPLOAD, FIELD_IP, { 'x-pfms-admin-token': 'admin-token' })).status).toBe(200);
    });

    test('an operator login does not override the Driver Station guard', async () => {
      expect((await post(UPLOAD, DS_IP, { 'x-pfms-operator-token': 'operator-token' })).status).toBe(403);
    });
  });

  describe('from another site', () => {
    // A plain POST goes out whatever CORS says: the guard has to be here.
    test('a page on another site is refused, even with a token', async () => {
      const origin = { origin: 'https://evil.example' };
      expect((await post(UPLOAD, FIELD_IP, origin)).status).toBe(403);
      expect((await post(UPLOAD, FIELD_IP, { ...origin, 'x-pfms-admin-token': 'admin-token' })).status).toBe(403);
      expect((await post('/api/firmware/download', FIELD_IP, origin)).status).toBe(403);
      expect(added).toEqual([]);
      expect(downloads).toBe(0);
    });

    test('nothing allows a browser to read a reply or send a token', async () => {
      const paths = ['/api/firmware', UPLOAD];
      for (const path of paths) {
        const preflight = await fetch(base + path, {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        });
        expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
        expect(preflight.headers.get('access-control-allow-headers')).toBeNull();
        const res = await fetch(base + path, { headers: { 'x-forwarded-for': FIELD_IP } });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
      }
    });
  });

  describe('off site', () => {
    test('nothing is read or written with no credential', async () => {
      expect((await post(UPLOAD, INTERNET_IP)).status).toBe(403);
      const list = await fetch(`${base}/api/firmware`, { headers: { 'x-forwarded-for': INTERNET_IP } });
      expect(list.status).toBe(403);
      expect(added).toEqual([]);
    });

    test('a forged address on the left does not help', async () => {
      expect((await post(UPLOAD, `${FIELD_IP}, ${INTERNET_IP}`)).status).toBe(403);
    });

    test('a made-up cookie is no credential', async () => {
      expect((await post(UPLOAD, INTERNET_IP, { cookie: 'pfms_access=made-up' })).status).toBe(403);
    });

    test('the access cookie counts as on site, as on the WebSocket', async () => {
      expect((await post(UPLOAD, INTERNET_IP, { cookie: 'pfms_access=good-cookie' })).status).toBe(200);
      codeSet = true;
      expect((await post(UPLOAD, INTERNET_IP, { cookie: 'pfms_access=good-cookie' })).status).toBe(401);
    });

    test('a login counts', async () => {
      expect((await post(UPLOAD, INTERNET_IP, { 'x-pfms-operator-token': 'operator-token' })).status).toBe(200);
    });
  });

  describe('what an upload may say', () => {
    test.each([
      ['a path in the version', `checksum=${CHECKSUM}&version=..%2F..%2Fetc%2Fx&upgradeFrom=from12x`],
      ['a Windows path in the version', `checksum=${CHECKSUM}&version=..%5C..%5Cx&upgradeFrom=from12x`],
      ['a version that starts with a dot', `checksum=${CHECKSUM}&version=.hidden&upgradeFrom=from12x`],
      ['a checksum that is not a SHA-256', 'checksum=abc&version=2.0.2&upgradeFrom=from12x'],
      ['an unknown radio type', `checksum=${CHECKSUM}&version=2.0.2&upgradeFrom=other`],
    ])('%s is refused', async (_, query) => {
      expect((await post(`/api/firmware/upload?${query}`, FIELD_IP)).status).toBe(400);
      expect(added).toEqual([]);
    });

    test('an empty file is refused', async () => {
      const res = await fetch(base + UPLOAD, { method: 'POST', headers: { 'x-forwarded-for': FIELD_IP } });
      expect(res.status).toBe(400);
      expect(added).toEqual([]);
    });
  });

  test('other paths are left alone', async () => {
    expect((await fetch(`${base}/api/firmwarex`)).status).toBe(404);
  });
});
