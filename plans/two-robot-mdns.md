# Two robots of one team: mDNS and matches

## Goal

When one team runs two robots at once (1967, 2026-10-12), each laptop must
resolve `.local` names (`limelight-*.local`, `roboRIO-TEAM-FRC.local`,
`radio.local`) to the devices on the robot that laptop drives, and both
robots must be able to play a match. Same day: 1967 couldn't reach a
Limelight until one robot was released, and couldn't ready their second
robot for a match.

## Environment / context

- Field server: steamboat (`ssh steamboat`, passwordless sudo). The backend
  runs `node dist`, Node v22.20.0. Python 3 is on the host. pFMS's websocket
  is behind Caddy: `ws://10.55.0.5/ws` with `Host: pfms.tsl` from the team
  network (TLS there is refused).
- Each station has a bridge `br-slotN` (VLAN 10×N). A team's station gets
  `10.TE.AM.<VLAN_HOST_OCTET>` (default `.254`) as a /24 on its bridge, so
  two stations of one team both hold `10.TE.AM.254`.
- 1967 on 2026-10-12: `1967-Elsa` on slot1 (laptop `10.55.79.159`),
  `1967-Lupe` on slot2 from 11:07 (laptop `10.55.139.121`). Elsa's devices:
  radio `.1`, roboRIO `.2`, `limelight-front.local` `.14`,
  `limelight-back.local` `.15`.
- Drive-session DNAT: `-d 10.TE.AM.254/32 -i br-slotN -p udp → laptop`.
  It catches **all** UDP a robot sends to `.254`, unicast mDNS replies
  included.
- This PC has `10.55.193.64` on VLAN 3 (the team network), so it can test
  the laptop path itself: `%TEMP%\claude-mdns-probe\laptop-test.mjs`
  (`node laptop-test.mjs 10.55.193.64 "slot1:name,name" "slot2:name"`). It
  sets a route preference the way the team page does, resolves with
  one-shot queries, and clears the preference afterwards.

## Root causes (confirmed)

**mDNS.** Node's dgram picks an IPv4 multicast interface only by address
(`setMulticastInterface(addr)`, `addMembership(group, addr)`). Two bridges
holding `10.19.67.254` resolve to one device, so the reflector sends every
query for the team out of one bridge. Verified 11:48 from this PC: routed to
slot2, `roboRIO-1967-FRC.local` answered; routed to slot1, pFMS sent the
query out `br-slot2`, and no answer came. Answers are also attributed by
team, not station.

**Matches (fixed, `f60afee`).** The FMS handshake (`resolveTeamSlot`) and
the DS UDP status both found a DS's station with `getStationForTeam`, which
for a duplicated team is always the first station. Lupe's laptop resolved
to slot1, which Elsa's laptop drives, so it was treated as a duplicate and
never assigned. slot2 could never be readied ("the field is not hearing from
its Driver Station"), and its disable/e-stop went to slot1. Also, a station
join/leave closed every TCP connection of the team, kicking the other
laptop.

## Decisions made (don't re-ask)

- **No extra per-station IP addresses.** Tried 2026-10-12 (`20242ce`,
  `add1ce6`); the user called it a hack, and it failed on the field (below).
  Reverted in `cdcd1df`.
- **One mDNS system for every team**, no old/new or duplicated-team split
  (user, 2026-10-12).
- **Prove it on a live robot from this PC before deploying** (the laptop
  test above), not with probes from steamboat alone.
- **Next design: one socket per station pinned to its bridge with
  `SO_BINDTODEVICE`**, sending ordinary queries from `.254:5353` and
  receiving only that bridge's answers. No extra addresses, NAT exceptions
  or one-shot queries. Clear the QU bit when forwarding, so answers are
  multicast on the robot's own bridge instead of unicast to `.254` (which
  the DNAT would take). Node can't set `SO_BINDTODEVICE`.
- **The helper is a native addon, Rust preferred** (modern C++ acceptable),
  **not Python** (user, 2026-10-12). How it's built and shipped (CI
  prebuilds vs building on steamboat) is still open.

## Findings / gotchas

- **Rust addon works, but sends collide in conntrack (2026-10-12, 13:04).**
  Built in WSL (rustup in WSL Ubuntu, napi-rs 2, libc), live-tested from
  `/tmp/pfms-mdns-test/` on steamboat. A pinned socket on `br-slot1`:
  `sendto` returns EPERM exactly when conntrack holds a
  `10.19.67.254:5353 → 224.0.0.251:5353` entry made by the reflector's
  socket going out the _other_ bridge, and works when there's none.
  Correlated over 10 tries. Cause: the bridge MASQUERADE
  (`-o br-slotN -j MASQUERADE`) also matches steamboat's own output, and
  the kernel drops a masqueraded connection whose output interface
  changed (`nf_nat_oif_changed`). Python's identical sequence gets the same
  EPERM, so it isn't the addon's code.

