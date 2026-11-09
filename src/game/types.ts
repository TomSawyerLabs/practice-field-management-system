/**
 * A game layer: everything about a season's game that pFMS needs to run a
 * match of it. The FRC phase machine (countdown → auto → teleop → endgame),
 * the Driver Station protocol, E-stop and the radio are core and the same
 * for every game; what changes from season to season lives here.
 *
 * A `GameDefinition` is plain JSON so the same object can be written by hand
 * in `games/*.json`, sent to every browser in `matchState`, and evaluated by
 * the shared rule functions in `rules.ts` on both sides. Rules the
 * declarative vocabulary can't express go in a plugin (`GamePlugin`), whose
 * hooks run on the server only.
 *
 * Kept free of runtime imports: the frontend and plugin authors import these
 * types, and a plugin's `import type` is erased when it's loaded.
 */
import type { Alliance, MatchPhase, ScoringElementConfig } from '../types.js';

/** Sounds a game may cue. Files are `sounds/<name>.wav`; see `src/matchAudio.ts`. */
export const GAME_CUE_SOUNDS = ['start', 'end', 'resume', 'warning', 'pause', 'getready'] as const;
export type GameCueSound = (typeof GAME_CUE_SOUNDS)[number];

/** Whose goal a teleop period switches off. `autoWinner`/`autoLoser` leave
 *  both goals on until the auto winner is known. */
export type GoalOffRule = 'autoWinner' | 'autoLoser' | 'red' | 'blue';

/** One named stretch of teleop before the endgame. */
export interface TeleopPeriod {
  /** Sub-period id on the wire (`matchState.subPeriod`, score breakdowns). */
  id: string;
  /** Full name: "Shift 1". */
  label: string;
  /** A few characters for the timeline bar: "S1". Defaults to `label`. */
  short?: string;
  /** Seconds. */
  duration: number;
  /** Whose goal is off for this period. Absent = both goals on. */
  goalOff?: GoalOffRule;
  /** Field sound played when this period begins (not after a resume). */
  cue?: GameCueSound;
}

/** What the Driver Station's game-data field carries during a match. */
export type GameDataRule =
  /** Once the auto winner is known (the pause after auto onwards): `red` if
   *  red won auto, `blue` if blue did. REBUILT sends `R` / `B`. */
  | { kind: 'autoWinner'; red: string; blue: string }
  /** The same text for the whole match, from the countdown on. */
  | { kind: 'fixed'; text: string };

/** Which rules a plugin computes in code. Clients use the server's
 *  broadcast values for these instead of evaluating the definition. */
export type GameRuleHook = 'subPeriod' | 'inactiveGoal' | 'gameData' | 'autoWinner';

export interface GameDefinition {
  /** Stable id: lowercase letters, digits and dashes ("rebuilt-2026"). */
  id: string;
  /** Shown on the match page, scoreboard and in history ("REBUILT"). */
  name: string;
  /** FRC season year, if it is one. */
  season?: number;
  description?: string;
  /** Official timing. Every match of this game runs on it; only the
   *  challenge format picks its own window. */
  timing: {
    /** Seconds of autonomous. 0 = the game has no auto. */
    autoDuration: number;
    /** Seconds robots sit disabled between auto and teleop. */
    pauseDuration: number;
    /** Seconds of teleop, endgame included. */
    teleopDuration: number;
    /** The last this-many seconds of teleop are the endgame. 0 = none. */
    endgameDuration: number;
  };
  /** Present when the game has an auto winner (decided from auto scores,
   *  ties broken at random unless a plugin says otherwise). Absent = no auto
   *  winner: the host's "Auto winner" control is hidden. */
  autoWinner?: {
    /** What the host's control starts on. Default `scores`. */
    default?: 'scores' | 'pause';
  };
  /** Teleop before the endgame, in order. Whatever time they leave before
   *  the endgame is one more period, `teleop`. Absent = all of it is `teleop`. */
  teleopPeriods?: TeleopPeriod[];
  /** Game data sent to the Driver Station. Absent = none. */
  gameData?: GameDataRule;
  /** Scoring elements to start with when none are configured. */
  elements?: ScoringElementConfig[];
  /** Set by pFMS, not by authors: which rules a loaded plugin computes. */
  ruleHooks?: GameRuleHook[];
}

/** What a plugin hook is told about the instant being judged. */
export interface GameRuleContext {
  game: GameDefinition;
  /** The phase that matters for the rules — the pre-pause phase while paused. */
  phase: MatchPhase | undefined;
  /** Seconds left in `phase`. */
  remaining: number;
  /** Seconds since teleop began, or null outside teleop/endgame. */
  teleopElapsed: number | null;
  autoWinner: Alliance | null;
}

/**
 * A game written in code. The default export of a `games/*.js|mjs|ts` file.
 * Each hook may return `undefined` to use the declarative rule for that
 * instant. Hooks must be pure and fast: they run on every match tick and
 * again for every late score report.
 */
export interface GamePlugin {
  definition: GameDefinition;
  /** Sub-period id at this instant, or null for none. */
  subPeriod?(ctx: GameRuleContext): string | null | undefined;
  /** Whose goal is off at this instant (null = both on). */
  inactiveGoal?(ctx: GameRuleContext): Alliance | null | undefined;
  /** Text for the Driver Station game-data field (null = none). */
  gameData?(ctx: GameRuleContext): string | null | undefined;
  /** Who won auto, given the points each alliance scored in it. */
  autoWinner?(scores: { red: number; blue: number }): Alliance | undefined;
}

/** Where a game came from. */
export type GameSource = 'builtin' | 'file' | 'plugin';

/** One line of the admin page's game list. */
export interface GameCatalogEntry {
  /** Absent when the file is too broken to have one. */
  id?: string;
  name?: string;
  season?: number;
  description?: string;
  source: GameSource;
  /** File name in the games directory (not built-ins). */
  file?: string;
  /** Why it isn't loadable. A game with errors can't be selected. */
  errors?: string[];
  /** The definition, for loadable games. */
  definition?: GameDefinition;
}

/** A sub-period as the UI draws it. */
export interface GamePeriod {
  id: string;
  label: string;
  short: string;
  duration: number;
  goalOff?: GoalOffRule;
  cue?: GameCueSound;
  /** Which match phase it belongs to. */
  phase: 'auto' | 'teleop' | 'endgame';
}
