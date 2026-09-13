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
7. [x] Committed (845c94a protocol, 6a5d8d7 instrumentation, d967126
       local-bind fix) and deployed to steamboat 2026-09-12 19:20 and 19:24
       PDT via `./update.sh`; service active.
8. [~] Live verification — see "Live results" below.
9. [ ] Scrimmage 2026-09-13: watch the journal for the three expected lines
       (see "Live results") and for any unparseable-status or unknown-tag lines.

## Live results (2026-09-12 evening, team 5940)

- 19:22 simulated 2027 handshake (team 9999, unassigned) against production:
  parsed and logged correctly, no reply (not joined), service stayed up.
- Local end-to-end test on the dev machine (real `startFMSServer` +
  `MatchEngine`): joined team gets the 8-byte 0x1f reply, unjoined gets
  none, legacy still gets the 5-byte 0x19, control packets go to the
  DS-advertised UDP port with game data tag 0x20.
- 19:24 5940 joined and started a match on the deployed build. DS showed
  "FMS connected" (TCP handshake + 0x1f reply worked) but the robot never
  enabled: no UDP status ever arrived on 1160, and the DS re-handshaked
  with a new control port every 3 s. pFMS was sending control packets from
  an ephemeral source port; Cheesy Arena sends them from its 1160 listener.
  Fix: match engine now sends from the FMS 10.0.100.5:1160 socket. Also
  0x1d is the 2027 DS TCP keepalive (Cheesy ignores it) — now parsed.
- 19:34–19:36 second attempt (build 3f24293, control packets from port
  1160): handshake → assigned red1 (0x1f), one empty UDP packet from the DS
  control port to 1160 (firewall punch; the try/catch logged it instead of
  crashing), "DS attached to FMS: slot1", match started, robot ENABLED at
  auto start — then disabled ~1 s later. Journal: "DS disable reported:
  slot1" 2 s after every enable. DS status byte during the match was 0x3a
  (robotComms/radio/rio, mode auto, enabled bit CLEAR) even while running:
  the 2027 DS doesn't set the enabled bit, pFMS read it as a team Disable
  press and started sending disabled packets. Fix 6cafd40 (deployed 19:39):
  for ds2027 only honour a disabled report after an enabled report since
  the FMS enable (real transition). First status after each enable is now
  logged with the raw byte ("DS status after FMS enable").
- The 2027 DS closes and reopens TCP 1750 every 3 s while assigned (5 s
  while not), advertising a new control port each time; pFMS follows the
  port on every handshake. Cheesy Arena has no special handling, so this is
  presumed inherent. Harmless so far but keep an eye on it.
- Open: does a Disable press on the 2027 DS reach pFMS at all (station page
  state)? If its status never sets the enabled bit, pFMS can't see it; the
  DS itself still stops the robot. Candidate: the TCP 0x16 status byte
  (Cheesy reads "DS disabled" from 0x08 there).
- Expected journal sequence when it works: `DS at <ip>: team N (2027 DS,
control UDP P, flags 0) → assigned <slot> (reply 0x1f)`, then `Match
control for slotX now sent to <ip>:P/ds2027 as <slot>` (once, not every
  3 s), then `DS attached to FMS: slotX`. Capture if needed:
  `sudo tcpdump -i eno1 -nn -X "host <ip> and udp"`.

## Not verified / residual risk

- No 2027 DS was available off-field to test the full enable loop; the
  reply format and UDP tag ids come from Cheesy Arena's implementation
  (which WPILib says works with alpha-7). First real proof is step 8.
- The DS→FMS UDP status packet (1160) from the 2027 DS is assumed to match
  the legacy layout (Cheesy Arena parses it identically).

## Open questions for the user

None — deploy authorized and done. Remaining proof is a real 2027 DS joining
a match (step 9).

## Unrelated issue noticed during deploy (pre-existing)

`Error setting route preference: Command failed: ip rule add from
2600:1700:…:5a5b to 10.59.40.0/24 table 10 — Invalid source address`,
logged on every backend start: a browser on an IPv6 address has slot1 route
preference selected and the ip rule is IPv4-only. Harmless error log, but
route preference (and mDNS reflection) doesn't work for IPv6 clients.

## Things not to do

- Don't reply to unjoined stations' handshakes (locks out local enable).
- Don't send legacy DSes an 8-byte 0x1f reply — they expect 5-byte 0x19.
