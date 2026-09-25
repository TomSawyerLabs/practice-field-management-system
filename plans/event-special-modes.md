# Speed Challenge — a special match format for field events

## Goal

A team is hosting an event on the practice field the weekend of **2026-09-26/27**
and wants two non-standard activities alongside normal matches: a **speed
challenge** and an **obstacle course**. Both are the same shape — a robot is
enabled for a fixed window and does as many laps of a course as it can.

The user's framing, which corrected the initial reading of this work:

> It's not a time trial — the goal is not to get close to a time. It's a "speed
> challenge". So just a simple time setting for the enable makes sense.
> I assume it's a "how many laps in X seconds" kind of challenge.

So the primary mode is **laps in a window**, not a stopwatch. A stopwatch
variant is a secondary nice-to-have ("or maybe we make both?"), stopped by a
staff button — there is no finish-line sensor and no time to build a vision
system.

## Environment / context

- Repo: `C:\Users\camer\git\practice-field-configurator` (pFMS), deploys to
  steamboat. ~5 days of lead time before the event.
- Relevant code:
  - `src/matchEngine.ts` — the only thing in pFMS that controls robot
    enable/disable. Phases, timing, ready check, e-stop, DS packets.
  - `src/websocketServer.ts` (~line 838) — the WS command dispatch chain, where
    new controller messages are wired to engine methods.
  - `src/types.ts` — `MatchConfig`, `MatchPhase`, `MatchState`, and the
    `is*()` type guards each WS message needs.
  - `src/shiftState.ts` — REBUILT shift scoring, assumes a 140 s teleop.
  - `src/matchRecorder.ts` / `src/matchHistoryStore.ts` — per-match video and
    history, both keyed off the match lifecycle.
  - `src/practiceStore.ts` — the precedent for a per-team result store kept
    deliberately separate from field-wide match history.
  - Frontend: `MatchControlPage.tsx` (host), `ScoreboardPage.tsx` (TV),
    `MatchTimeline.tsx` (pre-match config bar), `MatchTimer.tsx`,
    `hooks/useBackend.ts` (WS send helpers).

## Decisions already made (don't re-ask)

1. **Approach: Option A** — a new _format_ inside `MatchEngine`, not a separate
   engine and not a display-only clock. Rationale in "Findings" below: pFMS
   only controls robots inside a match, so field-enforced start/stop has to
   live in the match path.
2. **Primary mode is laps in a fixed window.** Not a precision time trial.
3. **Stopwatch variant is in scope too**, stopped by a staff button. No sensor,
   no vision.
4. **Support both one robot and head-to-head** (red vs blue racing). The engine
   handles two alliances natively so this is nearly free, and it spectates
   better.
5. **Results get a TV leaderboard, history entries with video links, and a
   penalty button** — all three were asked for.
6. Penalty costs are **set per run on the setup screen** (default −1 lap /
   +5 s), not baked-in constants — the user asked for this after the first
   pass. They carry over between runs like the window does, so an event host
   sets them once. Zero is allowed, meaning "tally fouls but don't score
   them". Each finished run records the cost it was scored under, so changing
   it mid-event applies from the next run rather than re-scoring the morning.

## Findings that constrain the design

1. **pFMS only controls robots inside a match.** `sendDSPacket()` is called
   only for stations with `joined === true`, and `sendJoinedHeartbeat()` skips
   everything else. When the field is idle, pFMS sends no control packets at
   all and teams enable their own robots from their DS. So any mode that
   enforces "robot goes live on the horn and is disabled when the clock
   expires" has to run through `MatchEngine`. A separate engine would have to
   duplicate the DS packet path, sequence numbers, the 2027-DS endpoint
   learning, e-stop, and duplicate-DS blocking.

2. **Durations are deliberately locked.** `updateMatchConfig()` ignores every
   duration a client sends and rewrites the config from `OFFICIAL_CONFIG`
   (20 s auto / 140 s teleop / 30 s endgame); only `skipAuto` and `autoWinner`
   survive. The new format must unlock durations _only_ for itself — a real
   match must stay impossible to start with a wrong clock.

3. **A one-robot match already works.** `startMatch()` only requires ≥ 1 joined
   station; a single robot joins red and gets slot `red1`.

4. **Count-up time is already tracked.** `MatchState.totalMatchTime`
   accumulates every tick, so a stopwatch display needs no new backend state.

