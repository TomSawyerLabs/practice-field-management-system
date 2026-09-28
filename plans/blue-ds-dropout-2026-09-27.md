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
     again DS app and browser together, red untouched. User: the Blue
     Alliance Station switch is **not in use**, so the laptops are on the
     site Wi-Fi (`docs/network.md`: team laptops live on the guest/laptop
     network, `10.55.0.0/16` via VLAN 3). Two laptops sitting together on
     the blue side losing the network at once, with red fine, points at the
     AP they share (roam, band steer, or a wired→wireless delivery fault of
     the kind in `plans/pfms-tsl-iphone-subnet-reachability.md`). Event 1
     hitting all four laptops but not the staff devices fits the same story
     one level up (both field APs, or the switch feeding them).
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
4. **Why the robots looked disabled, and the pFMS fix.** Two layers: an NI
   DS that stops hearing the FMS disables its robot itself, and pFMS, on
   seeing those 0x78 "disabled with robot comms OK" packets, treated them as
   driver disables and latched `disabledBy: 'ds'`. When the laptops came
   back at 12:20:05–10 the stations therefore stayed disabled. A driver
   could already recover from a `'ds'` disable with the Re-enable button on
   the team page (admin disables stay staff-only), but a driver whose
   laptop just dropped off Wi-Fi doesn't know to press it. **Fixed
   2026-09-27:** when a DS re-attaches after 5 s+ of silence during
   auto/teleop/endgame and the station is `disabledBy: 'ds'`, pFMS
   re-enables it (`Re-enabled: slot1 (DS back after dropping off the
field)`), going through `undisable` so e-stop/a-stop/admin/relay/finished
   refusals all still apply and the enable grace window absorbs the
   returning DS's first "disabled" reports. A driver's own Enter-key
   disable keeps the DS talking, so it still latches. Tests in
   `src/matchEngine.test.ts` ("a driver station that drops off the field").
5. The stale sweep removed the blue DNAT rules mid-match (12:19:52/57).
   They were re-added on return (12:20:07/09), so no lasting harm, but it
   is one more thing that has to succeed for a robot to come back after a
   DS-side outage.

## Match 62 (12:58–13:01): 751 "disabled by admin"

Same session, next match, steamboat still on `2a4188b` (fix not deployed).
Blue: 8048 (slot2, 10.55.199.242), 751 (slot4, 10.55.165.238), 1868
(slot6, 10.55.21.118). Red: 4159 (slot3), 581 (slot5).

| Time        | Event                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 13:00:44.26 | slot4 (751) DS reports **0x78** (disabled, a-stop bit, robot comms fine) and goes quiet. Same signature as match 61.               |
| 13:00:58.60 | Match control page: `adminStationEnable slot4` → "Re-enabled: slot4 (admin)". The DS is still offline, so nothing visible happens. |
| 13:00:59.63 | Match control page: `adminStationDisable slot4` → "Disabled: slot4 (by admin)". **1.0 s after the Enable click.**                  |
| 13:01:01–03 | 751's laptop returns: new DS TCP, team page websocket reconnects, DS re-attaches. Station stays down: admin disable.               |
| 13:01:11    | slot6 (1868) DS reports 0x78 and goes quiet; re-attaches 13:01:21; driver presses Re-enable 13:01:31; 0x78 again 13:01:34.         |
| 13:01:36    | Match complete. Red never dropped.                                                                                                 |

**What happened:** on the match control page each station row has one
button slot that reads **Enable** while the station is disabled and flips
to **Disable** the moment the enable lands (`MatchControlPage.tsx` ~980).
Staff clicked Enable on 751 at 13:00:58; the robot couldn't respond because
its laptop was off the Wi-Fi, the button under the cursor had already
turned into Disable, and the second click one second later (a double-click
or a "nothing happened, click again") sent the admin disable. Nobody meant
to disable it, which matches what the admins say. The DS-dropout re-enable
fix (`594e4b8`) would not have helped here: an admin disable is meant to
survive a DS return.

**Fixed (`e4e2768`, deployed to steamboat 13:24):** stopped the button flipping
under the cursor. Render Enable and Disable as two fixed buttons with the
inapplicable one greyed, and/or ignore a Disable within ~1.5 s of an Enable
on the same station, and show "DS offline" on the row (the state already
carries `dsAttached`) so staff know why Enable did nothing.

**Second data point on the 0x78 signature:** three more DS dropouts
(751 once, 1868 twice), all blue-side laptops, all preceded by a 0x78
packet and followed by silence and a re-attach 10–19 s later. Red laptops
were untouched in both matches. The a-stop bit is evidently what the NI DS
sends as it loses the field, not a human keypress.

## Match 64 (13:54–13:57): 4159 never enabled

Different failure, own note: `plans/ready-requires-ds-link.md`. 4159's DS
kept a stale field session after being moved from slot3 to slot4, never
attached to slot4, and the team readied anyway. Fixed in `789280c` by
gating Ready on the DS heartbeat.

## UniFi client history (checked 2026-09-28): not one AP

