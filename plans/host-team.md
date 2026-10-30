# Host team

## Goal

The team hosting the practice field should not have to re-enable its robots
every morning, and should be the last to give up a slot when visiting robots
arrive. Scrimmages are the exception: everyone is treated alike. All of it is
set and managed by admins only.

## Environment / context

- The daily reset is `src/scheduler.ts`, a cron on `RADIO_CLEAR_SCHEDULE`
  calling `radioManager.clearAllConfigurations()`.
- "The release list" has two faces today:
  - the pending list: `stageReleaseAll('postMatch')` queues every robot on the
    field to leave when a match ends (`src/index.ts`);
  - the "longest on the field first" lists staff read when deciding who to
    release: Teams & Controls on `/admin`, and the robot tiles on the CSA page
    (`stationOrder` in `frontend/src/utils/fieldIssues.ts`).
- Settings live in `SetupSettings`, written by `updateSetupSettings`, which
  `src/wsAccess.ts` already gates as `admin`. `setupConfigState` reaches every
  internal client, so read-only pages can see who the host is.

## Decisions already made (don't re-ask)

- **Host teams are a list of team numbers** (`hostTeams`), not SSIDs, so every
  robot a team brings counts. One team is the usual case; a list costs nothing.
- **A scrimmage is the match queue being in use** (user, 2026-10-30): its line
  is open, or a match is queued, on deck or playing. This replaced an admin
  checkbox from the first pass (`a04ab2e`). It is the test that already turned
  practice clips off, now shared as `queueInUse` in `src/utils.ts`.
- **Only the scheduled reset spares the host.** Admin "Clear all robots from
  the radio" stays total: it is the escape hatch for a stuck field.
- **Post-match, host robots are not queued to leave.** Staff can still release
  them; pFMS just never proposes it.
- **Staff lists put host robots last and label them Host.** Making room stays
  field staff's call: pFMS does not auto-release a host robot for a visitor.
- **At the reset, waiting changes about host robots stay on the list**; the
  rest are dropped as before. A reset that removes nothing does not touch the
  radio, so a host robot left on overnight keeps its Wi-Fi.

## Plan / steps

1. Settings, validators and shared helpers (`src/types.ts`, `src/utils.ts`).
2. Radio manager: `keep` for the clear, `stays` for the post-match release.
3. Wire the scheduler and match-end listener to the settings.
4. Frontend: admin card, release order, Host labels.
5. Tests, docs, commit.

## Progress log

- [x] Backend: `hostTeams` setting, `keep` on the clear, `stays` on the
      post-match release, scheduler and match-end wiring.
- [x] Scrimmage follows the queue instead of a checkbox.
- [x] Steamboat runs the reset: `RADIO_CLEAR_SCHEDULE=0 6 * * *` in
      `/etc/pfms/environment`, last fired 2026-10-30 6:00 AM PDT (13:00Z).
- [x] Frontend: Host team card on `/admin`, host last and labelled on Teams &
      Controls and the CSA page.
- [x] Docs: `docs/match-system.md`, `docs/configuration.md`.
- [x] Tests: `radioManager.test.ts`, `utils.test.ts`, `fieldIssues.test.ts`.
- [ ] Not deployed. The admin card has not been opened in a browser.

## Findings / gotchas

- The unit on steamboat is `practice-field-management-system.service`, not
  `pfms`.
- The last match of a queue still counts as a scrimmage. The release listener
  runs before the queue's own listener marks the match played, so a host robot
  is queued to leave after it.
- A match left in the queue keeps "scrimmage" on, so the 6:00 AM reset clears
  the host team too. The card shows Scrimmage when this happens.

## Things not to do

- Don't test against the field radio: tests use the dead `RADIO_URL` in
  `radioManager.test.ts`.
- Don't change `stationOrder` itself: it also ranks field issues, which should
  not move because a team is the host.
