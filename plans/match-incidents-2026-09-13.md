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

### What the logs proved (2026-09-13, follow-up)

- 5940/slot1 was assigned **red1 in every match that started** (all day). The
  only blue moment was a stray `join blue` at 12:20:34, corrected to red at
  12:20:40, before any match. No controller alliance-swap was ever used.
- So no started match ran with 5940 on blue. A match that felt reversed was
  not a wrong pFMS assignment in that match. Video should confirm what colour
  5940's **DS actually displayed**; if it showed blue while pFMS logged red1,
  that is a 2027-DS propagation issue.
- Found and fixed a latent propagation gap: switching a joined station's
  alliance (red<->blue) did **not** force the DS to re-handshake, so the new
  colour reached the DS only via the next UDP tick or the DS's own ~3 s
  reconnect. Now an alliance change emits `disconnectDS` exactly like
  join/leave, so the DS reconnects and gets the new 0x1f immediately. (Not
  the cause of 5940's match — four minutes elapsed — but removes the window.)

### Open question 1 (blocking a full field-side policy)

How are the six driver-station positions physically laid out, and what should
drive the robot's field side?

- (a) Slots are fixed to a side — e.g. slot1-3 on one wall, slot4-6 on the
  other. Then pFMS should tell the robot the colour that matches its physical
  side, or warn when a team joins the "wrong" colour for their slot.
- (b) It's a single practice wall / symmetric and teams should always feel
  like their own alliance regardless — then the current free choice is fine
  and this is just inherent red/blue origin behaviour to document.
- (c) Something else. A short description of where each slot physically sits
  relative to the field is enough for me to propose the exact change.

## 2. "5940 E-Stopped and their partners were also E-Stopped"

- pFMS did **not** propagate the E-Stop. The engine's `stationEStop` only ever
  touches the one station; the only alliance-wide/all-station E-Stop is
  `globalEStop`, reached solely by the admin "Global E-Stop" button
  (`adminGlobalEStop`), which was not sent in that match.
- Journal for the 12:24 match: `stationSelfEStop station: slot1` →
  `E-Stop: slot1` at 12:25:47, and that is the only E-Stop line. What the
  partners actually show around then, from the same log:
  - slot4 (972) at 12:25:49: `DS lost robot comms (raw=0x10)` — radio ping
    only, no robot link. A comms drop, now treated as "keep enabled".
  - slot2 (2813) at 12:26:23: `DS disable reported (raw=0x78)` — a real DS
    disable ~36 s later, then ECONNRESET on its TCP link at 12:26:54.
    These are independent robot/network events, not an E-Stop, and are spread
    over a minute rather than simultaneous with 5940's E-Stop.
- So if partners truly went to **E-Stop** (not just disabled) the instant
  5940 did, the cause is outside pFMS's match engine — most likely a physical
  field E-Stop loop wired so one button cuts the alliance, or the drivers
  read a disable as an E-Stop. pFMS has no code path that E-Stops an alliance
  from one team's button.

### Open question 2 (blocking a fix)

When the partners "got E-Stopped", did their Driver Stations show a red
**E-Stop**, or **No Comms / Disabled**? And is the field E-Stop button a
physical loop, or only the pFMS station-page button? That distinguishes a
field-wiring issue from a coincidental comms drop.

slot4/972's drop (12:25:49) had no pFMS network event (no DNAT/takeover/
duplicate/block); its status went to radio-ping-only while the AP kept the
radio associated — a robot-side/RF drop. 972 also has the radio QoS
bandwidth limit ON (see the robot-tester warning), a known latency/loss
risk with camera streams; worth turning off on their radio.

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
  one robot; the report is unconfirmed and likely field wiring.
