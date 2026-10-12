# Known Issues & Technical Debt

## Docs present OFFSEASON AP firmware as supported, for the wrong reason (README fixed)

`docs/setup.md:5`, `docs/network.md:3,62` and
`docs/getting-started.md:91-97` say pFMS works with `PRACTICE` **or**
`OFFSEASON` firmware. `getting-started.md` says `PRACTICE` is recommended
because the AP serves DHCP itself. Per the user (2026-10-12), `PRACTICE` is
**required**: `OFFSEASON` has excessive firewalls. The AP's DHCP on
`PRACTICE` is actually a cost that pFMS has to work around with reverse NAT.
A new field following the docs could flash `OFFSEASON` and get stuck.
Before changing the docs, decide whether the OFFSEASON code paths
(per-VLAN dnsmasq, `docs/internals.md`) stay.

## `setupWebSocket` parameter sprawl

The `setupWebSocket()` function in `src/websocketServer.ts` now has **21 positional parameters**. The call site in `src/index.ts` is nearly impossible to read — you have to count commas to understand which argument maps to which parameter. Adjacent optional callbacks of compatible types make it easy to accidentally swap arguments.

**Fix:** Refactor to accept an options object:

```ts
interface SetupWebSocketOptions {
  radioManager: RadioManager;
  matchEngine: MatchEngine;
  port: number;
  trustedProxyMatcher?: CIDRMatcher;
  // ...
}
```

Every new feature that adds another callback makes this worse. This is the single highest-impact refactor for maintainability of the WebSocket server wiring.

## Global hook redundancy in StationStatus

`StationStatus` renders 6 times (once per station). Each instance subscribes to several global hooks (`useLastLinked`, `usePortBridgeState`, `useLatest`, `useMatchState`, `useNetworkStats`, `useSubnetScan`, `useMdnsActivity`, etc.). Any update to these global states causes all 6 instances to re-render and diff their entire subtree, even if only one station's data changed.

This is the established pattern throughout the codebase and isn't a bottleneck at 6 stations with infrequent updates. But if performance ever becomes a concern, the proper fix would be a React context with per-station selectors — a broader refactor, not a one-off fix.

## Per-station firmware/radio configure progress not surfaced in UI

When a firmware update or radio reconfiguration runs through station test port mode, the `StationTestManager` receives per-station progress callbacks from the `RobotTestMonitor`. These are currently no-ops — the inline test port mode UI only shows settling banners (derived from `StationTestState.testState.reconfiguredAt`), not step-by-step progress (e.g., "Uploading firmware... 30%").

To add detailed progress UI to the inline view, we'd need:

1. A per-station progress message type (e.g., `StationFirmwareUpdateProgress`) or embed progress in `StationTestState`
2. Corresponding frontend hooks and UI components
3. Care to avoid conflating with the global test monitor's progress handlers

## DS-client operator guard is IP-based and UI-only

The guard that blocks `/match` and `/staff` on Driver Station devices
(`frontend/src/components/DsClientGuard.tsx`) compares the browser's IP to
connected DS IPs. Two accepted gaps (user decision 2026-07-24: fine for now):

- **Multi-interface laptops slip through** — a machine wired to the field for
  the DS but browsing over guest Wi-Fi has different IPs per interface and
  won't match. Hardening path: join on device hostname via `hostnameResolver`
  (same hostname on both interfaces), soft-block on hostname match to tolerate
  hostname collisions.
- **No backend enforcement** — the websocket still honors operator/staff
  messages from DS-identified clients; only the UI is blocked. Hardening path:
  compute a per-connection DS flag server-side and reject operator/staff
  commands from flagged connections.

## Stop buttons

Both surfaces now ignore keyboard-synthesized clicks on E-Stop and make
A-Stop dominant through the countdown and auto. What's left:

- Deferred decision: mapping Space in the match window to A-Stop during auto
  would match driver muscle memory (and A-Stop self-releases), but global key
  handlers that stop robots can misfire. Not done on purpose.
- The station page's new layout has not been looked at on a real phone.

## Unverified behaviour we depend on

Each of these is asserted by our code but was never confirmed against real
hardware or a real deployment:

- **Out-of-match release.** A DS that isn't in the match gets a status-2
  reply, meant to return it to local control. If a DS instead treats status 2
  as "connected, waiting", this parks every freeplay DS rather than freeing
  it. Default-on. `FMS_TCP_REPLY_STATIONS` (assign a real slot instead) has
  never been bench-tested either.
- **Re-enable after a DS-side disable.** `undisable()` clears the field's
  latch and resumes enable packets; whether a DS that latched a local Enter
  disable follows it back to enabled is untested.
- **2027 DS stop reporting.** Neither a Disable nor an E-Stop pressed on the
  2027 DS has been observed reaching pFMS.
- **Public match links need a proxy change.** The post-match QR and
  `/matches/<token>` links only work from outside once the reverse proxy
  rewrites `/matches/*` and exempts `/api/public/*` from its access check.
  That change was staged in the ops repo; there's no record it was applied.

## Depends on things outside this repo

- The balls-counter deployed on sentinel runs from the unmerged branch
  `fix/package-for-latest-uv` (PR #1 open), not its master. A `git pull` on
  master there silently breaks match score recording.
- Score review and match recording rely on fields in the `/ws/scores`
  broadcast (`phase`, `matchId`, `subPeriod`, `inactiveGoalAlliance`, pause
  spans) — see `docs/scoring.md`. Don't rename or drop them.

## Not started

- The Blue Alliance reporting (from the match-review work) was scoped and
  never begun.

## SystemCore gaps

- Passive robot telemetry (`robotPacketCapture.ts`) only captures packets to
  UDP port 1150. A SystemCore robot talks to its DS mostly over UDP 1110, so
  check whether battery voltage shows up for a SystemCore robot that isn't
  in a match. Unverified on hardware.

## Setup and packaging

- No "restart pFMS" action: settings read at startup only tell you to
  restart.
- The Linux standalone-binary targets compile but have never been run, and
  the binary has no self-update path (`update.sh` doesn't apply to it).

## Two robots of one team

- A laptop of a two-robot team whose drive session lapses (DS quiet for
  20 s, e.g. 1967-Elsa's laptop at 12:11 on 2026-10-12) doesn't get its
  robot back when the DS returns: with two robots pFMS can't guess, so the
  team has to press Drive again. Remembering the laptop's last robot, and
  re-claiming it if nobody else drives it, would avoid that
  (`src/driveSessions.ts`, `heard()`).
- pFMS's own traffic to a duplicated team's subnet (subnet-scanner fping,
  team-check HTTP to the radio/roboRIO, robot packet capture lookups) follows
  the main routing table, which holds one connected `10.TE.AM.0/24` route per
  bridge, so it all goes to one of the two robots. The Network page and team
  checks for the other robot show the first robot's devices. Seen with 1967
  on 2026-10-12. mDNS is fixed separately (per-station addresses, see
  `plans/two-robot-mdns.md`).
- `/proc/net/igmp` on steamboat showed 57 members of 224.0.0.251 on
  `br-slot1` (35 on slot2, 19, 18, 12, 10 on the rest) on 2026-10-12. A
  handful is expected, so memberships are probably leaking (team-check mDNS
  sockets, or reflector re-joins). Check with `cat /proc/net/igmp` over time.