5. **Shift scoring would misfire.** `getMatchSubPeriod()` derives
   transition/shift1-4/endgame from `teleopDuration` assuming 140 s. With a
   60 s run it would report bogus shifts and deactivate a goal. Must be
   bypassed for the new format (`subPeriod: null`, `inactiveGoalAlliance:
null`), as must the auto-winner game-data tag sent to the DS during teleop.

6. **`skipAuto` alone won't do.** `startMatch()` refuses to start a skip-auto
   match unless the auto winner is pre-set to red or blue — and pre-setting it
   turns on the shift tinting and the game-data byte. The challenge format has
   to bypass that guard and leave `autoWinnerAlliance` null.

7. **Endgame is skipped for free.** The teleop→endgame check is
   `remainingTime <= endgameDuration` inside the `remainingTime > 0` branch, so
   `endgameDuration: 0` can never trigger it.

8. **Video and share links come free** if the run is a match: `MatchRecorder`
   records every match from the field streams and `publicMatchApi` mints a
   share token and QR. Each challenge run automatically produces a
   downloadable clip for the team.

## Design

**`MatchConfig` gains a format.**

```ts
format?: 'official' | 'challenge'; // default 'official'
challengeTiming?: 'window' | 'stopwatch'; // challenge only
```

Under `format: 'challenge'`, `updateMatchConfig()` accepts a host-set
`teleopDuration` (default 60 s, clamped to a sane range) and forces
`autoDuration: 0`, `pauseDuration: 0`, `endgameDuration: 0`, `skipAuto: true`.
Under `official` the existing lock is untouched.

**Lifecycle is unchanged**: created → ready check → 3-2-1 countdown → run →
buzzer → post-match → auto-clear. That gets match audio, e-stop/A-stop, the
staff ready check, hold-to-start, pause/resume with the 3-2-1 re-enable, video
recording and the share QR at no cost.

**Tally**, live in `MatchState` and editable by the host during the run and
through post-match (so a miscount can be fixed before the field clears):

```ts
challenge?: Record<Alliance, { laps: number; penalties: number; finishedAt?: number }>;
```

Controls: `challengeLap(alliance, delta)`, `challengePenalty(alliance, delta)`,
and for stopwatch timing `challengeFinish(alliance)` — records that alliance's
elapsed time, disables its stations, and ends the match once every
participating alliance has finished (or the cap expires).

**Ranking.** Window mode: `laps − penalties`, descending. Stopwatch mode:
`elapsed + 5 × penalties`, ascending. A run that never finished in stopwatch
mode is a DNF and sorts last.

**Leaderboard store — changed during the build.** The plan was a separate
`challengeStore.ts` on the `practiceStore` precedent. It went into
`MatchHistoryEntry.challenge` instead: history already carries the teams, the
`matchId`, the `shareToken` and the recordings, so a separate store would have
duplicated all of it to gain nothing, and the user asked for challenge runs to
appear in history with video links anyway. The one real objection — a weekend
event outrunning the 100-entry rolloff — was answered by raising `MAX_ENTRIES`
to 250. Ranking lives in `src/challengeRanking.ts` (shared with the frontend
the way `shiftState` is) so it can be unit-tested.

## Plan / steps

- **Phase 1 — the format itself.** `MatchConfig.format`, the duration unlock,
  the `startMatch` and shift-scoring bypasses, host format selector and
  duration stepper, scoreboard/timeline branches so a run doesn't render as a
  broken red-vs-blue match. Shippable alone; this is the literal "countdown,
  one robot, X seconds" ask.
- **Phase 2 — tally.** Lap and penalty counters per alliance, live on the host
  page (phone-friendly, big tap targets) and the TV.
- **Phase 3 — stopwatch timing.** Count-up display, per-alliance finish button,
  early end when everyone's done.
- **Phase 4 — leaderboard.** `challengeStore`, the TV leaderboard between runs,
  a public shareable link, and challenge-aware labels in history/admin lists.

## Findings / gotchas

1. **`MatchHistoryStore`'s state listener early-returns when the phase hasn't
   changed** (`if (phase === lastPhase) return;`). A challenge tally is edited
   during `postMatch` without moving the phase, so the refresh that writes
   corrections back to the open entry has to sit _above_ that return. First
   attempt put it below and post-buzzer corrections silently never persisted —
   caught by the history test, not by hand.

