# Team page: say clearly when a match is holding your robot, and let teams clear an empty one

## Goal

On 2026-10-10 team 6036 tapped Enable at 21:07 while a match was set up.
pFMS held the change ("Holding Wi-Fi change (match)") and the team page
showed only a "Waiting" chip plus a generic line. They cancelled and
re-tapped 7 times in 8 minutes and waited ~31 minutes before the robot went
on. From 21:09:31 the set-up match had nobody in it at all.

The user asked for:

1. The team page shows clearly that the enable is held **because a match has
   been created** (and what kind of match state it is).
2. If nobody has joined that match, a button on the team page clears the
   match early so the team's robot goes on.

## Context

- Hold reason comes from `radioManager.setShouldHold` in `src/index.ts`:
  `'match'` while a match is running, or while one is set up / just over
  (unless the match page's hold switch is off).
- Held changes do NOT apply when the hold lifts — staff press Apply now. The
  one exception is the 10-minute abandoned-setup auto-cancel
  (`matchEngine.cancelAbandonedSetup` → `abandonedSetupHook` →
  `radioManager.applyPendingJoins()`), which applies waiting enables (not
  releases) unless the admin hold is on.
- Team page: `frontend/src/components/ControlPage.tsx`, `RobotRow`. Held
  enable shows the "Waiting" chip, a Cancel button, a caption from
  `holdReasonText(hold, 'team')`, and a one-time dialog "Waiting for the
  match admin".
- Every non-public client already receives `matchState` (phase,
  `stationStates[].joined`, `setupExpiresAt`).
- Station/team-page websocket messages carry no auth; the server checks
  state (pattern: `stationJoinAlliance`, `stationTeamStop`).

## Decisions

- The team-page clear goes through the same path as the 10-minute
  auto-cancel: cancel + apply waiting joins. A plain `matchCancel` would
  leave the team's enable waiting for staff.
- New message `stationClearEmptyMatch`. The server re-checks "set up, zero
  joined" so a stale button can't cancel a match someone just joined.
- The notice is phase-aware and replaces the generic caption only for
  `hold === 'match'`; admin/pending holds keep their existing text.

## Plan / steps

1. [x] Backend: `matchEngine.clearEmptySetup(who)`, shared with the
       auto-cancel; message type + handler; tests.
2. [x] Frontend: `MatchHoldNotice` in the robot row caption and the waiting
       dialog, with the "Clear the empty match" button.
3. [x] Typecheck, tests, commit.
4. [ ] Deploy (needs the user's OK).

## Progress log

- [x] `matchEngine.clearEmptySetup()` shares the auto-cancel path; tests in
      `src/matchEngine.test.ts` ("a set-up match nobody joins").
- [x] `MatchHoldNotice` in `ControlPage.tsx`: phase-aware text (empty set-up
      / set-up with N joined / running / just finished) in the robot row
      and the waiting dialog; the button only for an empty set-up match.
- [x] Checked live against a local dry-run backend
      (`DRY_RUN=1 WEBSOCKET_PORT=3917`, data dir in %TEMP%) with headless Playwright:
      create match → Enable held → notice + button shown in row and dialog
      → button press logged `Set-up match cleared by team 6036's page`,
      `Match cancelled`, `Applying 1 pending Wi-Fi change(s) … + 6036-DELTA`.
- [x] Docs: `docs/match-system.md`, `docs/internals.md`.

## Findings / gotchas

- The pFMS backend refuses to start on Windows without `DRY_RUN=1`.
- Staff cancelling a set-up match by hand used to leave held joins waiting
  for Apply now. Changed at the user's request: every cancel of a set-up
  match now runs `setupCancelledHook` (renamed from `abandonedSetupHook`)
  and applies waiting joins. Releases and the admin hold are unchanged; the
  hold lifting any other way (post-match clear) still waits for staff.
- Robot link/drop transitions are now logged by `radioManager` (asked for
  after 5940's unexplained 30-minute link on 2026-10-08).
