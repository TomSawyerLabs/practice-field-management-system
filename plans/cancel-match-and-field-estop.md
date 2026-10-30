# Cancel Match + Field E-Stop latch

## Goal

The user (2026-10-12): "right now, to end a match, there are 2 options: pause
and e-stop. E-stop should not be an option like that. Just change it to
cancel match. Cancelling a match shouldn't affect the teams not in a match.
There should still be a big E-STOP button, that's a global latch for
emergency. All teams should clearly see 'E-STOPPED' (with a reason, like
field level or single robot) so that teams can seek out fixing the issue
themselves."

So:

1. `/match` gets a **Cancel Match** button for a running (or paused) match.
   It ends the match for the teams in it only; free-driving robots are
   untouched.
2. The big **E-STOP** is a **field latch**, separate from the match: once
   pressed, every robot on the field is stopped until staff clear the latch.
   Ending/clearing/creating a match does not clear it.
3. Every team sees **E-STOPPED** with the reason: _field E-Stop_ (every
   robot, staff pressed it) vs. _this robot_ (and who: its Driver Station,
   the team's page, field staff).

## Environment / context

- Engine: `src/matchEngine.ts` (`stopMatch`, `abandonMatch`, `globalEStop`,
  `stationEStop`, `clearEStop`, `clearMatch`, `isEStopped`).
- The stop cut / out-of-match hold: `src/index.ts` (`eStopCut` listener,
  hold loop using `matchEngine.isEStopped`).
- WS handlers: `src/websocketServer.ts` ~1200–1310. Types: `src/types.ts`
  (`StationControlState`, `MatchState`, `MatchEndReason`, admin messages).
- UI: `MatchControlPage.tsx` (running controls ~1160–1225), `AdminPage.tsx`
  (`GlobalEStopSection`), `ControlPage.tsx` (team page), `MatchPanel.tsx`,
  `AStopPopout.tsx`, `utils/stationChecks.ts` (scoreboard labels),
  `utils/fieldIssues.ts`, `ScoreboardPage.tsx`.
- Docs: `docs/match-system.md` (Match Flow step 5–6, Stops section, Admin
  Overrides).

## Decisions already made (don't re-ask)

- Cancel Match uses the existing `stopMatch` path (→ `postMatch`,
  `endReason: 'stopped'`, normal 2-min auto-clear). It only disables joined
  stations; non-joined stations never get FMS packets, so free-drive is
  unaffected. The wire value stays `'stopped'` (history files already hold
  it); the UI labels it "Cancelled".
- Paused match: Resume / Cancel Match. Abandon (→ idle directly, skipping
  post-match) goes away so there is one way to end a match early.
- Field E-Stop is a separate latch `fieldEStop` on the engine/`MatchState`,
  not "set all six per-station flags". `isEStopped(station)` is true for
  every station while latched, so the network cut and the out-of-match hold
  cover all robots, including a team that takes a slot after the press.
- Per-station e-stops record who latched them (`eStopBy`: `ds` | `team` |
  `staff`) so the team page can say why.
- With the latch separate, clearing a match no longer has to own the field
  e-stop, so field-e-stop endings auto-clear like any other ending; the
  latch keeps every robot stopped regardless.
- Field E-Stop buttons stay where they are (`/match`, `/admin`); not added to
  team pages.

## Plan / steps

1. Backend: types (`fieldEStop`, `eStopBy`, `MatchEndReason`),
   engine (latch, refuse start/enable/create while latched, clear),
   WS message for clearing the field latch, DS game data. Tests.
2. `/match`: Cancel Match in running + paused; big FIELD E-STOP; latch
   banner with Clear; participant chips say the reason.
3. `/admin`: E-STOP button = field latch; "Force stop match" → "Cancel
   match"; clear UI distinguishes field latch vs. per-robot.
4. Team page: big E-STOPPED banner with reason (field vs. this robot);
   pop-out window text; MatchPanel chip.
5. Scoreboard: field-level E-STOP overlay; per-robot label.
6. Docs + README check. Typecheck, tests, commit.

## Findings / gotchas

- Admin page comment said "/match only aborts a countdown" — confirms there
  was no way to end a running match from `/match` except pause→abandon or
  E-Stop All.
- `globalEStop()` set `phase = 'postMatch'` even from `idle`/`created`. Fixed:
  the field E-Stop only ends an active match.
- `bun test` also picks up stale compiled tests in the gitignored `dist/`;
  `dist/fmsServer.test.js` fails on a port bind. Not related.

## Part 2: coming out of an e-stop starts disabled

The user (2026-10-12, follow-up): "Ignoring the single robot e-stops/disable,
E-STOPPED is a field level flag. For now, it's all software buttons that are
easy to sync state. In not too long, we'll have more permanent e-stop
buttons and will need to physically clear those presses before things can be
run again. In any case, as soon as any robot comes out of e-stopped, it needs
to start 'disabled' and a click of 'enable' (either on DS or team page
depending on active mode) is needed before it can run again."

Gaps found in what part 1 shipped:

- **In a match**, `enableParticipating` (start, auto→teleop, resume) calls
  `enableStation`, which enables every joined robot regardless of
  `disabledBy`. A robot whose e-stop was cleared mid-match would come back
  on at the next phase change by itself.
- **Out of a match**, clearing lifts the DS→robot cut at once. A DS that
  never noticed (not under field control, still set to Enabled) would
  re-enable the robot with no click. Whether the FRC DS drops to disabled
  when the cut starts was asserted in `535f015` but never verified.

Design:

- New `DisabledBy` value `'estop'`: set on every joined station when its
  e-stop ends during a match. `enableStation` skips it; only the team page's
  Re-enable (or staff Enable) clears it (`undisable`).
- Out of a match: after an e-stop ends, the station is **re-arming**. The
  cut stays on until pFMS sees the DS command the robot _disabled_ (the
  capture already reads DS→robot control packets on UDP 1110 at ingress, even
  while the FORWARD rule drops them), or sees no DS→robot traffic for 2 s
  (nothing is commanding the robot; a DS that starts later starts disabled).
  The team page says to press Disable and then Enable on the DS.
- Future (not now): physical e-stop buttons will be inputs to the field
  latch, and clearing will require every pressed button to be released first.
  Shape the latch so it can get more sources later; don't build it yet.

## Progress log

- [x] 1 backend — `fieldEStopSince` latch, `eStopBy`, `adminClearFieldEStop`,
      `abandonMatch`/`stationAbandonMatch` removed; engine tests added
- [x] 2 /match — Cancel Match (asks once) running + paused; E-STOP at the top
      in every phase; FIELD E-STOPPED banner with confirm-to-clear; start
      refused while latched; participant chips say field vs. own (+ source)
- [x] 3 /admin — shared FieldEStopControl; "Force stop match" → Cancel match;
      per-robot e-stop list clears only robots' own e-stops
- [x] 4 team page — TeamEStopBanner (shown to every team while the field is
      latched); pop-out button text; MatchPanel chip
- [x] 5 scoreboard — full-width E-STOPPED band; per-robot FIELD E-STOP label
- [x] 6 docs (match-system, network, README), typecheck, tests, commit
- [x] Verified in a DRY_RUN dev server: latch → /match banner, team page
      banner, scoreboard band; confirm-clear releases it.

- [x] Part 2 — `disabledBy: 'estop'` (phase changes skip it; team Re-enable
      lifts it); out-of-match re-arm cut until the DS shows Disabled or 2 s
      quiet (`REARM_QUIET_MS`); capture feeds `noteDsControl`; e-stops latched
      in setup survive the start; team-page notices; docs; tests

## Not verified

- Cancel Match on a real running match (needs a DS); covered by engine
  tests only.
- Superseded 2026-10-30: e-stops no longer cut traffic and the re-arm wait
  is gone (`plans/robot-estop-warnings.md`). The rest of this list stands.
- The re-arm cut on the field: that the capture sees DS→robot control
  packets for a station whose DS routes through pFMS (it already reads them
  for joysticks), and what the real FRC DS does when the cut starts (does it
  drop to Disabled by itself?). Check on steamboat: field E-Stop, clear, and
  watch the journal for `re-armed (its Driver Station shows Disabled)` vs.
  the robot staying cut while the DS says Enabled.
- The re-arm notice on the team page (in DRY_RUN there is no capture, so
  re-arming always ends by the 2 s quiet rule).

## Open questions for the user

(none yet)

## Things not to do

- Don't clear the field latch from `clearMatch`/`createMatch`.
- Don't send the e-stop bit to Driver Stations (DS latches it until roboRIO
  reboot) — stays backend-only, as today.
