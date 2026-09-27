# Blue Driver Stations dropped off the network twice in match 61 (2026-09-27)

## Goal

Explain why both blue robots "disconnected" in the last match of the
2026-09-27 practice session (match 61, engine "Match 5", 12:17–12:20 PDT),
and record the evidence so the next incident can be compared against it.

## Environment / context

- Host: steamboat (`ssh steamboat`), pFMS PID 29640, DS VLAN is `eno1.3`
  (`10.55.0.0/16`). Kernel log had no link events all afternoon.
- Ground truth: `~/practice-field-management-system/match-history.json`
  entry 61 (`bfea7022-…`), `journalctl -u practice-field-management-system`
  12:16–12:22. No journald suppression notices in the window, so the
  journal is complete for once.
- Teams and Driver Station addresses:

  | Slot  | Team | Alliance | DS address    | Note                               |
  | ----- | ---- | -------- | ------------- | ---------------------------------- |
  | slot1 | 6238 | blue1    | 10.55.64.219  |                                    |
  | slot5 | 840  | blue2    | 10.55.48.12   |                                    |
  | slot6 | 1868 | blue3    | 10.55.21.118  | DS status 0x00 all match: no robot |
  | slot2 | 972  | red1     | 10.55.153.222 |                                    |
  | slot3 | 2813 | red2     | 10.55.69.79   |                                    |

- Legacy DS→FMS status byte as pFMS decodes it (`src/fmsServer.ts`
  `byteToDsStatus`): 0x80 e-stop, 0x40 a-stop, 0x20 robot comms,
  0x10 radio ping, 0x08 rio ping, 0x04 enabled. So 0x38 = robot linked but
  disabled, 0x78 = the same plus the a-stop bit, 0x18 = radio/rio ping but no
  robot comms.

## Timeline (PDT)

| Time         | Event                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 12:17:12     | Match started, teleop only (auto skipped). All five DSes attached.                                                                                                                                                                                                                                                                                                 |
| 12:17:15     | Field enable. slot6 (1868) reports 0x00 and "lost robot comms" 2 s later: that robot was never on the field.                                                                                                                                                                                                                                                       |
| 12:18:09     | Blue's last score of the match (t=54).                                                                                                                                                                                                                                                                                                                             |
| 12:18:20     | Staff paused the match.                                                                                                                                                                                                                                                                                                                                            |
| ~12:18:25–38 | **Whole DS network blip.** All four real DSes fell off (>5 s no UDP) and re-attached 12:18:39; all four opened new FMS TCP sessions 12:18:41; the old sessions died with ECONNRESET 12:18:51 / ETIMEDOUT 12:19:01. The team pages open on all four DS laptops reconnected their websockets 12:18:38–40. Staff/scorer clients on the TSL network did not reconnect. |
| 12:19:14–17  | Staff resumed; field re-enabled. All DSes report 0x38 within 17 ms.                                                                                                                                                                                                                                                                                                |
| 12:19:30.52  | slot1 (6238) last packet: **0x78** (disabled, a-stop bit, robot comms fine). pFMS latched `disabledBy: 'ds'`.                                                                                                                                                                                                                                                      |
| 12:19:32.53  | slot5 (840) last packet: **0x78**, same latch. Both blue DSes then silent.                                                                                                                                                                                                                                                                                         |
| 12:19:52/57  | Both blue DSes swept stale (last seen ~12:19:32/33); drive sessions cleared, DNAT rules removed.                                                                                                                                                                                                                                                                   |
| 12:19:58     | Red 972 briefly reported no robot comms (0x18); pFMS kept it enabled. Red kept scoring 12:19:49–12:20:09.                                                                                                                                                                                                                                                          |
| 12:20:05–10  | Blue DSes back: 6238 TCP reset + drive restarted 12:20:07, re-attached 12:20:08; 840 reconnected 12:20:09–10. Blue team pages reconnected 12:20:08 (840) and 12:20:19 (6238). Red DSes and pages untouched.                                                                                                                                                        |
| 12:20:11     | Match complete; stations released 12:20:14.                                                                                                                                                                                                                                                                                                                        |

