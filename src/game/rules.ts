/**
 * The declarative game rules, as pure functions of a `GameDefinition`.
 * Shared by the server (match engine, score timeline) and the browser
 * (scoreboard, timer, host page), so both sides agree on which period it is
 * and whose goal is off without a round trip.
 *
 * No runtime imports beyond the built-in games: the frontend bundles this.
 */
import type { Alliance, MatchConfig, MatchPhase } from '../types.js';
import { DEFAULT_GAME } from './builtin.js';
import {
  GAME_CUE_SOUNDS,
  type GameCueSound,
  type GameDefinition,
  type GamePeriod,
  type GameRuleContext,
  type GoalOffRule,
  type TeleopPeriod,
} from './types.js';

/** The game a match config runs. A config from before game layers carries
 *  none, and every such match was REBUILT. */
export function gameOf(config: Pick<MatchConfig, 'game'> | null | undefined): GameDefinition {
  return config?.game ?? DEFAULT_GAME;
}

/** Whether a game decides an auto winner at all. */
export function hasAutoWinner(game: GameDefinition): boolean {
  return !!game.autoWinner;
}

function otherAlliance(a: Alliance): Alliance {
  return a === 'red' ? 'blue' : 'red';
}

/** Teleop before the endgame, with the unclaimed remainder as `teleop`. */
export function teleopPeriods(game: GameDefinition): TeleopPeriod[] {
  const declared = game.teleopPeriods ?? [];
  const beforeEndgame = Math.max(0, game.timing.teleopDuration - game.timing.endgameDuration);
  const used = declared.reduce((sum, p) => sum + p.duration, 0);
  const rest = beforeEndgame - used;
  // Half a tick of slack so float durations that add up don't leave a sliver.
  return rest > 0.125 ? [...declared, { id: 'teleop', label: 'Teleop', short: 'TELEOP', duration: rest }] : declared;
}

/** Every sub-period of a match, in order, with the durations the bar draws. */
export function gamePeriods(game: GameDefinition): GamePeriod[] {
  const out: GamePeriod[] = [];
  if (game.timing.autoDuration > 0) {
    out.push({ id: 'auto', label: 'Auto', short: 'AUTO', duration: game.timing.autoDuration, phase: 'auto' });
  }
  for (const p of teleopPeriods(game)) {
    out.push({
      id: p.id,
      label: p.label,
      short: p.short ?? p.label,
      duration: p.duration,
      goalOff: p.goalOff,
      cue: p.cue,
      phase: 'teleop',
    });
  }
  if (game.timing.endgameDuration > 0) {
    out.push({
      id: 'endgame',
      label: 'Endgame',
      short: 'END GAME',
      duration: game.timing.endgameDuration,
      phase: 'endgame',
    });
  }
  return out;
}

/** Sub-period ids in match order (the keys of a score breakdown). */
export function periodIds(game: GameDefinition): string[] {
  return gamePeriods(game).map(p => p.id);
}

/** The last sub-period: where balls scored after the buzzer belong. */
function lastPeriodId(game: GameDefinition): string {
  const ids = periodIds(game);
  return ids[ids.length - 1] ?? 'teleop';
}

/** Seconds since teleop began, given the phase and its remaining time. */
export function teleopElapsed(game: GameDefinition, phase: MatchPhase | undefined, remaining: number): number | null {
  if (phase !== 'teleop' && phase !== 'endgame') return null;
  return game.timing.teleopDuration - remaining;
}

/** The teleop period at `elapsed` seconds into teleop, or null once past them all. */
function teleopPeriodAt(game: GameDefinition, elapsed: number): TeleopPeriod | null {
  let end = 0;
  for (const p of teleopPeriods(game)) {
    end += p.duration;
    if (elapsed < end) return p;
  }
  return null;
}

/**
 * The sub-period at an instant. `phase` is the phase that matters for the
 * rules: the pre-pause one while paused.
 */
