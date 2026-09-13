# Support the 2027 FIRST Driver Station (SystemCore) FMS protocol

## Goal

Team 5940 practiced on 2026-09-12 with SystemCore + the new 2027 FIRST Driver
Station and their robot never received an enable from pFMS. Make pFMS speak
the new DS↔FMS handshake so SystemCore teams can run matches, while keeping the
legacy NI Driver Station working side by side.

## Environment / context

- pFMS backend: `src/fmsServer.ts` (TCP 1750 handshake + UDP 1160 status
  listener), `src/matchEngine.ts` (UDP control packets to each joined DS),
  `src/index.ts` (~line 1085 `resolveTeamSlot`, ~line 1206 `fms.on('message')`).
- pFMS listens on 10.0.100.5. Team VLANs are NAT'd, so a DS usually appears as
  the slot gateway (10.TE.AM.254) or its guest-network IP.
- Reference implementation of the new protocol: Cheesy Arena
  `field/driver_station_connection.go`, commit 1612d071 (PR #284,
  2026-06-14, "Implement changes for the 2027 DS FMS protocol"). The new DS is
  closed source; Cheesy Arena is the only public FMS that supports it.
- New DS: github.com/wpilibsuite/FirstDriverStation-Public. Latest
  v2027.0.0-alpha-7 (2026-09-01); alpha-6 (2026-07-02) is where the DS-side FMS
  path was fixed. README: "not supported on any current FIRST FMS. DS Alpha 7
  can be supported on development versions of Cheesy Arena (experimental)."
  FMS support is compiled out of macOS/Linux builds — Windows only.

## Protocol differences (from Cheesy Arena PR #284)

Legacy NI DS (unchanged, pFMS already does this):

- DS → FMS TCP: `00 03 18 <team hi> <team lo>` (tag 0x18 = 24).
- FMS → DS TCP: `00 03 19 <station> <status>` (tag 0x19 = 25).
- FMS → DS UDP control to fixed port 1121 (1120 = "lite", DS prompts).
- Game data via TCP tag (pFMS currently sends it as UDP tag 0x07).

New 2027 DS:

- DS → FMS TCP: `<len hi> <len lo> 1e <udpPort hi> <udpPort lo> <flags> <teamLen> <team ASCII…>`
  (tag 0x1e = 30, len ≥ 5). The DS tells the FMS which UDP port to send
  control packets to. Team number is ASCII, length-prefixed.
- FMS → DS TCP reply: `00 06 1f <station> <status> <flags> <team hi> <team lo>`
  (tag 0x1f = 31, 8 bytes). flags bit0 = lite mode (1). Station 0–5 =
  red1..blue3; status 0 = good, 2 = not in match, 3 = invalid.
- FMS → DS UDP control: same 22-byte body, sent to the DS-advertised port.
  Game data goes in the UDP packet as tag 0x20 (32), max 8 chars, not TCP.
- DS → FMS UDP status on 1160: same layout (team at bytes 4–5, battery 6–7).
- DS sends TCP tag 0x1d (29) periodically (seen 2026-07-17, ignored by pFMS).

## Decisions already made (don't re-ask)

- Only reply to the handshake for stations joined to a match (existing rule —
  replying flips the DS into FMS-controlled mode). Same rule for tag 0x1e.
- Keep legacy 0x18/0x19 path byte-for-byte unchanged.

## Findings / gotchas

- 2026-09-12 ~18:47 PDT on steamboat: the only DS connected to TCP 1750 is
  10.55.243.129 sending the legacy `00 03 18 17 94` (team 6036). 5940's robot
  is at 10.59.40.2 (slot1) and its DS at 10.55.65.16 (guest net, NAT'd via
  10.59.40.254) exchanges UDP 1110/1150 + TCP 1250 with it — but sends
  NOTHING to 10.0.100.5:1750. So today's failure is upstream of the protocol:
  the DS isn't attempting an FMS connection at all (see open questions).
- `journalctl -u practice-field-management-system` shows nothing useful for
  DS events (journald rate-limiting; see memory note). Use tcpdump.
- CORRECTION (18:50 PDT): 5940DS (10.55.65.16, Windows — TTL 128, NetBIOS
  name `5940DS`) DOES connect to 10.0.100.5:1750 every ~6 s. Captured
  handshake: `00 09 1e f0 12 00 04 35 39 34 30` → tag 0x1e, UDP port 0xf012
  (61458), flags 0, "5940". The next connection advertised 0xf013 — the port
  changes per reconnect, so it must be re-learned on every handshake. pFMS
  journal at 16:13:27: `Ignoring unknown DS TCP message type 30 (0x1e):
1eff28000435393430`. Root cause confirmed: pFMS never answered, so the DS
  never entered FMS mode and never got enable.
- DS↔SystemCore link is NOT the roboRIO protocol: DS → robot UDP 1110 and the
  robot replies from 1110 to the DS source port (symmetric, so conntrack
  NAT works without the 1150 DNAT trick). Also TCP 1250 (JSON device list),
  1740, 5810 (NetworkTables).

## Plan / steps

1. [x] Research: confirm protocol change (Cheesy Arena PR #284) and live field state.
2. [x] `fmsServer.ts`: parse tag 0x1e → `{type:0x1e, teamNumber, udpPort, flags}`;
       reply with 0x1f (8 bytes) via `makeStationAssignment` when `resolveTeamSlot`
       grants a slot; `makeDSPacket` takes `protocol` and emits game data as tag
       0x20 (capped at 8 bytes) for ds2027.
3. [x] `matchEngine.ts`: `dsEndpoints` map keyed by DS IP (`setDsEndpoint`),
       `endpointFor(ip)` picks port + protocol in `sendDSPacket` /
       `sendRawControlPacket`; `connectedStations` state now carries `protocol`.
4. [x] `index.ts`: on 0x1e/0x18 handshake, `matchEngine.setDsEndpoint(...)`.
       `telemetryManager.ts` learns team from 0x1e like 0x18.
5. [x] Typecheck passes. Byte-level scratch test (not committed) verified the
       parser against the captured 5940 handshake, the 0x19/0x1f replies, and
       the legacy vs ds2027 game data tags.
6. [x] Docs: `docs/network.md` "Driver Station generations" table,
       `docs/getting-started.md` mention.
7. [ ] Commit. Deploy to steamboat — needs user OK (team on the field).
8. [ ] Verify live: after deploy + 5940 joins a match, tcpdump should show an
       8-byte `00 06 1f …` reply on 1750 and control packets to the advertised
       UDP port; DS status heartbeats should start arriving on 1160.

## Not verified / residual risk

- No 2027 DS was available off-field to test the full enable loop; the
  reply format and UDP tag ids come from Cheesy Arena's implementation
  (which WPILib says works with alpha-7). First real proof is step 8.
- The DS→FMS UDP status packet (1160) from the 2027 DS is assumed to match
  the legacy layout (Cheesy Arena parses it identically).

## Open questions for the user

1. OK to deploy to steamboat now, while 5940 is on the field? (Resolved the
   earlier questions: 5940DS is Windows and is already attempting the FMS
   connection, so no DS-side change is needed.)

## Things not to do

- Don't reply to unjoined stations' handshakes (locks out local enable).
- Don't send legacy DSes an 8-byte 0x1f reply — they expect 5-byte 0x19.
