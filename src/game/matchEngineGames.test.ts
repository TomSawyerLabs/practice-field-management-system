/**
 * The match engine runs whatever game it's given, and nothing about REBUILT
 * leaks into a match of another game. Engine-level counterpart to the rule
 * tests in rules.test.ts.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchEngine } from '../matchEngine.js';
import { MatchHistoryStore } from '../matchHistoryStore.js';
import { ScoringEngine } from '../scoringEngine.js';
import type { MatchConfig } from '../types.js';
import { GENERIC, REBUILT_2026 } from './builtin.js';
import { pluginRules } from './registry.js';
import { cachedDeclarativeRules, fixedGameProvider, type GameProvider } from './rules.js';
import type { GameDefinition, GamePlugin } from './types.js';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const elapse = (ms: number) => jest.advanceTimersByTime(ms);

/** A provider whose current game can be switched, like the registry. */
function switchable(initial: GameDefinition, plugins: GamePlugin[] = []) {
  let current = initial;
  const provider: GameProvider = {
    current: () => current,
    rulesFor: game => {
      const plugin = plugins.find(p => p.definition.id === game.id);
      return plugin ? pluginRules(game, plugin) : cachedDeclarativeRules(game);
    },
  };
  return { provider, switchTo: (game: GameDefinition) => (current = game) };
}

const gameDataOf = (engine: MatchEngine) =>
  (engine as unknown as { currentGameData(): string | null }).currentGameData();

/** One robot on red, everything else waived, match started. */
function start(engine: MatchEngine, config?: Partial<MatchConfig>) {
  engine.createMatch();
  if (config) engine.updateMatchConfig({ ...engine.getState().config, ...config });
  engine.joinStationAlliance('slot1', 'red');
  for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
  engine.setReadyRequested(true);
  engine.dsReportedStatus('slot1', false, false, false, 0x38, true);
  engine.setReady('slot1', true);
  engine.startMatch();
  expect(engine.getState().phase).toBe('countdown');
}

describe('the engine runs the game it is given', () => {
  test('REBUILT is the default, with the same timing as before game layers', () => {
    const engine = new MatchEngine(() => 5940);
    engine.createMatch();
    const { config } = engine.getState();
    expect(config.game).toBe(REBUILT_2026);
    expect(config).toMatchObject({ autoDuration: 20, pauseDuration: 3, teleopDuration: 140, endgameDuration: 30 });
  });

  test('a generic match: its own timing, no auto winner, no shifts, no game data', () => {
    const engine = new MatchEngine(() => 5940);
    engine.setGameProvider(fixedGameProvider(GENERIC));
    engine.setAutoScoreResolver(() => ({ red: 10, blue: 0 }));
    start(engine);
    expect(engine.getState().config).toMatchObject({ autoDuration: 15, teleopDuration: 135, endgameDuration: 20 });

    elapse(3_000 + 5_000);
    expect(engine.getState()).toMatchObject({ phase: 'auto', subPeriod: 'auto', inactiveGoalAlliance: null });
    elapse(10_000 + 3_000 + 1_000); // through auto and the pause
    let s = engine.getState();
    expect(s.phase).toBe('teleop');
    expect(s.autoWinnerAlliance).toBeNull();
    expect(s.subPeriod).toBe('teleop');
    expect(s.inactiveGoalAlliance).toBeNull();
    expect(gameDataOf(engine)).toBeNull();

    elapse(120_000);
    s = engine.getState();
    expect(s).toMatchObject({ phase: 'endgame', subPeriod: 'endgame', inactiveGoalAlliance: null });
    engine.stopMatch();
  });

  test('a generic match may skip auto with no auto winner to pre-set', () => {
    const engine = new MatchEngine(() => 5940);
    engine.setGameProvider(fixedGameProvider(GENERIC));
    start(engine, { skipAuto: true, autoWinner: 'scores' });
    elapse(3_400);
    expect(engine.getState().phase).toBe('teleop');
    engine.stopMatch();
  });

  test('REBUILT still sends R/B and switches goals off by shift', () => {
    const engine = new MatchEngine(() => 5940);
    engine.setAutoScoreResolver(() => ({ red: 0, blue: 4 }));
    start(engine);
    elapse(3_000 + 20_000 + 3_000 + 250);
    let s = engine.getState();
    expect(s.phase).toBe('teleop');
    expect(s.autoWinnerAlliance).toBe('blue');
    expect(gameDataOf(engine)).toBe('B');
    expect(s.subPeriod).toBe('transition');
    elapse(10_000);
    s = engine.getState();
    expect(s.subPeriod).toBe('shift1');
    expect(s.inactiveGoalAlliance).toBe('blue');
    engine.stopMatch();
  });

  test('a client cannot send a game, or durations, with its config', () => {
    const engine = new MatchEngine(() => 5940);
    engine.createMatch();
    engine.updateMatchConfig({ ...GENERIC.timing, game: GENERIC, skipAuto: false });
    const { config } = engine.getState();
    expect(config.game).toBe(REBUILT_2026);
    expect(config.teleopDuration).toBe(140);
  });
});