export function subPeriodAt(game: GameDefinition, phase: MatchPhase | undefined, remaining: number): string | null {
  if (phase === 'auto' || phase === 'autoPause') return 'auto';
  if (phase === 'endgame' || phase === 'postMatch') {
    return game.timing.endgameDuration > 0 ? 'endgame' : lastPeriodId(game);
  }
  if (phase !== 'teleop') return null;
  const period = teleopPeriodAt(game, game.timing.teleopDuration - remaining);
  if (period) return period.id;
  // Past every teleop period but the engine hasn't ticked into endgame yet.
  return game.timing.endgameDuration > 0 ? 'endgame' : lastPeriodId(game);
}

/** Whose goal a rule switches off, given the auto winner. */
export function goalOffFor(rule: GoalOffRule | undefined, autoWinner: Alliance | null): Alliance | null {
  switch (rule) {
    case 'red':
    case 'blue':
      return rule;
    case 'autoWinner':
      return autoWinner;
    case 'autoLoser':
      return autoWinner ? otherAlliance(autoWinner) : null;
    default:
      return null;
  }
}

/**
 * Whose goal is off at an instant (null = both on). Only teleop periods
 * switch goals off; auto and the endgame keep both on.
 */
export function inactiveGoalAt(
  game: GameDefinition,
  phase: MatchPhase | undefined,
  remaining: number,
  autoWinner: Alliance | null | undefined,
): Alliance | null {
  if (phase !== 'teleop') return null;
  const period = teleopPeriodAt(game, game.timing.teleopDuration - remaining);
  return goalOffFor(period?.goalOff, autoWinner ?? null);
}

/** Phases a `fixed` game-data string is sent in. */
const FIXED_GAME_DATA_PHASES: ReadonlySet<MatchPhase> = new Set([
  'countdown',
  'auto',
  'autoPause',
  'paused',
  'teleop',
  'endgame',
]);

/** Phases the auto winner's game data is sent in, once it's known. */
const AUTO_WINNER_GAME_DATA_PHASES: ReadonlySet<MatchPhase> = new Set(['autoPause', 'teleop', 'endgame']);

/** The Driver Station game-data text for this instant, or null for none. */
export function gameDataAt(game: GameDefinition, phase: MatchPhase, autoWinner: Alliance | null): string | null {
  const rule = game.gameData;
  if (!rule) return null;
  if (rule.kind === 'fixed') return FIXED_GAME_DATA_PHASES.has(phase) ? rule.text : null;
  if (!autoWinner || !AUTO_WINNER_GAME_DATA_PHASES.has(phase)) return null;
  return autoWinner === 'red' ? rule.red : rule.blue;
}

/** The auto winner from auto points: the higher score, a tie at random. */
export function decideAutoWinner(scores: { red: number; blue: number }, random: () => number = Math.random): Alliance {
  if (scores.red > scores.blue) return 'red';
  if (scores.blue > scores.red) return 'blue';
  return random() < 0.5 ? 'red' : 'blue';
}

/**
 * Remaining-teleop-time values where one teleop sub-period ends and the next
 * begins, highest first, ending with 0. The host's timer pulses on them.
 */
export function teleopBoundaries(game: GameDefinition): number[] {
  const out: number[] = [];
  let remaining = game.timing.teleopDuration;
  for (const p of teleopPeriods(game)) {
    remaining -= p.duration;
    out.push(remaining);
  }
  if (out[out.length - 1] !== 0) out.push(0);
  return out;
}

/**
 * The field sound for moving from one teleop period to the next, if the new
 * period has one. Not on the way into teleop — the teleop horn plays then,
 * and the speaker can only play one clip at a time — and not on a resume,
 * which leaves the sub-period where it was.
 */
export function periodCue(
  game: GameDefinition,
  phase: MatchPhase | undefined,
  prevSubPeriod: string | null | undefined,
  subPeriod: string | null | undefined,
): GameCueSound | null {
  if (phase !== 'teleop' || !subPeriod || subPeriod === prevSubPeriod) return null;
  if (!prevSubPeriod || prevSubPeriod === 'auto') return null;
  return teleopPeriods(game).find(p => p.id === subPeriod)?.cue ?? null;
}

