import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import CIDRMatcher from 'cidr-matcher';
import { WebSocket } from 'ws';
import { AdminAuth } from './adminAuth.js';
import { ExternalAccessStore } from './externalAccessStore.js';
import { LoginLimiter } from './loginLimiter.js';
import { OperatorAuth } from './operatorAuth.js';
import type { HostnameResolver } from './hostnameResolver.js';
import type { MatchEngine } from './matchEngine.js';
import type RadioManager from './radioManager.js';
import { setupWebSocket, type WebSocketContext } from './websocketServer.js';
import { accessOf, dsClientMatch, isCrossSite, isOpenToOutsiders, messageTypes } from './wsAccess.js';

const SRC = __dirname;
const FRONTEND = join(SRC, '..', 'frontend', 'src');

describe('dsClientMatch', () => {
  const connected = { slot2: { ip: '10.16.78.5' } };

  test('an address match is certain', () => {
    expect(dsClientMatch('10.16.78.5', connected, {})).toEqual({ station: 'slot2', by: 'ip' });
  });

  test("a laptop's other interface matches on hostname, whatever the case", () => {
    const hostnames = { '10.16.78.5': 'TEAM1678-DS', '10.55.65.9': 'team1678-ds' };
    expect(dsClientMatch('10.55.65.9', connected, hostnames)).toEqual({ station: 'slot2', by: 'hostname' });
  });

  test('an address beats a hostname on another station', () => {
    const both = { slot1: { ip: '10.1.1.5' }, slot2: { ip: '10.2.2.5' } };
    const hostnames = { '10.1.1.5': 'ds', '10.2.2.5': 'ds' };
    expect(dsClientMatch('10.2.2.5', both, hostnames)).toEqual({ station: 'slot2', by: 'ip' });
  });

  test('other devices do not match, nor do unnamed ones', () => {
    expect(dsClientMatch('10.55.65.9', connected, { '10.55.65.9': 'phone' })).toBeNull();
    expect(dsClientMatch('10.55.65.9', connected, {})).toBeNull();
    expect(dsClientMatch('unknown', connected, {})).toBeNull();
  });
});

describe('isCrossSite', () => {
  test('a tool with no Origin is judged on its address', () => {
    expect(isCrossSite({ host: 'pfms.tsl' })).toBe(false);
  });

  test("the field's own names, by any port or case", () => {
    expect(isCrossSite({ origin: 'http://pfms.tsl', host: 'pfms.tsl' })).toBe(false);
    expect(isCrossSite({ origin: 'http://PFMS.tsl:8080', host: 'pfms.tsl:9005' })).toBe(false);
    expect(isCrossSite({ origin: 'https://pfms.tomsawyerlabs.com', host: 'pfms.tomsawyerlabs.com' })).toBe(false);
    expect(isCrossSite({ origin: 'http://[::1]:5173', host: '[::1]:9005' })).toBe(false);
  });

  test('a proxy that rewrites Host', () => {
    const headers = { origin: 'http://pfms.tsl', host: 'localhost:9005' };
    expect(isCrossSite(headers)).toBe(true);
    expect(isCrossSite({ ...headers, 'x-forwarded-host': 'pfms.tsl' })).toBe(false);
    expect(isCrossSite({ ...headers, 'x-forwarded-host': 'pfms.tsl, other' })).toBe(false);
  });

  test('anything else', () => {
    expect(isCrossSite({ origin: 'https://evil.example', host: 'pfms.tsl' })).toBe(true);
    expect(isCrossSite({ origin: 'https://pfms.tsl.evil.example', host: 'pfms.tsl' })).toBe(true);
    expect(isCrossSite({ origin: 'null', host: 'pfms.tsl' })).toBe(true);
    expect(isCrossSite({ origin: 'http://pfms.tsl' })).toBe(true);
  });
});

