# Games

Everything about a season's game that pFMS needs lives in one swappable
**game layer**: the match timing, the teleop periods and whose goal each
switches off, the auto winner, the game data sent to the Driver Station,
starter scoring elements, and per-period sound cues. The rest of pFMS — the
match lifecycle, the ready check, E-Stop and A-Stop, the Driver Station
protocol, the radio — is the same whatever game is loaded.

Swapping seasons means loading another game, not editing the core. And a
field can run a game of its own, written as a small JSON file or, for rules
JSON can't express, as a JS/TS plugin.

## Built-in games

| Id             | Game           | Timing (auto / pause / teleop / endgame) | Rules                                                                                                                                                    |
| -------------- | -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebuilt-2026` | REBUILT (2026) | 20 / 3 / 140 / 30 s                      | 10 s transition, then four 25 s shifts: the auto winner's hub is off in shifts 1 and 3, the loser's in 2 and 4. Game data `R`/`B` names the auto winner. |
| `generic`      | Generic match  | 15 / 3 / 135 / 20 s                      | None: both goals on all match, no auto winner, no game data. Points come from the scoring elements alone.                                                |

REBUILT is the default: a field that never picks a game runs it, and every
match recorded before game layers existed was a REBUILT match.

## Choosing the game

On **`/admin` → Match → Game**, every game the field can run is listed:
the built-ins, plus every file in the games directory, with the reason any
of them failed to load. **Use this game** switches it. The choice is saved
as the `game` setting in `setup-config.json`.

A switch applies to the next match, and to a match that is set up but not
started yet (its ready check closes, since what's about to run changed). A
match that is running or finished keeps the game it was set up with: the
game is snapshotted into the match's config, so a switch mid-match can never
change the rules under it.

If the selected game can't be loaded (its file was removed, or now has an
error), matches run REBUILT and the Game card says so.

The match page shows which game is set up above the timeline bar. A
[speed challenge](match-system.md#speed-challenge) isn't a match of any
game: it ignores the game's periods, as it always has.

## Where custom games live

Custom games go in a `games/` directory **beside `setup-config.json`**
(set `GAMES_DIR` to put it elsewhere). It's read at startup and whenever
someone presses **Reload games** on `/admin`.

| File                     | What it is                                                      |
| ------------------------ | --------------------------------------------------------------- |
| `*.json`                 | A declarative game (below)                                      |
| `*.js`, `*.mjs`, `*.ts`  | A [plugin](#plugins): a game definition plus rule hooks in code |
| anything else, dot-files | Ignored                                                         |

**JSON games can be uploaded from `/admin`** (saved as `<id>.json`), and
uploaded ones deleted from there. **Plugins can't**: a plugin is code that
runs as the pFMS service, so letting the admin page write one would turn the
admin passphrase into a way to run anything on the host. Put plugins in the
directory by hand, with access to the host.

A game whose id is already taken (by a built-in or another file) is listed
as broken rather than replacing it.

## Writing a game in JSON

A complete example is
[`samples/games/king-of-the-hill.json`](../samples/games/king-of-the-hill.json):

```json
{
  "id": "king-of-the-hill",
  "name": "King of the Hill",
  "description": "One goal at a time: red holds the hill, then blue, then a free-for-all.",
  "timing": { "autoDuration": 15, "pauseDuration": 3, "teleopDuration": 120, "endgameDuration": 20 },
  "teleopPeriods": [
    { "id": "red-hill-1", "label": "Red holds", "short": "RED", "duration": 25, "goalOff": "blue", "cue": "warning" },
    { "id": "blue-hill-1", "label": "Blue holds", "short": "BLUE", "duration": 25, "goalOff": "red", "cue": "warning" },
    { "id": "free-for-all", "label": "Free for all", "short": "FFA", "duration": 20, "cue": "start" }
  ],
  "gameData": { "kind": "fixed", "text": "KOTH" },
  "elements": [
    { "id": "ball", "name": "Ball", "pointValue": 2 },
    { "id": "climb", "name": "Climb", "pointValue": 5, "activePhases": ["endgame"] }
  ]
}
```

| Field           | Required | Meaning                                                                                                                                                                                                      |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | yes      | Lowercase letters, digits and dashes. Stable: it's how the `game` setting and match history refer to the game.                                                                                               |
| `name`          | yes      | Shown on `/admin`, the match page and in history.                                                                                                                                                            |
| `season`        |          | A year, shown after the name.                                                                                                                                                                                |
| `description`   |          | One line for `/admin`.                                                                                                                                                                                       |
| `timing`        | yes      | `autoDuration` (0 = no auto), `pauseDuration` (robots disabled between auto and teleop), `teleopDuration` (endgame included), `endgameDuration` (the last N s of teleop; 0 = none). Seconds.                 |
| `autoWinner`    |          | Present if the game has an auto winner: `{ "default": "scores" }` (decided by auto points, a tie at random) or `"pause"` (the host picks one in the pause after auto). Absent: the host's control is hidden. |
| `teleopPeriods` |          | Teleop before the endgame, in order (below). Time they leave unclaimed is one more period, `teleop`.                                                                                                         |
| `gameData`      |          | What the Driver Station's game-data field carries (below).                                                                                                                                                   |
| `elements`      |          | [Scoring elements](scoring.md#key-concepts) to start with (below).                                                                                                                                           |

Unknown fields are refused, so a misspelt `teleopPeriod` is an error on
`/admin` rather than a game that quietly has no periods.

### Teleop periods and goals

Each entry in `teleopPeriods` is:

| Field      | Meaning                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | The sub-period's id in score breakdowns and `matchState.subPeriod`. Not `auto`, `teleop` or `endgame`, which pFMS adds itself.                             |
| `label`    | Full name, e.g. "Shift 1".                                                                                                                                 |
| `short`    | A few characters for the timeline bar, e.g. "S1".                                                                                                          |
| `duration` | Seconds.                                                                                                                                                   |
| `goalOff`  | Whose goal is off: `red`, `blue`, `autoWinner` or `autoLoser` (the last two need `autoWinner`, and leave both goals on until it's known). Absent: both on. |
| `cue`      | A field sound when the period begins: `start`, `end`, `resume`, `warning`, `pause` or `getready`.                                                          |

While an alliance's goal is off, balls it scores don't count toward the
match (they show as "off-goal" on the scoreboard). The same 3 s in-flight
grace applies as for REBUILT's shifts, and pausing the match turns both
goals off just the same. See [scoring.md](scoring.md#key-concepts).

A period's `cue` doesn't play on the way into teleop (the teleop horn does)
or when a match resumes; the speaker plays one clip at a time.

### Game data

- `{ "kind": "autoWinner", "red": "R", "blue": "B" }` — once the auto
  winner is known (the pause after auto, then teleop and endgame), the
  winner's string. REBUILT's rule. Needs `autoWinner`.
- `{ "kind": "fixed", "text": "KOTH" }` — the same text from the countdown
  to the buzzer.

At most 8 plain ASCII characters: the 2027 Driver Station reads no more.

### Scoring elements

A game's `elements` are what the scoring engine starts with, **unless
someone has configured elements themselves** (`PUT /api/score/config`):
those always win and a game switch leaves them alone. Switching from a game
that brought elements to one that brings none clears them. Elements change
with the match, not the selection: a switch while a match runs takes effect
once that match clears, so its sensors' reports keep counting. `/admin` marks
the game whose elements are in use.

## Plugins

A plugin is for a rule JSON can't say, or says badly. A complete example is
[`samples/games/hot-goal.ts`](../samples/games/hot-goal.ts): after the auto
winner's head start, the goals take turns every 10 s, and an auto tie goes
to blue instead of a coin flip.

```ts
import type { GamePlugin } from '../../src/game/types.js'; // erased at load time

