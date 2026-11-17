# Radio reconfigure: feedback for teams

Branch: `t3/radio-reconfig-team-feedback` (worktree `.t3/worktrees/practice-field-configurator/t3-a3a73638-…`).

## Goal

While the field radio reconfigures (~30–45 s, every robot's Wi-Fi drops), teams
should see what is happening and when it ends, without losing their page:

1. **Scoreboard / TV**: replace the scoreboard with a reconfigure screen —
   countdown, and the list of changes (who joins, leaves, moves).
2. **Team (laptop) page**: no full-screen blocking backdrop. A large dismissible
   banner instead; dismissed, it collapses into a progress bar across the
   status header.
3. **Team page Radio tab**: a small callout above the "Radio" tab while
   reconfiguring: "watch here to see when your robot reconnects".

## Environment / context

- Old backdrop: `frontend/src/roots/wrap.tsx` (`showReconfigOverlay`, default
  true; only `/<ssid>` (ControlPage) and the overview root still use it).
- Progress: `frontend/src/hooks/useReconfigProgress.ts`, from the radio's
  polled status (`CONFIGURING`) in status history.
- Scoreboard uses the public `/ws/scores` socket: only `PUBLIC_SAFE_TYPES` in
  `src/websocketServer.ts`. It never sees radio status, so it needs a new message.
- Radio pushes all go through `RadioManager.configureRadio()` (`src/radioManager.ts`),
  serialized by `enqueueRadioPush`. Commits: `doCommitConfiguration()`; also
  `doSetSyslogIP()`.

## Decisions

- New public-safe message `radioReconfigure` { active, since, expectedMs,
  changes[] } broadcast by the server around each radio POST. Changes are
  station + from/to SSID only (no keys, no internet flag). SSIDs are team
  numbers (+ suffix), already public via the scoreboard's station data.
- `expectedMs`: median of the last few real reconfigure durations, 40 s default,
  so the countdown matches this radio/firmware.
- Changes are the diff between `activeConfig` and what the radio reports just
  before the POST (same basis as `getDeferredChanges`).
- TV: full-screen overlay on top of the scoreboard/leaderboard views (keeps the
  scoreboard mounted: video stream and settings survive).
- Team page banner dismissal lasts one reconfigure (reset when it ends), so
  the next one shows the big banner again.

## Plan / steps

1. [x] Backend: `RadioManager` tracks the push in `configureRadio()` (start, changes, duration samples); `radioReconfigure` broadcast + sent on connect (field and `/ws/scores`).
2. [x] Frontend: `useRadioReconfigure`; `useReconfigProgress` merges server state with radio status; `describeReconfigureChanges` + test.
3. [x] TV: `ReconfigureTvScreen` overlay in `frontend/src/roots/scores.tsx` (scoreboard and leaderboard views).
4. [x] Team page: `ReconfigureBanner` under the status bar (team + overview pages, `WrapAll reconfigBanner`); Hide collapses it into a fill across the status bar. Every other page gets the status-bar fill only (replaces the old full-screen backdrop, which only the team and overview pages had).
5. [x] Radio tab callout: controlled MUI Tooltip on the tab label while reconfiguring; clicking it opens the Radio tab.
6. [x] typecheck, full `bun test` (1320 pass), headless-Chrome screenshots against `scripts/fake-backend-reconfigure.ts`.
7. [ ] Deploy (owned by the deploy thread, see `plans/deploy-log.md`) and watch one real reconfigure on the TV.

## Findings / gotchas

- The public socket (`/ws/scores`) is open to the internet (ISSUES.md entry);
  only station + SSID are added to it.
- `src/wsAccess.test.ts` and `src/game/gameAdmin.test.ts` stub RadioManager:
  new methods used by `setupWebSocket` must be added to both stubs.
- Headless Chrome on Windows here only wrote `--screenshot` files when run with
  the scratchpad as cwd and Windows-style paths. Its minimum window width is
  ~500 px, so a 390 px screenshot crops rather than reflows: not a real overflow.
- `--virtual-time-budget` fast-forwards timers, so countdowns read further on
  than the fake backend's `ELAPSED_S`.

## Progress log

- [x] 1–6 done; fast-forwarded into local master at `e40c7f9` (2026-11-16), to be pushed with other recent work
- [ ] 7 deploy

## Open questions for the user

(none)
