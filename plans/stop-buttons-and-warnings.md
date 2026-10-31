# E-Stop on every staff page, and a warning when a stop doesn't take

**Status: done, on local master. Not deployed: the deploy thread owns that.**

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
- A real field stop said "Waiting for 6 Driver Stations" on a field with three
  robots and no DS, because `reviewStopWaits` waited on empty slots too. Only a
  screenshot caught this: the text matched every assertion.
- `innerText` returns MUI buttons' labels in upper case, so match labels without
  case when driving the page.
- The 1160 FMS server only binds to `10.0.100.5` and the packet capture is off in
  `DRY_RUN`, so telemetry can't reach a Windows dry-run backend. The warning was
  seen in a browser through the overlay, and its server side only in unit tests.

## Things not to do

- No field hardware: always a fake `RADIO_URL`, even with `DRY_RUN`.
- No steamboat, ops or Caddy. No push or deploy.
- Nothing on the user's screen: headless Chrome only.

## Progress

- [x] 1. E-STOP on the Driver Station block
- [x] 2. E-Stop on `/staff` and `/csa`
- [x] 3. Warning for a robot enabled through a stop
- [x] 4. `stopWaiting` Clear buttons
- [x] Browser check: 100 checks at 1280x900 and 390x844 with touch, headless Chrome
      over the DevTools protocol, dry-run backend, fake radio on 127.0.0.1

## What the browser check covered, and what it couldn't

- Against the real server: E-STOP taps, the field latching, locked pages with a real
  operator code, a real 2 s `stopWaiting` after a field stop, and a normal stop
  showing no warning.
- Overlaid on the WebSocket in the page: the Driver Station match, `stopWaiting` on
  a station, and `enabledThroughStop`.
- Not seen: telemetry reaching the warning on a real field. `broadcastTelemetry`
  calling `noteRobotEnabled` has never run. A team page out of a match with a real
  DS hasn't either.
- A sibling thread's harness hit this check's backend on port 39005 around 9:50 PM
  PDT (2026-10-31 04:50Z) on 2026-10-30, latching a field stop. That run was thrown
  away. The results above come from a restarted backend on port 39105.
