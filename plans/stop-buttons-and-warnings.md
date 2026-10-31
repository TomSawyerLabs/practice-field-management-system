# E-Stop on every staff page, and a warning when a stop doesn't take

**Status: in progress, branch `t3/603a506e`.**

## Goal

Close three `ISSUES.md` entries and check one thing shipped on 2026-10-30:

1. E-STOP stays on screen on `/match` for a device matched as a Driver Station.
2. `/staff` and `/csa` get the field E-Stop: one tap, no login, works while locked.
3. `/match` and `/csa` warn when an e-stopped robot still says it's enabled.
4. While a station has `stopWaiting`, the Clear buttons are disabled and say why,
   and the team page tells them to click Disable.

## Decisions (don't re-ask)

- Reuse `FieldEStopControl`. `adminGlobalEStop` and `adminClearFieldEStop` are
  already `anyone` in `src/wsAccess.ts`, so no server change for 1 and 2.
- `DsClientBlock` renders the control itself, so `/match` and `/staff` both get it.
- The warning is decided in `MatchEngine`, not the page: only the server knows when
  a stop began, `/match` has no telemetry, and it travels in `stationStates` like
  `stopWaiting`.
- Any report of "enabled" counts. `tele.dsStatus` mixes two sources (the robot's
  UDP 1150 replies and its DS's UDP 1160 status), so "last report wins" would
  flicker when they disagree. The engine keeps only when a robot last said enabled.
- Grace is 2 s, measured against the report's own time: a report only counts if it
  arrived 2 s or more after the stop. A cut robot sends nothing at all, so normal
  stops never trip this. The cut is in place within about a second at worst, then
  the robot disables about 100 ms later.

## Findings

- `stopWaiting` is only ever set on unjoined stations (`reviewStopWaits`), but
  `/match`'s "Waiting for DS" was on `ActiveParticipantRow`, which lists joined
  stations only. It could never show. The real path is E-Stop then Leave Match:
  unjoined, e-stopped, waiting, and no row anywhere on `/match`.
- `/admin`'s "Yes, clear" was disabled with no reason shown.
- `tele.dsStatus` holds the robot's own bits when it comes from the packet capture.
- The old `enabled-while-held` alarm had no grace, so it could flash on `/csa` on
  every e-stop in a match.

## Things not to do

- No field hardware: always a fake `RADIO_URL`, even with `DRY_RUN`.
- No steamboat, ops or Caddy. No push or deploy.
- Nothing on the user's screen: headless Chrome only.

## Progress

- [ ] 1. E-STOP on the Driver Station block
- [ ] 2. E-Stop on `/staff` and `/csa`
- [ ] 3. Warning for a robot enabled through a stop
- [ ] 4. `stopWaiting` Clear buttons
- [ ] Browser check, desktop and phone
