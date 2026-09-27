# Match roster names the robot that joined, not the slot's radio

## Goal

When a team leaves a match and a different team takes the same slot, the
match page (and every other roster view) keeps showing the **old** team's
number for the new team until the radio change is applied. Fix it so the
roster identifies robots by who actually joined, not by whatever the slot's
radio happens to hold right now.

Wider observation from Cameron: pFMS keys too much on the physical slot. This
task fixes the roster identity; it does not rewrite the slot-keyed protocol.

## Environment / context

- Repo: `C:\Users\camer\git\practice-field-configurator` (pFMS), branch `master`.
- Backend: `src/matchEngine.ts`, `src/radioManager.ts`, `src/index.ts`.
- Frontend team page: `frontend/src/components/ControlPage.tsx`
  (`useProjectedStations`, `useStationsForTeam`), match page:
  `frontend/src/components/MatchControlPage.tsx`.
- Scripts: `bun run typecheck`, `bun run test` (~3 min, exercises ffmpeg),
  `bunx prettier --check`.

## Root cause

- `StationControlState.teamNumber` is re-derived on every `getState()` from
  `radioManager.getTeamForStation(station)` — the SSID on the radio's
  **active** config (`src/matchEngine.ts` getState, `src/radioManager.ts:1071`).
- Since commit `819291b` (one-button Wi-Fi), a team's Wi-Fi request is
  **held** (staged, not applied) while a match exists (created → postMatch)
  or the admin hold is on.
- The team page decides which station is "theirs" from the **projected**
  config (held → deferred → active), so team B sees the slot as theirs and
  can press Join while the radio still has team A.
- The engine marks the slot joined and labels it with the active radio's
  team: A. Everyone sees A until Apply now / match cleared.

## Decisions already made (don't re-ask)

- **Record the team at join time, on the server.** The engine resolves the
  joining robot from the radio manager's projected config (held change
  wins over active) — the same view the team page used to offer the Join
  button. No new client → server fields; nothing to trust from the client.
- **While joined, the recorded team is not overwritten** by the live radio
  resolver (`getState()`), and `startMatch()` keeps it for the match
  snapshot. Unjoined stations still show the radio's active team (what is
  physically on the Wi-Fi), as before.
- **If the projected robot for a joined station changes during setup
  (`created` phase), that station leaves the match.** Covers a joined team
  releasing its Wi-Fi, staff releasing the slot, or a held request being
  cancelled/replaced. Without this, the roster entry would name a robot
  that is no longer coming. Not applied during an active match — a
  mid-match Release is a separate question and the snapshot is the record.
- Deferred changes are already in `activeConfig`, so "projected" only has
  to consult staged changes over active.

## Plan / steps

1. `src/radioManager.ts` — add `getProjectedTeamForStation(station)`.
2. `src/matchEngine.ts` — second constructor resolver (projected team); set
   `teamNumber` on a fresh join; stop re-resolving joined stations in
   `getState()` and `startMatch()`; add `reconcileJoinedTeams()`.
3. `src/index.ts` — pass the projected resolver; call reconcile from the
   radio config-change and pending-commit listeners.
4. Tests: `src/matchEngine.test.ts` (join records projected team, survives
   a differing live resolver, snapshot at start, reconcile kicks/keeps),
   `src/radioManager.test.ts` (projected team under hold).
5. `docs/match-system.md` — one line in the Join step.
6. `bun run typecheck`, prettier, `bun run test`; commit.

Current step: **done.** Typecheck and prettier clean; full suite 395/395
(with the other thread's in-progress edits in the tree); the staged tree
alone also type-checked and passed the engine + radio manager tests.

## Findings / gotchas

- The hold path of `RadioManager.configure()` does **not** call
  `notifyConfigChange()` — it only broadcasts pending-commit state. Any
  reaction to a staged change has to hang off `addPendingCommitListener`,
  not `addConfigChangeListener`. `cancelStagedChange()` calls both.
- `MatchPanelForControl` already receives an `ssid` prop it never uses —
  the intent to identify by robot was there.
- `getState()` for `postMatch` serves a frozen snapshot (ISSUES.md) —
  untouched here.
- **Incident while committing (2026-09-27).** To type-check the staged
  tree on its own I made a throwaway `git worktree` in `%TEMP%` with
  `mklink /J` junctions to the repo's `node_modules`. `git worktree remove
--force` recursed through the junction, then through bun's workspace link
  `node_modules/practice-field-configurator-frontend` → `frontend/`, and
  deleted the real `frontend/` directory (95 tracked files, `dist`,
  `node_modules`) and most of the root `node_modules` before I killed it.
  Recovered: tracked files from the index (`git ls-files -d -z | git
checkout-index -z --stdin`), the other thread's uncommitted frontend
  edits from the `git stash create` safety snapshot taken just before, and
  deps with `bun install --frozen-lockfile`. Lost: whatever the other
  thread changed in `frontend/src/components/MatchControlPage.tsx` after
  the snapshot (its diff had grown from 7 to 33 lines). Zero-context
  (`-U0`) hunk patches also mis-applied when sibling hunks were dropped —
  use `-U3` so `git apply --cached` can place hunks by context.

## Progress log

- [x] Traced the flow from Join button to `teamNumber` in the broadcast.
- [x] Step 1 — projected team resolver in the radio manager.
- [x] Step 2 — engine records the joining team, keeps it while joined,
      reconciles on config changes during setup.
- [x] Step 3 — wiring in index.ts.
- [x] Step 4 — tests (7 engine cases, 1 radio manager case).
- [x] Step 5 — docs.
- [x] Step 6 — checks + commit (only this task's hunks staged; another
      thread's ready-check work in the same files was left unstaged).

## Open questions for the user

None blocking.

## Things not to do

- Do not make `getTeamForStation()` itself return the projected team: a
  dozen callers in `index.ts` (DNAT, route preference, team checks, mDNS)
  need what is physically on the radio.
- Do not kick a joined station mid-match because its Wi-Fi request changed.
- Never `git worktree remove --force` (or `rm -rf`) a directory that holds
  junctions/symlinks into this repo. Remove each link first with
  `cmd /c rmdir <link>` (link only), then delete the directory. Better:
  verify a staged tree with `bun install` in the temp worktree, no links.
