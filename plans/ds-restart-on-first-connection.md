# Driver Station needs a restart on first connection

## Goal

Teams often have to restart the Driver Station software the first time they
connect on the field, especially after their laptop was connected straight to
the robot's own Wi-Fi. Find out what is stuck and fix it on the pFMS side if
we can. Reported by the user 2026-10-14.

## Environment / context

- Production: steamboat, `practice-field-management-system` service, running
  on Bun since 2026-10-13.
- DS laptops reach the field over guest Wi-Fi (`10.55.x.x`, VLAN 3, IPv4
  only). The site router's static route sends `10.0.0.0/8` to steamboat, which
  masquerades onto the station bridges (`br-slotN`, gateway `10.TE.AM.254`).
- Robot→DS UDP 1150 reaches the laptop only through the drive session's DNAT
  rule (`docs/network.md`, "DS ↔ RIO UDP and Dynamic DNAT"). A session starts
  on the DS's first TCP 1750 handshake carrying its team number and ends after
  20 s of silence (`src/driveSessions.ts`).
- When the DNAT rule is added, pFMS flushes conntrack entries for UDP to the
  gateway (`src/index.ts`, `addDnat`), so robot replies that arrived before the
  rule don't stay pinned to local delivery.

## Decisions already made (don't re-ask)

- Build the per-session robot-link logging first, then fix from evidence
  (user, 2026-10-14).
- No team-page message about the wait after a robot is added: DS restarts are
  relatively fast, so a team that restarts loses little (user, 2026-10-30).

## Findings / gotchas

- **Symptom (user, 2026-10-14):** all DS lights red, "No Robot
  Communication", so Enable is unavailable. Seen only on the NI 26.x DS so
  far. Restarting the DS alone fixes it (no Wi-Fi reconnect needed). The red
  FMS light is expected out of a match: a DS not in a match gets no reply.
- **Dropped hypothesis (no support, see the 2026-10-28 finding): the DS's cached roboRIO address.** In the
  pits the laptop on the robot's own Wi-Fi resolves `roboRIO-TEAM-FRC.local`
  to whatever the robot radio's DHCP gave the roboRIO. On the field the
  roboRIO may get a different address from the field AP; a DS that keeps the
  old resolution sends to an address nobody answers from until restarted.
  Team 840 today was healthy and at the standard `.2`. The new logging tells
  this apart ("the DS sends to X, but no robot answers").
- **The capture on the trunk (`eno1`) sees every leg:** the laptop's own
  1110 packets arrive untagged from `10.55.x`, the masqueraded copy goes out
  tagged (vlan 20 for slot2) from `.254`, and robot 1150 replies are seen both
  to `.254` and, after DNAT, to the laptop (checked live 2026-10-14 18:04).

- **The conntrack race is already handled** (flush on `addDnat`). Not the
  cause unless the flush fails; no `conntrack flush failed` lines since
  2026-10-13.
- **A laptop on the robot's own Wi-Fi almost never reaches pFMS.** Since
  2026-10-01 only one DS handshake came from a team-subnet address
  (`10.99.97.200`, team 8, 2026-10-11). So "connected to the robot's Wi-Fi"
  happens off the field (pits, robot not yet on a station). The laptop then
  moves to guest Wi-Fi with the DS still running.
- **Drive sessions ending with "no activity for 20s" are real gaps**, not a
  bookkeeping bug: in each case checked (10.55.96.248 at 16:59:41 and
  17:04:51 on 2026-10-14) the DS was silent for 40+ s, then reconnected
  fresh ("DS connected"), often followed by `ETIMEDOUT` on the old socket.
- **pFMS logs nothing about whether a DS actually reaches its robot.** There
  is no per-session "DS→robot 1110 seen" / "robot→DS 1150 delivered" line, so
  past incidents can't be reconstructed from the journal. The passive capture
  (`src/robotPacketCapture.ts`) already sees both directions per station.
- **Coverage gap found 2026-10-16:** the first version only watched laptops
  that already had a drive session, so a DS stuck _before_ reaching pFMS as
  its FMS (no TCP 1750 handshake, no session, no DNAT) logged nothing even
  though the capture saw its 1110 packets. Now reported as "� but it has no
  drive session". Still invisible: a DS that neither reaches pFMS nor sends
  robot packets through it (its packets never cross `eno1`).
- **journald is not dropping lines any more:** no `Suppressed` notices since
  2026-09-15, and the journal goes back to 2026-03 (4 GB), so `Robot link`
  lines will survive for later reading.