/** One row of an alliance's score breakdown on the scoreboard. */
export interface BreakdownRow {
  label: string;
  period: string;
}

/**
 * The scoreboard breakdown for one alliance: every period, except that
 * periods whose goal follows the auto result show only the ones this
 * alliance scores in, numbered "Period 1, 2…". Before the winner is known
 * the first few such periods stand in.
 */
export function breakdownRows(game: GameDefinition, alliance: Alliance, autoWinner: Alliance | null): BreakdownRow[] {
  const periods = gamePeriods(game);
  const relative = periods.filter(p => p.goalOff === 'autoWinner' || p.goalOff === 'autoLoser');
  let own: GamePeriod[];
  if (autoWinner) {
    own = relative.filter(p => goalOffFor(p.goalOff, autoWinner) !== alliance);
  } else {
    // Unknown winner: as many rows as the alliance would get either way
    // (the loser's count), filled with the first relative periods.
    const asLoser = relative.filter(p => goalOffFor(p.goalOff, otherAlliance(alliance)) !== alliance).length;
    own = relative.slice(0, asLoser);
  }
  const rows: BreakdownRow[] = [];
  let ownAdded = false;
  for (const p of periods) {
    if (p.goalOff === 'autoWinner' || p.goalOff === 'autoLoser') {
      if (!ownAdded) {
        own.forEach((o, i) => rows.push({ label: `Period ${i + 1}`, period: o.id }));
        ownAdded = true;
      }
      continue;
    }
    if (goalOffFor(p.goalOff, autoWinner) === alliance) continue;
    rows.push({ label: p.label, period: p.id });
  }
  return rows;
}

/** Rule evaluation for one game. The declarative rules, or a plugin's. */
export interface GameRules {
  readonly game: GameDefinition;
  subPeriod(phase: MatchPhase | undefined, remaining: number): string | null;
  inactiveGoal(phase: MatchPhase | undefined, remaining: number, autoWinner: Alliance | null): Alliance | null;
  gameData(phase: MatchPhase, autoWinner: Alliance | null): string | null;
  /** Null when the game has no auto winner. */
  autoWinner(scores: { red: number; blue: number }): Alliance | null;
}

export function declarativeRules(game: GameDefinition): GameRules {
  return {
    game,
    subPeriod: (phase, remaining) => subPeriodAt(game, phase, remaining),
    inactiveGoal: (phase, remaining, autoWinner) => inactiveGoalAt(game, phase, remaining, autoWinner),
    gameData: (phase, autoWinner) => gameDataAt(game, phase, autoWinner),
    autoWinner: scores => (hasAutoWinner(game) ? decideAutoWinner(scores) : null),
  };
}

/** The context a plugin hook sees. */
export function ruleContext(
  game: GameDefinition,
  phase: MatchPhase | undefined,
  remaining: number,
  autoWinner: Alliance | null,
): GameRuleContext {
  return { game, phase, remaining, teleopElapsed: teleopElapsed(game, phase, remaining), autoWinner };
}

// ── Validation ────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PERIOD_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const RESERVED_PERIOD_IDS = new Set(['auto', 'teleop', 'endgame']);
const GOAL_OFF_RULES = new Set<string>(['autoWinner', 'autoLoser', 'red', 'blue']);
const PHASES = new Set<string>(['auto', 'autoPause', 'paused', 'teleop', 'endgame', 'postMatch']);
const TOP_LEVEL_KEYS = new Set([
  'id',
  'name',
  'season',
  'description',
  'timing',
  'autoWinner',
  'teleopPeriods',
  'gameData',
  'elements',
  'ruleHooks',
]);
/** The 2027 Driver Station reads at most 8 game-data characters. */
const MAX_GAME_DATA = 8;

export type GameValidation = { ok: true; game: GameDefinition } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isGameDataText = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= MAX_GAME_DATA && /^[\x20-\x7e]+$/.test(v);

/**
 * Check a game definition someone wrote, and return a clean copy. Errors are
 * sentences for the admin page, so an author can fix the file from them.
 * Unknown keys are refused: a misspelt `teleopPeriod` would otherwise be a
 * game that silently has no shifts.
 */
