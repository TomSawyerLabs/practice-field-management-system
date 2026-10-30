# Field verification checklist

What can only be settled at the field, with what to try and what each result
means. Written from the 2026-10-30 audit of `ISSUES.md`, which also settled
everything that code, the steamboat journal and the ops repo could answer.

## Goal

Stop depending on Driver Station behaviour nobody has observed. Each check
below ends in either "works, delete the `ISSUES.md` entry" or a named code
change.

## Environment / context

- Read results off steamboat, read-only:
  `journalctl -u practice-field-management-system --since "10 minutes ago"`.
  Journald drops some lines, so a missing line proves nothing on its own.
- `recordings/<id>/telemetry.csv` on steamboat has about 4 rows a second per
  station. Its `enabled` column is the DS's status byte
  (`src/sessionMetadata.ts`), so it shows what the DS thinks, for matches and
  practice runs.
- For the 2027 DS, capture its status while testing:
  `sudo tcpdump -i any -w /tmp/ds2027.pcap udp port 1160 and host <DS IP>`.
  The IP is in the journal's `is a 2027 (SystemCore) Driver Station` line.
- Times below are US Pacific.

## Checks at the field

Run them with the robot on blocks, in a practice match you can restart.

### 1. Does an NI DS follow Re-enable after the driver presses Enter?

1. Start a practice match. In teleop, have the driver press Enter on the DS,
   with the robot still connected.
2. Confirm the journal shows `DS disable reported: slotN`.
3. Press Re-enable on the team page.

| Result                                                                                            | Meaning                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| DS shows Enabled and the robot runs within a second. No second `DS disable reported`.             | Works. Delete the entry.                                                                                                                       |
| `Re-enabled: slotN (self)`, then `DS disable reported` 2 to 3 s later, and the DS stays Disabled. | The DS latched it locally and field packets can't clear it. The Re-enable button promises something it can't do: change it to tell the driver. |
| `DS lost robot comms` instead of `DS disable reported`.                                           | Not this test: the robot link dropped. Fix the link and repeat.                                                                                |

### 2. Can pFMS see a Disable or an E-Stop pressed on a 2027 DS?

Needs a team on a 2027 DS (5940 is the regular one). Tell them first: an
e-stop may need a power cycle to clear. Run the capture above and note the time
of each press.

1. In a match, press Disable on the DS.
2. Re-enable, then press E-Stop on the DS. Do this last, since it ends their
   run.

| Result                                                   | Meaning                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disable changes the status byte at the press.            | pFMS can learn to read it. Note which bit: `dsEnabledSeen` in `src/matchEngine.ts` needs that bit instead of the enabled one.                          |
| Disable changes nothing in the capture.                  | The field can't see it. Staff and the team page show the robot enabled while it is disabled, until the SystemCore parser reads it from the robot side. |
| `DS e-stop reported: slotN` appears at the E-Stop press. | E-Stop reporting works on the 2027 DS.                                                                                                                 |
| E-Stop leaves no line and the byte doesn't change.       | Same gap as Disable: the team page won't say the robot is e-stopped.                                                                                   |

Known already: none of 37,736 telemetry rows for team 5940 (through 2026-10-16)
has the enabled, e-stop or a-stop bit set. That doesn't show anyone pressed
them.

### 3. Does a DS get its Enable button back outside a match?

Do it with an NI DS 26.0 and, if one is there, a 2027 DS.