- **Per-station addresses didn't work.** 11:35, from this PC: queries went
  out the right bridges from `.253`/`.252`, but no device answered any of
  them. 11:18 capture: the Limelights, roboRIO and radio each sent
  `who-has 10.19.67.253` about once a second. Steamboat replied every time,
  and they never sent the answer. Something on the robot side drops ARP
  replies for an address it hasn't seen (cause not found). Don't revisit.
- **MASQUERADE applies to pFMS's own output.** `-o br-slotN -j MASQUERADE`
  rewrote `.253` to `.254` (proved by the roboRIO answering
  `.254:<same port>`). Remember this for anything sent from steamboat onto
  a bridge.
- Probes from `.254` are ambiguous while a team is on two stations: the
  kernel picks the bridge. Several mid-day "nothing answers .254" results
  were this, not the robot.
- `dig -b … -p 5353 @224.0.0.251` doesn't set `IP_MULTICAST_IF` and times
  out. Use `%TEMP%\claude-mdns-probe\probe.py`, one `python3 -` per `ssh`:
  a second one in the same command gets an empty stdin and does nothing.
- Robots can power off between tests (11:03:35 "Robot dropped off the field
  radio"). Check `ping 10.19.67.2` before reading anything into silence.
- The leftover `.253`/`.252` /32s and `pfms-nat-mdns-*` RETURN rules stay
  on steamboat until the next reconfigure of those stations. Harmless.
- `br-slot1` showed 57 members of 224.0.0.251 in `/proc/net/igmp` (logged
  in ISSUES.md).

## Progress log

- [x] Drive-button fix: the team page, `/route` and the station panel show
      "Driving" from the drive session, not the route preference
      (`a4623c9`). 1967 used it on slot2 at 11:08.
- [x] Per-station addresses: built, deployed, failed on the field,
      reverted (`20242ce`, `add1ce6`, revert `cdcd1df`).
- [x] Match fix `f60afee`: stationOfDs (drive session for duplicated
      teams) in the handshake and the UDP status; no team-wide kick for a
      duplicated team.
- [x] Deployed `cdcd1df` + `f60afee` at 11:47. Both drive sessions
      restored. Laptop test: slot2 resolves, slot1 doesn't (the known bug).
- [x] Match fix verified 11:50: `assigned blue1` / `assigned red1`, both
      ready, Match 1 ran with slot1 + slot2.
- [x] Robot names next to the team number when a team has two robots
      (`a5a13ef`): match state carries `robot` (SSID), history records it,
      label rule `teamLabelAmong` in src/utils.ts. Not deployed yet.
- [x] E-stop latch after Clear match (`6aec796`): a Global E-Stop
      (11:51:52) latched every station; Clear match (11:56:15) left it, so
      both robots were held under field control with no Clear E-Stop button
      on the match page, until a match was created+cancelled at 11:59:05.
      clearMatch now clears e-stops/a-stops. Not deployed yet. The DS
      restart at 12:01 is unexplained: pFMS had released both DSes and
      Elsa's DS never reported an e-stop after 11:59:05.
- [x] Select deployed (`6bc53c5`, 12:57).
- [x] Forwarded-only bridge MASQUERADE + migration (`bb587c3`).
- [x] Interface-pinned mDNS: Rust addon `native/mdns-socket`, loader
      `src/mdnsSocket.ts`, reflector and team checks rewritten, CI workflow
      `.github/workflows/mdns-socket.yml`, fetch in `bun run build`
      (`e263bcf`). Unit tests pass. The full suite's fmsServer setup
      failures are environmental (they pass alone and on master).
- [x] Released `mdns-socket-v0.1.0` (x64 + arm64 assets, workflow run 38310973434) and deployed `458ab2d` at 14:31. All five bridges got
      the forwarded-only MASQUERADE; the `.253/.252` leftovers and RETURN
      rules were removed; pinned sockets opened on br-slot1..5.
- [x] Verified from this PC (VLAN 3): routed to slot3 (1700-franz),
      `roboRIO-1700-FRC.local → 10.17.0.2` and `radio.local → 10.17.0.1`.
      The capture showed a QM query out br-slot3 from .254 and multicast
      answers. `/tmp/pfms-mdns-test` deleted on steamboat.
- [ ] Not yet seen live: two robots of one team both on. 1967's robots
      were off at 14:32. Check with `laptop-test.mjs` on slot1 + slot2
      when they're both up.

## Open questions for the user

(none open)

## Things not to do

- Don't add extra IP addresses to station bridges.
- Don't send unicast-answer mDNS to `.254`: the drive-session DNAT takes
  the answers.
- Don't re-run the full station teardown to change addresses: it removes
  `.254` and disrupts a live robot.
- Don't disable IPv6 or touch the radio.
- Don't commit from the main checkout while another session's half-done
  work breaks the typecheck. Commit from the clean temp worktree
  (`%TEMP%\pfms-hotfix`) and move `master` with
  `git update-ref refs/heads/master <new> <old>`. Then sync the main
  checkout's copies of your own files only.
