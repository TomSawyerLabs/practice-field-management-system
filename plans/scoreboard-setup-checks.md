# Scoreboard setup checks

## Goal

Give the main scoreboard (`/scores`, including the Cast TVs) an option that
shows, per robot on the field, the ladder of setup checks a team has to turn
green before a match, so field staff can see at a glance what is wrong and
for whom. Then make the start of a match a clean transition out of that view:
the columns animate down into the normal battery row, a big 3-2-1 plays, and
the 0–0 scores ease in. During a match, a robot that is disabled or has lost
comms shows a clear indicator in place of its battery chart.

The ladder, as asked for (usually turns green in this order):

0. Table stakes — the robot's Wi-Fi is configured on a field station. That is
   what earns a column.
1. The DS is talking to the FMS — yellow for partial, green for full.
2. The robot radio is linked to the field radio.
3. The DS reports robot comms.
4. The DS has joysticks (if pFMS can see that).
5. The battery is above 12 V (live readout).
6. The team is Ready (greyed out until the match has asked for Ready).

## Environment / context

- Scoreboard: `frontend/src/components/ScoreboardPage.tsx` (served at
  `/scores`, root `frontend/src/roots/scores.tsx`, HTML `frontend/scores.html`
  which also hosts the Cast sender/receiver glue).
- `/scores` connects to the **public read-only** socket `/ws/scores`
  (`useBackend.ts` picks the path). Only `PUBLIC_SAFE_TYPES` in
  `src/websocketServer.ts` reach it: `scoreState`, `matchState`, `telemetry`,
  `playGetReady`, `queueState`. Radio status (`StatusEntry`), drive sessions,
  and team checks never reach the scoreboard.
- Per-station state already on the public socket, in `matchState`:
  `stationStates[s]` (`teamNumber`, `joined`, `alliance`, `ready`,
  `enabled`, `eStop`, `aStop`, `disabledBy`, `dsAttached`, `matchSlot`),
  `connectedStations[s]` (DS TCP-level link, `lastSeen`), `readyRequested`.
- DS link has two layers (`src/matchEngine.ts`, `src/index.ts`):
  - TCP handshake from a known team → `startDrive` → `setDSAddress` →
    `dsConnections` (swept after 20 s idle). This is **partial**.
  - UDP 1160 status heartbeats (only while the DS holds a station assignment,
    i.e. in FMS mode) → `lastDsHeartbeat` → `isDsAttached` (5 s). This is
    **full**. The same packet carries the DS's own `robotComms` bit
    (`index.ts` calls `matchEngine.dsReportedStatus(...)`).
- Robot radio association: `radioManager` status listener,
  `radioUpdate.stationStatuses[s].isLinked`.
- Telemetry has two producers that both emit `TelemetryUpdate`:
  - `src/telemetryManager.ts` from DS→FMS 1160 UDP: real DS view of
    `robotComms`/`radioPing`/`rioPing`.
  - `src/robotPacketCapture.ts` from tcpdump of robot→DS UDP 1150: fabricates
    `radioPing: true`, `rioPing: true`, and reports the _robot code_ bit as
    `robotComms`. Both are coalesced per station, latest wins
    (`src/telemetryThrottle.ts`), so the client cannot tell them apart.
- Joysticks: nothing in pFMS reads them today. They ride in DS→robot UDP 1110
  packets (tag `0x0c`). pFMS is on the DS→robot path for drive sessions, but
  per memory `ds-out-of-match-observability` "DS→robot 1110 is only sometimes
  visible (asymmetric routing / drive-session DNAT)".
- Cast TVs: swap/mute are pushed to a receiver by the admin page
  (`castReceiverSwap` / `castReceiverMute` → server → the receiver's socket →
  `localStorage` + reload), and by the Cast sender on session start
  (`scores.html`).
- Checks: `bun run typecheck`, `bun run test` (bun test, includes
  `frontend/src/utils/*.test.ts`), prettier via lefthook.

## Decisions already made (don't re-ask)

- **Compute the ladder on the server** and broadcast a small sanitized
  `stationChecks` message that is public-safe. Reasons: the scoreboard's
  public socket never sees radio link state, the DS-vs-robot telemetry
  sources are indistinguishable client-side, the rules become unit-testable,
  and every display shows the same verdict. Only team numbers, booleans,
  voltages and joystick counts go out — all already public via
  `matchState`/`telemetry`.
