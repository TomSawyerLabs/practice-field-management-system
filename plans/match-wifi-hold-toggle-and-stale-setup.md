# Match-page Wi-Fi hold switch, and a set-up match that cancels itself

## Goal

On 2026-10-01 team 840 arrived, pressed Enable Wi-Fi three times, and was
told each time that the match admin had to apply it. Nobody was at the match
page: a match had been set up at 19:25:50 and never started, joined, or
cancelled, and it was still in `created` over an hour later. 840 gave up and
used their own direct connection.

Two changes so this does not repeat:

1. **A set-up match nobody joins cancels itself** after 10 minutes, and the
   join requests it was holding go through.
2. **A switch on `/match`** for whether teams' Wi-Fi requests are held while
   a match is set up, so the person running matches can turn the hold off
   without the admin passphrase.

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator`, branch `master`,
  shared working tree (other threads commit here; stage only own hunks).
- Production: `steamboat`, service `practice-field-management-system`,
  health at `localhost:9005/health`. Running `5425f4c` when this started.
- Hold logic: `src/index.ts` `radioManager.setShouldHold(...)`; list and
  apply in `src/radioManager.ts`; lifecycle in `src/matchEngine.ts`.
- Earlier design this builds on: `plans/pending-wifi-changes-list.md`.

## Decisions already made (don't re-ask)

- User chose **both** pieces (2026-10-01).
- The switch is a setup setting, `holdRadioChangesForMatch` (absent/true =
  hold), so it survives a restart and shows on the admin page too. `/match`
  writes it through its own message (`matchHoldWifi`) with match-page trust:
  that page can already press Apply now, which is the stronger power.
- With the switch off, requests are still held while a match is **running**
  (countdown through endgame, paused). Applying mid-match would change which
  team a station holds under a running match. The switch only relaxes
  `created` and `postMatch`.
- Turning the switch off does not apply what is already waiting; staff press
  Apply now (same rule as every other hold lifting).
- Auto-cancel: 10 minutes in `created` with no station joined, counted from
  when the match last had nobody joined. A join stops the clock; the last
  team leaving restarts it. Staff clicks do not reset it (staff pages send
  heartbeats, so "any activity" would never expire).
- On auto-cancel, waiting **joins** are applied and waiting **releases** are
  left for staff. This narrows the earlier "waiting changes never apply by
  themselves" decision: its reason was that nothing should leave the field
  without staff, and that still holds. Skipped while the admin "Hold Wi-Fi
  changes" switch is on.
- Wording: never "Enabled/Disabled" on a switch about robots (see
  `plans/out-of-match-enable-check.md`).

## Plan / steps

1. Backend: setting + validator, `matchHoldWifi` message, `shouldHold`.
2. Backend: created-phase auto-cancel timer in `MatchEngine`,
   `autoCancelAt` in `MatchState`, abandoned-setup hook.
3. Backend: `RadioManager.applyPendingJoins()`.
4. Tests for 2 and 3.
5. Frontend: switch card on `/match`, auto-cancel note in the created view,
   admin page wording, team/staff hold text.
6. Docs (`docs/match-system.md`, `docs/internals.md`,
   `docs/configuration.md`).
7. Typecheck, tests, commit. Deploy only when the user says.

## Findings / gotchas

- journald had zero suppressed lines on 2026-10-01, so the log sequence for
  840 is complete (19:33:35, 19:34:37, 19:36:10 `Holding Wi-Fi change
(match)`, each withdrawn by the team).
- `updateSetupSettings` needs admin login once a passphrase is set; `/match`
  messages do not. Hence the dedicated message.
- `setShouldDefer` is `isMatchActive() || anyRobotEnabled()`: a commit never
  reaches the radio mid-match anyway, but `applyPendingChanges()` rewrites
  `activeConfig` at once, which is why the running phases keep the hold.
- A finished match already auto-clears after 2 minutes
  (`POST_MATCH_AUTO_CLEAR_MS`); only `created` had no way out.

## Progress log

- [x] Diagnosed 840's report from steamboat logs.
- [x] Steps 1–7, 2026-10-01. `MatchState` field ended up named
      `setupExpiresAt`. `docs/configuration.md` needed nothing (it does not
      list these settings). Typecheck clean, 763 tests pass.
- [x] Deployed 2026-10-02 13:12 with `update.sh`: steamboat runs `b566f37`
      (contains `934d850`), service active, no errors in the first minutes,
      the switch text is in the served `match-*.js` bundle. The field was
      already idle before the deploy, so the parked match is gone.
- [ ] The two pages have still not been looked at in a browser: the dev
      server does not run on the Windows machine (the backend needs Linux
      netlink) and the T3 preview browser could not load `pfms.tsl`
      (`chrome-error://chromewebdata/`). Someone on the field network should
      glance at the switch card on `/match` and the new admin checkbox.

## Open questions for the user

1. When an abandoned set-up match cancels itself, robots waiting to join
   are applied without staff. Keep that, or go back to the strict "only
   Apply now" rule? Recommendation: keep it.

## Things not to do

- Do not make the switch lift the hold during a running match.
- Do not auto-apply releases; only joins.
- Do not clear the parked match on steamboat or deploy without being asked.
