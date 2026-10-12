# mDNS for two robots of one team

## Goal

When one team runs two robots at once (1967, 2026-10-12), `.local` names
(`limelight-*.local`, `roboRIO-TEAM-FRC.local`, `radio.local`) must resolve
on each laptop to the devices on the robot that laptop drives. On
2026-10-12, 1967 couldn't reach their Limelight until one of the two robots
was released.

## Environment / context

- Field server: steamboat (`ssh steamboat`, passwordless sudo). The backend
  runs `node dist`, Node v22.20.0. Python 3 is available on the host.
- Each station has a bridge `br-slotN` (VLAN 10×N). A team's station gets
  `10.TE.AM.<VLAN_HOST_OCTET>` (default `.254`) as a /24 on its bridge.
  `net.ipv4.conf.all.promote_secondaries = 0`.
- 1967's robot devices (seen 2026-10-12, on `br-slot1`): radio `.1`/`.4`,
  roboRIO `.2`, `limelight-front.local` `.14`, `limelight-back.local` `.15`.
  Nothing answers plain `limelight.local` on that robot.
- Drive-session DNAT: `-d 10.TE.AM.254/32 -i br-slotN -p udp → laptop`.
  It catches **all** UDP the robot sends to `.254`, unicast mDNS replies
  included.

## Root cause (confirmed)

With two stations on one team, both bridges carry the same address,
`10.19.67.254`. Node's dgram selects an IPv4 multicast interface only by
address (`addMembership(group, ifaceAddr)`, `setMulticastInterface(addr)`
→ `IP_MULTICAST_IF` with an `in_addr`). The kernel resolves that address
to the first device that has it, so:

- every laptop query the reflector forwards for team 1967 goes out the
  **same** bridge, whichever robot the laptop drives, and the other robot's
  Limelight never hears it;
- answers are attributed by team (source `10.TE.AM.x`), and `teamToStation`
  keeps only the last station, so an answer can't be traced to its robot.

Releasing one robot left one bridge holding the address, so it worked
again. The team-check mDNS diagnostics (`teamChecker.mdnsQuery`) have the
same flaw.

## Decisions made

- **A per-station mDNS address.** Each team bridge also gets
  `10.TE.AM.(VLAN_HOST_OCTET − slotNumber)` as a **/32** (`.253` for slot1
  … `.248` for slot6 with the default octet). Being /32 it's its own
  primary, so it can't be swept away with the /24, and source selection and
  MASQUERADE keep using `.254` (the /24 is the on-subnet match). It sits
  outside the DHCP pool (`.100–.199`) and outside the DNAT match (`.254`).
- **Forward queries as legacy unicast** (RFC 6762 §6.7), from a
  per-station socket bound to `stationMdnsIp:<ephemeral>`, with
  `IP_MULTICAST_IF` = that address. That selects the right bridge, and every
  answer comes back unicast to that socket, so it is attributed to the
  exact station. No multicast joins on team VLANs are needed for this path.
- **Uniform for all stations**, not only duplicated teams. One code path,
  exercised by every team every day. If a station's socket can't bind
  (the address is missing or conflicted), fall back to the old team path.

## Findings / gotchas