## Findings

1. **Two separate outages, both on the Driver Station side of the network,
   neither caused by pFMS or the robots' radios.**
   - Event 1 (~12:18:25–38) took out all four DS laptops at once: their DS
     apps _and_ their browsers reconnected together. Staff clients on the
     TSL network never dropped, steamboat's NIC logged nothing, and no
     `arp_cache` overflow appeared in dmesg. Whatever failed is common to
     both alliance stations but not to steamboat: the shared uplink/switch
     the two station switches hang off, or the station switches' power.
   - Event 2 (12:19:32–12:20:05, ~33 s) took out only the two blue laptops,
     again DS app and browser together, red untouched. That points at the
     Blue Alliance Station switch (or its uplink cable/PoE).
   - The robots' radios were fine both times: the last packets from both
     blue DSes still carried robot comms + radio ping + rio ping, and
     neither blue station ever logged "DS lost robot comms".
2. **Blue was already off before the pause.** Blue stopped scoring at
   12:18:09 and staff paused at 12:18:20, so event 1 most likely began
   around 12:18:10 and the pause was a reaction to it, not a cause. The
   journal can't pin the start closer because a DS just goes quiet.
3. **Unexplained signature:** the very last packet from _each_ blue DS
   before silence had the a-stop bit set (0x78), 2.001 s apart. pFMS never
   sends a-stop, and the DS shouldn't a-stop in teleop. Unknown whether the
   NI DS sets that bit on its own when its link drops, or whether someone
   touched the laptops. The DS log viewer on either blue laptop at 12:19:30
   would settle it.
4. **pFMS behaviour worth a look:** because those 0x78 packets said
   "disabled with robot comms OK", pFMS treated them as driver disables and
   latched `disabledBy: 'ds'` for both blue stations. When the laptops came
   back at 12:20:05–10 the stations stayed disabled. With 1–6 s left it made
   no difference here, but a DS that vanishes mid-match with a disable
   packet and returns 30 s later would need staff to re-enable it. The
   `DS lost robot comms` carve-out (2026-09-13) covers only the
   no-robot-comms case.
5. The stale sweep removed the blue DNAT rules mid-match (12:19:52/57).
   They were re-added on return (12:20:07/09), so no lasting harm, but it
   is one more thing that has to succeed for a robot to come back after a
   DS-side outage.

## Things not to do

- Don't read the 33 s silence as "the DS app crashed": the browser
  websocket on the same laptop dropped and returned in lockstep, so it was
  the laptop's network path.
- Don't blame the robot radios or the team VLAN bridges; the DS packets
  said the robot link was up until the DS itself went silent.

## Open questions for the user

1. Are both blue laptops wired into the Blue Alliance Station switch, and
   does that switch share an uplink/PoE source with the red one? The UniFi
   event log for those switches around 12:18:15 and 12:19:32 is the oracle
   (I did not open UniFi).
2. Did anyone touch the blue laptops at 12:19:30? The a-stop bit in the last
   packets is the one detail a network fault doesn't explain.
3. Should pFMS un-latch a `disabledBy: 'ds'` station when its DS re-attaches
   after going stale (finding 4)? My recommendation: yes, treat "DS went
   silent within a few seconds of reporting disabled" like a comms loss
   and re-enable on re-attach, logging it.

## Progress log

- [x] Pull match-history entry and journal for 12:16–12:22
- [x] Decode status bytes against `src/fmsServer.ts`
- [x] Rule out steamboat-side causes (kernel log, dmesg, NIC counters, staff clients)
- [x] Rule out pFMS-side causes (pause path only disables + sends packets; relay hand-off is inert outside relay mode)
- [ ] Confirm the switch story from UniFi events / the laptops (user)
- [ ] Decide on finding 4 (pFMS re-enable after DS returns)
