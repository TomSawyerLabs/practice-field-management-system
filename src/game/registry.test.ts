import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERIC, REBUILT_2026 } from './builtin.js';
import { GameRegistry, pluginRules } from './registry.js';
import type { GameDefinition } from './types.js';

const CUSTOM: GameDefinition = {
  id: 'cone-rush',
  name: 'Cone Rush',
  timing: { autoDuration: 10, pauseDuration: 0, teleopDuration: 100, endgameDuration: 15 },
  elements: [{ id: 'cone', name: 'Cone', pointValue: 2 }],
};

/** A plugin that flips the goal every 10 s of teleop, written the way an
 *  author would: TypeScript, importing pFMS types that don't exist on disk. */
const PLUGIN_TS = `
import type { GamePlugin } from 'pfms/game';
const plugin = {
  definition: {
    id: 'flip-flop',
    name: 'Flip Flop',
    timing: { autoDuration: 0, pauseDuration: 0, teleopDuration: 60, endgameDuration: 0 },
  },
  inactiveGoal(ctx: { teleopElapsed: number | null }) {
    if (ctx.teleopElapsed === null) return undefined;
    return Math.floor(ctx.teleopElapsed / 10) % 2 === 0 ? 'red' : 'blue';
  },
  gameData: () => 'FF',
  autoWinner: () => 'blue',
} satisfies GamePlugin;
export default plugin;
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pfms-games-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ids = (r: GameRegistry) =>
  r
    .catalog()
    .filter(e => !e.errors)
    .map(e => e.id);
const broken = (r: GameRegistry) => r.catalog().filter(e => e.errors);

describe('GameRegistry', () => {
  test('built-ins with no games directory; REBUILT until something is selected', async () => {
    const r = new GameRegistry(join(dir, 'missing'));
    await r.load();
    expect(ids(r)).toEqual(['rebuilt-2026', 'generic']);
    expect(r.current()).toBe(REBUILT_2026);
    r.select('generic');
    expect(r.current()).toBe(GENERIC);
  });

  test('a selected game that is not loaded runs REBUILT, and is still reported as selected', async () => {
    const r = new GameRegistry(dir);
    await r.load();
    r.select('nope');
    expect(r.current()).toBe(REBUILT_2026);
    expect(r.selected).toBe('nope');
  });

  test('JSON games load; broken ones are listed with their errors', async () => {
    writeFileSync(join(dir, 'cone-rush.json'), JSON.stringify(CUSTOM));
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    writeFileSync(join(dir, 'typo.json'), JSON.stringify({ ...CUSTOM, id: 'typo', teleopPeriod: [] }));
    writeFileSync(join(dir, 'clash.json'), JSON.stringify({ ...CUSTOM, id: 'generic' }));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const r = new GameRegistry(dir);
    await r.load();
    expect(ids(r)).toEqual(['rebuilt-2026', 'generic', 'cone-rush']);
    const errors = Object.fromEntries(broken(r).map(e => [e.file, e.errors![0]]));
    expect(errors['bad.json']).toStartWith('Not valid JSON');
    expect(errors['typo.json']).toBe('Unknown field "teleopPeriod".');
    expect(errors['clash.json']).toBe('Id "generic" is already used by a built-in game.');
    r.select('cone-rush');
    expect(r.current()).toEqual(CUSTOM);
  });

  test('a TypeScript plugin loads, and its hooks run behind the declarative rules', async () => {
    writeFileSync(join(dir, 'flip-flop.ts'), PLUGIN_TS);
    const r = new GameRegistry(dir);
    await r.load();
    r.select('flip-flop');
    const game = r.current();
    expect(game.ruleHooks).toEqual(['inactiveGoal', 'gameData', 'autoWinner']);
    const rules = r.rulesFor(game);
    expect(rules.inactiveGoal('teleop', 55, null)).toBe('red'); // 5 s in
    expect(rules.inactiveGoal('teleop', 45, null)).toBe('blue'); // 15 s in
    expect(rules.inactiveGoal('auto', 5, null)).toBeNull(); // hook says undefined → declarative
    expect(rules.gameData('teleop', null)).toBe('FF');
    expect(rules.autoWinner({ red: 9, blue: 0 })).toBe('blue');
    expect(rules.subPeriod('teleop', 30)).toBe('teleop'); // no hook → declarative
  });

  test('Reload picks up an edited plugin', async () => {
    const path = join(dir, 'flip-flop.ts');
    writeFileSync(path, PLUGIN_TS);
    const r = new GameRegistry(dir);
    await r.load();
    expect(r.catalog().find(e => e.id === 'flip-flop')?.name).toBe('Flip Flop');
    await Bun.sleep(20); // a distinct mtime
    writeFileSync(path, PLUGIN_TS.replace("name: 'Flip Flop'", "name: 'Flip Flop 2'"));
    await r.load();
    expect(r.catalog().find(e => e.id === 'flip-flop')?.name).toBe('Flip Flop 2');
  });

  test('a plugin that is not one is listed as broken', async () => {
    writeFileSync(join(dir, 'empty.js'), 'export const x = 1;');
    writeFileSync(join(dir, 'throws.js'), 'throw new Error("boom");');
    writeFileSync(
      join(dir, 'odd.js'),
      `export default { definition: ${JSON.stringify(CUSTOM)}, inactiveGoal: 'red', extra: 1 };`,
    );
    const r = new GameRegistry(dir);
    await r.load();
    const errors = Object.fromEntries(broken(r).map(e => [e.file, e.errors!.join(' ')]));
    expect(errors['empty.js']).toContain('export default');
    expect(errors['throws.js']).toContain('boom');
    expect(errors['odd.js']).toContain('Unknown export field "extra".');
    expect(errors['odd.js']).toContain('"inactiveGoal" must be a function.');
  });

  test('a match keeps its rules when its game file is removed mid-match', async () => {
    writeFileSync(join(dir, 'cone-rush.json'), JSON.stringify(CUSTOM));
    const r = new GameRegistry(dir);
    await r.load();
    r.select('cone-rush');
    const game = r.current();
    rmSync(join(dir, 'cone-rush.json'));
    await r.load();
    expect(r.current()).toBe(REBUILT_2026);
    expect(r.rulesFor(game).subPeriod('teleop', 50)).toBe('teleop');
  });

  test('upload writes <id>.json; only uploaded JSON can be deleted', async () => {
    writeFileSync(join(dir, 'flip-flop.ts'), PLUGIN_TS);
    const r = new GameRegistry(join(dir, 'new'));
    await r.load();
    expect(await r.saveJson(JSON.stringify(CUSTOM))).toBeNull();
    expect(readdirSync(join(dir, 'new'))).toEqual(['cone-rush.json']);
    expect(ids(r)).toContain('cone-rush');
    // Replacing your own upload is fine; taking a built-in's id is not.
    expect(await r.saveJson(JSON.stringify({ ...CUSTOM, name: 'Cone Rush 2' }))).toBeNull();
    expect(await r.saveJson(JSON.stringify({ ...CUSTOM, id: 'rebuilt-2026' }))).toEqual([
      'Id "rebuilt-2026" is already used by a built-in game.',
    ]);
    expect(await r.saveJson('{')).toHaveLength(1);
    expect(await r.deleteJson('../flip-flop.ts')).toBe('Only uploaded .json games can be deleted here.');
    expect(await r.deleteJson('cone-rush.json')).toBeNull();
    expect(ids(r)).not.toContain('cone-rush');
  });

  test('listeners hear loads and selections', async () => {
    const r = new GameRegistry(dir);
    let heard = 0;
    r.addListener(() => heard++);
    await r.load();
    r.select('generic');
    r.select('generic'); // no change, no event
    expect(heard).toBe(2);
  });
});

describe('pluginRules', () => {
  test('a hook that throws or answers nonsense falls back, and is reported once', () => {
    const warnings: string[] = [];
    const rules = pluginRules(
      GENERIC,
      {
        definition: GENERIC,
        inactiveGoal: () => {
          throw new Error('bug');
        },
        subPeriod: () => 42 as unknown as string,
        gameData: () => 'MUCH TOO LONG',
      },
      w => warnings.push(w),
    );
    expect(rules.inactiveGoal('teleop', 50, null)).toBeNull();
    expect(rules.inactiveGoal('teleop', 40, null)).toBeNull();
    expect(rules.subPeriod('teleop', 50)).toBe('teleop');
    expect(rules.gameData('teleop', null)).toBeNull();
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('inactiveGoal failed (bug)');
  });
});

describe('the sample games in samples/games', () => {
  test('all load, and the plugin computes its turns', async () => {
    const r = new GameRegistry(join(__dirname, '..', '..', 'samples', 'games'));
    await r.load();
    expect(broken(r)).toEqual([]);
    expect(ids(r)).toEqual(['rebuilt-2026', 'generic', 'hot-goal', 'king-of-the-hill']);

    r.select('hot-goal');
    const hot = r.rulesFor(r.current());
    expect(r.current().ruleHooks).toEqual(['inactiveGoal', 'autoWinner']);
    // Head start (declarative): the loser's goal is off.
    expect(hot.inactiveGoal('teleop', 130, 'red')).toBe('blue');
    // Turns: the winner's goal off first, then the loser's, every 10 s.
    expect(hot.inactiveGoal('teleop', 115, 'red')).toBe('red');
    expect(hot.inactiveGoal('teleop', 105, 'red')).toBe('blue');
    expect(hot.autoWinner({ red: 2, blue: 2 })).toBe('blue');
    expect(hot.autoWinner({ red: 3, blue: 2 })).toBe('red');
  });
});