export function validateGameDefinition(input: unknown): GameValidation {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['A game must be a JSON object.'] };

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`Unknown field "${key}".`);
  }
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) {
    errors.push('"id" must be 1-48 lowercase letters, digits or dashes, starting with a letter or digit.');
  }
  if (!isText(input.name, 60)) errors.push('"name" must be a non-empty string of at most 60 characters.');
  if (input.season !== undefined && !(Number.isInteger(input.season) && (input.season as number) >= 1992)) {
    errors.push('"season" must be a year.');
  }
  if (input.description !== undefined && !(typeof input.description === 'string' && input.description.length <= 500)) {
    errors.push('"description" must be a string of at most 500 characters.');
  }

  const t = input.timing;
  let teleopBudget = Infinity;
  if (!isObj(t)) {
    errors.push('"timing" is required: { autoDuration, pauseDuration, teleopDuration, endgameDuration } in seconds.');
  } else {
    const limits: [string, number, number][] = [
      ['autoDuration', 0, 300],
      ['pauseDuration', 0, 60],
      ['teleopDuration', 1, 900],
      ['endgameDuration', 0, 900],
    ];
    for (const [key, min, max] of limits) {
      const v = t[key];
      if (!isNum(v) || v < min || v > max)
        errors.push(`"timing.${key}" must be a number of seconds from ${min} to ${max}.`);
    }
    for (const key of Object.keys(t)) {
      if (!limits.some(([k]) => k === key)) errors.push(`Unknown field "timing.${key}".`);
    }
    if (isNum(t.teleopDuration) && isNum(t.endgameDuration)) {
      if (t.endgameDuration > t.teleopDuration) errors.push('"timing.endgameDuration" can\'t be longer than teleop.');
      teleopBudget = t.teleopDuration - t.endgameDuration;
    }
  }

  const aw = input.autoWinner;
  if (aw !== undefined) {
    if (!isObj(aw)) errors.push('"autoWinner" must be an object, e.g. { "default": "scores" }.');
    else if (aw.default !== undefined && aw.default !== 'scores' && aw.default !== 'pause') {
      errors.push('"autoWinner.default" must be "scores" or "pause".');
    }
  }

  const periods = input.teleopPeriods;
  if (periods !== undefined) {
    if (!Array.isArray(periods) || periods.length > 24) {
      errors.push('"teleopPeriods" must be a list of at most 24 periods.');
    } else {
      const seen = new Set<string>();
      let total = 0;
      periods.forEach((p: unknown, i) => {
        const at = `teleopPeriods[${i}]`;
        if (!isObj(p)) {
          errors.push(`${at} must be an object.`);
          return;
        }
        for (const key of Object.keys(p)) {
          if (!['id', 'label', 'short', 'duration', 'goalOff', 'cue'].includes(key)) {
            errors.push(`Unknown field "${at}.${key}".`);
          }
        }
        if (typeof p.id !== 'string' || !PERIOD_ID_RE.test(p.id)) {
          errors.push(`${at}.id must be 1-32 letters, digits, dashes or underscores.`);
        } else if (RESERVED_PERIOD_IDS.has(p.id)) {
          errors.push(`${at}.id "${p.id}" is reserved — pFMS adds auto, teleop and endgame itself.`);
        } else if (seen.has(p.id)) {
          errors.push(`${at}.id "${p.id}" is used twice.`);
        } else seen.add(p.id);
        if (!isText(p.label, 40)) errors.push(`${at}.label must be a non-empty string of at most 40 characters.`);
        if (p.short !== undefined && !isText(p.short, 10)) errors.push(`${at}.short must be at most 10 characters.`);
        if (!isNum(p.duration) || p.duration <= 0) errors.push(`${at}.duration must be a positive number of seconds.`);
        else total += p.duration;
        if (p.goalOff !== undefined) {
          if (typeof p.goalOff !== 'string' || !GOAL_OFF_RULES.has(p.goalOff)) {
            errors.push(`${at}.goalOff must be "autoWinner", "autoLoser", "red" or "blue".`);
          } else if ((p.goalOff === 'autoWinner' || p.goalOff === 'autoLoser') && aw === undefined) {
            errors.push(`${at}.goalOff "${p.goalOff}" needs the game to have an "autoWinner".`);
          }
        }
        if (p.cue !== undefined && !(GAME_CUE_SOUNDS as readonly unknown[]).includes(p.cue)) {
          errors.push(`${at}.cue must be one of ${GAME_CUE_SOUNDS.join(', ')}.`);
        }
      });
      if (total > teleopBudget + 1e-9) {
        errors.push(`"teleopPeriods" add up to ${total} s, but teleop before the endgame is only ${teleopBudget} s.`);
      }
    }
  }

  const gd = input.gameData;
  if (gd !== undefined) {
    if (!isObj(gd)) errors.push('"gameData" must be an object.');
    else if (gd.kind === 'autoWinner') {
      if (!isGameDataText(gd.red) || !isGameDataText(gd.blue)) {
        errors.push(`"gameData.red" and "gameData.blue" must be 1-${MAX_GAME_DATA} plain ASCII characters.`);
      }
      if (aw === undefined) errors.push('"gameData" of kind "autoWinner" needs the game to have an "autoWinner".');
    } else if (gd.kind === 'fixed') {
      if (!isGameDataText(gd.text)) errors.push(`"gameData.text" must be 1-${MAX_GAME_DATA} plain ASCII characters.`);
    } else errors.push('"gameData.kind" must be "autoWinner" or "fixed".');
  }

  const els = input.elements;
  if (els !== undefined) {
    if (!Array.isArray(els) || els.length > 64)
      errors.push('"elements" must be a list of at most 64 scoring elements.');
    else {
      els.forEach((e: unknown, i) => {
        const at = `elements[${i}]`;
        if (!isObj(e)) return void errors.push(`${at} must be an object.`);
        if (typeof e.id !== 'string' || !/^[\w-]{1,64}$/.test(e.id))
          errors.push(`${at}.id must be a short identifier.`);
        if (!isText(e.name, 60)) errors.push(`${at}.name must be a non-empty string.`);
        if (!isNum(e.pointValue)) errors.push(`${at}.pointValue must be a number.`);
        if (e.awardToOpponent !== undefined && typeof e.awardToOpponent !== 'boolean') {
          errors.push(`${at}.awardToOpponent must be true or false.`);
        }
        if (
          e.activePhases !== undefined &&
          !(Array.isArray(e.activePhases) && e.activePhases.every(ph => typeof ph === 'string' && PHASES.has(ph)))
        ) {
          errors.push(`${at}.activePhases must list match phases (${[...PHASES].join(', ')}).`);
        }
        if (
          e.deduplicationWindowMs !== undefined &&
          !(isNum(e.deduplicationWindowMs) && e.deduplicationWindowMs >= 0)
        ) {
          errors.push(`${at}.deduplicationWindowMs must be a non-negative number.`);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  // A clean copy: authors don't get to claim plugin hooks.
  const game = JSON.parse(JSON.stringify(input)) as GameDefinition;
  delete game.ruleHooks;
  return { ok: true, game };
}

/** Where the server gets games from: the one staff picked, and the rules
 *  for any game a match was set up with (a plugin's, if it is one). */
export interface GameProvider {
  current(): GameDefinition;
  rulesFor(game: GameDefinition): GameRules;
}

const declarativeCache = new WeakMap<GameDefinition, GameRules>();

/** Rules for a definition with no plugin behind it, cached per object. */
export function cachedDeclarativeRules(game: GameDefinition): GameRules {
  let rules = declarativeCache.get(game);
  if (!rules) declarativeCache.set(game, (rules = declarativeRules(game)));
  return rules;
}

/** A provider that always runs one declarative game (tests, and the
 *  engine before the registry is wired in). */
export function fixedGameProvider(game: GameDefinition = DEFAULT_GAME): GameProvider {
  return { current: () => game, rulesFor: cachedDeclarativeRules };
}
