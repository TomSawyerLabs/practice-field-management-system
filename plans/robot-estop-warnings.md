# Robot e-stop warnings, and what happened to TestBird

## Goal

Tell a team when its robot is e-stopped in the roboRIO, which only a reboot
clears, and record everything known about who sent it, including when the DS
for the team's other robot did.

## Decisions made

- The robot's own status bit decides "latched". pFMS's records of e-stops don't,
  because they can be cleared while the robot stays latched.
- Attribution uses the forwarded copy of each control packet: it reached the
  robot, and its VLAN says which robot. The laptop comes from the source port
  seen on the arriving copy.
- With two robots of one team, a laptop-side packet pFMS can't place is dropped
  rather than guessed. The copy on the robot's VLAN is still reported.

## What happened to TestBird (2026-10-28)

Evidence, from `recordings/practice-20261028-170958-0aed/telemetry.csv` and the
journal:

- 5:10:11.187 PM PDT (00:10:11.187Z): TestBird reports enabled.
- 5:10:11.208 PM PDT: it reports e-stopped, 21 ms later (one DS packet).
- It stayed e-stopped until it rebooted around 5:17:30 PM PDT. Later runs show
  no e-stop.
- 5:14:09 PM PDT: the Field E-Stop, three minutes after the latch. It can't have
  caused it: pFMS never sets the e-stop bit (both `new Control(false, …)` calls).
- 5:17:27 PM PDT: the control packets from TestBird's laptop 10.55.231.82 had
  control byte 0x00, no e-stop bit, while the robot was still latched.
- Main robot's rows (battery about 12.30 V) show no e-stop, so the main laptop's
  packets weren't reaching and e-stopping it.

Not determined: who sent it. Control bytes weren't logged then. Candidates:

1. Space pressed on the TestBird laptop. The DS catches Space even when it isn't
   the focused window, so typing anywhere on that laptop would do it. 21 ms after
   enable suggests one action did both, but that is not proven.
2. A third DS reaching TestBird directly (tethered, or on its own 2.4 GHz Wi-Fi).
   114 does use direct connections. The field couldn't see that.
3. The main laptop's packets reaching TestBird for a moment. Less likely: nothing
   in the journal shows it.

The new journal lines settle this next time.

## Earlier statements that were wrong

- "The 5:14 PM Field E-Stop latched it": see above.
- "pFMS passed the stop to both laptops": it disables, and never sends e-stop.
- "The TestBird laptop stopped sending control packets" (`Robot link down … the DS
sends the robot nothing`): unreliable. The laptop's arriving copies were being
  counted on slot1, so slot2's link check saw none. tcpdump at 5:17 PM showed it
  sending normally.
- `docs/network.md` also said pFMS sends the DS the e-stop. Fixed.

## Findings / gotchas

- `recordings/.../telemetry.csv` for two robots of one team mixes them: every
  reply was also filed under the first station by team number, flipping "slot1"
  enabled/disabled every 20 ms. That caused the flood of `Practice recording
continues` lines, and 706 of the 765 e-stop rows above were TestBird's, filed
  under slot1. Fixed by resolving laptop-side packets by drive session.
- Long bash heredocs break here: use a script file.

## Progress log

- [x] Detector, attribution, two-robot fix, who-pressed logging
- [x] Team banner, every robot of the team; `/csa` critical issue
- [x] Tests and docs
- [x] Merged to local master
- [x] Deployed on its own: `6e290fb`, 2026-10-30 9:53 AM PDT (16:53Z)
- [ ] Seen on a real e-stop
- [x] Stop cut removed from e-stops, re-arm wait dropped, e-stop clears are
      `staff`
- [ ] Out-of-match e-stop timed at the field (checklist check 7)

## Stop cut and follow-up threads (2026-10-30)

The user doesn't want to cut comms, saying it shouldn't ever be needed. Agreed
change, in `issues/stop-cut`: remove the `pfms-estop-*` cut from the field and
station e-stops, keep it for the team page's Stop until a replacement exists,
and drop the wait that keeps it on after a clear until the DS shows Disabled.

Done on 2026-10-30:

- E-stops (field and station) rely on field control alone. The cut remains only
  for the team page's Stop (`teamStopCut`), and `ISSUES.md` has an entry for
  replacing it. The rule keeps its `pfms-estop-` name, so startup still removes
  one left by an older version.
- The re-arm wait is gone, with `reArming`, `noteDsControl` and the capture's
  `onDsControl`, plus the team page notice that went with it.
- `/csa` link warnings used to skip e-stopped robots as "cut by the field". They
  now skip only team-stopped ones.
- `adminClearEStop` and `adminClearFieldEStop` are `staff`. A team's own e-stop
  never had a Clear on its team page, so nothing a team page does needed them,
  and `/match` has no login, which rules out `admin`.

What a DS that ignores the field can now do: keep driving through any e-stop,
in or out of a match, while pFMS shows it e-stopped. A cooperating DS out of a
match takes the stop at its next handshake, about 8 s, where the cut took ~100
ms. Not measured: check 7 in `plans/field-verification-checklist.md`. pFMS
doesn't warn about it yet (`ISSUES.md`).

Remaining `ISSUES.md` entries went to seven threads, each claimed by branch name
in that file. Left out on purpose:

- The Blue Alliance reporting and the Space → A-Stop mapping: the user said not
  yet.
- The field checks and balls-counter: they need a field visit or another repo.
- The SystemCore parser: 5940 comes back mid next week, around 2026-11-04.
- 114's Driver Station logs: not expected, so stop waiting on them.

The first launch of nine threads used the tomsawyerlabs.com project ID. Those
threads changed nothing, and their worktrees and branches were removed.

## Things not to do

- Don't launch T3 threads on a remembered project ID: read the project first,
  and check each new thread's worktree path after launching.
- Don't treat a pFMS "cleared" e-stop as the robot being clear.
- Don't trust historical two-robot telemetry station by station; use the voltage
  to tell the robots apart.
