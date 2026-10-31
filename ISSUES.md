# Known Issues & Technical Debt

## Check per-laptop `ip rule` entries on steamboat on a day with teams

The cleanup (`480bc89`) deployed in `0586d9a` with no team on the field, so two
things have only run against a fake kernel. Read-only on steamboat, while laptops
are driving or routed:

- `ip rule list` should show rules numbered from 32765 down, one per laptop, no
  duplicates. This is the first real use of `ip rule add ... priority N`.
- After a graceful reload (`systemctl reload`) with teams on, the journal should
  show `Restored route preference`, and those laptops' rules should still be there.

If rules don't appear, or the journal shows `Could not remove stale ip rule`, that
matters: Drive and auto-connect depend on them. Close this entry once both are
seen. Background: `plans/ip-rule-cleanup.md`.

## The scoreboard socket shows match state to the internet

`/ws/scores` is open to everyone, on purpose, for `/scores` and Cast TVs. It sends
the whole `matchState`, which includes each connected Driver Station's address
(`connectedStations`), plus `stationChecks` and `telemetry` (seen 2026-10-30).
`/ws` no longer shows these to strangers (`plans/ws-internet-guard.md`). Matters
because this is the remaining way to read the field from outside: a trimmed public
copy of what the scoreboard actually draws would close it.

## Anyone on site can clear the field E-Stop

`adminClearFieldEStop` is `staff`, and `/match` clears aren't behind the operator
code (`plans/operator-login.md`), so clearing the field E-Stop lets every robot run
again with no login. The user chose to leave it open for now (2026-10-30). Revisit
later: an operator login for the field clear only, with a team still able to clear
its own from its DS.

## Stops still cut comms

An e-stop out of a match cuts a DS's control traffic (`stopCut` in
`src/matchEngine.ts`, `setStopCut` in `src/networkManager.ts`) until the DS is seen
to stop, and the team page's **Stop robot** cuts it for as long as it lasts. Matters
because the user doesn't want to cut comms, and would rather everything stayed
connected, but an e-stop has to act within 1 s, 250 ms at best (2026-10-30), and a
DS's next TCP handshake can be about 8 s away. Check 7 in
`plans/field-verification-checklist.md` shows whether a DS in local control obeys
the disabled UDP packets on its own. If it does, remove the cut, and move Team Stop
to the same field control. Note the journal's
`slotN: e-stop: <why>, N ms after the stop` lines, which time every real stop.

## Nothing warns about a running robot that isn't reporting to the field

A DS connected to its robot some other way (tethered, or the robot's own Wi-Fi)
never crosses the field, so it keeps driving while `/match`, `/csa` and the team's
page say E-STOPPED. `/match` and `/csa` warn once the robot's own status says it's
still enabled, but a robot whose replies don't cross the field sends pFMS nothing,
so there's no warning for it, only a note on those pages during any e-stop.
Matters because staff could still believe a running robot is stopped.

## Unverified behaviour we depend on

Each needs a field visit. What to try and what each result means is in
`plans/field-verification-checklist.md`.

- **Re-enable after a DS-side disable (check 1).** `undisable()` clears the
  field's latch and resumes enable packets, but a DS that latched a local Enter
  disable may not follow. There's no clean sample: since telemetry began on
  2026-09-27, every disable followed by a re-enable was a dropped DS or a lost
  robot link.
- **2027 DS stop reporting (check 2).** pFMS can't see a Disable pressed on a
  2027 DS: `dsReportedStatus` only counts a disable after seeing the enabled
  bit, which that DS never sets (0 of 37,736 telemetry rows for team 5940, whose
  e-stop and a-stop bits were never set either). The field would show that
  robot as enabled. Whether the DS signals a stop some other way is unknown.
- **DSes that keep reporting outside a match (checks 3, 4).** pFMS drops a DS
  that streams status while not in a match, so it returns to local control. It
  doesn't always take: 590 drops from 2026-10-09 to 2026-10-28, repeating every
  15 s, including 173 in 43 minutes for one DS of team 2813 on 2026-10-25. Nobody
  has looked at such a laptop, so it isn't known if the team could still drive.

## Depends on things outside this repo

- The balls-counter deployed on sentinel runs from the unmerged branch
  `fix/package-for-latest-uv` (`897046d`, PR #1 open, mergeable, 9 ahead of
  master, as of 2026-10-30), not its master. A `git pull` on master there
  silently breaks match score recording.

## Not started

- The Blue Alliance reporting (from the match-review work) was scoped and
  never begun.

## SystemCore gaps

- pFMS can't read a SystemCore robot's own traffic yet. Since `cb0db29` it
  records UDP 1110 both ways but doesn't decode it, so outside a match there's
  no battery, link or dropout data for these robots. In a match, battery does
  show, because the DS reports it to the field. Waiting on a first capture
  (check 5 in `plans/field-verification-checklist.md`), then a parser:
  `plans/systemcore-robot-capture.md`.

## A robot just released can leave its slot a false "last linked"

`RadioManager` clears `lastLinked` when a change is applied, but the status poll
stamps it again while the radio still shows the old robot linked (seen 2026-10-30
on a fake radio). `/csa` then told a new team in that slot "dropped off the field
Wi-Fi, last linked 24 s ago", 1 s after it arrived. Matters because staff look for
a lost robot, not one still joining.

## An e-stop cut can still pulse for two robots of one team

The laptop-side copy of a DS control packet can't be matched to a station when a
team has two robots and pFMS doesn't know which robot that laptop drives
(`RobotPacketCapture.resolveStation` returns undefined rather than guess). While
the stop cut drops the forwarded copy, nothing reaches `noteDsControl`, so the wait
lapses after 2 s (`DS_CONTROL_QUIET_MS`), the cut lifts, and the next packet re-arms
it: the robot gets a burst of enabled packets about every 2 s. Seen by reading the
code, not on a field. Matters because it's the one case left of the pulsing fixed
for a deferred release: the laptop is the only thing that could say which robot.

## Most page actions throw if pressed while the socket is connecting

Stops now go through `stopDelivery`, but the other ~100 `ws?.send(...)` calls in
`frontend/src/hooks/useBackend.ts` don't. One pressed in the moment a socket is
CONNECTING throws `InvalidStateError` in the click handler, and one pressed while
it's closed is lost with no sign (Clear field E-Stop, Ready, Join). Reproduced in
headless Chrome. None of them stops a robot, so it's lost actions, not a safety gap.