- Legacy-unicast probe from `10.19.67.254:<ephemeral>` (2026-10-12,
  tcpdump on br-slot1): the roboRIO, both Limelights and the radio all
  answered unicast to the ephemeral port. QU queries from :5353 drew
  **multicast** answers from the roboRIO, and no answer at all for
  `limelight.local` (the name doesn't exist on that robot).
- The probe socket never received those unicast answers: the drive-session
  DNAT rewrote them to the DS laptop (`10.55.79.159`). That's why the
  per-station address must not be `.254`.
- `dig -b 10.19.67.254 -p 5353 @224.0.0.251` times out: dig doesn't set
  `IP_MULTICAST_IF`. Use the Python probe below instead.
- **MASQUERADE rewrote the per-station address (first deploy, 10:48).**
  `-o br-slotN -j MASQUERADE` (pfms-nat-vlan-\*) applies to pFMS's own
  output too, so queries from `.253` reached the robot as from `.254`.
  Answers went to `.254:<port>` and the DNAT sent them to the laptop, so
  every team's lookups failed. Fixed in `add1ce6` with a nat POSTROUTING
  `-s <mdns>/32 -o br-slotN -j RETURN` inserted ahead of the MASQUERADE,
  deployed 11:02. The wire then showed `10.19.67.253.<port> > 224.0.0.251`.
- **Unresolved: no answers to the true `.253` source (11:02:26–11:02:43).**
  With the robot on (enabled 11:02:29–38), one-shot queries from `.253`
  drew no answer from either Limelight, the roboRIO or the radio. The
  roboRIO sent one ARP `who-has 10.19.67.253` and got a reply, but no UDP
  followed. Counter-evidence: at 10:50 the same reflector socket's queries,
  rewritten to `.254`, were answered. The robot powered off at 11:03:35
  (`Robot dropped off the field radio`), so this is not conclusive. A
  watcher (`%TEMP%\claude-mdns-probe\wait-and-test.sh`, results in
  `results.txt` there) reruns `.253` vs `.254` once the roboRIO is back.
- When probing, run each `python3 -` in its own `ssh`: a second one in the
  same command finds stdin already drained and silently does nothing.
- `br-slot1` showed 57 members of 224.0.0.251 in `/proc/net/igmp`
  (`br-slot2` 35, …), which looks like leaked memberships. Logged in
  ISSUES.md; not part of this fix.

Probe used (read-only; nothing written on steamboat):
`ssh steamboat 'python3 - 10.19.67.254 limelight-front.local' < probe.py`
(the script lives in `%TEMP%\claude-mdns-probe\probe.py`).

## Plan / steps

1. **networkManager** — `stationMdnsIp(station, team)`. Ensure the /32 is
   present on every team bridge (including the "unchanged team" skip path,
   so the first deploy adds it **without** tearing down `.254`). Remove it on
   teardown and keep it in the stale-address sweep. Arping before adding;
   skip on conflict.
2. **subnetScanner** — drop pFMS's own addresses from fping results.
3. **mdnsReflector** — per-station legacy-unicast sockets; answers are
   attributed per station; fall back to the team path when a socket can't
   bind. Tests.
4. **teamChecker** — mDNS checks use the station's address with
   legacy-unicast queries.
5. Typecheck, tests, commit. **Deploy only with the user's go-ahead**
   (1967 is on the field).
6. After deploy: verify `ip -4 addr` shows the /32 on team bridges; probe
   or tcpdump a laptop's `limelight-front.local` lookup.

## Progress log

- [x] Root cause found and confirmed on steamboat (read-only)
- [x] Verified responders: legacy unicast works for radio, roboRIO, Limelight
- [x] Step 1 networkManager — plus `ensureMdnsAddresses()` at graceful
      restart (index.ts), since a reload doesn't rerun the network config
- [x] Step 2 subnetScanner
- [x] Step 3 mdnsReflector + tests (bind failures retried every 30 s)
- [x] Step 4 teamChecker (robot tester keeps the multicast path)
- [x] Step 5 typecheck, 881 tests, prettier; committed `20242ce`, side
      issues logged in ISSUES.md (`34e9ec4`)
- [x] Related, same visit: the team page showed "Driving" from the route
      preference it sets on load, which hid both Drive buttons and linked
      nothing. Now it reads the drive session for the browser's IP
      (`useMyDriveStation`). Same for `/route` and the station panel.
      `a4623c9`. The load-time route stays: it gives non-DS devices mDNS.
- [x] Step 6a deployed `cf5f85c` at 10:48. Drive session and DNAT restored;
      `.253/32` added. Masquerade bug found; hotfix `add1ce6` deployed 11:02
      (pushed as part of `02b4658`, with another session's commit on top).
- [ ] Step 6b ← current: prove `.253` one-shot queries are answered on a
      live robot (the watcher). If they aren't, find why and fix it within
      the one per-station path. The user doesn't want an old/new split.
- [ ] Step 6c: on each 1967 laptop, the team page shows "This laptop
      drives <robot>", the other robot has a Drive button, and Limelight
      names resolve.

## Open questions for the user

(none open: the user chose one system for everyone, proven on a live
robot, over reverting or a hybrid. 2026-10-12)

## Things not to do

- Don't use `.254` as the mDNS source for unicast answers: the DNAT eats
  them.
- Don't re-run the full station teardown to add the new address. It
  removes `.254` and disrupts a live robot.
- Don't disable IPv6 or touch the radio as part of this.
- Don't add a second mDNS path for "normal" teams (no hybrid). Fix the one
  per-station path.
- Don't commit from the main checkout while another session's half-done
  work breaks the typecheck. Commit from a clean temp worktree
  (`%TEMP%\pfms-hotfix`) and move `master` with `git update-ref`.
