# One button to enable a robot's Wi-Fi — retire "stage" vs "apply"

## Goal

Teams find the "Stage" / "Stage and Apply" / "Apply pending changes" trio
confusing. Replace it with **one button per robot: "Enable Wi-Fi"**. The
_server_ decides when the radio actually reconfigures:

- Nothing else in the way → apply immediately.
- Other robots on the field but none enabled → apply immediately.
- Robots enabled → wait for them all to be disabled, then apply (this is the
  existing "deferred commit" path).
- A match exists (created, running, or post-match) or the admin has ticked
  **Hold Wi-Fi changes** → the request is _held_ (the old "staged"). Teams see
  it is waiting and why; the match manager sees the pending changes plus the
  connected robots and gets an **Apply now** button.

Also asked for in the same request:

- Admin "Teams & Controls" rows get slot-management actions (**Release**,
  **Kick**, **Forget**) instead of Enable / Disable / E-Stop. Global E-Stop
  stays.
- Never show "Slot N" to teams.
- Admin checkbox that holds Wi-Fi changes, same effect as a match existing.

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator` (pFMS), branch
  `master`, shared working tree (other threads may have uncommitted changes —
  stage only own files).
- Backend: `src/radioManager.ts` (active + staged config, commit queue,
  defer), `src/websocketServer.ts` (message handlers),
  `src/index.ts` (wires `setShouldDefer`, retry hooks),
  `src/types.ts` (messages, `SetupSettings` + validators),
  `src/setupConfigStore.ts` (`addListener`).
- Frontend: `frontend/src/components/ControlPage.tsx` (team page: robot
  list, add form, takeover picker), `StationStatus.tsx` (station card +
  config dialog, used on team page via `StationExperience`? — no: used from
  `AllianceStatus.tsx` = overview/staff page; team page uses its own
  `StationExperience`), `StatusBar.tsx` (apply banner),
  `AdminPage.tsx`, `MatchControlPage.tsx`, `hooks/useBackend.ts`.
- Scripts: `bun run typecheck`, `bun test`, `bunx prettier --write`.
- Commit subjects are user-facing (Slack deploy announcement); tag with
  `Changelog:` trailer.

## Decisions already made (don't re-ask)

- **Hold = match phase is not `idle`, or admin setting `holdRadioChanges`.**
  Post-match counts as held: in a scrimmage the manager creates the next
  match straight from post-match, and a 30 s radio reconfigure in that window
  is exactly what they asked to avoid. On a normal practice day the cost is a
  ≤2 min wait (post-match auto-clears) or one click of "Apply now".
- **When the hold lifts, held changes apply automatically** (then defer if
  robots are enabled). The team already asked for it; there is no team-facing
  apply button any more, so nothing else would ever apply them.
- **"Apply now" (staff) bypasses the hold** but not the defer: if robots are
  enabled the commit still waits for them to be disabled. The button is
  disabled while robots run and says why.
- **Clients no longer send `stage`.** The field is dropped from
  `StationUpdate` and `EnableSavedRobot`. Old tabs get the version-mismatch
  reload prompt anyway.
- **Teams can withdraw a held request** (new `cancelStationChange` message →
  `radioManager.cancelStagedChange`). A held _release_ is undone by pressing
  Enable Wi-Fi again (server: active config matches request + staged change
  → cancel staged).
- **Deferred changes are made visible to clients**: `pendingCommitState`
  gains `hold` (`'match' | 'admin'`) and `deferredChanges` (stations whose
  active config differs from what the radio currently has). Without this a
  team who pressed the button while robots were enabled would see nothing for
  minutes.
- Admin table keeps the Slot column (admins are not teams) and drops per-row
  Enable / Disable / E-Stop. Per-row actions: Release (clear the slot),
  Kick (only while joined in a created match), Forget (remove saved
  passphrase + release).
- Button text: **"Enable Wi-Fi"**; inverse stays **"Release"** (already
  understood on the field). Takeover: **"Take over"**.
- No hover-only information for teams (touch devices): reasons are rendered
  as text, not tooltips.

## Plan / steps

1. **Backend — `radioManager.ts`**: `setShouldHold(fn)` returning a hold
   reason or null; `configure()` stages when held, otherwise immediate.
   `retryHeldChanges()` applies staged changes when the hold has lifted.
   Broadcast `hold` + `deferredChanges`. Drop the `stage` option from
   `configure()`.
2. **Backend — `types.ts`**: remove `stage` from `StationUpdate` /
   `EnableSavedRobot`; add `CancelStationChange`; extend
   `PendingCommitState`; add `holdRadioChanges` setting + validator.
3. **Backend — `websocketServer.ts`**: drop `stage` plumbing; handle
   `cancelStationChange`; `removeSavedTeam` releases through the normal path.
4. **Backend — `index.ts`**: wire `setShouldHold` (match phase + setting),
   retry held changes on match state change and setup-config change.
5. **Tests — `src/radioManager.test.ts`**: hold → staged; hold lifts →
   applied; defer → waits → retried; apply-now bypasses hold; cancel.
6. **Frontend — `useBackend.ts`**: drop `stage` params; add
   `sendCancelStationChange`; expose hold/deferred state.
7. **Frontend — team page (`ControlPage.tsx`)**: one "Enable Wi-Fi" button;
   waiting states with reasons; takeover picker one button; add-robot form
   one button; wording without "slot".
8. **Frontend — `StationStatus.tsx`** (overview/staff): dialog Save only
   (no Stage / Shift+Enter); clear goes through the normal path.
9. **Frontend — `StatusBar.tsx`**: passive "Wi-Fi changes waiting" indicator
   (no team-facing apply button); change list names teams, not slots.
10. **Frontend — shared `PendingRadioChanges.tsx`**: pending changes +
    connected robots + "Apply now"; used by match page (all phases) and admin.
11. **Frontend — `AdminPage.tsx`**: hold switch section; pending panel; table
    row actions Release / Kick / Forget.
12. **Docs**: `docs/internals.md` (configure flow), `docs/getting-started.md`
    step 2, `docs/match-system.md` (hold during matches + apply now), README
    if it mentions apply.
13. Typecheck, tests, prettier; commit in logical units.

Current step: **done and committed; awaiting deploy.**

## Findings / gotchas

- Immediate configs already wait for robots to disable: `commitConfiguration()`
  defers when `shouldDefer()` (`isMatchActive() || anyRobotEnabled()`), and
  `retryDeferredCommit()` is called from the telemetry disable transition and
  every match state change (`src/index.ts` ~866-892). So "wait for them to
  disable" needed no new machinery — only the hold path is new.
- The client only sees the radio's _reported_ SSIDs (`radioUpdate.
stationStatuses`) plus `stagedChanges`. A deferred immediate change lives
  in `activeConfig` only, invisible to clients — hence `deferredChanges` in
  the pending message.
- `activeConfig` entries are POSTed to the radio via
  `buildRadioStationConfig()`, which destructures explicitly — safe to keep
  bookkeeping fields there.
- Staged clear on an _empty_ station (`stagedChanges[s] = null` with no
  active config) is a no-op that still shows as pending; `configure()` with an
  empty SSID on an empty, unstaged station should just be ignored.
- `matchEngine.addStateListener` fires on every state broadcast (timer ticks
  included); the retry hooks must be cheap no-ops when nothing is pending.
- **Latent bug fixed on the way:** a deferred commit set `_deferredCommit`
  but never flipped `_pendingCommit`, so unless something was also staged
  the broadcast said `pending: false` and clients never learned a change was
  waiting for robots to be disabled. `commitConfiguration()` now sets
  pending on deferral. Covered by the "while robots are enabled" test.
- **Dropped the `Already configuring` early return in `configure()`**: the
  commit queue already serializes commits, so that guard only served to
  silently drop a team's click during the radio's ~30 s reconfigure. The
  guard inside `configureRadio()` stays (it is always false there anyway,
  because of the queue).
- `radioManager.test.ts` must `mock.module('./networkManager.js')` before a
  dynamic import: `networkManager` builds the Linux netlink backend at module
  load and throws on Windows. Under the CommonJS tsconfig the dynamic
  import's `.default` types as the namespace — cast it.
- ESLint is not runnable in this checkout (`@eslint/js` missing); the
  pre-commit hook only runs typecheck + prettier, so that is the bar.
- README does not mention stage/apply; no change needed there.

## Progress log

- [x] 1 radioManager hold/deferred (`setShouldHold`, `retryHeldChanges`,
      `getPendingState` with `hold` + `deferredChanges`)
- [x] 2 types
- [x] 3 websocketServer
- [x] 4 index wiring
- [x] 5 radioManager tests (12 tests; full suite 383 green)
- [x] 6 useBackend
- [x] 7 ControlPage
- [x] 8 StationStatus
- [x] 9 StatusBar
- [x] 10 PendingRadioChanges
- [x] 11 AdminPage
- [x] 12 docs
- [x] 13 commits: `819291b` (one-button Wi-Fi: backend, team page, status
      bar, match page panel, docs), `051264b` (admin page: Release / Kick /
      Forget, hold checkbox), plan commit. Typecheck, prettier, full test
      suite and a production frontend build all pass.
- [ ] Deploy to steamboat and watch a real team press the button (not done
      in this thread; nothing pushed yet)

## Open questions for the user

None blocking. Worth confirming after seeing it: whether post-match should
count as "held" (see decisions) — easy to narrow to created/countdown only.

## Things not to do

- Don't reintroduce a team-facing apply button anywhere (StatusBar is shared
  by every page, including team pages).
- Don't put reasons in tooltips only — touch devices.
- Don't touch `clearAllConfigurations` (nightly scheduler) — it clears
  `activeConfig` directly and commits; unrelated to the hold.