2. **`frontend/eslint` isn't installed** in this checkout (`Cannot find package
'@eslint/js'`). The pre-commit hook runs typecheck and prettier only, so
   this doesn't block anything, but don't expect `bunx eslint` to work in
   `frontend/` without an install.

3. **Vite picks 5174 here**, because another project's dev server holds 5173 —
   check the port before pointing a browser at it.

4. **The full suite takes ~170 s.** Run it in the background; the challenge
   end-to-end tests add ~14 s of real waiting because the 3 s countdown is
   driven by real timers (`setInterval`), not fakeable ones.

5. **A stepper reading its value from the last broadcast loses taps.** Two
   presses inside one round trip both compute from the same stale number and
   send the same result — and even with local state, a burst inside one render
   repeats, because the handler closes over the rendered value. `useStepped`
   in `MatchTimeline.tsx` holds the value in a ref and steps from that;
   verified by firing three same-tick clicks and getting +3.

6. **`AllianceScoreBox` was reusable for laps.** Its `freePlayLabel` prop
   renders a caption under the big number, so laps + "LAPS" needed no new
   component — and its chase/flourish animations are all gated on
   `isFreePlay`, which is false in match mode.

## Progress log

- [x] 2026-09-21 — surveyed the match path, wrote up the options.
- [x] 2026-09-21 — user chose Option A, corrected the framing to a laps-in-a-
      window speed challenge, asked for head-to-head support, TV leaderboard,
      history+video, and a penalty button.
- [x] Phase 1 — the challenge format (`cda45c1`). Format switch, window chips
      and stepper, shift/skip-auto bypasses, purple "not a match" styling on
      the setup card and the TV.
- [x] Phase 2 — lap and penalty tally (`60a662c`). Per-alliance Lap/Undo/
      Penalty on `/match`, laps in place of the ball score on the TV.
- [x] Phase 3 — stopwatch timing (`60a662c`). Count-up clock, per-alliance
      Finish, early end once everyone has finished, DNF for the rest.
- [x] Phase 4 — leaderboard. `MatchHistoryEntry.challenge`,
      `src/challengeRanking.ts`, the board on `/match` and on the TV between
      runs, challenge results in history rows.
- [x] Driven in the real app (DRY_RUN backend + vite): create → Speed Challenge
      → window chips → stopwatch toggle → cancel → create all behave, and the
      format/window/timing carry over to the next run as intended.
- [x] Penalty costs made settable per run (laps / seconds kept separately,
      zero allowed, recorded with each run so the leaderboard is stable).
- [ ] **Try it on real hardware before the weekend.** Everything so far is
      typecheck + unit tests; no challenge run has been driven from an actual
      Driver Station.

## Open questions for the user

1. Is 60 s the right default window, and are 1 lap / 5 s the right _default_
   penalty costs? All three are now settable on the setup screen, so this is
   only about what a fresh field starts at.
2. The UI and the config path are verified in the real app, but nothing has
   been exercised against a real DS yet — the countdown, enable
   and buzzer all run through the normal match path, so they should behave,
   but a dry run on the field before Saturday is the only way to know.
3. Not built, and not asked for: a public shareable leaderboard link (the
   board is on `/match` and the TV only).

## Things not to do

- Do not relax `updateMatchConfig()`'s duration lock globally. The lock is
  deliberate; unlock only under `format === 'challenge'`.
- Do not build a second robot-control path outside `MatchEngine` (finding 1).
- Do not leave shift scoring active for a non-140 s teleop (finding 5).
- Do not pre-set `autoWinnerAlliance` to satisfy the skip-auto guard (finding 6) — it leaks alliance tinting and a game-data byte into a non-match.

---

# Relay race — 2026-09-25

## Goal

Review the (untested on hardware) speed challenge code and add a third
timing style: a **relay race**. Each alliance runs its robots one at a time —
red1 and blue1 go on the horn, do the course, come home, and hand off to the
next robot on their alliance. Whichever alliance gets all of its robots home
first wins. No autonomous period anywhere in this.

## Decisions already made (don't re-ask)

1. **Relay is a `challengeTiming` (`'relay'`), not a new format.** It is a
   stopwatch run with FMS-managed legs: same count-up clock, same Finish
   semantics on the last leg, same penalty-seconds, same "fastest time" ranking
   in its own leaderboard table. Everything that keys off "not a regulation
   match" (shift bypasses, purple styling, history) comes for free.
2. **Three hand-off styles, chosen on the setup card (`relayHandoff`):**
   - `manual` — every robot is enabled at once, the clock runs, staff press
     Finish. The drivers police their own hand-offs. The user's "simple timer
     while all robots are enabled".
   - `staff` — one robot per alliance is enabled at a time. A line ref presses
     **Next robot** when the runner crosses the line; the FMS disables the
     runner and enables the next. On the last leg the same button is Finish.
   - `ds` — as `staff`, but the trigger is the running robot's own Driver
     Station disabling itself (Enter key / the station console's Disable).
     The line-ref button stays available as a backup.
     Both of the user's proposed triggers are built rather than picking one,
     because the engine work is identical and only the trigger differs.
3. **Leg order is the match-slot order** (red1, red2, red3 = join order),
   frozen at start. No reordering UI — swap/kick before the run if needed.
4. **The `ds` trigger only works with the legacy NI Driver Station.** The 2027
   DS never sets the "enabled" status bit and pFMS only honours a disable
   from it after an enabled→disabled transition (see
   `ds2027-systemcore-fms-support` memory), so its self-disable never
   registers as a hand-off. The setup card says so; `staff` is the default.

## Review findings on the speed challenge (fixed in this pass)

1. **Pause/resume re-enabled a finished stopwatch alliance.** `completeResume()`
   called `enableParticipating()`, which enables every joined station — a red
   robot that had already pressed Finish drove again after a safety pause.
2. **A finished robot could re-enable itself.** `challengeFinish` cleared
   `enabled` but left `disabledBy` null, so the team's "Re-enable robot"
   button (and the DS-side path through `undisable`) brought it back.
3. **Finish times carried up to 250 ms of tick jitter.** Elapsed was
   `totalMatchTime − 3`, but the countdown→run transition happens on a 250 ms
   tick boundary, so "3" was really 3.0–3.25 s and varied per run. The engine
   now stamps the run's start and reports `runElapsed` in the state; the
   frontend clock and every recorded time read that instead.
4. **Finish was accepted for an alliance with nobody on the field.** Harmless
   in history (`challengeTallyFor` drops it) but it left a phantom time in the
   live state. Now refused.
5. **A run could idle to the cap after the last running robot left**, if the
   other alliance had already finished. `leaveStation` now re-checks whether
   everyone left is done.
6. **The host-page timer pulsed at 140 s shift boundaries during a challenge**
   (remaining 50 s, 25 s… on a 60 s window). Now pulses only in the last 3 s
   of a challenge.

Not bugs, noted: `getActiveColor` is safe (no auto winner ⇒ no tint); the
history store's post-buzzer follow is correct; `stopMatch` mid-stopwatch
correctly yields DNFs.

## Design notes

- `ChallengeTally.splits?: number[]` — elapsed seconds at each completed leg.
  Leg _i_ belongs to match slot `${alliance}${i+1}`, so history (which stores
  `matchSlot` per team) can name the runner without a new field.
- `MatchState.runElapsed` — seconds since the robots went live, pauses
  excluded. Source of truth for finish times and splits.
- Engine: `relayOrder` (per alliance, frozen at start), `relayAdvance()`,
  `enableParticipating()` only enables the current runner in `staff`/`ds`
  relays and never a finished alliance; `undisable()` refuses non-runners and
  finished alliances; `dsReportedStatus`/`stationDisable('self')` feed
  `relayAdvance` in `ds` mode; a runner leaving mid-run counts as a hand-off.
- `disabledBy: 'relay'` — new value, so the station console says "your leg is
  done" instead of "disabled by field staff" and refuses re-enable.
- Staff page: `/staff?role=scorekeeper&alliance=red` shows that side's
  tally/hand-off panel — the "line ref per side" buttons.

## Progress log

- [x] Review of the challenge code (findings above).
- [x] Engine + types + tests for the relay and the review fixes (7 new
      engine tests: stopwatch hold-down through pause/resume, finish refused
      off-field, early end on leave, staff/ds/manual relays; 1 ranking test).
- [x] Frontend: setup card (timing + hand-off radios), tally/hand-off panel
      with leg list and splits, `/staff?alliance=` line-ref view, TV big
      number = robots home, "Fastest relay" leaderboard table, station
      console "Relay — not your leg".
- [x] Docs (README bullet, docs/match-system.md "Relay race").
- [x] Deployed to steamboat 2026-09-25 15:39 (e38e602), Slack announcement posted.
- [ ] **Unverified on real hardware** — same caveat as the speed challenge.
