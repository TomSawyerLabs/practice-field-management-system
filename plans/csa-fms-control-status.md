# CSA page: show FMS control (enabled / disabled / released) per station

## Goal

Two linked things, both raised on 2026-10-04 while team 8 was on the field:

1. **Live incident:** team 8's legacy NI Driver Station had no Enable button
   (the DS hides it while it believes an FMS controls it) even though pFMS was
   releasing it with the status-2 "not in match" reply. Team 6036, on the same
   field at the same time with the same replies, could enable fine.
2. **Feature (user request):** the CSA page must show, per station, whether
   the FMS is enabling, disabling, holding, or has released the DS. Today the
   tile only shows `red1 · EN` while in a match; outside a match it shows
   nothing about FMS control.

## Environment / context

- Production: steamboat, service `practice-field-management-system`
  (`sudo journalctl -u practice-field-management-system`).
- Team 8: DS 10.55.36.193 (legacy NI DS), robot 10.0.8.2, SSID `8-ubot`,
  station slot1. A second team-8 laptop, 10.55.14.73, was online and was
  blocked as a duplicate DS at 18:07–18:08.
- Team 6036: DS 10.55.243.129 (legacy NI DS), slot2.
- CSA page: `frontend/src/components/CsaPage.tsx` (`stationFacts`,
  `StationTile`, `StationDialog`).
- Server-side state already available: `StationControlState.joined`,
  `.enabled`, `.disabledBy`, `.blockedReason`, `.heldReason`
  (`src/types.ts`); release vs assign decision in `resolveTeamSlot`
  (`src/index.ts`); handshake reply in `src/fmsServer.ts`.
- Robot packet capture (`src/robotPacketCapture.ts`) already parses robot→DS
  1150 (enabled bit → telemetry `dsStatus.enabled`) and DS→robot 1110 (only
  joystick count today).

## Findings / gotchas

- **Wire signature of a DS that is truly FMS-attached** (team 8 during match 1,
  18:28–18:34): one long-lived TCP 1750 connection, a 50 Hz stream of 17-byte
  tag-0x16 messages on it, and UDP status to 10.0.100.5:1160 (from DS port
  1145, 19 bytes; pFMS logs these as "Unparseable DS UDP status").
- **Wire signature of a released DS** (both teams, before and after the match):
  TCP 1750 reconnects every ~8 s, the DS sends only the 5-byte team handshake
  (`00 03 18 <team>`), pFMS answers status 2, no UDP to 1160, and pFMS sends the
  DS no UDP control packets.
- **Team 8 while stuck looked identical on the wire to 6036 while working.**
  The DS→robot control byte was `0x00` (no FMS bit 0x08) for both. So the DS's
  "FMS has me" UI state is not visible in any packet we capture; don't infer
  "not FMS-locked" from the 0x08 bit.
- Team 8's DS had no joystick in slot 0 (its one stick was in slot 5). Not
  known to matter.
- pFMS restarted at 18:21:15 (another thread's deploy); unrelated.
- Team 8 has no field history before 2026-10-04 (journal back to March);
  6036 has used the field since July from the same laptop, under both no
  reply (to 09-12) and status 2 (09-16 on). So 6036 proves nothing about how
  team 8's DS takes silence.
- Two readings remain: (1) team 8's DS parks on status 2 specifically, so
  silence fixes it; (2) it hides Enable whenever an FMS TCP connection is
  open, so silence doesn't help either. The field test separates them.
- Staff worked around it by running team 8 in a match (joined 18:28:35, match
  18:29:02–18:34:05, released 18:34:08).

## Plan / steps

1. ~~Get one at-the-DS observation after the 18:34 release.~~ Answer: Enable
   came back briefly, then disappeared again (it showed only during the 9 s
   the DS had no FMS connection, 18:34:08–18:34:17, and vanished on the next
   status-2 reply).
   - Back → the earlier lock came from that DS's history (an earlier assignment
     it never let go of), and a fresh join + release cleared it.
   - Still missing → this DS doesn't honour status 2 (version-specific?). The
     fix is then a per-DS fallback (no reply, as before 2026-09-15) or a way
     for staff to release one DS. Needs a design decision from the user.
2. **Done:** per-team no-reply list (`silentReleaseTeams`, admin page →
   Freeplay card → "Driver Stations that hide Enable outside matches").
   Commit `1a5a599`, deployed to steamboat 18:57 2026-10-04.
3. **[current]** Field test: staff add team 8 to the list, team 8 checks
   whether Enable stays on their DS. Log line to look for:
   `DS at 10.55.36.193: team 8 → not in match (no reply: team is on the
no-reply list)`. If Enable still disappears, reading 2 holds (the DS hides
   Enable whenever it has an FMS TCP connection) and silence won't fix it.
4. Build the CSA display:
   - Per-station "FMS control" line on the tile and dialog header: In match ·
     enabled / disabled (+ why: phase, disabledBy, blocked), Held by staff /
     policy (FMS holding disabled), Released to team (freeplay), No DS.
   - Show the robot's own enabled bit (from 1150) next to it, so "FMS says
     released, robot is disabled" is visible at a glance.
   - Decide how to show the DS's own belief. Packets can't reveal it (see
     findings), so don't claim to.

## Progress log

- [x] Live diagnosis: pFMS treats team 8 and 6036 identically; captures saved
      on steamboat at `/tmp/team8-enable.pcap` (18:21–18:25).
- [x] At-the-DS observation after release: Enable briefly back, then gone.
- [x] No-reply list built, tested (779 tests pass), deployed (`1a5a599`).
- [ ] Field test with team 8 on the list (step 3).
- [ ] CSA FMS-control display.

## Open questions for the user

1. ~~After the match released team 8 at 18:34, does their DS show Enable?~~
   Briefly, then no.
2. With team 8 on the no-reply list, does Enable stay?
3. What DS version is team 8 running? (DS About box or title bar.) Is 6036's
   newer?

## Things not to do

- Don't conclude from the DS→robot 0x08 bit that a DS isn't FMS-locked.
- Don't change field behaviour for all DSes on one team's report. Status 2 is
  confirmed working for most legacy DSes (see the out-of-match-enable-check
  plan).
