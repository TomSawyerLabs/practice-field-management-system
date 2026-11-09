# Game layers: swappable season rules

## Goal

Turn pFMS's season-specific match and scoring logic into a swappable
**game layer**. Each FRC season (2026 REBUILT now, 2027 next) is one
self-contained layer that can be switched without touching the core, and
teams/fields can define their **own custom games** without forking.

Asked for by the user in a review comment on the Chief Delphi intro post
draft (`plans/chiefdelphi-intro-post-draft.md`, "Game-agnostic scoring"
bullet): _"Can we make each year a game "layer" that can easily be swapped
out? Can teams use this system as a base for their own custom games?"_

## Environment / context

- Worktree `C:\Users\camer\.t3\worktrees\practice-field-configurator\feat-game-layers`,
  branch `feat/game-layers` from local master (`3ba8a96`). Don't push or merge
  into master without asking.
- Checks: `bun run typecheck`, `bun test` (backend, `src/**/*.test.ts`) and the
  frontend tests (`frontend/src/**/*.test.ts`).
- Never test against field hardware: `DRY_RUN=1` plus a fake `RADIO_URL`.
- The CD draft is owned by the CD-post thread. Don't edit it; propose wording.

## Inventory (season-specific code, as of `3ba8a96`)

### Backend

| Where                                              | What                                                                                                                                                                                                                                | Kind      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `src/shiftState.ts` (whole file)                   | REBUILT shift rules: `TRANSITION_DURATION=10`, `SHIFT_DURATION=25`, `MatchSubPeriod` union (`auto`/`transition`/`shift1-4`/`endgame`), `getMatchSubPeriod`, `getAllianceShiftState` (which goal is off), `getAllianceScoringShifts` | rule      |
| `src/matchEngine.ts:102-111`                       | `OFFICIAL_CONFIG`: 20 s auto, 3 s pause, 140 s teleop, 30 s endgame, `autoWinner: 'scores'`                                                                                                                                         | timing    |
| `src/matchEngine.ts:1064-1088` `updateMatchConfig` | official durations forced from `OFFICIAL_CONFIG`; only `skipAuto`/`autoWinner` settable                                                                                                                                             | timing    |
| `src/matchEngine.ts:1244-1278` `startMatch`        | skip-auto requires a pre-set auto winner (REBUILT needs one for shifts)                                                                                                                                                             | rule      |
| `src/matchEngine.ts:2060-2087` `getState`          | computes `subPeriod` and `inactiveGoalAlliance` via shiftState (skipped for challenge)                                                                                                                                              | rule      |
| `src/matchEngine.ts:2256-2294` `computeAutoWinner` | auto winner from auto scores, random tiebreak ("REBUILT picks randomly")                                                                                                                                                            | rule      |
| `src/matchEngine.ts:2487-2495`                     | DS game data: `R`/`B` = auto winner, sent in autoPause/teleop/endgame                                                                                                                                                               | game data |
| `src/matchTimeline.ts:60,135-145`                  | `MatchMoment.subPeriod`/`inactiveGoal` from shiftState; `GOAL_GRACE_SECONDS=3` (in-flight grace)                                                                                                                                    | rule      |
| `src/scoringEngine.ts:17,100,712`                  | imports `getMatchSubPeriod` (unused?); period breakdown hard-codes the 7 REBUILT period ids                                                                                                                                         | scoring   |
| `src/scoringApi.ts:495-505`                        | OpenAPI text: "auto, transition, shift1–4, endgame", "goal had been off (shift or pause)"                                                                                                                                           | docs      |
| `src/types.ts:1215,1509-1514,3097,3195`            | comments + `MatchState.subPeriod: MatchSubPeriod` type (imports from shiftState)                                                                                                                                                    | types     |
| `src/matchAudio.ts:300-350`                        | field audio is **phase**-driven only (start/end/resume/warning/pause/abort). No per-shift cue. Generic FRC already.                                                                                                                 | audio     |
| `src/fmsServer.ts:747-806`                         | game-data tag encoding per DS generation (2027 DS ≤ 8 bytes). Protocol, not season.                                                                                                                                                 | protocol  |
| `src/index.ts:1687,1834-1848`                      | game-data field reused for status text ("Multiple DSes Detected"). Not season.                                                                                                                                                      | protocol  |
| Scoring elements                                   | **No defaults exist.** Elements are in-memory, set by `PUT /api/score/config` or auto-registered (limit 1). Not persisted.                                                                                                          | scoring   |

### Frontend