- **Team 114's first arrival, 2026-10-28 (laptop `10.55.150.65`, NI DS, robot
  `10.1.14.2`), the one reported occurrence so far.** Local PDT; journal:
  - 4:58:55 PM DS reaches pFMS, team 114. No robot on the field yet.
  - 5:01:30 PM 114 added to slot1; session and DNAT start at once. DS already
    sending to `10.1.14.2`.
  - 5:02:02 PM radio ACTIVE, 5:02:07 PM `Robot linked to the field radio`.
  - about 5:02:25 PM DS stops: control packets and FMS status end together.
    UniFi shows no Wi-Fi event for this laptop from 4:59 PM to 5:39 PM, so
    this is the DS being closed, not the laptop dropping off.
  - 5:02:57 PM DS back. Robot answers by 5:03:21 PM (`Practice buffer started`
    at 5:03:18 PM agrees).
- **Same arrival with nobody touching the DS** (time from robot added to robot
  answering): 114 on 2026-10-29, same laptop and robot, about 28 s; 8048
  on 2026-10-23, about 34 s; 2813 on 2026-10-25, about 68 s. 114 on the 28th
  was closed at 55 s and answered at about 107 s.
- **Reading:** the restart was probably not what fixed it. Most of this wait is
  the field: radio configure takes about 30 s, then the robot must link and
  answer. A DS left alone recovers by itself. Not proved: the robot's own boot
  isn't logged, and "no robot answers" could not separate a silent robot from
  pFMS not forwarding (now split, step 3).
- **Ruled out for this occurrence:** wrong or cached address (all 78 addresses
  in `Robot link` lines since 2026-10-16 are the teams' `.2`), pFMS not
  delivering replies (no such line in the window), Wi-Fi drop, DS never
  reaching pFMS.
- **Bad lines in the logs:** `Robot link` lines for the second robot of a team
  before `6e290fb` are unreliable (control copies were filed under the first
  station, fixed by that commit). "It never reached pFMS as its FMS" was too
  strong: 114's laptop had connected at 5:15:32 PM but had two robots to choose
  from, and its session waited for the Drive button (reworded).
- **Side finding, not this task:** 5:05:44 to 5:09:07 PM, a second 114 laptop
  was blocked and unblocked with every ~6 s TCP flap, so the block has gaps.
  Fixed by `4cf44ab`.

## Plan / steps

1. ~~Pin down the symptom with the user.~~ Done (see findings).
2. Make the next occurrence leave evidence: log per drive session when
   DS→robot control (1110) first appears and when robot replies (1150) first
   flow, and warn when one direction is missing for N seconds after the
   session starts. Then a stuck DS shows which side is stuck.
   Built: `src/robotLinkWatch.ts`, fed by `RobotPacketCapture`'s new
   `onHop`; lines `Robot link up/down/back …` (documented in
   `docs/network.md`). Deployed; waiting for a stuck DS on the field.
3. **[current]** Depending on 1–2: a pFMS fix (if robot replies don't reach the laptop) or
   team-facing guidance (if the DS never sends, i.e. it's the DS's own
   network/mDNS state after the adapter changed).

## Progress log

- [x] Checked the conntrack flush path: in place.
- [x] Checked journal since 2026-10-01 for laptops on team subnets: one.
- [x] Checked "no activity" session endings: real silence.
- [x] Symptom details from the user.
- [x] Diagnostics for the next occurrence: built and tested.
- [x] Deploy the diagnostics: `73ed821` live on steamboat 2026-10-14 23:52
      (no drive sessions at the time, so no `Robot link` line seen yet).
- [x] 2026-10-16: still no drive sessions since the deploy, so no lines yet.
- [x] Cover laptops sending to their robot with no drive session (gap above).
- [x] Deploy that addition: `3ef6456` live on steamboat 2026-10-16 19:28
      (capture listening, frontend bundle matches).
- [x] Read team 114's 2026-10-28 occurrence from the logs (findings above).
- [x] Split "no robot answers" from "pFMS isn't forwarding", fix the
      no-session wording.
- [x] Deployed: `0586d9a` live on steamboat 2026-10-30 3:33 PM PDT (22:33Z),
      with the rest of that day's work in one push (`579d716` included).
- [ ] Next occurrence: confirm with the split line, and with what the team did.

## Open questions for the user

1. ~~What the stuck DS shows~~: all red, no robot comms.
2. ~~Which DS~~: NI 26.x only so far.
3. ~~Restart alone enough?~~ Yes.
4. ~~Deploy the diagnostics?~~ Yes, deployed.

## Things not to do

- Don't test on field hardware without explicit consent (this PC reaches the
  real radio).
- Don't infer what happened from the absence of a log line: journald has
  dropped pFMS logs under load before.
