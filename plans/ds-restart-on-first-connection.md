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

## Findings / gotchas

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

## Plan / steps

1. **[current]** Pin down the symptom with the user (questions below).
2. Make the next occurrence leave evidence: log per drive session when
   DS→robot control (1110) first appears and when robot replies (1150) first
   flow, and warn when one direction is missing for N seconds after the
   session starts. Then a stuck DS shows which side is stuck.
3. Depending on 1–2: a pFMS fix (if robot replies don't reach the laptop) or
   team-facing guidance (if the DS never sends, i.e. it's the DS's own
   network/mDNS state after the adapter changed).

## Progress log

- [x] Checked the conntrack flush path: in place.
- [x] Checked journal since 2026-10-01 for laptops on team subnets: one.
- [x] Checked "no activity" session endings: real silence.
- [ ] Symptom details from the user.
- [ ] Diagnostics for the next occurrence.

## Open questions for the user

1. What does the DS show while stuck: Communications light red (no robot),
   FMS light red, Robot Code red, or Enable missing?
2. Which Driver Station: NI 26.x, the 2027 FIRST DS, or both?
3. Where does "connected to the robot's Wi-Fi directly" happen: pits before
   the robot is on a station, or on the field?
4. Is a restart of the DS alone enough, or do they also reconnect Wi-Fi?

## Things not to do

- Don't test on field hardware without explicit consent (this PC reaches the
  real radio).
- Don't infer what happened from the absence of a log line: journald has
  dropped pFMS logs under load before.