const plugin: GamePlugin = {
  definition: {
    id: 'hot-goal',
    name: 'Hot Goal',
    timing: { autoDuration: 15, pauseDuration: 3, teleopDuration: 140, endgameDuration: 20 },
    autoWinner: { default: 'scores' },
    teleopPeriods: [{ id: 'turns', label: 'Turns', duration: 120 }],
  },
  inactiveGoal(ctx) {
    if (ctx.phase !== 'teleop' || ctx.teleopElapsed === null || !ctx.autoWinner) return undefined;
    return Math.floor(ctx.teleopElapsed / 10) % 2 === 0 ? 'red' : 'blue';
  },
  autoWinner: scores => (scores.red === scores.blue ? 'blue' : undefined),
};
export default plugin;
```

The default export is `{ definition, ...hooks }`. `definition` is an
ordinary game (everything in the JSON section applies) and is still what
the timeline bar, scoreboard and history draw, so give it the periods people
should see. The hooks, all optional:

| Hook                 | Returns                                                | Replaces                     |
| -------------------- | ------------------------------------------------------ | ---------------------------- |
| `subPeriod(ctx)`     | sub-period id, or `null`                               | which period it is           |
| `inactiveGoal(ctx)`  | `'red'`, `'blue'` or `null` (both on)                  | whose goal is off            |
| `gameData(ctx)`      | up to 8 characters, or `null`                          | the Driver Station game data |
| `autoWinner(scores)` | `'red'` or `'blue'`, given `{ red, blue }` auto points | the auto winner decision     |

`ctx` is `{ game, phase, remaining, teleopElapsed, autoWinner }`: the phase
that matters for the rules (the pre-pause one while paused), seconds left in
it, seconds since teleop began (`null` outside teleop/endgame), and the auto
winner if known.

**Return `undefined` to fall back** to the definition's declarative rule for
that instant. Hooks must be pure and fast: they run on every match tick and
again whenever a late score report is judged at the instant it scored. A
hook that throws, or returns something that isn't an answer, is logged once
and the declarative rule is used instead, so a bug can't stall a match.

**The browser can't run hooks.** For whatever a plugin computes, the match
page, timer and scoreboard show the value the server broadcasts four times a
second instead of working it out locally, and the scoreboard shows no 3 s
in-flight grace for a hooked goal rule (scoring itself still applies the
grace).

**Loading:** pFMS `import()`s the file, which works from the single-file
binary and under Bun for `.js`, `.mjs` and `.ts`. Running from `node dist`
loads `.js`/`.mjs` only. `import type` lines are erased, so the path in the
example only needs to resolve in your editor. After editing a plugin, press
**Reload games**; a match already set up keeps the rules it started with.

## How the rest of pFMS sees a game

- **`matchState`** carries the game in `config.game`, plus the live
  `subPeriod` and `inactiveGoalAlliance`. REBUILT's sub-period ids
  (`auto`, `transition`, `shift1`–`shift4`, `endgame`) and those two field
  names are a contract with the ball counter; they don't change.
- **Score breakdowns** (`periodBreakdown` in score state and match history)
  are keyed by the game's sub-period ids, in match order.
- **Match history** records `game: { id, name, season }` for every match
  (not challenge runs), and the public summary page shows it.
- **Audio**: phase sounds are the same for every game
  ([match-system.md](match-system.md#match-audio)); a game adds only its
  period `cue`s.