describe('switching games', () => {
  test('applies to a match that is only set up, and keeps the host choices it can', () => {
    const { provider, switchTo } = switchable(REBUILT_2026);
    const engine = new MatchEngine(() => 5940);
    engine.setGameProvider(provider);
    engine.createMatch();
    engine.updateMatchConfig({ ...engine.getState().config, skipAuto: true, autoWinner: 'red' });

    switchTo(GENERIC);
    engine.refreshGame();
    const { config } = engine.getState();
    expect(config.game).toBe(GENERIC);
    expect(config.teleopDuration).toBe(135);
    expect(config.skipAuto).toBe(true);
  });

  test('never changes the rules of a match already running', () => {
    const { provider, switchTo } = switchable(REBUILT_2026);
    const engine = new MatchEngine(() => 5940);
    engine.setGameProvider(provider);
    engine.setAutoScoreResolver(() => ({ red: 1, blue: 0 }));
    start(engine);
    elapse(3_000 + 20_000 + 3_000 + 10_250);

    switchTo(GENERIC);
    engine.refreshGame();
    const s = engine.getState();
    expect(s.config.game).toBe(REBUILT_2026);
    expect(s.subPeriod).toBe('shift1');
    expect(s.inactiveGoalAlliance).toBe('red');
    engine.stopMatch();

    // The next match picks the new game up.
    engine.clearMatch();
    elapse(60_000);
    engine.createMatch();
    expect(engine.getState().config.game).toBe(GENERIC);
  });

  test('a challenge run keeps its own clock when the game changes', () => {
    const { provider, switchTo } = switchable(REBUILT_2026);
    const engine = new MatchEngine(() => 5940);
    engine.setGameProvider(provider);
    engine.createMatch();
    engine.updateMatchConfig({ ...GENERIC.timing, format: 'challenge', teleopDuration: 45 });
    switchTo(GENERIC);
    engine.refreshGame();
    expect(engine.getState().config).toMatchObject({ format: 'challenge', teleopDuration: 45 });
  });
});

describe('a plugin game', () => {
  const ALTERNATE: GamePlugin = {
    definition: {
      id: 'alternate',
      name: 'Alternate',
      timing: { autoDuration: 0, pauseDuration: 0, teleopDuration: 60, endgameDuration: 0 },
      ruleHooks: ['inactiveGoal', 'gameData'],
    },
    inactiveGoal: ctx => (ctx.teleopElapsed === null ? undefined : ctx.teleopElapsed < 30 ? 'blue' : 'red'),
    gameData: ctx => (ctx.phase === 'teleop' ? 'ALT' : null),
  };

  test('its hooks drive the broadcast state and the game data', () => {
    const { provider } = switchable(ALTERNATE.definition, [ALTERNATE]);
    const engine = new MatchEngine(() => 5940);
    engine.setGameProvider(provider);
    start(engine);
    elapse(3_400);
    let s = engine.getState();
    expect(s.phase).toBe('teleop');
    expect(s.inactiveGoalAlliance).toBe('blue');
    expect(gameDataOf(engine)).toBe('ALT');
    elapse(31_000);
    s = engine.getState();
    expect(s.inactiveGoalAlliance).toBe('red');
    engine.stopMatch();
  });
});

describe('history and scoring follow the game', () => {
  test('a match records which game it ran; the breakdown has that game’s periods', () => {
    const file = join(tmpdir(), `pfms-history-${randomUUID()}.json`);
    const engine = new MatchEngine(() => 5940);
    const scoring = new ScoringEngine();
    engine.setGameProvider(fixedGameProvider(GENERIC));
    engine.addStateListener(state => scoring.onMatchStateChange(state));
    const history = new MatchHistoryStore(file);
    history.attach(engine, scoring);

    start(engine);
    elapse(3_000 + 15_000 + 3_000 + 1_000);
    // Timed (ageMs), so the 5 s grace for untimed reports doesn't hand it to auto.
    scoring.submitEvent({ source: 'test', alliance: 'red', element: 'ball', ageMs: 0 });
    engine.stopMatch();

    const entry = history.getState().matches.at(-1)!;
    expect(entry.game).toEqual({ id: 'generic', name: 'Generic match' });
    expect(Object.keys(entry.periodBreakdown ?? {})).toEqual(['auto', 'teleop', 'endgame']);
    expect(entry.periodBreakdown?.teleop.red).toBe(1);
    rmSync(file, { force: true });
  });

  test("a game's elements seed scoring only until someone configures their own", () => {
    const scoring = new ScoringEngine();
    const cones: GameDefinition = { ...GENERIC, id: 'cones', elements: [{ id: 'cone', name: 'Cone', pointValue: 3 }] };
    scoring.applyGameElements(cones);
    expect(scoring.getElements().map(e => e.id)).toEqual(['cone']);
    expect(scoring.getElementsSource()).toBe('cones');

    // Switching to a game with no elements takes the old game's away.
    scoring.applyGameElements(GENERIC);
    expect(scoring.getElements()).toEqual([]);

    scoring.setElements([{ id: 'mine', name: 'Mine', pointValue: 1 }]);
    scoring.applyGameElements(cones);
    expect(scoring.getElements().map(e => e.id)).toEqual(['mine']);
    expect(scoring.getElementsSource()).toBeNull();
  });
});
