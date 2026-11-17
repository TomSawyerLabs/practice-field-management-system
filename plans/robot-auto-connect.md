# Robot auto-connect, passphrase recovery, check-before-reconfigure

## Goal

Make arriving at the field hands-off for teams, and keep robots on site
under field control (a robot on the field's Wi-Fi can be disabled by it).
Asked for (user, 2026-11-16):

1. **Auto-connect.** A robot that has been here before (a saved robot),
   heard on its 2.4 GHz backup network `FRC-<ssid>`, is put on the field as
   `<ssid>` automatically — unless the team turned that off for that robot.
   "Arrive, turn on robot, wait 60 s, it's connected."
2. **Passphrase recovery.** Teams forget passphrases. When the saved one
   doesn't open the robot, try the team's other saved passphrases and the
   pattern `{NUM}{NUM}` (team number twice, e.g. `12341234`).
3. **Check before reconfiguring.** A team entering a passphrase pFMS doesn't
   know yet no longer reconfigures the field blind (30 s outage to find out).
   pFMS tests it on the robot first and only reconfigures once it works.

User note: radios can have different client (6 GHz) and AP (2.4 GHz)
passphrases, but no team has been seen doing it. So the 2.4 GHz check is
treated as the truth, with "Enable anyway" kept as the escape hatch.

## Environment / context

- Worktree `C:\Users\camer\.t3\worktrees\practice-field-configurator\t3-99175ea5-8cfed23adaed4ea4`,
  branch `t3/auto-connect-robots-smoke-test-passphrase`, base `master` @ `ca468b7`.
- Builds on the robot Wi-Fi scan: `src/robotWifiScan.ts`, plan
  `plans/robot-wifi-scan.md`. The scan is ON at steamboat (card `wlp0s20f3`).
- Saved robots: `src/savedTeamStore.ts` (`saved-teams.json`). Every config the
  radio takes is auto-saved there (index.ts config-change listener).
- Field changes: `radioManager.configure()` → pending list → apply/hold/in-line.

## Decisions already made (don't re-ask)

- Auto-connect needs the saved passphrase **verified** on the robot's 2.4 GHz
  network first. Never reconfigure the field on an unverified key automatically.
- Opt-out is per saved robot (`autoConnect: false` in saved-teams.json), a
  toggle on the robot's row. Default on.
- (Round 2, user 2026-11-16) **Keep every passphrase each team has ever
  used**, for good, rolling over year to year: `team-passphrases.json`
  (team → keys, newest first), seeded from saved robots on first run. No
  caps on what is kept or tried. Replaces the per-robot `formerKeys` (last 5).
- (Round 2) "Arrival" = first heard after ~90 s unheard: OK as is.
- (Round 2) Not during a match: confirmed.
- (Round 2) **Coalesce auto-connects and show them on the scoreboard.**
  `src/autoConnectBatch.ts`: first robot waits 5 s, extended 5 s at a time
  while another heard robot is still being checked (`arrivalChecks()`),
  60 s cap; then `radioManager.enableTogether()` = one radio change, which
  still respects holds and the enabled-robot deferral. Scoreboard strip
  (`FieldWifiNote`, `utils/fieldWifiNotice.ts`): live countdown "in N s, once
  robots are disabled", then "once robots are disabled"; also shows a
  deferred reconfiguration and held changes (admin / match / staff).
- (Round 3, user 2026-11-16) Wider recovery (unknown / capitals-only names,
  saved as new robots) OK — but **never try capitalization variants**; only
  the name as broadcast is joined (true already: checks join the heard SSID).
- (Round 3) 2-minute retry after no answer OK, and **the CSA page must show
  what is happening**: `RobotWifiActivityLog` (in memory, 100 entries / 4 h)
  fed by the scanner's `note` option and the batch apply in index.ts;
  `RobotWifiActivityPanel` on the CSA page with "under way" lines
  (`utils/robotWifiActivity.ts`) and the activity list. Unreachable key
  checks carry `retryAt`. `enableTogether` returns its hold reason.

## Design (my calls — flag to user if they disagree)

- **Once per arrival.** A robot auto-connects at most once per "appearance"
  (from first heard until it drops off the scan, ~90 s silent). A robot
  heard while already on the field counts as connected. So a robot that is
  released (by the team, idle release, or after a match) and stays powered
  is **not** put back — no fight with releases. Power-cycling it (off > 90 s)
  is a new arrival.
- **Not while a match is set up / running / just over** (phase ≠ idle): the
  automatic enable waits for idle so it never lands on the match admin's
  pending list. An explicit team request (feature 3) is not held back by
  this; it goes through the pending list like pressing Enable.
- Field full: an auto-connect goes in line like pressing Enable does.
- **Recovery candidates**, in order, no cap: the team's saved robots'
  passphrases (most recent first), every passphrase in the team's history,
  then `{NUM}{NUM}`. Keys that aren't valid WPA (8–63 chars) are skipped
  (`{NUM}{NUM}` for a 3-digit team is 6 chars → skipped).
- A found passphrase is **saved** on the robot (every one stays in the team history)
  and the row says it was recovered. Then auto-connect proceeds.
- Recovery also runs for a heard network of a known team whose name isn't
  saved (other suffix, or capitals differ): if a team passphrase opens it,
  pFMS saves it as a new robot under the name it broadcasts (inheriting
  auto-connect from the capitals-only match, or off if any of the team's
  robots is opted out). This turns the "capitals differ" error into a
  self-fix.
- A stalled on-field robot whose field passphrase is wrong also searches; a
  found key is saved and the station reconfigured in place with it.
- **Check-before-reconfigure** applies to a team's new robot / changed
  passphrase (`stationUpdate` whose ssid+key isn't saved, robot not on the
  field) **while the scan is running**. The robot is saved, and a connect
  request is recorded; the field changes only once the check passes. Not
  heard → row says "turn it on", with **Enable anyway**. Scan off → blind,
  as before (nothing to test with). Request expires after 30 min.
- An `unreachable` check result is retried after 2 min (was: never).
- Key-check results for a network are forgotten when it drops off the scan,
  so every arrival re-verifies (a team may have changed the radio).

## Plan / steps

1. Plan doc.
2. Types + saved store (`autoConnect`, `formerKeys`, `keysForTeam`,
   `setAutoConnect`). Tests. (formerKeys later replaced by the team history.)
3. Scanner: candidates, search, found callback, arrival tracking,
   auto-connect, requests, unreachable retry, forget on expiry. Tests.
4. Wiring: index.ts options; websocketServer gating + `setRobotAutoConnect`;
   wsAccess.
5. Frontend: row toggle, awaiting/recovered/searching lines, add-form hint,
   Enable anyway.
6. Docs (`docs/robot-tester.md`), README if needed.
7. typecheck, prettier, tests, commit.
8. Merge to master, deploy (deploy owner thread, `plans/deploy-log.md`), and
   watch a team arrive: `journalctl -u practice-field-management-system | grep "Robot Wi-Fi"`.

Current step: **8 — deploy and verify on a real robot** (implementation done, committed on the branch, not merged to master or deployed).

## Findings / gotchas

- Fix-passphrase **Save** (save only) now also connects the robot once the
  new key checks out, if it hasn't been connected this arrival and
  auto-connect is on — "Save and enable" is mostly redundant now.
- Each auto-connect is its own radio change (~30 s outage for robots on the
  field, deferred while any robot is enabled). Arrivals are spread by the
  one-at-a-time checks, so batching wasn't attempted.
- `RobotWifiScanner.keyChecks` was never pruned; results lived for the
  process lifetime. Now pruned when the network drops off.

## Progress log

- [x] 1 plan
- [x] 2 types + store (`savedTeamStore.test.ts`, 4 tests)
- [x] 3 scanner (`robotWifiScan.test.ts` 29 → 48 tests; mutation-checked the
      arrival rules: dropping the "placed when it went quiet" guard or the
      `arrived` check each fails tests)
- [x] 4 wiring (index.ts `enableHeardRobot` / `saveFoundKey` / `robotPlaced`;
      websocketServer gates `stationUpdate`, handles `setRobotAutoConnect`)
- [x] 5 frontend (row: auto-connect line + Turn off/on, Waiting for robot,
      Trying other passphrases…, recovered line, Enable anyway; add-form
      note). Unit-tested wording only — not looked at in a browser.
- [x] 6 docs (`docs/robot-tester.md`, README intro)
- [x] 7 typecheck, prettier, full suite 1340/1340
- [x] Round 2: permanent passphrase history (`team-passphrases.json`),
      shared reconfiguration (`AutoConnectBatch`, `enableTogether`),
      scoreboard note. Tests: batch 4, notice 6, radioManager +3, scanner
      +2, store rewritten (5). Scoreboard strip not looked at in a browser.
- [x] Round 3: CSA page robot Wi-Fi activity panel. Tests: scanner +5,
      activity log 1, under-way lines 3. Panel not looked at in a browser.
- [x] Merged into local master (`8f4f25c`, 2026-11-16); not pushed or deployed.
- [ ] Verify on a real robot at steamboat (needs a deploy + a team)

## Open questions for the user

None yet.

## Things not to do

- Never test against field hardware from this PC (see memory: fake
  RADIO_URL always).
- Don't auto-connect on an unverified passphrase.
