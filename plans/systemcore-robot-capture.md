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

### Decoded from the first capture (2026-11-03)

5940 (`10.59.40.2`, slot2) and its backup 9940 (`10.99.40.2`, slot3) drove
5:54–6:17 PM PST (01:54–02:17Z, Nov 4). The raw pcap is copied to this PC at
`C:/Users/camer/sc-pcap/systemcore-2026-11-03.pcap`. The day's 50 MB cap was
hit at about 6:17 PM PST, so later traffic is only in the separate capture
below. Analysis scripts are in `C:/Users/camer/sc-pcap-scripts/`
(`replay.ts` runs a pcap through `RobotPacketCapture`).

- **Both directions use comm version `0x02`** at byte 2 (NI is `0x01`), at
  50 Hz like NI. The robot echoes the control packet's sequence number
  (bytes 0–1): every reply matched one, so the NI link timer works unchanged.
- **Robot reply bytes 0–7 are NI-shaped:** seq (2), version 0x02, status,
  trace, battery as whole volts + 1/256ths (bytes 5–6), then a byte that's
  almost always 0. The battery sagged with enables (12.4 → 9.1 V for 5940,
  12.8 → 6.6 V for 9940), so the reading is right.
- Then come NI-style tags (the size counts the id): byte 15 repeats the
  status byte (or is 0), bytes 16–23 look random, then tag `0x35` (10 data
  bytes), tag `0x37` (8 bytes), and sometimes `0x34` (20 bytes) or `0x33`
  (16 bytes). Not decoded.
- **Status byte 3:** only `0x02` and `0x06` were seen, on both robots. Bit 2
  (`0x04`) followed the DS's control byte 3 exactly, so it's enabled.
  **Mode bits 0–1: 1 = auto, 2 = teleop** (NI: 0 = teleop, 1 = test,
  2 = auto). At 6:37:54 PM PST 9940 switched to mode 1 (`0x01`/`0x05`) and ran
  enabled 6:37:56–6:38:19 and 6:38:52–6:38:58. The team was heard yelling
  "that was auto" at 6:38. Every other enable was mode 2. The robot's status
  echoes the DS's control byte exactly. The 2027 DS has no "test" mode; it
  has **Util = 3**. Confirmed on 5940 at 6:51 PM PST while disabled, with the
  user cycling util → tele → auto → match → util: DS control byte `0x03` →
  `0x02` (6:51:32) → `0x01` (6:51:40) → `0x11` (6:51:48) → `0x03`
  (6:51:55), and the robot's status byte echoed each one, except that it
  showed `0x01` for match. So **"Match" is auto plus DS control bit `0x10`**,
  which the robot doesn't echo.
- **Brownout:** status bit 4 never set, even at 6.6 V on 9940 (6:16:47 PM
  PST). Either SystemCore's threshold was lower, or brownout is carried
  elsewhere. **Unknown.** The e-stop bit (7) was never seen either.
- **Trace byte 4:** `0x61` / `0x60` normally. It was `0x00` and `0x40` for
  about 10 s at 5:56:05 PM PST, which looks like a robot code restart. So
  `0x20` is robot code, as on NI, and `0x40` is probably "SystemCore" (NI
  uses `0x10` for roboRIO). Bit 0 is not "disabled": `0x60` appeared while
  disabled too, and in those packets byte 15 is 0.
- **DS control:** seq (2), 0x02, the control byte (same `0x04` enable bit),
  then `0x40`, then a byte that went 0 → 3 around 6:03 PM PST on both DSes,
  then more tags. Not decoded.
- 9940's link round trip was a steady ~115 ms median vs 5940's 1.8 ms, on the
  same field at a similar signal (-52 vs -47 dBm). Either 9940's code answers
  late, or its link is slow. Not investigated.

Separate captures on steamboat, in `~/sc-capture/`:

- `sc-20261103-181545.pcap` (550 MB): every packet to or from either robot,
  6:15–6:26 PM PST (02:15–02:26Z), camera streams included.
- `sc-ports-20261103-182654.pcap`: UDP 1110/1150 and TCP 1740/1250 only,
  6:26–6:41 PM PST. The capture died at its first rotation: tcpdump drops to
  its own user after opening a file and couldn't create the next one in
  `~/sc-capture/`. **Run it with `-Z root`.** Because of this, 5940's util-mode
  test (about 6:45 PM PST) was not captured, and pFMS's own recorder had hit
  its daily 50 MB cap.
