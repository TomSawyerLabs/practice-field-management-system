/**
 * Every game the field can run: the built-ins, plus whatever is in the
 * `games/` directory beside `setup-config.json`.
 *
 * - `*.json` — a declarative `GameDefinition`.
 * - `*.js`, `*.mjs`, `*.ts` — a plugin (`GamePlugin`): a definition plus
 *   rule hooks in code. Loaded with `import()`, which works from the
 *   single-file binary too. Plugins only ever come from disk; the admin page
 *   can upload JSON, never code (a plugin runs as the field service).
 *
 * Files are read at startup and again on reload. A file that doesn't load
 * is listed with its errors rather than dropped silently, so the admin page
 * can say why a game isn't there.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appWarn } from '../appLogger.js';
import type { Alliance } from '../types.js';
import { BUILTIN_GAMES, DEFAULT_GAME } from './builtin.js';
import {
  cachedDeclarativeRules,
  declarativeRules,
  ruleContext,
  validateGameDefinition,
  type GameProvider,
  type GameRules,
} from './rules.js';
import type { GameCatalogEntry, GameDefinition, GamePlugin, GameRuleHook, GameSource } from './types.js';

export type { GameCatalogEntry, GameSource } from './types.js';

interface LoadedGame {
  definition: GameDefinition;
  rules: GameRules;
  source: GameSource;
  file?: string;
}

const PLUGIN_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
const HOOKS: GameRuleHook[] = ['subPeriod', 'inactiveGoal', 'gameData', 'autoWinner'];
const isAlliance = (v: unknown): v is Alliance => v === 'red' || v === 'blue';

/**
 * Wrap a plugin's hooks around the declarative rules. A hook that throws or
 * returns something that isn't an answer falls back to the declarative rule
 * for that instant, and is reported once — a bad plugin must not stall the
 * match tick or turn every score into an error.
 */
export function pluginRules(game: GameDefinition, plugin: GamePlugin, warn = appWarn): GameRules {
  const base = declarativeRules(game);
  const reported = new Set<string>();
  const call = <T>(hook: GameRuleHook, run: () => unknown, valid: (v: unknown) => v is T, fallback: () => T): T => {
    try {
      const v = run();
      if (v === undefined) return fallback();
      if (valid(v)) return v;
      throw new Error(`returned ${JSON.stringify(v)}`);
    } catch (err) {
      if (!reported.has(hook)) {
        reported.add(hook);
        warn(
          `Game ${game.id}: plugin hook ${hook} failed (${err instanceof Error ? err.message : err}); using the declarative rule`,
        );
      }
      return fallback();
    }
  };
  const nullOr =
    <T>(check: (v: unknown) => v is T) =>
    (v: unknown): v is T | null =>
      v === null || check(v);
  const isString = (v: unknown): v is string => typeof v === 'string';
  return {
    game,
    subPeriod: (phase, remaining) =>
      plugin.subPeriod
        ? call(
            'subPeriod',
            () => plugin.subPeriod!(ruleContext(game, phase, remaining, null)),
            nullOr(isString),
            () => base.subPeriod(phase, remaining),
          )
        : base.subPeriod(phase, remaining),
    inactiveGoal: (phase, remaining, autoWinner) =>
      plugin.inactiveGoal
        ? call(
            'inactiveGoal',
            () => plugin.inactiveGoal!(ruleContext(game, phase, remaining, autoWinner)),
            nullOr(isAlliance),
            () => base.inactiveGoal(phase, remaining, autoWinner),
          )
        : base.inactiveGoal(phase, remaining, autoWinner),
    gameData: (phase, autoWinner) =>
      plugin.gameData
        ? call(
            'gameData',
            () => plugin.gameData!(ruleContext(game, phase, 0, autoWinner)),
            nullOr((v: unknown): v is string => typeof v === 'string' && v.length <= 8),
            () => base.gameData(phase, autoWinner),
          )
        : base.gameData(phase, autoWinner),
    autoWinner: scores =>
      plugin.autoWinner
        ? call(
            'autoWinner',
            () => plugin.autoWinner!({ ...scores }),
            isAlliance,
            () => base.autoWinner(scores),
          )
        : base.autoWinner(scores),
  };
}