| Where                                                                           | What                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/utils/shiftState.ts`                                              | re-exports `src/shiftState.ts`                                                                                                                                                                                                          |
| `frontend/src/components/MatchTimeline.tsx:38-170, 525-827`                     | `OfficialTimeline`: hard-coded bar AUTO / pause / TS / S1-S4 / END GAME, own copy of 10/25/30 s constants and a fixed `PERIODS` table (20 s auto, 3 s pause), shift colouring by auto winner, "Auto Winner (REBUILT game data)" control |
| `frontend/src/components/ScoreboardPage.tsx:33,85-98,383-405,456-460,2552-2640` | background tint from shift state, goal-off/grace display, current sub-period, `PeriodBreakdown` table with fixed rows (Auto, Transition, two "your" shifts, Endgame)                                                                    |
| `frontend/src/components/MatchControlPage.tsx:96,114-130,1060-1082`             | page tint by shift; timer pulse at hard-coded `teleopDur - 10/35/60/85/110` boundaries                                                                                                                                                  |
| `frontend/src/components/MatchTimer.tsx:3,28-37`                                | timer colour by shift                                                                                                                                                                                                                   |
| `frontend/src/components/MatchSummaryPage.tsx:178`                              | `PeriodTable` renders whatever keys `periodBreakdown` has (generic already)                                                                                                                                                             |
| `frontend/src/hooks/useMatchAudio.ts`                                           | browser audio, phase-driven, mirrors `matchAudio.ts` (generic FRC)                                                                                                                                                                      |
| `frontend/src/utils/matchFormat.ts`                                             | phase labels (Auto/Teleop/Endgame), generic                                                                                                                                                                                             |

### External contract (must not break)

The ball counter (balls-counter) reads `/ws/scores` `MatchState.phase`,
`matchId`, `subPeriod`, `inactiveGoalAlliance`, mirrors the 3 s grace
(`docs/scoring.md`, guarded by `src/matchEngine.test.ts`). REBUILT's
sub-period ids (`transition`, `shift1`..`shift4`) and both field names stay
exactly as they are. Match history `periodBreakdown` keys stay the same.

### Not season-specific (left alone)

The FRC phase machine (countdown → auto → autoPause → teleop → endgame →
postMatch), e-stop/A-stop, DS protocol, radio/network, challenge format
(a field event, orthogonal to which game is loaded).

## Design

### Key observation

Every REBUILT rule fits a small **declarative** vocabulary: teleop is a list
of timed periods, and each period says whose goal is off — `autoWinner`,
`autoLoser`, or nobody. Game data is "the auto winner's initial while the
winner is known". So a game can be pure JSON data, and **the frontend can
evaluate the same rules** (the scoreboard interpolates the clock locally and
needs shift state every frame). Code hooks can't run in the browser, so a
declarative definition is not just simpler for custom games — it's the only
form both halves can share.

### `GameDefinition` (JSON-serialisable, `src/game/types.ts`)

```ts
interface GameDefinition {
  id: string; // 'rebuilt-2026', 'generic', 'my-game'
  name: string; // 'REBUILT' — shown on /match, scoreboard, history
  season?: number; // 2026
  description?: string;
  timing: {
    autoDuration: number; // 0 = no auto
    pauseDuration: number; // auto→teleop scoring delay
    teleopDuration: number; // includes endgame
    endgameDuration: number; // last N s of teleop
  };
  /** Does the game have an auto winner, and how is it decided by default. */
  autoWinner?: { default: 'scores' | 'pause' | 'red' | 'blue'; tiebreak: 'random' };
  /** Teleop before the endgame, split into named periods (sum ≤ teleop − endgame;
   *  any remainder is one trailing 'teleop' period). Absent = one 'teleop' period. */
  teleopPeriods?: {
    id: string; // sub-period id on the wire ('transition', 'shift1')
    label: string; // 'Shift 1'
    short: string; // 'S1' (timeline bar)
    duration: number;
    goalOff?: 'autoWinner' | 'autoLoser'; // whose goal is inactive
    cue?: SoundName; // field audio at period start (none for REBUILT)
  }[];
  /** What the DS game-data field carries. */
  gameData?: { kind: 'autoWinner'; red: string; blue: string } | { kind: 'fixed'; text: string };
  /** Scoring elements seeded when none are configured. */
  elements?: ScoringElementConfig[];
}
```

Pure functions over it (`src/game/rules.ts`, shared front/back, replacing
`shiftState.ts`): `subPeriodAt(game, phase, remaining)`,
`inactiveGoalAt(game, phase, remaining, autoWinner)`,
`periodIds(game)`, `periodBoundaries(game)` (for the host timer pulse and the
timeline bar), `scoringPeriodsFor(game, alliance, autoWinner)`,
`gameDataFor(game, phase, autoWinner)`.

### Built-in layers (`src/game/builtin/`)

- `rebuilt-2026` — today's behaviour exactly: 20/3/140/30, transition 10 s +
  shift1-4 at 25 s alternating `autoWinner`/`autoLoser`, game data R/B,
  auto winner by scores with random tiebreak, no elements, no cues.
- `generic` — 15 s auto, 3 s pause, 135 s teleop, 20 s endgame, no auto
  winner, no shifts, no game data. Sub-periods `auto`, `teleop`, `endgame`.
- Example custom game JSON in `samples/games/` and in docs.

### Code plugins (user chose JSON + runtime JS plugins, 2026-11-07)

A plugin is a `.js`/`.mjs`/`.ts` file in `games/` whose default export is
`{ definition, subPeriod?, inactiveGoal?, gameData?, autoWinner? }`. The
`definition` is an ordinary `GameDefinition` (periods, timing, labels — what
the UI draws). Each hook gets a context (`phase`, `remaining`,
`teleopElapsed`, `autoWinner`, the definition) and returns a value or
`undefined` to fall back to the declarative rule. Hooks run **server side
only**:

- The server already broadcasts `subPeriod` and `inactiveGoalAlliance` in
  every `matchState` (4/s). The registry marks a plugin game's definition with
  `ruleHooks: [...]`, and clients use the broadcast values instead of
  evaluating locally for the hooked rules. A declarative game keeps the
  smooth local evaluation.
- A hook that throws or returns junk is logged once per match and the
  declarative rule is used, so a bad plugin can't stall the match tick.
- Verified 2026-11-07: a `bun build --compile` binary `import()`s both `.ts`
  and `.js` from disk, and type-only imports of modules that don't exist are
  erased (so plugins can `import type` the pFMS types without a package).
- Built-in REBUILT stays declarative: it proves the vocabulary and keeps the
  scoreboard's local evaluation.

### Where the active game lives

- `SetupSettings.game?: string` — id of the selected layer. Absent =
  `rebuilt-2026` (no behaviour change on upgrade). Switch on `/admin` (live
  settings), validated against the known ids.
- The **definition is snapshotted into `MatchConfig.game`** when a match is
  created/started, so a match runs on the rules it started with even if staff
  switch games mid-match, and every client reads the rules from the
  `matchState` it already receives. History entries record `game: {id, name}`.
- Switching takes effect on the pending config only while no match is running.
- The challenge format stays orthogonal: `format: 'challenge'` ignores the
  game's periods (as now).

### Custom games — where they come from (user chose "both", 2026-11-07)

- A `games/` directory next to `setup-config.json` (override with
  `GAMES_DIR`). `*.json` = declarative game, `*.js|*.mjs|*.ts` = plugin.
  Scanned at startup and on "Reload" in `/admin`.
- `/admin` lists every game (built-in, file, plugin) with validation errors,
  selects the active one, and **uploads JSON** games (written into `games/`)
  or deletes uploaded JSON files.
- **Plugins are disk-only — no web upload.** A plugin is arbitrary code
  running as the field service; letting the admin page write one would turn
  the admin passphrase into remote code execution on the host. Dropping a
  file in `games/` needs shell access, which already means full control.

## Decisions already made (don't re-ask)

- REBUILT moves first with **no behaviour change**; existing tests must pass.
- Wire contract with balls-counter is frozen (ids + field names above).
- E-stop, network and radio behaviour are out of scope.
- The CD draft is not edited here; wording is proposed to the user.
- Custom games: declarative JSON **and** runtime JS/TS plugins (user, 2026-11-07).
- Storage: `games/` dir **and** `/admin` upload (user, 2026-11-07). Web upload
  is JSON only (security call, see "Custom games" above).

## Plan / steps

1. [x] Inventory (above).
2. [x] Design (above). Open questions answered 2026-11-07.
3. [x] `src/game/` types, rules, built-ins (`rebuilt-2026`, `generic`), unit
       tests incl. a parity test: rules(rebuilt) == old shiftState at every
       0.25 s of a match for both auto winners (`src/game/rules.test.ts`,
       reference copy in `src/game/legacyShiftState.fixture.ts`).
4. [x] Backend wired to the layer: matchEngine (timing, auto winner, game
       data, sub-period/inactive goal), matchTimeline, scoringEngine breakdown
   - game element seeding, setup setting `game` + validator, history
     `game`, per-period audio cues (server + browser). Engine-level
     boundary tests in `src/game/matchEngineGames.test.ts`.
     Registry (`src/game/registry.ts`) loads `games/*.json` and plugins,
     WS `gameCatalog` / `gameUpload` / `gameDelete` / `gameReload`.
5. [x] Frontend wired: MatchTimeline bar from the game's periods (game
       name shown, auto-winner control only for games with one),
       ScoreboardPage tint/grace/breakdown, MatchControlPage tint & pulse,
       MatchTimer, `/admin` Match tab "Game" card (`GameSection.tsx`: select,
       list + load errors, JSON upload, delete, reload). `shiftState.ts`
       (both) deleted. End-to-end WS test: `src/game/gameAdmin.test.ts`.
6. [x] Samples: `samples/games/king-of-the-hill.json` (fixed-alliance
       goals, cues, fixed game data, elements) and `samples/games/hot-goal.ts`
       (plugin: computed turns + tie rule); a registry test loads both.
       scoringApi OpenAPI text made game-neutral.
7. [x] Docs: new `docs/games.md` (full reference), `docs/scoring.md`,
       `docs/match-system.md`, `docs/configuration.md` (`GAMES_DIR`),
       `docs/README.md`, README "Writing your own game"; public summary page
       shows the game.
8. [x] Self-review fixes (`e1da6c0`): elements follow the match not the
       selection; content compare so reload keeps readiness; clear shows a
       switched game; skip-auto reset when the new game needs a winner.
9. [ ] **← current** CD-draft wording proposed to the user (not edited here;
       the CD-post thread owns the draft). Waiting on the user to merge
       `feat/game-layers` into master and hand the wording over.

## Findings / gotchas

- `MatchSummaryPage`'s `PeriodTable` already renders arbitrary breakdown keys.
- Audio has no shift cues today; a per-period `cue` is new capability, unused
  by REBUILT so behaviour doesn't change.
- `ScoringEngine` has no default elements and doesn't persist them; a game's
  `elements` seed it only while nobody configured their own
  (`applyGameElements`; the API's `setElements` takes over for good).
- **Bun ignores `?query` and `#hash` on file-URL imports** — the module cache
  is by path, so `import(url + '?v=2')` returns the old module (verified,
  Bun 1.4.2, also in a `--compile` binary). Reload imports an edited plugin
  from a throwaway dot-file copy beside the original, then deletes it.
- **`DRY_RUN=1` breaks 27 unrelated tests** (robotTestMonitor, wifiCards,
  fieldTimelapse, fmsServer handshake): "Dry run: the robot radio was not
  updated". None import the game code; fmsServer passes 13/13 without it.
  Baseline for the full `bun test src` run here: 1254 pass / 27 fail.
- An untimed score report within 5 s of a phase change is judged just before
  it (phase grace) — a test that scores 1 s into teleop sees it land in auto.
  Use `ageMs: 0` for a timed event in tests.
- `wsAccess.test.ts` keeps its own `ADMIN_ONLY` list; a new `adminOnly`
  message must be added there too.
- `frontend/node_modules` in this worktree has TypeScript 5.9.3 (pnpm
  install from worktree setup?) vs 5.8.2 at the root: `cd frontend && bun
run build` fails in untouched `NudgeSettings.tsx` (Uint8Array/BufferSource).
  Root `bun run typecheck` passes; `bunx vite build` bundles fine.
- A plugin-hooked rule shows no 3 s grace on the scoreboard: the browser only
  has the server's present value, not the history to tell grace from off.
- Plugins work from the single binary and Bun; `node dist` can load `.js`
  / `.mjs` plugins but not `.ts`.

## Progress log

- [x] 2026-11-07: inventory + design written.
- [x] 2026-11-07: user chose JSON + JS plugins, games/ dir + /admin upload.
- [x] 2026-11-08: game core, registry, backend wiring, audio cues; 37 game
      tests + all match/scoring/history/wsAccess suites green.
- [x] 2026-11-08: samples, docs, self-review fixes; full suite 1284 pass /
      27 known env failures; frontend 156 pass.
- [ ] Not done: no visual check of the new UI in a browser (typecheck,
      vite bundle and WS end-to-end test only).
- [x] 2026-11-08: frontend + /admin game card; full suite 1279 pass / 27
      known env failures; frontend 156 pass; vite bundle builds.

## Open questions for the user

1. Merge `feat/game-layers` into master (and deploy via the deploy-owner
   thread)? Recommendation: yes after a look at the /admin Game card and the
   match page in a browser.
2. Pass the proposed CD wording (in the thread's final message) to the
   CD-post thread?

(Earlier: 1: plugins too; 2: both — answered 2026-11-07.)

## Things not to do

- Don't rename `subPeriod` / `inactiveGoalAlliance` or REBUILT's period ids.
- Don't let a game switch change the rules of a match already running.
- Don't edit `plans/chiefdelphi-intro-post-draft.md`.