Source: UniFi Network system log, `POST
/proxy/network/v2/api/site/default/system-log/all` with
`{timestampFrom, timestampTo, pageNumber, pageSize}` (read-only, API key in
the ops repo's `unifi/.env.local`). DS laptops found by last IP in
`/proxy/network/api/s/default/rest/user`. All nine DS laptops are on the
`Tom Sawyer Labs` SSID (VLAN "Public", `10.55.0.0/16`). No disconnect
reason codes are recorded, only AP, band, signal, and channel
utilization/interference.

**It was not one AP.** The same drop events hit laptops on different APs:

| Drop (UniFi stamp) | Laptops and the AP each was on                                   |
| ------------------ | ---------------------------------------------------------------- |
| 12:04:50           | 2813, 840, 6238, 972: all on U7-Pro West                         |
| 12:18:37           | 2813, 840 on U7-Pro East; 6238, 972 on U7-Pro West (same second) |
| 12:20:03–05        | 6238 on U7-Pro West; 840 on U7-Pro East                          |
| 13:00:31–13:01:20  | 840 on Outside; 751 on U7-Pro East; 1868 on U7-Pro East          |
| 13:01:44–51        | 8048 on U7-Pro West; 581 on U7-Pro East; 1868 on U7-Pro East     |

**It was not RF.** Every DS drop was at a usable signal (−42 to −73 dBm)
with channel utilization 6–20 % and interference 1–3 % on the indoor APs.

**It was not the Wi-Fi as a whole.** Of 86 wireless disconnects site-wide
from 11:55 to 13:05, 29 were the nine DS laptops. Every multi-client burst
was DS laptops only; the ~50 phones and other laptops on the same APs and
SSID dropped one at a time, never in step with the DS laptops.

**It lines up with pFMS releasing stations.** At 12:04:44 pFMS released
match 60's four DSes and closed their FMS TCP sessions; UniFi logged exactly
those four laptops leaving at 12:04:50, and all four reconnected to pFMS at
12:04:54. At 13:01:39 pFMS released match 62; 8048, 581 and 1868 left the
Wi-Fi at 13:01:44–51. The mid-match drops (12:18:3x, 12:19:32, 13:00:44,
13:01:11) follow each DS's last "0x78" packet by ~5–10 s, which is about
the AP's detection lag.

**Correction to the earlier "blue side" story:** red laptops dropped too
(972 and 2813 at 12:18:37, 581 at 13:01:44). The mid-match drops were blue,
but blue laptops were spread over three APs, so "blue side" was never a
single AP either.

**UniFi's own timestamps lag.** `CONNECTED` events are stamped up to a
minute after pFMS saw the laptop back (e.g. 6238 back on pFMS 12:04:54,
UniFi "connected" 12:06:03), so UniFi disconnect→connect gaps overstate
the outage. Use pFMS's journal for outage length and UniFi only for which
AP and when the drop began.

**Where that leaves the cause:** something on the DS laptops themselves
makes them drop Wi-Fi, and it tends to fire when the Driver Station's FMS
connection changes state. Whether that is the NI Driver Station, a Windows
power/driver setting, or a reaction to pFMS closing the TCP session is not
determined; a web search found no documented DS behaviour that toggles
Wi-Fi. The oracle is the laptop's own log: Event Viewer → Applications and
Services Logs → Microsoft → Windows → WLAN-AutoConfig → Operational, event
8003 ("disconnected") around one of the times above, whose reason text says
whether the laptop chose to leave or the AP dropped it.

## Things not to do

- Don't read UniFi's disconnect→reconnect gap as the outage length; its
  `CONNECTED` stamps lag pFMS by up to a minute.
- Don't blame a single AP or the RF: see "UniFi client history".
- Don't read the 33 s silence as "the DS app crashed": the browser
  websocket on the same laptop dropped and returned in lockstep, so it was
  the laptop's network path.
- Don't blame the robot radios or the team VLAN bridges; the DS packets
  said the robot link was up until the DS itself went silent.

## Open questions for the user

1. ~~Which AP were the DS laptops on?~~ Answered from UniFi 2026-09-28:
   three different APs, see "UniFi client history". Open instead: can
   someone pull the WLAN-AutoConfig event 8003 from one affected laptop
   (6238, 840, 751 or 1868) at a drop time? That decides laptop-side vs
   network-side.
2. ~~Did anyone touch the blue laptops at 12:19:30?~~ Match 62 showed the
   same 0x78-then-silence signature three more times with no one at the
   laptops; it is the DS losing the field, not a keypress.
3. ~~Build the match-control-page fix?~~ Done, `e4e2768`, deployed 13:24. Was: the Enable/Disable button flipping
   under the cursor (see "Match 62")? My recommendation: yes, two fixed
   buttons plus a "DS offline" marker on the row.
4. ~~Should pFMS un-latch a `disabledBy: 'ds'` station when its DS
   re-attaches?~~ Decided: yes, temporary comms drops must recover without
   staff (user, 2026-09-27). Built, see finding 4.

## Progress log

- [x] Pull match-history entry and journal for 12:16–12:22
- [x] Decode status bytes against `src/fmsServer.ts`
- [x] Rule out steamboat-side causes (kernel log, dmesg, NIC counters, staff clients)
- [x] Rule out pFMS-side causes (pause path only disables + sends packets; relay hand-off is inert outside relay mode)
- [x] UniFi client history: not one AP, not RF, DS laptops only, drops follow pFMS releases (2026-09-28)
- [ ] Windows WLAN-AutoConfig 8003 reason from one affected laptop (needs someone at a team laptop)
- [x] Decide on finding 4: re-enable on DS return (user said yes)
- [x] Implement + test + document the re-enable (`src/matchEngine.ts`, `src/matchEngine.test.ts`, `docs/match-system.md`)
- [x] Committed as `594e4b8` (fix) and `6517e72` (this note), both on `origin/master`
- [x] Deployed `e4e2768` (both fixes) to steamboat 13:24:40; service active, no errors in the first minute
- [ ] Watch the journal for `Re-enabled: … (DS back after dropping off the field)` and `Ignoring Disable for …` on the next dropout
