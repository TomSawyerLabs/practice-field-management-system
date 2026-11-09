/**
 * Connect the game registry to the rest of pFMS. One place, so the server
 * (index.ts) and the end-to-end test run exactly the same wiring.
 */
import type { MatchEngine } from '../matchEngine.js';
import type { ScoringEngine } from '../scoringEngine.js';
import type { SetupConfigStore } from '../setupConfigStore.js';
import { isChallengeConfig, type GameCatalogState } from '../types.js';
import type { GameRegistry } from './registry.js';

export interface GameLayerDeps {
  registry: GameRegistry;
  matchEngine: MatchEngine;
  scoringEngine: ScoringEngine;
  setupConfigStore: SetupConfigStore;
}

/**
 * - The `game` setting selects the registry's current game.
 * - The match engine takes new matches' game (and plugin rules) from the
 *   registry, and picks up a switch while no match is running.
 * - Scoring judges each score by the rules of the game its match ran.
 * - Scoring elements follow the game of the match on the field, or set up
 *   next — never the selection alone, so switching games mid-match leaves
 *   the running match's elements (and its sensors' reports) alone.
 *
 * Loads the games directory, and returns the /admin catalog builder.
 */
export async function wireGameLayer({
  registry,
  matchEngine,
  scoringEngine,
  setupConfigStore,
}: GameLayerDeps): Promise<() => GameCatalogState> {
  matchEngine.setGameProvider(registry);
  scoringEngine.setGameRulesResolver(game => registry.rulesFor(game));
  registry.addListener(() => matchEngine.refreshGame());
  matchEngine.addStateListener(state => {
    if (state.config.game && !isChallengeConfig(state.config)) scoringEngine.applyGameElements(state.config.game);
  });
  const applyGameSetting = () => registry.select(setupConfigStore.get().settings.game);
  setupConfigStore.addListener(applyGameSetting);
  applyGameSetting();
  await registry.load();

  return () => ({
    type: 'gameCatalog',
    games: registry.catalog(),
    selected: registry.selected,
    current: registry.current().id,
    dir: registry.dir,
    elementsFrom: scoringEngine.getElementsSource(),
  });
}