describe('the access table', () => {
  test('a message nobody classified is refused', () => {
    expect(accessOf('somethingNew')).toBe('adminOnly');
    expect(accessOf(undefined)).toBe('adminOnly');
    expect(accessOf('constructor')).toBe('adminOnly');
  });

  test('every message the server handles has been classified', () => {
    const server = readFileSync(join(SRC, 'websocketServer.ts'), 'utf8');
    const types = readFileSync(join(SRC, 'types.ts'), 'utf8');
    const guards = new Set([...server.matchAll(/\bis[A-Z]\w+(?=\(data\b)/g)].map(m => m[0]));
    guards.delete('isScoreboardView'); // a field of castReceiverRegister
    expect(guards.size).toBeGreaterThan(100);
    // Guards name their type as a quoted literal, or as `case` labels.
    const unclassified: string[] = [];
    for (const guard of guards) {
      const start = types.indexOf(`export function ${guard}(`);
      const body = types.slice(start, types.indexOf('\n}\n', start));
      const literals = [...body.matchAll(/(?:(?:type|\.type) (?:!==|===) |case |in )'(\w+)'/g)].map(m => m[1]);
      expect(literals.length, guard).toBeGreaterThan(0);
      for (const type of literals) {
        if (accessOf(type) === 'adminOnly' && !ADMIN_ONLY.has(type)) unclassified.push(`${guard}: ${type}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  /** The ones that really are `adminOnly`, to tell them from unclassified. */
  const ADMIN_ONLY = new Set([
    'saveSlackConfig',
    'operatorSetCode',
    'operatorRevokeDevice',
    'createExternalAccessToken',
    'revokeExternalAccessToken',
    'saveAudioDeviceConfig',
    'testAudioDevice',
    'refreshAudioDevices',
    'clearMatchHistory',
    'deleteRecording',
    'deleteRecordingsBefore',
    'captureTimelapseFrame',
    'renderTimelapse',
    'testTimelapseLights',
    'deleteTimelapseRender',
  ]);
});

/** Every `useBackend` export a page's code imports, following relative imports. */
function backendImports(root: string): Set<string> {
  const seen = new Set<string>();
  const names = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, imported, path] of source.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+'(\.[^']+)'/g)) {
      const target = resolve(dirname(file), path.replace(/\.js$/, ''));
      if (target.endsWith(join('hooks', 'useBackend'))) {
        for (const m of imported.matchAll(/\b\w+\b/g)) names.add(m[0]);
        continue;
      }
      if (!target.startsWith(FRONTEND)) continue;
      const found = ['.tsx', '.ts'].map(ext => target + ext).find(existsSync);
      if (found) walk(found);
    }
  };
  walk(root);
  return names;
}

/** What each `useBackend` export sends, by the `type:` literals in its body. */
function sentByExport(): Map<string, string[]> {
  const source = readFileSync(join(FRONTEND, 'hooks', 'useBackend.ts'), 'utf8');
  const parts = source.split(/^export (?:async )?function /m).slice(1);
  return new Map(
    parts.map(part => [part.match(/^\w+/)![0], [...part.split(/^}/m)[0].matchAll(/\btype: '(\w+)'/g)].map(m => m[1])]),
  );
}

describe('pages with no login', () => {
  const sent = sentByExport();
  const sends = (root: string) =>
    [...backendImports(join(FRONTEND, 'roots', root))].flatMap(name => sent.get(name) ?? []);

  test('the walk really finds what a team page sends', () => {
    expect(sends('control.tsx')).toEqual(expect.arrayContaining(['stationReady', 'portBridge', 'drive']));
  });

  // Imported along the way, but in parts these pages never render. A new entry
  // here should be a surprise.
  const importedNotRendered = new Set([
    'updateMatchConfig', // MatchTimeline's editor: these pages pass `progress` or `readOnly`
    'applyConfig', // PendingRadioChangesPanel: these pages use only that file's text helpers
    'cancelPendingChange', // the same panel
  ]);
  const gated = (root: string) => [
    ...new Set(sends(root).filter(t => accessOf(t) !== 'anyone' && !importedNotRendered.has(t))),
  ];

  test('a team page, which a Driver Station runs, sends nothing gated', () => {
    expect(gated('control.tsx')).toEqual([]);
  });

  test('the scoreboard sends nothing gated', () => {
    expect(gated('scores.tsx')).toEqual([]);
  });

  test('what any page sends on connecting is open from the internet', () => {
    const source = readFileSync(join(FRONTEND, 'hooks', 'useBackend.ts'), 'utf8');
    const onOpen = source.slice(source.indexOf('nws.onopen'), source.indexOf('nws.onerror'));
    const types = [...onOpen.matchAll(/\btype: '(\w+)'/g)].map(m => m[1]);
    expect(types.length).toBeGreaterThan(2);
    expect(types.filter(t => !isOpenToOutsiders(t))).toEqual([]);
  });

  test('the public match pages send nothing over the socket', () => {
    // The walk reaches MatchVideoCard, but formatBytes is all they take from it.
    for (const page of ['MatchSummaryPage', 'PracticeDayPage']) {
      const source = readFileSync(join(FRONTEND, 'components', `${page}.tsx`), 'utf8');
      expect(source).toContain("import { formatBytes } from './MatchVideoCard';");
      expect(source).not.toContain('useBackend');
    }
  });

  test('the login page sends only what a visitor keeps, but for claiming the field', () => {
    const names = backendImports(join(FRONTEND, 'components', 'AdminAuthGate.tsx'));
    const types = [...names].flatMap(name => sent.get(name) ?? []);
    expect(types.filter(t => !isOpenToOutsiders(t))).toEqual(['adminSetPassphrase']);
  });
});

// Tests log in over and over; the real cost has its own test in adminAuth.test.ts.
const CHEAP_HASH = { N: 2 ** 10, r: 8, p: 1 };

// A stand-in server: no radio, no Driver Station packets, nothing leaves this
// process. The stubs record what reached them.
describe('the WebSocket gate', () => {
  const DS_IP = '10.16.78.5';
  const SAME_NAME_IP = '10.55.65.9';
  const STAFF_IP = '10.55.65.20';

  const authDir = mkdtempSync(join(tmpdir(), 'pfms-ws-access-'));
  let adminAuth = new AdminAuth(join(authDir, 'unused.json'), CHEAP_HASH);
  let operatorAuth = new OperatorAuth(join(authDir, 'unused-operator.json'));
  const externalAccess = new ExternalAccessStore(join(authDir, 'external-access.json'));
  let adminLogins = new LoginLimiter();
  let context: WebSocketContext;
  let url: string;
  /** The server's own heartbeat, to fire instead of waiting 10 s for it. */
  let heartbeat: () => void;
  let engineCalls: string[] = [];
  const open: WebSocket[] = [];

  const stateListeners: ((state: unknown) => void)[] = [];
  let connectedStations: Record<string, { ip: string; lastSeen: number }> = {};
  const hostnames: Record<string, string> = {};

  const engineState = () => ({ type: 'matchState', connectedStations });
  const matchEngine = new Proxy(
    {
      getState: engineState,
      addStateListener: (fn: (state: unknown) => void) => stateListeners.push(fn),
      isMatchActive: () => false,
    } as Record<string | symbol, unknown>,
    {
      get: (target, key) =>
        target[key] ??
        ((...args: unknown[]) => {
          engineCalls.push(String(key));
          void args;
        }),
    },
  ) as unknown as MatchEngine;

  const radioManager = {
    addStatusListener() {},
    addPendingCommitListener() {},
    addLastLinkedListener() {},
    getStatusHistory: () => [],
    getPendingState: () => ({}),
    getLastLinkedTimestamps: () => ({}),
    getTeamForStation: () => null,
    getStationConfig: () => undefined,
    applyPendingChanges: async () => {},
    cancelPendingChange() {},
  } as unknown as RadioManager;

  const hostnameResolver = {
    getState: () => ({ type: 'hostnames', hostnames }),
    track() {},
  } as unknown as HostnameResolver;

  beforeAll(async () => {
    const timers = spyOn(globalThis, 'setInterval');
    context = setupWebSocket({
      radioManager,
      matchEngine,
      port: 0,
      trustedProxyMatcher: new CIDRMatcher(['127.0.0.0/8', '::ffff:127.0.0.0/104', '::1/128']),
      // Read once at startup, so this forwards to whichever the test set up.
      adminAuth: {
        isConfigured: () => adminAuth.isConfigured(),
        login: (passphrase: string) => adminAuth.login(passphrase),
        validateToken: (token: string) => adminAuth.validateToken(token),
        setPassphrase: (passphrase: string, force?: boolean) => adminAuth.setPassphrase(passphrase, force),
      } as AdminAuth,
      operatorAuth: new Proxy({} as OperatorAuth, {
        get: (_, key: keyof OperatorAuth) => {
          const member = operatorAuth[key];
          return typeof member === 'function' ? member.bind(operatorAuth) : member;
        },
      }),
      externalAccessStore: externalAccess,
      strangerAdminLogins: {
        take: (address: string) => adminLogins.take(address),
        clear: (address: string) => adminLogins.clear(address),
      } as LoginLimiter,
      hostnameResolver,
    });
    heartbeat = timers.mock.calls.find(([, ms]) => ms === 10_000)![0] as () => void;
    timers.mockRestore();
    if (!context.server.listening) await new Promise(r => context.server.once('listening', r));
    url = `ws://127.0.0.1:${(context.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(() => {
    for (const ws of open) ws.terminate();
    context.server.close();
    rmSync(authDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    engineCalls = [];
    connectedStations = { slot2: { ip: DS_IP, lastSeen: Date.now() } };
    Object.assign(hostnames, { [DS_IP]: 'TEAM1678-DS', [SAME_NAME_IP]: 'team1678-ds' });
    adminAuth = new AdminAuth(join(authDir, 'unused.json'), CHEAP_HASH);
    operatorAuth = new OperatorAuth(join(authDir, `operator-${Math.random()}.json`));
    adminLogins = new LoginLimiter();
  });

  type Reply = {
    type?: string;
    error?: string;
    station?: string | null;
    by?: string;
    required?: boolean;
    authenticated?: boolean;
    token?: string;
    tokenRejected?: boolean;
    retryAfterMs?: number;
    secret?: string;
    devices?: { id: string; name: string }[];
  };

  async function client(ip: string, headers: Record<string, string> = {}) {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': ip, ...headers } });
    open.push(ws);
    const replies: Reply[] = [];
    ws.on('message', raw => {
      const parsed = JSON.parse(String(raw));
      // The heartbeat keeps its own time, so it is never an answer: on a slow
      // machine it can land inside any `send`.
      if (!Array.isArray(parsed) && parsed.type !== 'serverInfo') replies.push(parsed);
    });
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    /** Wait for the server to have answered everything sent so far (it answers
     *  messages in order, and every socket gets an answer to a bad one). */
    const settled = async (before: number) => {
      ws.send('not json');
      while (!replies.slice(before).some(r => r.error === 'Invalid JSON')) await Bun.sleep(2);
    };
    // The connection's opening burst must not land among a test's replies.
    await settled(0);
    const send = async (msg: object) => {
      const before = replies.length;
      ws.send(JSON.stringify(msg));
      await settled(before);
      return replies.slice(before).filter(r => r.error !== 'Invalid JSON');
    };
    const dsState = () => replies.filter(r => r.type === 'dsClientState').at(-1);
    const operatorState = () => replies.filter(r => r.type === 'operatorAuthResult').at(-1);
    /** The code check is slow on purpose, so a login answers later than `send`. */
    const login = async (code: string) => {
      const before = replies.length;
      ws.send(JSON.stringify({ type: 'operatorLogin', code, name: 'Test phone' }));
      while (!replies.slice(before).some(r => r.type === 'operatorAuthResult')) await Bun.sleep(2);
      return replies.slice(before).find(r => r.type === 'operatorAuthResult')!;
    };
    /** So is a passphrase check. */
    const adminLogin = async (passphrase: string) => {
      const before = replies.length;
      ws.send(JSON.stringify({ type: 'adminLogin', passphrase }));
      while (!replies.slice(before).some(r => r.type === 'adminAuthResult')) await Bun.sleep(2);
      return replies.slice(before).find(r => r.type === 'adminAuthResult')!;
    };
    return { ws, send, dsState, operatorState, login, adminLogin, replies };
  }

  const claimField = async () => {
    adminAuth = new AdminAuth(join(authDir, `claimed-${Math.random()}.json`), CHEAP_HASH);
    await adminAuth.setPassphrase('correct horse');
  };
  const unclaimField = () => {
    adminAuth = new AdminAuth(join(authDir, `unclaimed-${Math.random()}.json`), CHEAP_HASH);
  };

  test('a heartbeat while a message is answered is not part of the answer', async () => {
    const staff = await client(STAFF_IP);
    heartbeat();
    expect(await staff.send({ type: 'adminStopMatch' })).toEqual([]);
  });

  test('a Driver Station is told so, and refused match control', async () => {
    const ds = await client(DS_IP);
    expect(ds.dsState()).toEqual({ type: 'dsClientState', station: 'slot2', by: 'ip' });
    const replies = await ds.send({ type: 'matchCreate' });
    expect(replies[0].error).toContain('Driver Station');
    expect(engineCalls).toEqual([]);
  });

  test("a Driver Station's team page still works", async () => {
    const ds = await client(DS_IP);
    expect(await ds.send({ type: 'stationReady', station: 'slot2', ready: true })).toEqual([]);
    expect(engineCalls).toEqual(['setReady']);
  });

  test('stops are never refused, Driver Station or not', async () => {
    const ds = await client(DS_IP);
    for (const type of ['adminStopMatch', 'matchAbortCountdown', 'stationPauseMatch']) {
      expect(await ds.send({ type })).toEqual([]);
    }
    expect(await ds.send({ type: 'adminGlobalEStop' })).toEqual([]);
    expect(await ds.send({ type: 'adminStationEStop', station: 'slot1' })).toEqual([]);
    expect(await ds.send({ type: 'adminStationDisable', station: 'slot1' })).toEqual([]);
    expect(engineCalls).toEqual([
      'stopMatch',
      'abortCountdown',
      'pauseMatch',
      'fieldEStop',
      'stationEStop',
      'stationDisable',
    ]);
  });

  test('any other device can run the match', async () => {
    const staff = await client(STAFF_IP);
    expect(staff.dsState()).toEqual({ type: 'dsClientState', station: null });
    expect(await staff.send({ type: 'matchCreate' })).toEqual([]);
    expect(engineCalls).toEqual(['createMatch']);
  });

  test("a laptop's other interface is refused until it says it isn't the DS", async () => {
    const laptop = await client(SAME_NAME_IP);
    expect(laptop.dsState()).toEqual({ type: 'dsClientState', station: 'slot2', by: 'hostname' });
    expect((await laptop.send({ type: 'matchCreate' }))[0].error).toContain('looks like a Driver Station');
    await laptop.send({ type: 'dsClientDismiss' });
    expect(laptop.dsState()).toEqual({ type: 'dsClientState', station: null });
    expect(await laptop.send({ type: 'matchCreate' })).toEqual([]);
    expect(engineCalls).toEqual(['createMatch']);
  });

  describe('with an operator code', () => {
    const CODE = 'correct horse';
    const STOPS = [
      { type: 'adminStopMatch' },
      { type: 'matchAbortCountdown' },
      { type: 'stationPauseMatch' },
      { type: 'adminGlobalEStop' },
      { type: 'adminStationEStop', station: 'slot1' },
      { type: 'adminStationDisable', station: 'slot1' },
    ];

    beforeEach(async () => {
      await operatorAuth.setCode(CODE);
    });

    test('a page learns on connecting that it needs a login', async () => {
      const phone = await client(STAFF_IP);
      expect(phone.operatorState()).toMatchObject({ required: true, authenticated: false });
    });

    test('a device with no login cannot run the field', async () => {
      const phone = await client(STAFF_IP);
      for (const type of ['matchCreate', 'stationStartMatch']) {
        expect((await phone.send({ type }))[0]?.error).toBe('Operator login required');
      }
      expect(engineCalls).toEqual([]);
    });

    test('every stop still works with no login', async () => {
      const phone = await client(STAFF_IP);
      for (const stop of STOPS) expect(await phone.send(stop)).toEqual([]);
      expect(engineCalls).toEqual([
        'stopMatch',
        'abortCountdown',
        'pauseMatch',
        'fieldEStop',
        'stationEStop',
        'stationDisable',
      ]);
    });

    test('clearing an e-stop needs no login, so a Driver Station can', async () => {
      const ds = await client(DS_IP);
      expect(await ds.send({ type: 'adminClearEStop', station: 'slot2' })).toEqual([]);
      expect(await ds.send({ type: 'adminClearFieldEStop' })).toEqual([]);
      expect(engineCalls).toEqual(['clearEStop', 'clearFieldEStop']);
    });

    test('every stop still works after a wrong code', async () => {
      const phone = await client(STAFF_IP);
      expect((await phone.login('wrong code'))?.error).toContain("isn't right");
      for (const stop of STOPS) expect(await phone.send(stop)).toEqual([]);
      expect(engineCalls).toHaveLength(STOPS.length);
    });

    test('a team page works with no login', async () => {
      const ds = await client(DS_IP);
      expect(await ds.send({ type: 'stationReady', station: 'slot2', ready: true })).toEqual([]);
      expect(engineCalls).toEqual(['setReady']);
    });

    test('the right code unlocks the device, and its token survives a reconnect', async () => {
      const phone = await client(STAFF_IP);
      const { token, authenticated } = await phone.login(CODE);
      expect(authenticated).toBe(true);
      expect(await phone.send({ type: 'matchCreate' })).toEqual([]);

      const reconnected = await client(STAFF_IP);
      expect(reconnected.operatorState()?.authenticated).toBe(false);
      await reconnected.send({ type: 'operatorCheckAuth', token });
      expect(reconnected.operatorState()?.authenticated).toBe(true);
      expect(await reconnected.send({ type: 'matchCreate' })).toEqual([]);
      expect(engineCalls).toEqual(['createMatch', 'createMatch']);
    });

    test('an operator login does not get past the Driver Station guard', async () => {
      const ds = await client(DS_IP);
      await ds.login(CODE);
      expect((await ds.send({ type: 'matchCreate' }))[0]?.error).toContain('Driver Station');
      expect(engineCalls).toEqual([]);
    });

    test('an admin login needs no operator login', async () => {
      await claimField();
      const admin = await client(STAFF_IP);
      await admin.adminLogin('correct horse');
      expect(await admin.send({ type: 'matchCreate' })).toEqual([]);
      expect(engineCalls).toEqual(['createMatch']);
    });

    test('a logged-in device pairs a new one with a QR code that works once', async () => {
      const phone = await client(STAFF_IP);
      await phone.login(CODE);
      const [pairing] = await phone.send({ type: 'operatorPairStart', name: 'Head ref' });

      const fresh = await client('10.55.65.21');
      await fresh.send({ type: 'operatorPairRedeem', secret: pairing.secret });
      expect(fresh.operatorState()).toMatchObject({ authenticated: true, device: { name: 'Head ref' } });
      expect(await fresh.send({ type: 'matchCreate' })).toEqual([]);

      const late = await client('10.55.65.22');
      const [refused] = await late.send({ type: 'operatorPairRedeem', secret: pairing.secret });
      expect(refused.error).toContain('expired or was already used');
      expect(refused.authenticated).toBe(false);
    });

    test('a device with no login cannot start a pairing', async () => {
      await claimField();
      await operatorAuth.setCode(CODE);
      const phone = await client(STAFF_IP);
      expect((await phone.send({ type: 'operatorPairStart' }))[0]?.error).toBe('Admin authentication required');
    });

    test('revoking a device takes its rights on the spot', async () => {
      await claimField();
      const phone = await client(STAFF_IP);
      await phone.login(CODE);
      const admin = await client('10.55.65.23');
      await admin.adminLogin('correct horse');
      const [{ id }] = operatorAuth.listDevices();
      await admin.send({ type: 'operatorRevokeDevice', id });

      expect(phone.operatorState()).toMatchObject({ authenticated: false, tokenRejected: true });
      expect((await phone.send({ type: 'matchCreate' }))[0]?.error).toBe('Operator login required');
    });

    test('only an admin can set the code or see the device list', async () => {
      await claimField();
      const phone = await client(STAFF_IP);
      await phone.login(CODE);
      expect((await phone.send({ type: 'operatorSetCode', code: null }))[0]?.error).toContain('Admin');
      expect((await phone.send({ type: 'operatorRevokeDevice' }))[0]?.error).toContain('Admin');
      expect(phone.replies.some(r => r.type === 'operatorDevicesState')).toBe(false);
    });

    test('the queue card on /match takes an operator login', async () => {
      await claimField();
      const phone = await client(STAFF_IP);
      expect((await phone.send({ type: 'queueSkip', id: 'x' }))[0]?.error).toBe('Admin authentication required');
      await phone.login(CODE);
      // Past the gate: this stand-in server just has no queue.
      expect((await phone.send({ type: 'queueSkip', id: 'x' }))[0]?.error).toBe('The match queue is not available');
    });

    test('with no code there is nothing to pair with', async () => {
      await claimField();
      const admin = await client(STAFF_IP);
      await admin.adminLogin('correct horse');
      await admin.send({ type: 'operatorSetCode', code: null });
      expect((await admin.send({ type: 'operatorPairStart' }))[0]?.error).toBe('Set an operator code first');
    });

    test('with no code the field is back to how it was', async () => {
      await claimField();
      const admin = await client(STAFF_IP);
      await admin.adminLogin('correct horse');
      await admin.send({ type: 'operatorSetCode', code: null });

      const phone = await client('10.55.65.21');
      expect(phone.operatorState()?.required).toBe(false);
      expect(await phone.send({ type: 'matchCreate' })).toEqual([]);
      expect((await phone.send({ type: 'queueSkip', id: 'x' }))[0]?.error).toBe('Admin authentication required');
    });
  });

  test('an address match cannot be dismissed', async () => {
    const ds = await client(DS_IP);
    await ds.send({ type: 'dsClientDismiss' });
    expect(ds.dsState()).toEqual({ type: 'dsClientState', station: 'slot2', by: 'ip' });
    expect((await ds.send({ type: 'matchCreate' }))[0].error).toContain('Driver Station');
  });

  test('the verdict follows a DS starting and stopping', async () => {
    const laptop = await client(STAFF_IP);
    connectedStations = { slot4: { ip: STAFF_IP, lastSeen: Date.now() } };
    for (const fn of stateListeners) fn(engineState());
    await laptop.send({ type: 'teamPrefsGet', team: 1678 });
    expect(laptop.dsState()).toEqual({ type: 'dsClientState', station: 'slot4', by: 'ip' });
    connectedStations = {};
    for (const fn of stateListeners) fn(engineState());
    await laptop.send({ type: 'teamPrefsGet', team: 1678 });
    expect(laptop.dsState()).toEqual({ type: 'dsClientState', station: null });
  });

  test('an admin login overrides the Driver Station check', async () => {
    await claimField();
    const ds = await client(DS_IP);
    const token = (await adminAuth.login('correct horse'))!;
    await ds.send({ type: 'adminCheckAuth', token });
    expect(await ds.send({ type: 'matchCreate' })).toEqual([]);
    expect(engineCalls).toEqual(['createMatch']);
  });

  describe('once the field has a passphrase', () => {
    beforeEach(claimField);

    test.each([
      [{ type: 'createApiKey', label: 'x' }],
      [{ type: 'revokeApiKey', id: 'x' }],
      [{ type: 'approvePendingDevice', id: 'x', label: 'x' }],
      [{ type: 'scoreReset' }],
      [{ type: 'removeSavedTeam', ssid: 'x' }],
      [{ type: 'stopCast' }],
      [{ type: 'testSlackConnection' }],
    ])('%j needs an admin login', async msg => {
      const anyone = await client(STAFF_IP);
      expect((await anyone.send(msg))[0].error).toBe('Admin authentication required');
    });

    test('a team can still bind a port from its page', async () => {
      const ds = await client(DS_IP);
      const replies = await ds.send({ type: 'portBridge', station: 'slot2', portVlanId: 2 });
      // This test server has no port bridging: reaching that answer is the point.
      expect(replies[0].error).toBe('Port bridging is not configured on this server');
    });
  });

  describe('before the field has a passphrase', () => {
    beforeEach(unclaimField);

    test('setup can still lock scoring with a key', async () => {
      const anyone = await client(STAFF_IP);
      const replies = await anyone.send({ type: 'scoreReset' });
      expect(replies).toEqual([]);
    });

    test('the always-a-login messages stay refused', async () => {
      const anyone = await client(STAFF_IP);
      expect((await anyone.send({ type: 'clearMatchHistory' }))[0].error).toBe('Admin authentication required');
    });
  });

  describe('from outside the field', () => {
    const VISITOR = '203.0.113.7';
    /** What pFMS gets for a visitor through Cloudflare who forged a LAN address. */
    const FORGED = `${STAFF_IP}, ${VISITOR}, 172.70.176.14`;
    const REFUSED = 'This only works from the field network';
    const KEPT = [
      'adminLogin',
      'adminCheckAuth',
      'operatorCheckAuth',
      'operatorPairRedeem',
      'dsClientDismiss',
      'castReceiverRegister',
    ];

    test('the list of what stays open is exactly this', () => {
      expect(messageTypes().filter(isOpenToOutsiders).sort()).toEqual([...KEPT].sort());
    });

    test.each([
      ['a visitor', VISITOR],
      ['a visitor forging a LAN address', FORGED],
    ])('%s is refused every other message, whatever its tier', async (_, xff) => {
      const visitor = await client(xff);
      const refused: string[] = [];
      for (const type of messageTypes().filter(t => !KEPT.includes(t))) {
        if ((await visitor.send({ type }))[0]?.error === REFUSED) refused.push(type);
      }
      expect(refused).toEqual(messageTypes().filter(t => !KEPT.includes(t)));
      expect(engineCalls).toEqual([]);
    });

    test('nobody can claim an unclaimed field from the internet', async () => {
      unclaimField();
      const visitor = await client(VISITOR);
      expect((await visitor.send({ type: 'adminSetPassphrase', passphrase: 'mine now' }))[0].error).toBe(REFUSED);
      expect(adminAuth.isConfigured()).toBe(false);
    });

    test('the external login still works, and then everything does', async () => {
      await claimField();
      const visitor = await client(VISITOR);
      const replies = [await visitor.adminLogin('correct horse')];
      expect(replies.find(r => r.type === 'adminAuthResult')?.authenticated).toBe(true);
      expect(await visitor.send({ type: 'adminGlobalEStop' })).toEqual([]);
      expect(engineCalls).toEqual(['fieldEStop']);
    });

    test('a wrong passphrase gets nothing', async () => {
      await claimField();
      const visitor = await client(VISITOR);
      await visitor.adminLogin('wrong');
      expect((await visitor.send({ type: 'adminGlobalEStop' }))[0].error).toBe(REFUSED);
    });

    describe('guessing the admin passphrase', () => {
      const guess = (visitor: Awaited<ReturnType<typeof client>>, passphrase = 'wrong') =>
        visitor.adminLogin(passphrase);
      const spendTries = async (visitor: Awaited<ReturnType<typeof client>>) => {
        for (let i = 0; i < 5; i++) expect((await guess(visitor)).retryAfterMs).toBeUndefined();
      };

      test('a stranger gets five tries, and even the right passphrase then waits', async () => {
        await claimField();
        const visitor = await client('203.0.113.20');
        await spendTries(visitor);
        const blocked = await guess(visitor, 'correct horse');
        expect(blocked.authenticated).toBe(false);
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
        expect(blocked.token).toBeUndefined();
      });

      test('a new socket or a new forged address gets no fresh tries', async () => {
        await claimField();
        const via = (forged: string) => `${forged}, 203.0.113.21, 172.70.176.15`;
        // Through Cloudflare this is the edge, until Caddy passes its client_ip.
        await spendTries(await client(via('10.0.0.1')));
        expect((await guess(await client(via('10.0.0.2')))).retryAfterMs).toBeGreaterThan(0);
      });

      test('a good login starts the count again', async () => {
        await claimField();
        const visitor = await client('203.0.113.22');
        for (let i = 0; i < 4; i++) await guess(visitor);
        expect((await guess(visitor, 'correct horse')).authenticated).toBe(true);
        const again = await client('203.0.113.22');
        await spendTries(again);
      });

      test('on site is never counted', async () => {
        await claimField();
        const staff = await client('10.55.65.21');
        for (let i = 0; i < 8; i++) expect((await guess(staff)).retryAfterMs).toBeUndefined();
        expect((await guess(staff, 'correct horse')).authenticated).toBe(true);
      });

      test('an access cookie is never counted, so a flood cannot lock its holder out', async () => {
        await claimField();
        const { token } = externalAccess.createToken('Mentor');
        const stranger = await client('203.0.113.23');
        await spendTries(stranger);
        const mentor = await client('203.0.113.23', { cookie: `pfms_access=${token}` });
        expect((await guess(mentor, 'correct horse')).authenticated).toBe(true);
      });

      test("another site's page on a laptop at the field is counted", async () => {
        await claimField();
        const page = await client('10.55.65.22', { origin: 'https://evil.example' });
        await spendTries(page);
        expect((await guess(page)).retryAfterMs).toBeGreaterThan(0);
      });

      test('a flood from many addresses stops strangers, and nobody else', async () => {
        await claimField();
        const { token } = externalAccess.createToken('Mentor');
        for (let i = 0; i < 6; i++) await spendTries(await client(`198.51.100.${i}`));
        expect((await guess(await client('203.0.113.24'), 'correct horse')).retryAfterMs).toBeGreaterThan(0);
        expect((await guess(await client(STAFF_IP), 'correct horse')).authenticated).toBe(true);
        const mentor = await client('203.0.113.24', { cookie: `pfms_access=${token}` });
        expect((await guess(mentor, 'correct horse')).authenticated).toBe(true);
      });
    });

    test('a page that opens with a stored token gets no error', async () => {
      const visitor = await client(VISITOR);
      for (const msg of [
        { type: 'adminCheckAuth', token: 'stale' },
        { type: 'operatorCheckAuth', token: 'stale' },
        { type: 'dsClientDismiss' },
      ]) {
        expect((await visitor.send(msg)).filter(r => r.error)).toEqual([]);
      }
    });

    test('an operator login carries on from outside, as far as the tiers allow', async () => {
      await claimField();
      await operatorAuth.setCode('field code');
      const phone = await client(STAFF_IP);
      const { token } = await phone.login('field code');
      const away = await client(VISITOR);
      await away.send({ type: 'operatorCheckAuth', token });
      expect(await away.send({ type: 'matchCreate' })).toEqual([]);
      expect(engineCalls).toEqual(['createMatch']);
      expect((await away.send({ type: 'updateSetupSettings' }))[0].error).toBe('Admin authentication required');
    });

    test('a QR code can be redeemed on cellular', async () => {
      await operatorAuth.setCode('field code');
      const { secret } = operatorAuth.startPairing('Admin');
      const phone = await client(VISITOR);
      const replies = await phone.send({ type: 'operatorPairRedeem', secret, name: 'Phone' });
      expect(replies.at(-1)?.token).toBeTruthy();
    });

    test('a typed operator code is refused, so a stranger cannot spend the overall limit', async () => {
      await operatorAuth.setCode('field code');
      const visitor = await client(VISITOR);
      expect((await visitor.send({ type: 'operatorLogin', code: 'guess', name: 'x' }))[0].error).toBe(REFUSED);
    });

    describe('with the access cookie', () => {
      const cookie = (token: string) => ({ cookie: `other=1; pfms_access=${token}` });

      test('a holder can do what someone on site can', async () => {
        const { token } = externalAccess.createToken('Mentor');
        const mentor = await client(VISITOR, cookie(token));
        expect(await mentor.send({ type: 'adminGlobalEStop' })).toEqual([]);
        expect(await mentor.send({ type: 'matchCreate' })).toEqual([]);
        expect(engineCalls).toEqual(['fieldEStop', 'createMatch']);
      });

      test('the tiers still apply to a holder', async () => {
        await claimField();
        const { token } = externalAccess.createToken('Mentor');
        const mentor = await client(VISITOR, cookie(token));
        expect((await mentor.send({ type: 'updateSetupSettings' }))[0].error).toBe('Admin authentication required');
      });

      test('a made-up cookie is nothing', async () => {
        const visitor = await client(VISITOR, cookie('made-up'));
        expect((await visitor.send({ type: 'adminGlobalEStop' }))[0].error).toBe(REFUSED);
      });

      test('revoking a token cuts off a socket already open', async () => {
        const { token, id } = externalAccess.createToken('Mentor');
        const mentor = await client(VISITOR, cookie(token));
        expect(await mentor.send({ type: 'adminStopMatch' })).toEqual([]);
        externalAccess.revokeToken(id);
        // The revocation is broadcast too, so the refusal needn't come first.
        expect((await mentor.send({ type: 'adminStopMatch' })).find(r => r.error)?.error).toBe(REFUSED);
      });

      test("another site's page gets nothing from a visitor's cookie", async () => {
        const { token } = externalAccess.createToken('Mentor');
        const page = await client(VISITOR, { ...cookie(token), origin: 'https://evil.example' });
        expect((await page.send({ type: 'adminGlobalEStop' }))[0].error).toBe(REFUSED);
      });
    });

    test('the public scoreboard socket is untouched', async () => {
      const ws = new WebSocket(url.replace(/\/ws$/, '/ws/scores'), { headers: { 'x-forwarded-for': VISITOR } });
      open.push(ws);
      const replies: Reply[] = [];
      ws.on('message', raw => replies.push(JSON.parse(String(raw))));
      await new Promise(res => ws.once('open', res));
      ws.send(JSON.stringify({ type: 'castReceiverRegister', name: 'TV', swapped: false }));
      while (!replies.some(r => r.type === 'castReceiverId')) await Bun.sleep(2);
      expect(replies.some(r => r.type === 'matchState')).toBe(true);
    });
  });

  describe('on site', () => {
    const STOPS = [
      { type: 'adminStopMatch' },
      { type: 'matchAbortCountdown' },
      { type: 'stationPauseMatch' },
      { type: 'adminStationDisable', station: 'slot1' },
      { type: 'adminGlobalEStop' },
      { type: 'adminStationEStop', station: 'slot1' },
      { type: 'adminClearFieldEStop' },
      { type: 'adminClearEStop', station: 'slot1' },
    ];

    test.each([
      ['a locked operator page', STAFF_IP],
      ['a Driver Station laptop', DS_IP],
      ['a VPN peer', '10.255.0.50'],
      ['this host', '127.0.0.1'],
      ['a device with a ULA address', 'fd12:3456:789a::1'],
      ['a link-local neighbour', 'fe80::1'],
    ])('stops and clears need no login from %s', async (_, ip) => {
      await claimField();
      await operatorAuth.setCode('field code');
      const device = await client(ip);
      for (const stop of STOPS) expect(await device.send(stop)).toEqual([]);
      expect(engineCalls).toHaveLength(STOPS.length);
    });

    test('a team page still works', async () => {
      const ds = await client(DS_IP);
      expect(await ds.send({ type: 'stationReady', station: 'slot2', ready: true })).toEqual([]);
      expect((await ds.send({ type: 'subscribe', topic: 'usage' })).filter(r => r.error)).toEqual([]);
    });

    test("the field's own page connects, whatever name it was opened by", async () => {
      const opened: Record<string, string>[] = [
        { origin: url.replace('ws://', 'http://').replace(/\/ws$/, '') },
        { origin: 'http://pfms.tsl', 'x-forwarded-host': 'pfms.tsl' },
      ];
      for (const headers of opened) {
        const page = await client(STAFF_IP, headers);
        expect(await page.send({ type: 'adminGlobalEStop' })).toEqual([]);
      }
    });

    test.each([['https://evil.example'], ['http://pfms.tsl.evil.example'], ['null']])(
      'a page from %s on a laptop at the field is an outsider',
      async origin => {
        const page = await client(STAFF_IP, { origin });
        expect((await page.send({ type: 'adminGlobalEStop' }))[0].error).toBe('This only works from the field network');
        expect(engineCalls).toEqual([]);
      },
    );
  });
});
