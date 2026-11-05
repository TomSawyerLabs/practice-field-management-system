# Release an offline robot for a waiting team

## Goal

On 2026-11-03 the field filled to 6/6 while 114 had been off the Wi-Fi for
over two hours (dropped 6:03 PM PST, 02:03Z). A team arriving at a full
field could not even ask for a slot: the team page disables Enable Robot and
says "ask field staff". Staff had to notice and press Release on `/admin`
(done at 8:16 PM PST, 04:16Z).

Fix it so:

1. A team at a full field can **get in line** instead of hitting a dead end.
2. While a team is in line, pFMS **releases the robot that has been off the
   field Wi-Fi longest**, once that is over N minutes, and the waiting robot
   takes its slot in the same radio change.
3. N is an **admin setting** (default 5 min, 0 = never).
4. On a full field, staff see a **Release** button on any robot that is off
   the Wi-Fi, not only on host robots.

## Environment / context

- Pending list: `src/radioManager.ts` (`changes`, `computeTarget`,
  `request`, `waitReason`, `applyPendingChanges`). An enable with no free
  station already stays on the list ("unresolved"); only the team page
  refused to send one.
- Per-station link tracking: `lastLinked` / `wasLinked` in `RadioManager`,
  updated on every status poll; in memory only.
- `connectedAt` per station in `activeConfig` (persisted).
- Settings: `SetupSettings` + `SETUP_SETTING_VALIDATORS` in `src/types.ts`;
  admin card for match/release settings in `frontend/src/components/AdminPage.tsx`.
- Team page: `frontend/src/components/ControlPage.tsx` (`FieldFullAlert`,
  `RobotRow`, `useRobotPending`).
- Field issues: `frontend/src/utils/fieldIssues.ts` (`host-parked-*`,
  `robot-not-linked-*`).

## Decisions already made (don't re-ask)

- Build it (user, 2026-11-04). N = 5 min default, admin-configurable.
- **Host robots stay exempt** from the automatic release
  (`plans/host-team.md`: "pFMS does not auto-release a host robot for a
  visitor"). Staff can still release them; during a scrimmage
  (`hostTeamsInEffect` = []) everyone is treated alike.
- Only release when someone is actually waiting. An idle robot on a field
  with room keeps its slot indefinitely.

## Design

- **Waiting enables don't block other requests.** `waitReason()` ignores
  enables that are unresolved (field full); otherwise one team in line would
  turn every later request into "waiting for staff". With that, any release
  (team, staff, automatic) applies the whole list and the waiting robot lands
  in the freed slot in the same commit.
- `request()` returns `{ result: 'waiting', reason: 'full' }` when its enable
  is still unresolved after applying. New `RadioHoldReason` `'full'`, also
  reported as `hold` in the pending state when only full-field waits remain.
- **Automatic release** (`RadioManager.releaseIdleForWaiting`), run about
  once a second from the status poll and right after a request goes into
  line:
  - only with a waiting (unresolved) enable, no hold (match / admin), no
    other changes waiting for staff, and the radio answering;
  - candidates: stations whose robot is not linked now and isn't exempt;
    offline since = max(last linked, when it took the slot, when the radio
    last came back) — a pFMS restart or radio outage never makes a robot look
    long-gone;
  - release the longest-offline candidates over N minutes, one per waiting
    enable, then apply the list.
  - remember each release (ssid, when, offline for, for whom) for an hour, sent
    in `pendingCommitState.idleReleases` so the released team's page can
    say what happened.
- Team page: Enable Robot stays enabled on a full field and puts the robot in
  line ("Waiting for a slot" chip, Cancel). The full-field alert explains the
  line and the N-minute rule.
- `/csa` field issues: on a full field, a robot off the Wi-Fi (not in a match)
  gets a Release action, with "pFMS releases it automatically in X min if a team
  is waiting".

## Plan / steps

1. [x] Types + setting (`idleReleaseMinutes`), validators.
2. [x] RadioManager: `'full'` wait reason, waitReason fix, `releaseIdleForWaiting`,
       idle-release history; tests.
3. [x] index.ts wiring (policy: minutes, exemptions, match idle).
4. [x] Frontend: team page line + notice; admin setting (`/admin#wifi`); field
       issue Release.
5. [x] Docs (`docs/match-system.md`, `docs/internals.md`); README has nothing on
       this.
6. [x] Typecheck, tests, commit `796bf5a`.
7. [x] End-to-end in headless Chrome (see Progress log).
8. [x] Deployed `563e474` to steamboat 5:03 PM PST (01:03Z Nov 5) 2026-11-04,
       at the user's request; logged in `plans/deploy-log.md`.

## Findings / gotchas

- Last night's log: 8048 actually got the last free slot (slot 5) at
  8:13:39 PM PST (04:13:39Z), 20 s after opening its page; the field was
  only full after that. A team turned away at a full field leaves no
  server-side trace, because the page never sends the request.

- `applyPendingChanges()` used to push the radio even when no station changed,
  dropping every robot for ~30 s. Unreachable before (teams couldn't send an
  enable at a full field), but joining the line would have hit it. Now an
  apply with no station change leaves the radio alone.
- `computeTarget()` placed enables strictly in list order, so a waiting enable
  ahead of a release never got the freed station. Now an enable that finds no
  station gets a second pass after the whole list.
- The admin page asks a fresh install to set a passphrase; the setting is on
  the Wi-Fi tab (`/admin#wifi`), not the default Match tab.
- "Off since" is the last poll that saw the robot linked, so a robot last seen
  at t0 is released at t0 + N, not N after it was first seen off.

## Progress log

- [x] Investigation of 2026-11-03 (see Findings).
- [x] Unit tests: `src/radioManager.test.ts` (line, idle release ordering,
      exemptions, restart baseline, leaveLine), `fieldIssues.test.ts`. Full
      suite 1265 pass, typecheck clean.
- [x] End-to-end, 2026-11-04 3:58–4:12 PM PST (23:58Z–00:12Z Nov 5): the real
      `src/index.ts` with `DRY_RUN=1`, `RADIO_URL` = a fake radio on 127.0.0.1,
      fresh temp state dir, headless Chrome (playwright-core, outside the
      repo). All 15 checks pass: the full-field alert, Enable Robot opens the
      "in line" dialog and the row says In line, joining the line sends the
      radio nothing, `/csa` shows "8048 is waiting for a slot" with Release 114,
      the admin field defaults to 5 and saves 1, 114 is released about a
      minute after it went off and 8048 takes its slot in one radio update,
      8048's page goes Active, and 114's page explains the release. No real
      radio was contacted. Harness: `%TEMP%/pfms-e2e/harness/e2e.ts`.

## Open questions for the user

(none)

## Things not to do

- Don't test against the field radio: tests use a dead or fake `RADIO_URL`.
- Don't release on `lastLinked` alone: it is in memory and empty after a
  restart.