export class GameRegistry implements GameProvider {
  private games = new Map<string, LoadedGame>();
  private broken: GameCatalogEntry[] = [];
  private selectedId: string | undefined;
  private listeners: (() => void)[] = [];
  private loads = 0;
  /** Plugin modules by path, with the mtime they were imported at. */
  private modules = new Map<string, { mtime: number; mod: { default?: unknown } }>();
  private copies = 0;

  /** `dir` is the games directory; it needn't exist until someone uploads. */
  constructor(readonly dir: string) {
    for (const game of BUILTIN_GAMES) {
      this.games.set(game.id, { definition: game, rules: cachedDeclarativeRules(game), source: 'builtin' });
    }
  }

  /** The games directory for a setup-config file. `GAMES_DIR` overrides it. */
  static dirFor(setupConfigFile: string): string {
    return process.env.GAMES_DIR ?? join(dirname(resolve(setupConfigFile)), 'games');
  }

  addListener(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        appWarn(`Game registry listener failed: ${err}`);
      }
    }
  }

  /** (Re)read every file in the games directory. */
  async load(): Promise<void> {
    const loads = ++this.loads;
    const found = new Map<string, LoadedGame>();
    const broken: GameCatalogEntry[] = [];
    for (const game of BUILTIN_GAMES) {
      found.set(game.id, { definition: game, rules: cachedDeclarativeRules(game), source: 'builtin' });
    }

    const files = existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter(f => f.endsWith('.json') || PLUGIN_EXTENSIONS.has(extname(f)))
          // Dot-files are ours (reload copies) or editors' (swap files).
          .filter(f => !f.startsWith('.') && !f.endsWith('.d.ts'))
          .sort()
      : [];
    for (const file of files) {
      const path = join(this.dir, file);
      const isPlugin = PLUGIN_EXTENSIONS.has(extname(file));
      const source: GameSource = isPlugin ? 'plugin' : 'file';
      let loaded: LoadedGame | { errors: string[] };
      try {
        loaded = isPlugin ? await this.loadPlugin(path, file) : this.loadJson(path, file);
      } catch (err) {
        loaded = { errors: [`Could not load: ${err instanceof Error ? err.message : String(err)}`] };
      }
      if ('errors' in loaded) {
        broken.push({ source, file, errors: loaded.errors });
        continue;
      }
      const clash = found.get(loaded.definition.id);
      if (clash) {
        const where = clash.source === 'builtin' ? 'a built-in game' : clash.file;
        broken.push({
          id: loaded.definition.id,
          name: loaded.definition.name,
          source,
          file,
          errors: [`Id "${loaded.definition.id}" is already used by ${where}.`],
        });
        continue;
      }
      found.set(loaded.definition.id, loaded);
    }

    // A newer reload started while this one awaited a plugin: let it win.
    if (loads !== this.loads) return;
    this.games = found;
    this.broken = broken;
    for (const b of broken) appWarn(`Game file ${b.file}: ${b.errors?.join(' ')}`);
    console.log(`Games: ${[...found.keys()].join(', ')}${broken.length ? ` (${broken.length} broken)` : ''}`);
    this.notify();
  }

  private loadJson(path: string, file: string): LoadedGame | { errors: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      return { errors: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
    }
    const v = validateGameDefinition(parsed);
    if (!v.ok) return { errors: v.errors };
    return { definition: v.game, rules: cachedDeclarativeRules(v.game), source: 'file', file };
  }

  private async loadPlugin(path: string, file: string): Promise<LoadedGame | { errors: string[] }> {
    const mod = await this.importFresh(path);
    const plugin = mod.default as Partial<GamePlugin> | undefined;
    if (!plugin || typeof plugin !== 'object') {
      return { errors: ['A plugin must `export default { definition, ...hooks }`.'] };
    }
    const v = validateGameDefinition(plugin.definition);
    if (!v.ok) return { errors: v.errors.map(e => `definition: ${e}`) };
    const errors: string[] = [];
    for (const key of Object.keys(plugin)) {
      if (key !== 'definition' && !(HOOKS as string[]).includes(key)) errors.push(`Unknown export field "${key}".`);
    }
    const hooks = HOOKS.filter(h => plugin[h] !== undefined);
    for (const h of hooks) if (typeof plugin[h] !== 'function') errors.push(`"${h}" must be a function.`);
    if (errors.length) return { errors };
    const definition: GameDefinition = { ...v.game, ...(hooks.length ? { ruleHooks: hooks } : {}) };
    return { definition, rules: pluginRules(definition, plugin as GamePlugin), source: 'plugin', file };
  }

  /**
   * Import a plugin, again if it changed since the last import. Bun caches
   * modules by path and ignores `?query` and `#hash` on file URLs, so an
   * edited plugin is imported from a throwaway copy beside the original
   * (where its relative imports still resolve), then the copy is removed.
   */
  private async importFresh(path: string): Promise<{ default?: unknown }> {
    const mtime = statSync(path).mtimeMs;
    const cached = this.modules.get(path);
    if (cached && cached.mtime === mtime) return cached.mod;
    let target = path;
    if (cached) {
      const ext = extname(path);
      target = join(dirname(path), `.${basename(path, ext)}.reload-${process.pid}-${++this.copies}${ext}`);
      copyFileSync(path, target);
    }
    try {
      const mod = (await import(pathToFileURL(target).href)) as { default?: unknown };
      this.modules.set(path, { mtime, mod });
      return mod;
    } finally {
      if (target !== path) unlinkSync(target);
    }
  }

  /** Choose the game new matches run (the `game` setup setting). */
  select(id: string | undefined): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    if (id && !this.games.has(id)) appWarn(`Selected game "${id}" isn't loaded; running ${DEFAULT_GAME.name}`);
    this.notify();
  }

  /** The id staff selected, even when that game isn't loadable. */
  get selected(): string | undefined {
    return this.selectedId;
  }

  current(): GameDefinition {
    return (this.selectedId && this.games.get(this.selectedId)?.definition) || DEFAULT_GAME;
  }

  /**
   * Rules for the game a match was set up with. Looked up by id so a plugin
   * game gets its hooks; a definition the registry no longer has (its file
   * was removed mid-match) still runs on its declarative rules.
   */
  rulesFor(game: GameDefinition): GameRules {
    const loaded = this.games.get(game.id);
    if (loaded && loaded.definition === game) return loaded.rules;
    if (loaded && loaded.source !== 'plugin') return cachedDeclarativeRules(game);
    // A plugin reloaded since the match was set up: same id, new object.
    // Keep the hooks; the definition's periods are the match's own.
    if (loaded) return loaded.rules;
    return cachedDeclarativeRules(game);
  }

  catalog(): GameCatalogEntry[] {
    const ok: GameCatalogEntry[] = [...this.games.values()].map(g => ({
      id: g.definition.id,
      name: g.definition.name,
      season: g.definition.season,
      description: g.definition.description,
      source: g.source,
      file: g.file,
      definition: g.definition,
    }));
    return [...ok, ...this.broken];
  }

  /**
   * Save an uploaded JSON game into the games directory, as `<id>.json`.
   * Returns the errors that stopped it, or null. Replaces an uploaded file
   * with the same id; never a built-in or a plugin.
   */
  async saveJson(text: string): Promise<string[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
    }
    const v = validateGameDefinition(parsed);
    if (!v.ok) return v.errors;
    const existing = this.games.get(v.game.id);
    if (existing && existing.source !== 'file') {
      return [
        `Id "${v.game.id}" is already used by ${existing.source === 'builtin' ? 'a built-in game' : existing.file}.`,
      ];
    }
    if (existing?.file && existing.file !== `${v.game.id}.json`) {
      return [`Id "${v.game.id}" is already used by ${existing.file}.`];
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${v.game.id}.json`), `${JSON.stringify(v.game, null, 2)}\n`);
    await this.load();
    return null;
  }

  /** Delete a JSON game file. Plugins and built-ins can't be deleted from the web. */
  async deleteJson(file: string): Promise<string | null> {
    const name = basename(file);
    if (name !== file || extname(name) !== '.json') return 'Only uploaded .json games can be deleted here.';
    const path = join(this.dir, name);
    if (!existsSync(path)) return `${name} isn't in the games directory.`;
    unlinkSync(path);
    await this.load();
    return null;
  }
}