1. Before any match, connect the DS. The journal says
   `(no reply: local control)`. Check the Enable button is visible, and that
   Enable and Disable both work without the `[ ] \` key combo, which works even
   with the button hidden.
2. Run a short match, then leave it. Check Enable comes back within about 10 s
   with no DS restart.

| Result                                           | Meaning                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Enable visible both times.                       | Out-of-match control works.                                                                                         |
| Enable missing, and no journal `still reports`.  | No reply doesn't free this DS. Note its version: this was the 2026-10-04 question and would need a design decision. |
| Enable missing, with `still reports` every 15 s. | Go to check 4.                                                                                                      |

### 4. What is a DS doing while pFMS keeps dropping it?

Watch the journal for `still reports to the field while not in a match` every
15 s for the same DS. It went on for 43 minutes for one DS on 2026-10-25. When
it happens, go to that laptop:

1. Does the DS show Enable? Does the robot drive?
2. Restart the DS software. Does the line stop?
3. Note the DS's version, and whether another laptop of that team is on the
   field (`Blocked duplicate DS` lines).

| Result                                       | Meaning                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Robot drives normally.                       | Harmless apart from the reconnects. Stop the drops after the first few.                       |
| Enable hidden, or the robot won't enable.    | A real lockout of a team outside a match. The drop doesn't work on it, so it needs a new fix. |
| Only happens beside a blocked second laptop. | Look at how the duplicate handling and this loop interact.                                    |

### 5. First SystemCore capture

Needs 5940 or another SystemCore robot, driven for a few minutes on a 2027 DS.
Note the time of an enable, a disable and any brownout. This is step 3 of
`plans/systemcore-robot-capture.md`.

| Result                                                                                                   | Meaning                                                                                 |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `systemcore-captures/systemcore-YYYY-MM-DD.pcap` exists on steamboat with traffic both ways on UDP 1110. | Ready to decode.                                                                        |
| No file, though the DS drove the robot through the field.                                                | The capture isn't seeing it: check the tcpdump filter is live and the robot was marked. |

Also look at the team page while the robot is outside a match. No battery there
is expected until the parser exists. In a match, battery does show, because the
DS sends it to the field.

### 6. The team page on a real phone

Headless Chrome at phone sizes passed (see below). A real phone adds browser
toolbars and real thumbs. Use an iPhone in Safari and an Android in Chrome.

1. In a match, portrait: A-Stop and E-Stop are on screen without scrolling.
2. Turn it sideways: the stop row stays pinned to the bottom of the screen.
3. Swipe the tabs: Video is reachable.
4. Tap Pop Out: note what a phone does with it.

| Result                                              | Meaning                                                     |
| --------------------------------------------------- | ----------------------------------------------------------- |
| All fine.                                           | Nothing to do.                                              |
| Toolbars cover the pinned row.                      | `PINNED_STOPS` in `MatchPanel.tsx` needs a safe-area inset. |
| Pop Out loses the team page or does nothing useful. | Hide the button on phones.                                  |

### 7. How long does an e-stop take to reach a DS out of a match?

E-stops no longer cut traffic (2026-10-30), so an out-of-match e-stop rests on
the DS taking field control at its next handshake. With a robot on blocks,
enabled from its own DS and not in a match, press the field E-Stop and time the
robot's enabled bit from the press. Then clear it. Try the `[ ] \` enable key
combo while held.

| Result                                                           | Meaning                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Disables within about 8 s, 3 s on a 2027 DS.                     | Works as documented in `docs/network.md`. Note the real time there.                                    |
| Doesn't disable until someone touches the DS, or at all.         | E-stops don't stop a free-driving robot. Tell the user at once: out-of-match e-stops need another way. |
| After the clear, the robot comes back on with no Enable pressed. | The DS doesn't stay disabled when the field lets go. Nothing covers that now the re-arm wait is gone.  |
| The key combo enables the robot while held.                      | A held DS can be overridden from its keyboard. Note it in `docs/network.md`, then decide what to do.   |

## Settled by the audit (2026-10-30)

- **Out-of-match release.** The status-2 reply was removed on 2026-10-04. A DS
  outside a match now gets no reply (`resolveTeamSlot` in `src/index.ts`; 304
  `no reply: local control` lines since). steamboat doesn't set
  `FMS_TCP_REPLY_STATIONS`, and its question has been answered: any assignment
  hides Enable. Whether every DS really comes back is checks 3 and 4.
- **Public match links work.** The change is in ops (`5dd09da`, `cedfaae`) and
  live: Caddy's running config on steamboat has the `/api/public/*`,
  `/matches/*` and `/practice/*` rules. `pfms.log` shows off-site addresses
  getting JSON and video from `/api/public/*`, most recently JSON at 9:53 AM PDT
  (16:53Z) on 2026-10-30. No proxy change is needed.
- **balls-counter** still runs the unmerged branch. sentinel is at `897046d` on
  `fix/package-for-latest-uv`, and the service is up. `cinderblock/balls-counter`
  PR #1 is open, mergeable, 9 ahead of master and 0 behind, with no reviews or
  checks. Its last commit is from 2026-09-13.
- **`/ws/scores` fields.** balls-counter reads `phase`, `matchId`, `subPeriod`
  and `inactiveGoalAlliance`, and builds its pause spans from `phase`. There is
  no pause-span field. A test now pins the four.
- **Team page at phone sizes.** Checked at 320×568, 390×844, 412×915, 568×320
  and 768×1024 in headless Chrome with touch emulation, a dry-run backend and a
  fake radio, for each match phase and stop state. The match states were
  overlaid on the WebSocket in the page, because a real start needs an attached
  DS. Fixed: tabs out of reach, stop buttons off screen sideways, small tap
  targets.

## Findings / gotchas

- The journal has no clean sample for check 1. Since telemetry began
  (2026-09-27), every `DS disable reported` followed by a Re-enable had the DS
  dropping off the field or the robot link down. Team 972 at 3:06:57 PM PDT on
  2026-09-27 looked like one, but telemetry shows `robot_comms=false` throughout.
- On 2026-09-13, before telemetry existed, several re-enables were followed by
  a `DS disable reported` about 2 s later, the length of the enable grace
  window. That could be a DS staying latched or a DS dropping out.
- `DS disable reported` hasn't appeared for a 2027 DS since `6cafd40`
  (2026-09-12) added the `dsEnabledSeen` gate. The lines before it were false:
  the DS never sets the bit, so every enable was undone 2 s later.
- The `still reports` drops: 590 from 2026-10-09 to 2026-10-28. Seven DSes
  reached 15 or more in a day. The worst was 173 in 43 minutes, at the DS driving
  for team 2813 while two of that team's other laptops were blocked as
  duplicates.
- No SystemCore capture exists yet. Nothing from a 2027 DS has reached the field
  since the capture deployed on 2026-10-29.
- `preview_open` timed out here, so the phone check used Chrome over the
  DevTools protocol. In Git Bash, set `MSYS_NO_PATHCONV=1` before passing a
  `/1234` path to a script, or it becomes a Windows path and loads a blank page.

## Things not to do

- Don't test any of this from a development PC against the real radio.
- Don't ship a SystemCore parser from the header alone
  (`plans/systemcore-robot-capture.md`).

## Progress log

- [x] Audit done, `ISSUES.md` rewritten (2026-10-30)
- [x] Phone layout fixed
- [ ] Check 1: NI re-enable
- [ ] Check 2: 2027 DS stop reporting
- [ ] Check 3: Enable outside a match
- [ ] Check 4: repeated drops
- [ ] Check 5: first SystemCore capture
- [ ] Check 7: e-stop out of a match
- [ ] Check 6: real phones
