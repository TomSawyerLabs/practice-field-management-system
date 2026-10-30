import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import CIDRMatcher from 'cidr-matcher';
import { WebSocket } from 'ws';
import { AdminAuth } from './adminAuth.js';
import type { HostnameResolver } from './hostnameResolver.js';
import type { MatchEngine } from './matchEngine.js';
import type RadioManager from './radioManager.js';
import { setupWebSocket, type WebSocketContext } from './websocketServer.js';
import { accessOf, dsClientMatch } from './wsAccess.js';

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
    'adminClearFieldEStop', // FieldEStopControl: these pages use only that file's TeamEStopBanner
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
});

// A stand-in server: no radio, no Driver Station packets, nothing leaves this
// process. The stubs record what reached them.
describe('the WebSocket gate', () => {
  const DS_IP = '10.16.78.5';
  const SAME_NAME_IP = '10.55.65.9';
  const STAFF_IP = '10.55.65.20';

  const authDir = mkdtempSync(join(tmpdir(), 'pfms-ws-access-'));
  let adminAuth = new AdminAuth(join(authDir, 'unused.json'));
  let context: WebSocketContext;
  let url: string;
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
      hostnameResolver,
    });
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
    adminAuth = new AdminAuth(join(authDir, 'unused.json'));
  });

  type Reply = { type?: string; error?: string; station?: string | null; by?: string };

  async function client(ip: string) {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': ip } });
    open.push(ws);
    const replies: Reply[] = [];
    ws.on('message', raw => {
      const parsed = JSON.parse(String(raw));
      if (!Array.isArray(parsed)) replies.push(parsed);
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
    return { ws, send, dsState };
  }

  const claimField = () => {
    adminAuth = new AdminAuth(join(authDir, `claimed-${Math.random()}.json`));
    adminAuth.setPassphrase('correct horse');
  };
  const unclaimField = () => {
    adminAuth = new AdminAuth(join(authDir, `unclaimed-${Math.random()}.json`));
  };

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

  test('a Driver Station cannot clear an e-stop, even its own', async () => {
    const ds = await client(DS_IP);
    for (const msg of [
      { type: 'adminClearEStop', station: 'slot2' },
      { type: 'adminClearEStop' },
      { type: 'adminClearFieldEStop' },
    ]) {
      expect((await ds.send(msg))[0]?.error).toContain('Driver Station');
    }
    expect(engineCalls).toEqual([]);
  });

  test('any other device can clear an e-stop, with no login', async () => {
    claimField();
    const staff = await client(STAFF_IP);
    expect(await staff.send({ type: 'adminClearEStop', station: 'slot2' })).toEqual([]);
    expect(await staff.send({ type: 'adminClearFieldEStop' })).toEqual([]);
    expect(engineCalls).toEqual(['clearEStop', 'clearFieldEStop']);
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
    claimField();
    const ds = await client(DS_IP);
    const token = adminAuth.login('correct horse')!;
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
});
