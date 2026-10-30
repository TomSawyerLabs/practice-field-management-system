# SystemCore robots: see their Driver Station link like NI robots

## Goal

pFMS's passive capture decodes the NI Driver Station ↔ roboRIO traffic
(battery, brownout, enabled, link round trip, dropouts). For a SystemCore
robot driven by the 2027 FIRST Driver Station, it sees nothing. Support both,
so the dropout warnings (`plans/robot-dropout-warnings.md`), link checks,
battery chart and recordings' telemetry work for SystemCore teams too.

## Environment / context

- Team 5940 runs a 2027 DS with a SystemCore robot and uses the field
  regularly. The journal shows `team 5940 (2027 DS, control UDP …)`
  handshakes since 2026-09-12, but never a `RobotPacketCapture: team 5940`
  line, so the capture has never decoded their robot.
- DS ↔ SystemCore on the field (docs/network.md "Driver Station
  generations"): UDP 1110 **both ways**. The robot answers from 1110 to the
  DS's own (ephemeral) port, not to 1150 like a roboRIO. Also UDP 1150 and
  TCP 1250, 1740, 5810 seen.
- The capture filter was `udp and (dst port 1150 or dst port 1110)`, so
  SystemCore replies were never captured. The parser assumes the NI layout
  (frcture.readthedocs.io).
- A direct connection (laptop tethered to the robot) never crosses pFMS.
  Nothing can be seen there, whichever DS.

## Findings

- The protocol is unpublished. The 2027 DS is closed source. On the robot
  side, allwpilib's SystemCore HAL (`hal/src/main/native/systemcore/DriverStation.cpp`)
  hands everything to **mrclib**, a binary-only library from frcmaven
  (`org.wpilib.mrclib:mrclib-cpp`, built from a private `mrccomm` repo).
- mrclib's public headers (`DsComms.hpp`, version
  2027.1.0-alpha-1-116-g5288562) define the robot's 32-bit control flags
  word. It is probably carried on the wire, so it's the first thing to look
  for in a capture (likely as a little-endian uint32):

  | bit  | meaning           |
  | ---- | ----------------- |
  | 0    | enabled           |
  | 1–2  | robot mode        |
  | 3    | e-stop            |
  | 4    | FMS connected     |
  | 5    | DS connected      |
  | 6    | watchdog active   |
  | 7    | supports op modes |
  | 8–11 | alliance station  |
  | 12   | robot Wi-Fi mode  |
  | 13   | timed match       |
  | 14   | **brownout**      |

  `Systemcore.h`: the brownout threshold is configurable from 5.0 to 8.0 V,
  and recovery up to 8.5 V. So a SystemCore brownout isn't fixed at 6.8 V.

## Plan / steps

1. [x] Capture SystemCore traffic raw. `src/port 1110` added to the filter.
       A robot answering from 1110 is marked SystemCore, and both directions
       go to `systemcore-captures/systemcore-YYYY-MM-DD.pcap` on steamboat
       (`src/rawPacketLog.ts`; 50 MB/day, 300 MB total, oldest days pruned).
       They are no longer misread as NI packets. NI traffic is unchanged.
2. [x] Deployed (user OK, 2026-10-29).
3. [ ] **Next:** when 5940 drives, note when they enable, disable and
       e-stop (or read their pFMS log lines), then decode the day's pcap in
       Wireshark: sequence number, the control-flags word (table above),
       battery voltage, and how replies pair with control packets.
4. [ ] Write a SystemCore parser next to the NI one. Feed the same
       consumers: telemetry, `RobotLinkTimer`, `RobotLinkWatch` (drop its
       `isLegacyDs` gate), `RobotDropoutTracker`, joysticks.
5. [ ] Remove the raw recording, or keep it opt-in for future firmware
       changes.

## Things not to do

- Don't guess the layout and ship a parser from the header alone. A wrong
  brownout or enabled bit would show teams false warnings.
- Don't change how the 2027 DS's control packets feed `onDsControl` or the
  joystick count until the layout is known. They still go through the NI
  parser exactly as before, because match logic may depend on it.

## Progress log

- [x] Research and raw capture built (2026-10-29)
- [x] Deployed 2026-10-29 7:19 PM PDT (02:19Z) as `9891816`. tcpdump
      filter confirmed live: `udp and (dst port 1150 or dst port 1110 or src port 1110)`
- [ ] First SystemCore capture recorded
- [ ] Decoded
- [ ] Parser shipped

## Open questions for the user

1. ~~OK to deploy?~~ Yes, deployed 2026-10-29.
2. Can you ask 5940 (or whoever runs SystemCore) to drive through pFMS for a
   few minutes next visit, including an enable, a disable and a brownout if
   one happens naturally?