- **Check levels:** `ok` (green), `partial` (yellow), `bad` (red), `waiting`
  (grey — not asked for yet / not applicable yet), `unknown` (grey "?" —
  pFMS can't see it). Joysticks are honestly `unknown` when pFMS cannot see
  the DS→robot traffic, rather than guessed.
- **Rules** (see `src/stationChecks.ts`):
  1. DS: `dsAttached` → ok; DS TCP link known → partial; else bad.
  2. Radio: `isLinked` → ok / bad; no radio status yet → unknown.
  3. Robot comms: fresh DS 1160 status → its `robotComms` bit; else fresh
     robot→DS 1150 packets (robot is answering its DS) → ok; else, with the
     capture running, radio unlinked or no packets → bad; capture not running
     → unknown.
  4. Joysticks: fresh DS→robot 1110 capture → ok if any joystick tag has
     axes/buttons/POVs, else bad; no DS→robot traffic seen → unknown.
  5. Battery: fresh voltage from either source → ok ≥ 12.0 V else bad;
     none → unknown.
  6. Ready: not joined or Ready not requested → waiting; ready → ok; else
     bad.
- **Toggle:** a "checks" chip on the scoreboard, `?checks=1` URL override,
  persisted per browser in `localStorage` (`scoreboard-checks`) — same
  pattern as swap/mute/lite. Also pushed to Cast TVs from the admin page and
  on Cast session start, like swap/mute.
- **Where the ladder shows:** normal (non-video) layout, between matches
  (phase `idle`/`created`). It takes the main area; the score boxes step
  aside until the match starts. Post-match keeps the scores + QR; the ladder
  comes back when the match clears to idle. Video mode keeps its layout (no
  ladder) but gets the in-match indicators.
- **The start transition** (checks mode only — without checks the scores
  are already on screen): at `countdown` the ladder rows collapse and the
  columns settle into the bottom battery row, a big 3-2-1 fills the centre,
  and at `auto` the 0–0 scores ease in. Lite mode skips the animation.
- **In-match indicator** (all modes): for robots in the match, replace the
  battery chart with, in priority order, E-STOP, A-STOP, NO DS, NO ROBOT
  COMMS, DISABLED (enabled phases only), LEG DONE (relay handoff, neutral).
  Match participants keep their card even when telemetry stops — today the
  card silently vanishes after 15 s, which is exactly when staff need it.

## Plan / steps

1. Backend `src/stationChecks.ts`: pure `evaluateStationChecks()` + a
   `StationChecksTracker` fed by index.ts; types + `stationChecks` message in
   `src/types.ts`; public-safe; broadcast on change (≤ 2 Hz) and on connect.
   Tests.
2. `src/robotPacketCapture.ts`: capture `dst port 1110` too; parse joystick
   tags; report robot-packet and joystick observations to the tracker. Pure
   parser exported + tested.
3. Frontend hook `useStationChecks()`; pure helpers in
   `frontend/src/utils/stationChecks.ts` (first failing check, card tone,
   in-match alert) + tests.
4. Scoreboard: checks toggle; station cards that expand into the ladder;
   countdown + score ease-in; in-match alerts; participants pinned.
5. Cast: `checks` in receiver register/list, `castReceiverChecks` admin
   command, admin toggle, `scores.html` sender/receiver.
6. Docs (`docs/configuration.md` scoreboard section, README if relevant),
   verify in the browser, commit in logical steps.

## Findings / gotchas

- The robot→DS capture's `robotComms` is the robot _code_ bit, not comms;
  don't use telemetry's `dsStatus.robotComms` for the ladder.
- An unjoined legacy DS with the default "no reply" admin setting never sends
  1160 status, so out of a match most DSes sit at **partial** until they join.
  That is expected, not a bug.
- 2027 DS (SystemCore): its DS→robot protocol is not the 1110 format, so
  joysticks read unknown for those teams.
- **Shared index, 2026-09-28:** the queue/push thread
  (`practice-field-configurator-29`) edits `src/index.ts`, `src/types.ts`,
  `src/websocketServer.ts` and `frontend/src/hooks/useBackend.ts` at the same
  time and stages wholesale. Its `git add src/types.ts` picked up my types
  hunk, and my staging was nearly committed with its work. Coordinate over
  SendMessage before committing.
- Staging my hunks with a zero-context patch (`git apply --cached
--unidiff-zero`) **misplaced pure-insertion hunks** in `src/index.ts`, and
  the staged file failed to compile (`Cannot find name 'ws'`). What works:
  rebuild the file as HEAD plus my edits, `git hash-object -w` it, then
  `git update-index --cacheinfo`. Verify by type-checking a
  `git checkout-index -a --prefix=.staged-check/` copy _inside_ the repo, so
  `node_modules` resolves by walking up, and `cd` out before deleting it. Never
  junction `node_modules` into a temp copy: `rm -rf` follows junctions (memory
  `junction-worktree-remove-deletes-repo`).
- The full `bun test` takes ~5 min (615 tests). Run targeted files while
  iterating.

## Progress log

- [x] Recon: scoreboard, public socket, DS link layers, radio link,
      telemetry sources, cast plumbing
- [x] Step 1 — server checks + tests (`src/stationChecks.ts`, 15 tests).
      The types, public-safe entry and `useStationChecks` hook landed in the
      queue thread's commit `1560449`, by agreement, to keep the shared files
      whole.
- [x] Step 2 — joystick capture + tests (`countDsJoysticks`, 6 tests)
- [x] Step 3 — frontend helpers + tests (`frontend/src/utils/stationChecks.ts`)
- [x] Step 4 — scoreboard UI. Verified with a scripted Playwright run that
      replaces `/ws/scores` (setup → countdown → auto → teleop alerts → back
      to setup); screenshots looked right. The harness lives in
      `%TEMP%/pw/scenario.mjs` (playwright-core in a scratch dir, cached
      Chromium from `%LOCALAPPDATA%/ms-playwright`).
- [ ] Step 5 — Cast / admin toggle ← current
- [ ] Step 6 — docs, commits

## Open questions for the user

1. Between matches with checks on, the ladder replaces the big free-play
   scores. If free-play scoring on the TV matters while checks are on, we
   could keep compact score boxes above the ladder. (Default: ladder only.)
2. Battery threshold is a hard 12.0 V. A yellow band (e.g. 11.8–12.2) is
   easy to add if wanted.

## Things not to do

- Don't touch the other thread's uncommitted queue work (`QueuePage`,
  `QueueBanner`, `QueueNextUp`, `matchQueue.ts`, the Queue link in
  `MainPage.tsx`, `vite.config.ts` queue route, README line). Stage only
  this task's hunks.
- Don't add radio status or drive-session details to the public socket —
  send the derived verdicts only.
