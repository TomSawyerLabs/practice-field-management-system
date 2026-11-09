/**
 * The /admin game flow end to end, over the real WebSocket server: the
 * catalog arrives on connect, an uploaded JSON game lands in the games
 * directory, selecting it through the `game` setting changes the match the
 * host sets up, and code is never accepted over the wire. A stand-in radio;
 * nothing leaves this process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CIDRMatcher from 'cidr-matcher';
import { WebSocket } from 'ws';
import { AdminAuth } from '../adminAuth.js';
import { MatchEngine } from '../matchEngine.js';
import type RadioManager from '../radioManager.js';
import { ScoringEngine } from '../scoringEngine.js';
import { SetupConfigStore } from '../setupConfigStore.js';
import type { SetupProbeState } from '../types.js';
import type { GameCatalogState, GameActionResult, MatchState } from '../types.js';
import { setupWebSocket, type WebSocketContext } from '../websocketServer.js';
import { GameRegistry } from './registry.js';

const CHEAP_HASH = { N: 2 ** 10, r: 8, p: 1 };

const SUMO = {
  id: 'sumo',
  name: 'Robot Sumo',
  description: 'Push the other robot out of the ring.',
  timing: { autoDuration: 0, pauseDuration: 0, teleopDuration: 90, endgameDuration: 15 },
  elements: [{ id: 'push-out', name: 'Push out', pointValue: 5 }],
};

describe('/admin games over the WebSocket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pfms-game-admin-'));
  const gamesDir = join(dir, 'games');
  const setupStore = new SetupConfigStore(join(dir, 'setup-config.json'));
  const registry = new GameRegistry(GameRegistry.dirFor(setupStore.path));
  const engine = new MatchEngine();
  const scoring = new ScoringEngine();
  const adminAuth = new AdminAuth(join(dir, 'admin.json'), CHEAP_HASH);
  let context: WebSocketContext;
  let url: string;
  const sockets: WebSocket[] = [];

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

  beforeAll(async () => {
    await adminAuth.setPassphrase('correct horse');
    // The same wiring as index.ts.
    engine.setGameProvider(registry);
    scoring.setGameRulesResolver(game => registry.rulesFor(game));
    registry.addListener(() => {
      engine.refreshGame();
      scoring.applyGameElements(registry.current());
    });
    const applyGameSetting = () => registry.select(setupStore.get().settings.game);
    setupStore.addListener(applyGameSetting);
    applyGameSetting();
    await registry.load();

    context = setupWebSocket({
      radioManager,
      matchEngine: engine,
      scoringEngine: scoring,
      port: 0,
      trustedProxyMatcher: new CIDRMatcher(['127.0.0.0/8', '::ffff:127.0.0.0/104', '::1/128']),
      adminAuth,
      games: {
        registry,
        catalog: (): GameCatalogState => ({
          type: 'gameCatalog',
          games: registry.catalog(),
          selected: registry.selected,
          current: registry.current().id,
          dir: registry.dir,
          elementsFrom: scoring.getElementsSource(),
        }),
      },
      setup: {
        configStore: setupStore,
        runProbe: async () => ({ type: 'setupProbeState', steps: [] }) as unknown as SetupProbeState,
      },
    });
    if (!context.server.listening) await new Promise(r => context.server.once('listening', r));
    url = `ws://127.0.0.1:${(context.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(() => {
    for (const ws of sockets) ws.terminate();
    context.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A staff phone on the field network, logged in as admin. */
  async function admin() {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': '10.55.65.20' } });
    sockets.push(ws);
    const heard: { type?: string; [k: string]: unknown }[] = [];
    ws.on('message', raw => {
      const parsed = JSON.parse(String(raw));
      if (!Array.isArray(parsed)) heard.push(parsed);
    });
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    const next = async <T>(type: string, after: number, match: (m: T) => boolean = () => true): Promise<T> => {
      for (let i = 0; i < 2500; i++) {
        const found = heard.slice(after).find(m => m.type === type && match(m as T));
        if (found) return found as T;
        await Bun.sleep(2);
      }
      throw new Error(`no ${type}`);
    };
    const send = (msg: object) => ws.send(JSON.stringify(msg));
    const mark = () => heard.length;
    const at = mark();
    send({ type: 'adminLogin', passphrase: 'correct horse' });
    await next('adminAuthResult', at, (m: { authenticated?: boolean }) => !!m.authenticated);
    return { send, next, mark, heard };
  }

  test('the catalog arrives on connect, with REBUILT running', async () => {
    const c = await admin();
    const catalog = await c.next<GameCatalogState>('gameCatalog', 0);
    expect(catalog.current).toBe('rebuilt-2026');
    expect(catalog.games.map(g => g.id)).toEqual(['rebuilt-2026', 'generic']);
    expect(catalog.dir).toBe(gamesDir);
  });

  test('upload, select, set up a match on it, and delete', async () => {
    const c = await admin();

    let at = c.mark();
    c.send({ type: 'gameUpload', json: JSON.stringify(SUMO) });
    expect(await c.next<GameActionResult>('gameActionResult', at)).toMatchObject({ action: 'upload', ok: true });
    expect(readdirSync(gamesDir)).toEqual(['sumo.json']);
    await c.next<GameCatalogState>('gameCatalog', at, m => m.games.some(g => g.id === 'sumo'));

    at = c.mark();
    c.send({ type: 'updateSetupSettings', settings: { game: 'sumo' } });
    const switched = await c.next<GameCatalogState>('gameCatalog', at, m => m.current === 'sumo');
    expect(switched.selected).toBe('sumo');
    // The game's elements are what scoring starts with.
    expect(switched.elementsFrom).toBe('sumo');
    expect(scoring.getElements().map(e => e.id)).toEqual(['push-out']);

    at = c.mark();
    c.send({ type: 'matchCreate' });
    const created = await c.next<MatchState>('matchState', at, m => m.phase === 'created');
    expect(created.config.game?.id).toBe('sumo');
    expect(created.config).toMatchObject({ autoDuration: 0, teleopDuration: 90, endgameDuration: 15 });
    engine.clearMatch();

    // The running game's file can be deleted; matches go back to REBUILT.
    at = c.mark();
    c.send({ type: 'gameDelete', file: 'sumo.json' });
    expect(await c.next<GameActionResult>('gameActionResult', at)).toMatchObject({ action: 'delete', ok: true });
    const after = await c.next<GameCatalogState>('gameCatalog', at, m => !m.games.some(g => g.id === 'sumo'));
    expect(after.current).toBe('rebuilt-2026');
    expect(after.selected).toBe('sumo'); // still asked for — /admin says it's missing
    c.send({ type: 'updateSetupSettings', settings: { game: null } });
  });

  test('a bad upload says why; code is never accepted', async () => {
    const c = await admin();
    let at = c.mark();
    c.send({ type: 'gameUpload', json: JSON.stringify({ ...SUMO, teleopPeriod: [] }) });
    expect(await c.next<GameActionResult>('gameActionResult', at)).toEqual({
      type: 'gameActionResult',
      action: 'upload',
      ok: false,
      errors: ['Unknown field "teleopPeriod".'],
    });

    // A plugin dropped on disk loads on Reload, but can't be deleted from the web.
    writeFileSync(
      join(gamesDir, 'ring.js'),
      `export default { definition: ${JSON.stringify({ ...SUMO, id: 'ring' })} };`,
    );
    at = c.mark();
    c.send({ type: 'gameReload' });
    await c.next<GameActionResult>('gameActionResult', at);
    const catalog = await c.next<GameCatalogState>('gameCatalog', at, m => m.games.some(g => g.id === 'ring'));
    expect(catalog.games.find(g => g.id === 'ring')?.source).toBe('plugin');
    at = c.mark();
    c.send({ type: 'gameDelete', file: 'ring.js' });
    expect(await c.next<GameActionResult>('gameActionResult', at)).toMatchObject({ ok: false });
    expect(existsSync(join(gamesDir, 'ring.js'))).toBe(true);
  });

  test('without an admin login, uploads and deletes are refused', async () => {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': '10.55.65.21' } });
    sockets.push(ws);
    const replies: { type?: string; error?: string }[] = [];
    ws.on('message', raw => {
      const parsed = JSON.parse(String(raw));
      if (!Array.isArray(parsed)) replies.push(parsed);
    });
    await new Promise(res => ws.once('open', res));
    ws.send(JSON.stringify({ type: 'gameUpload', json: JSON.stringify({ ...SUMO, id: 'sneaky' }) }));
    ws.send(JSON.stringify({ type: 'gameDelete', file: 'ring.js' }));
    for (let i = 0; i < 500 && replies.filter(r => r.error).length < 2; i++) await Bun.sleep(2);
    expect(replies.filter(r => r.error).length).toBe(2);
    expect(existsSync(join(gamesDir, 'sneaky.json'))).toBe(false);
    expect(existsSync(join(gamesDir, 'ring.js'))).toBe(true);
  });
});
