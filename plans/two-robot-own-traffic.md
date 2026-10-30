# Two robots of one team: pFMS's own traffic, and the IGMP counts

## Goal

Close the ISSUES.md section "Two robots of one team". When one team is on two
stations, the Network page and team checks for each station must describe the
robot on that station. Also find out why steamboat's bridges showed dozens of
members of 224.0.0.251. mDNS was solved in `plans/two-robot-mdns.md`; packet
capture attribution in `6e290fb`.

## Environment / context

- Each station has a bridge `br-slotN`. A team's station holds `10.TE.AM.254/24`
  on it, so a duplicated team has two identical connected routes in the main
  table, and an unpinned socket always gets the first.
- Steamboat, read 2026-10-30 9:58 AM PDT (16:58Z), up since 2026-05-05: pFMS
  runs as root on Bun, `net.ipv4.conf.br-slotN.rp_filter` is 2 (loose), curl
  8.12.1, fping 5.1. The Docker image already installs curl.
- Lab: `%TEMP%\pfms-two-robot-lab\lab.sh`, run as root in WSL. Sealed network
  namespaces, two bridges holding the same `.254`, a fake robot on each with
  the same `.1`/`.2` plus one unique address. Nothing has a route out, so it
  can't reach the field. fping there is a copy of steamboat's binary (WSL has
  no route to the apt mirrors).

## Decisions

- **Pin to the interface, as mDNS does.** No extra addresses (see the mDNS
  plan), and no policy-routing rules: `src/routePreferenceManager.ts` is being
  reworked by issues/ip-rule-cleanup, and per-source-port rules would be a
  second routing system.
- **`fping -I` and `curl --interface`.** Both use `SO_BINDTODEVICE`. Node and
  Bun fetch can't bind to a device. Extending the Rust addon would need a
  tagged release before deploy; curl needs nothing new on steamboat or in the
  Docker image.
- **Every team takes the same path** whenever pFMS runs the bridges, matching
  the "one system for every team" decision for mDNS. A duplicated-team special
  case would only be exercised when a team brings two robots.
- **The SystemCore probe is pinned too** (user, 2026-10-30: one team running a
  SystemCore and a roboRIO should work). No system tool sends pinned UDP, so
  `InterfaceSocket` gained `sendTo`, released as addon 0.2.0. It opens on a free
  port rather than 5353: the answer returns on that flow, so the drive session's
  DNAT leaves it alone, and the query keeps the shape 5940's SystemCore answered.
- **curl is an optional tool, not a required one.** Without it the field still
  runs; only the checks on station networks fail, and the setup wizard lists it.

## Findings

- **Lab, unpinned (the bug):** three `curl http://.2/status` all answered
  `{"robot":"first"}`. fping from the host only ever saw the first robot's
  `.14`.
- **Lab, pinned:** `--interface br-slot1` got first, `br-slot2` got second.
  `fping -I` found `.1 .2 .14` on slot1 and `.1 .2 .20` on slot2, including with
  both sweeps running at once.
- **Failure modes (lab):** curl exits 45 on a missing interface and 28 on a
  timeout. `fping -I` on a missing or down interface exits 1 with no hosts,
  which the scanner already reads as "nothing alive".
- **The IGMP counts are orphaned kernel refcounts, not a live leak.**
  - 2026-10-30: `br-slot1..6` Users 56, 35, 19, 18, 12, 10, against 57, 35, 19,
    18, 12, 10 on 2026-10-12. Eighteen days of use barely moved them.
  - All six bridges were down with no sockets on them. `ss` showed only pFMS's
    reflector and bootbob on 5353, and one socket can join a group only once per
    interface, so no open socket can hold 56.
  - Cause: `IP_DROP_MEMBERSHIP` by address after the address has left the
    interface. The kernel finds the socket's entry and removes it, but with the
    address gone it can't find the device, so it skips the decrement and still
    returns success. The old reflector did exactly this:
    `dropMembership(MDNS_ADDR, ip)` when a team left, from `c3a7a66` until
    `e263bcf` replaced it on 2026-10-12.
  - Reproduced in the lab: five cycles of join, remove address, drop, close left
    Users at 5 with no sockets open. Five more cycles that close without
    dropping added none. Nothing in `src/` calls `dropMembership` now, and the
    addon joins by interface index and only ever closes.
  - The counts are harmless and stay until steamboat reboots or a bridge is
    deleted. `br-slot1` reading 56 in future is not a new leak; only growth is.

- **Lab, mixed controllers (2026-10-30):** the real `checkRobotController` and
  addon 0.2.0, with rio+core, core+rio, core+core and rio+rio on two bridges of
  one team. All four named the right controller and the right robot per bridge.
- **Lab trap:** Bun loads an addon only from a `.node` filename. Given a `.so`, it
  parsed the ELF as JavaScript, the load failed, and the probe returned null, which
  looked like a probe bug. Also bind a multi-address fake robot's UDP socket to
  `.2`, or its answer leaves from `.1` and the probe ignores it.
- **Robot tester (2026-10-30), confirmed wrong:** plain requests go to the station
  bridge, not the test port, when the same team is on both. dhcpcd's default metric
  is 1000+ifindex (`man dhcpcd`) and the bridge's connected route is 0. Lab: three
  plain requests answered from the station's robot; only `--interface testport`
  reached the test port's. Writes (configure, firmware) follow the same route.
  Fixed in `plans/tester-interface-pinning.md`.
- **Laptop routing (read from the code, 2026-10-30):** each laptop can choose,
  from the team page's Connect (route preference) or `/route` and Drive.
  Auto-connect used to place a laptop that hadn't chosen on the team's last
  station, moving it off the robot it was reaching. Conntrack has no interface,
  so that was always a guess.

## Addon releases

`bun run build` fetches the addon for the crate's version and fails without that
release, on steamboat and in `release.yml`. So a version bump's tag has to be
pushed, and its `mdns-socket` workflow finished, before master goes out. Pushing
master first fails safely ("nothing deployed"), but the release run fails.

Addon 0.2.0 went out in that order: published 2026-10-30 3:30 PM PDT (22:30Z).

## Progress log

- [x] Read IGMP state and socket owners on steamboat (read-only).
- [x] Prove pinning and reproduce the IGMP orphan in the lab.
- [x] `fping -I` in `src/subnetScanner.ts`; `src/interfaceFetch.ts` and
      `CheckSource` in `src/teamChecker.ts`; curl in `OPTIONAL_TOOLS`.
- [x] Unit tests, docs, ISSUES.md.
- [x] Pinned SystemCore probe: `sendTo` in the addon, version 0.2.0, proven in
      the lab with all four controller pairings. Released and pushed.
- [x] Robot tester checked: wrong robot confirmed, logged, and handed to
      `issues/station-test-port` (user, 2026-10-30).
- [x] Guest laptops of a duplicated team: listed only on the robot they chose,
      and never auto-connected (user approved, 2026-10-30).
- [ ] Not yet seen live: two robots of one team both on. Check the Network page
      for both stations next time. The pinned path runs for every team from the
      next deploy, so ordinary team checks exercise it straight away.

## Things not to do

- Don't call `dropMembership` by address on a station bridge. If a socket has to
  leave a group, close it, or leave by interface index.
- Don't read `/proc/net/igmp` on steamboat as a leak unless the numbers grow.
- Don't add per-station addresses (see `plans/two-robot-mdns.md`).
