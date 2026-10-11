# 2027 DS status packets pFMS can't parse (team 100, 2026-10-10)

## Goal

Team 100's 2027 Driver Station joined matches on 2026-10-10 but the field
never heard from it, so staff had to force-ready the station twice (matches 95
and 96; 96 ended in an E-stop). Find out why pFMS rejected its UDP status
packets and make the field accept them.

## Environment / context

- Production: steamboat, `~/practice-field-management-system`, running
  `b302134` at the time of the incident (pid 6965).
- Team 100's DS laptop: `10.55.183.68`, 2027 (SystemCore) DS. Robot SSID
  `100-test0`. A second laptop `10.55.18.41` ran the 2027 DS and the legacy NI
  DS at the same time earlier that afternoon.
- Comparison: team 5940's 2027 DS (`10.55.65.16`) attaches fine — see
  `docs/network.md` "Driver Station generations".
- Parser: `parseIncomingUdpMessage` in `src/fmsServer.ts`.

## Findings

- Journal, 21:13:57: the TCP handshake was fine, same as 5940's:
  `DS at 10.55.183.68: team 100 (2027 DS, control UDP 65485, flags 0) → assigned red1 (reply 0x1f)`.
  But no `DS attached to FMS: slot1` ever followed, and Ready was refused:
  `Cannot ready slot1: the field is not hearing from its Driver Station`.
- Every UDP status packet from it failed to parse:
  `Unparseable DS UDP status from 10.55.183.68: 1000 so far` at 21:16:03, 2000 at 21:19:26, 3000 at
  21:32:54, 4000 at 21:36:25 — about 5/s, only while assigned to a match.
- Error text: `Reading number past end of buffer`. That's either a packet
  shorter than the 8-byte header, or a tag whose body is shorter than the
  layout the parser expects (one short tag threw away the whole packet,
  header included).
- **No hex of the bad packets exists.** pFMS only logged the first bad packet
  per address per process; the first one from `10.55.183.68` was an empty
  packet from its legacy DS on Friday (port 1145), so Saturday's 4000 were
  counted but never shown.
- Empty packets on attach are normal for both DS generations (the 2027 DS's
  firewall punch, and the legacy DS on attach) — they're not the problem.

## Plan / steps

1. [x] Log the hex of every new _kind_ of bad packet (per address, length and
       error), capped per address, not just the first one ever.
2. [x] Parse tags leniently: a tag shorter than its expected layout, or a size
       byte running past the packet end, is logged once and skipped — the header
       (team number, status) is still used.
3. [x] Tests for both.
4. [x] Deployed `2a1faea` to steamboat 2026-10-11 13:25.
5. [ ] **Current:** next time team 100 is on the field with the 2027 DS, read
       the new `Unparseable DS UDP status … bytes): <hex>` / `Skipping DS UDP status tag` lines (or
       `sudo tcpdump -i any -X udp port 1160 and host <ip>`) and confirm whether
       step 2 fixed it or the header itself is short.

## Things not to do

- Don't assume the packets are empty because the one logged sample was — it
  came from a different DS app on a different day.