- `sc-ports-*.pcap` from 6:48 PM PST: same filter, `-Z root`, 5-minute files.
  It stops by itself around 9:48 PM PST (05:48Z).

Delete them once they're no longer needed.

## Plan / steps

1. [x] Capture SystemCore traffic raw. `src/port 1110` added to the filter.
       A robot answering from 1110 is marked SystemCore, and both directions
       go to `systemcore-captures/systemcore-YYYY-MM-DD.pcap` on steamboat
       (`src/rawPacketLog.ts`; 50 MB/day, 300 MB total, oldest days pruned).
       They are no longer misread as NI packets. NI traffic is unchanged.
2. [x] Deployed (user OK, 2026-10-29).
3. [x] Decoded the battery, sequence and enable bit from 5940/9940's traffic
       (findings above).
4. [x] Parser for what's proven: battery, link round trip and dropouts
       (`parseSystemCoreReply`; control packets with version 0x02 feed the
       link timer and dropout tracker). No `dsStatus`, `brownout` or e-stop
       yet, since match logic acts on those.
5. [x] Deployed `5fc0c7e` 6:39 PM PST (02:39Z), user's yes. The journal
       showed `team 9940 (SystemCore) → 12.45V` right after.
6. [x] Mode bits: 1 = auto, 2 = teleop, 3 = util, and DS bit `0x10` =
       match (6:51 PM PST, 5940).
7. [x] Enable and mode reported through `dsStatus` (`c2c68bf`, deployed
       7:09 PM PST). Util is its own mode. `eStop` is reported false. The 2027
       DS's own UDP status no longer carries `dsStatus` or counts toward the
       enabled checks, because its enabled bit is never set.
8. [x] `RobotLinkWatch`'s `isLegacyDs` gate dropped (`0c92375`, deployed
       7:13 PM PST). Replayed first; live it caught 9940 leaving the radio
       24 s before the radio poll did (7:18:12 vs 7:18:36 PM PST).
9. [x] Raw recording is now selective (`b00b311`, deployed 7:18 PM PST):
       only around a packet with bits not seen yet, mode 0, or a battery
       under 7 V, from ~3 s before to 10 s after. Replay: one trigger in the
       day (9940 at 6.82 V), 0.5 MB.
10. [ ] **Next:** when the journal shows a `SystemCore robot <ip>: <why>`
        line ("recording its packets raw"), pull that day's
        `systemcore-captures/` file and decode the brownout or e-stop bit.
        Then report `brownout`, feed `RobotEStopWatch`, and replace
        `eStop: false`. Don't ask a team to e-stop; clearing it takes a
        reboot.

## Things not to do

- Don't ship a parser for bits that haven't been seen working. A wrong
  brownout or enabled bit would show teams false warnings, and match logic
  acts on `dsStatus`.
- Don't change how the 2027 DS's control packets feed `onDsControl` or the
  joystick count until the layout is known. They still go through the NI
  parser exactly as before, because match logic may depend on it.

## Progress log

- [x] Research and raw capture built (2026-10-29)
- [x] Deployed 2026-10-29 7:19 PM PDT (02:19Z) as `9891816`. tcpdump
      filter confirmed live: `udp and (dst port 1150 or dst port 1110 or src port 1110)`
- [x] First SystemCore capture recorded (2026-11-03, 5940 and 9940)
- [x] Battery, sequence and enable bit decoded
- [x] Battery/link/dropout parser committed and replayed against the real
      pcap (5940 8.6–13.0 V, 9940 6.6–14.5 V, every reply paired)
- [x] Parser deployed (`5fc0c7e`, 2026-11-03 6:39 PM PST)
- [x] Mode values decoded: auto 1, teleop 2, util 3, match = DS bit 0x10
- [x] Enable/mode in `dsStatus`, link watch for SystemCore, selective raw
      recording: all deployed by 7:18 PM PST (`b00b311`)
- [ ] Brownout and e-stop decoded (waiting for one to happen)

## Open questions for the user

1. ~~OK to deploy?~~ Yes, deployed 2026-10-29.
2. ~~Ask 5940 to drive through pFMS?~~ Done 2026-11-03.
3. ~~Test/util mode?~~ Done 6:51 PM PST.
4. ~~Deploy now?~~ Yes, deployed 6:39 PM PST.
5. ~~Report enable and mode now?~~ Yes ("do it all"), done 7:09 PM PST.
