# Scrimmage incidents 2026-09-13: reversed field side, and "E-Stop hit partners"

Both reported by Cameron after the afternoon matches. Investigated from the
steamboat journal; no code changed yet — each needs a decision.

## 1. 5940 joined red but drove/auto'd as if on the other side

- 5940 is physically at **slot1**. Every time they joined they were assigned
  correctly by colour: journal shows `team 5940 → assigned red1 (reply 0x1f)`
  for the red matches and `blue1` when they later joined blue. The station
  byte in the 0x1f handshake and the UDP control packet both come from
  `slotForStation` and agree. So pFMS is not sending the wrong colour.
- Mechanism of the reversal: the alliance byte (red1..blue3) is exactly what
  the robot uses for its field origin — red and blue have **opposite**
  origins, so a red robot and a blue robot drive field-relative in opposite
  directions. On a real FRC field red1-3 are always physically on the red
  wall, so this matches where the drivers stand. This practice field lets any
  physical slot join any alliance, so a team standing at slot1 who joins the
  colour whose origin is at the _far_ wall sees everything mirrored.
- So this is not a wrong-assignment bug; it is that **alliance colour is
  decoupled from physical driver-station side**. Fixing it needs a field-side
  decision (below), not a code correction to the current logic.

### What the logs proved (corrected 2026-09-16 — the earlier pass was wrong)

An earlier follow-up in this document claimed "5940/slot1 was assigned
**red1 in every match that started** (all day)" and that the only blue
moment was a stray join at 12:20 before any match. **That is false.** It
only looked at the morning and early-afternoon matches and missed the
13:37 re-join. The record:

- `match-history.json`: 5940/slot1 is recorded **red** for matches 21-24
  and **blue** for matches 25-29 (13:40 onward). Five matches ran with
  5940 on blue.
- The last match 5940 played (match 29, 14:53:33) logged it outright:
  `Match 1 started with stations: slot1, slot2, slot4 (red: slot2, blue:
slot1,slot4)`. 5940 was on **blue**, which is exactly the match the
  reversed-side report came from.

How they got there, from the journal (all times 2026-09-13):

| time     | event                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 13:34:26 | `stationJoinAlliance slot1 red` → `Station slot1 joined red alliance`; DS told `red1`                         |
| 13:35:09 | `stationLeave slot1` → released to local control                                                              |
| 13:35:59 | `Drive started: 10.55.65.16 → slot1 (team 5940)` — free driving                                               |
| 13:37:25 | `stationJoinAlliance slot1 **blue**` → `Station slot1 joined blue alliance`; DS told `blue1` one second later |
| 13:38:47 | ready check opened                                                                                            |
| 13:39:10 | slot1 readies up                                                                                              |
| 13:40:40 | match 25 starts, 5940 on blue                                                                                 |

So, answering the question directly: **yes — somebody clicked "join blue"
on slot1, and nobody noticed.** Nobody clicked "swap": `grep -c "swapped
to"` over the whole day is **0**, so `swapStationAlliance` was never used.
pFMS did exactly what it was told, and told the DS the right thing within
a second of being told it.

Note the log wording is diagnostic: `joinStationAlliance` prints
"switched to" when a _joined_ station changes alliance and "joined" on a
fresh join. The 13:37:25 line says "joined", which is consistent with the
`stationLeave` at 13:35:09 — they left and came back on the other colour,
so the "changing alliance clears ready" guard never applied. The ready
check then opened _after_ the change, so readying up gave the team no hint
their colour had changed since the previous match.

## 2. "5940 E-Stopped and their partners were also E-Stopped"

**No pFMS event matches this report.** Corrected 2026-09-16 against the
full day's journal, not just the 12:24 match:

- `E-Stop: slot1` (5940) appears exactly **twice** all day: 10:07:44 and
  12:25:47. Neither is in the last match.
- In the last match 5940 played (match 29, 14:53:33 — blue: slot1+slot4),
  the only E-Stop is `stationSelfEStop slot4` at 14:54:22. That is **972**,
  not 5940. slot1 was never E-Stopped in that match. slot2 (2813) reported
  an ordinary `DS disable` at 14:56:12 — 110 s later, unrelated.
- The one field-wide E-Stop all day was `adminGlobalEStop` at **10:07:56**,
  12 s after 5940's own E-Stop at 10:07:44. But in that match slot1 was the
  **only** station joined and the only attached DS — there were no partners
  to E-Stop. So it cannot be the reported event either.

`globalEStop()` is worth knowing precisely, because it is the only
alliance-crossing path: it sets `eStop = true` on **all six** stations and
sends E-Stop packets to every station with a known DS address, explicitly
"not just joined". So a Global E-Stop does hit robots merely driving around
outside the match — it just had nobody to hit at 10:07:56.

Most likely reading of the report: the E-Stop was **972's** (slot4), not
5940's, and the "partners too" impression came from 2813's disable in the
same match plus the general confusion of a stopped field. A single station
E-Stop provably touches only that station.

Relevant: at 10:07 the E-Stop buttons did not yet distinguish one-robot
from whole-field. Commit `e84f44a` ("E-Stop buttons now clearly read
'E-Stop One' vs 'E-Stop All'") landed at 13:16:35 the same day, ~3 h after
that global E-Stop. If a mis-click was ever the mechanism, the guard for it
is already shipped.

### Open question 2 — largely answered

Still worth knowing whether the field E-Stop is a physical loop, since
that is the one mechanism outside pFMS that could stop an alliance at
once. But pFMS's own logs now rule out the software path: no station
E-Stop propagated, and no global E-Stop fired in any match that had
partners on the field.

## 3. Side finding (my recent code): recorder pre-roll dir race

During the 12:24 rapid triple hold/abort, the recorder logged `Error opening
output files: No such file or directory` once and recovered. The pre-roll
adopt/discard (commit 86c1248) can `rmSync` or rename a session directory
while a just-spawned ffmpeg is opening a part in it. Low severity (only under
repeated start/abort within ~2 s; it self-reconnected) but worth hardening:
create the part's directory in `spawnPart` before ffmpeg opens it (done —
`mkdirSync` guard). Further hardening of `finishSession`/`adopt` against a
stale session is still worth doing but the "No such file" symptom is fixed.

## Things not to do

- Don't add an alliance-wide E-Stop to "match" the report — real FRC E-Stops
  one robot, and the logs show no propagation ever happened.
- Don't conclude anything about a day's matches from a single match's log
  window. The first pass at both questions did that and got both wrong:
  it missed a re-join three hours later and an E-Stop in a different slot.
  Check `match-history.json` for the whole day first, then go to the
  journal for the specific minute.
