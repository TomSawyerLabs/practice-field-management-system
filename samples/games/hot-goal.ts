/**
 * Hot Goal: a sample pFMS game plugin.
 *
 * Copy this file into the `games/` directory beside `setup-config.json`
 * (or `GAMES_DIR`), then press "Reload games" on /admin. A plugin is code
 * running as the field service, so it can only be put there by someone with
 * access to the host — /admin uploads JSON games only.
 *
 * Use a plugin for a rule the JSON vocabulary can't say, or says badly.
 * Here: after the auto winner's head start, the goals take turns being off
 * every 10 seconds — twelve periods that would be tedious to write out — and
 * an auto tie goes to blue instead of a coin flip.
 *
 * The `definition` is still what the timeline bar, scoreboard and history
 * draw, so give it the periods people should see. The hooks override the
 * declarative rules on the server; return `undefined` to fall back to them.
 * The browser can't run hooks, so it shows the server's broadcast value for
 * whatever a hook computes (and no 3 s in-flight grace on the scoreboard).
 *
 * The `import type` below is erased when pFMS loads the file, so it doesn't
 * matter that the path doesn't exist on the field host: it is only there for
 * your editor while you write the plugin in a pFMS checkout.
 */
import type { GamePlugin } from '../../src/game/types.js';

const TURN = 10;
const HEAD_START = 20;

const plugin: GamePlugin = {
  definition: {
    id: 'hot-goal',
    name: 'Hot Goal',
    description: 'The goals take turns every 10 s; the auto winner scores first.',
    timing: { autoDuration: 15, pauseDuration: 3, teleopDuration: 140, endgameDuration: 20 },
    autoWinner: { default: 'scores' },
    teleopPeriods: [
      { id: 'head-start', label: 'Head start', short: 'HEAD', duration: HEAD_START, goalOff: 'autoLoser' },
      { id: 'turns', label: 'Turns', short: 'TURNS', duration: 100 },
    ],
    gameData: { kind: 'autoWinner', red: 'R', blue: 'B' },
  },

  /** During "turns", whose goal is off flips every TURN seconds, starting
   *  with the auto winner's (the loser had to wait through the head start). */
  inactiveGoal(ctx) {
    if (ctx.phase !== 'teleop' || ctx.teleopElapsed === null || !ctx.autoWinner) return undefined;
    const intoTurns = ctx.teleopElapsed - HEAD_START;
    if (intoTurns < 0 || intoTurns >= 100) return undefined; // head start / endgame: the declarative rule
    const loser = ctx.autoWinner === 'red' ? 'blue' : 'red';
    return Math.floor(intoTurns / TURN) % 2 === 0 ? ctx.autoWinner : loser;
  },

  /** A tie in auto goes to blue; anything else, the higher score. */
  autoWinner(scores) {
    return scores.red === scores.blue ? 'blue' : undefined;
  },
};

export default plugin;
