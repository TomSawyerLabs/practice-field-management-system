# Known Issues & Technical Debt

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

## Admin-page actions the WebSocket accepts from anyone

Seen 2026-10-13 in `src/websocketServer.ts` (~L1450–1490): `createApiKey`,
`revokeApiKey`, `reactivateApiKey`, `deleteApiKey`, `approvePendingDevice`,
`dismissPendingDevice`, `scoreReset` and `portBridgeRequest` run without
checking `adminConnections` / `setupWritesAllowed`. Only the admin page's UI
gate stands in the way, so any page on the field network (a team's laptop on
guest Wi-Fi) could mint a scoring key, revoke the real ones, or reset the
score. Other admin actions (clear the radio, restart, setup writes) are
checked. Needs a pass over every message type to decide which need admin and
which a staff or team page legitimately sends.

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

- The Linux standalone-binary targets compile but have never been run, and
  the binary has no self-update path (`update.sh` doesn't apply to it).

## Two robots of one team

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

## Flaky under load: robotWifiScan "capitals-only difference is still tested automatically"

`src/robotWifiScan.test.ts` › `the scanner > capitals-only difference is still tested automatically` failed once in a full `bun test` run (2026-10-13, 941 pass / 1 fail, while another thread's uncommitted work was in the tree) and passes on its own (`bun test src/robotWifiScan.test.ts`, 29/29). Looks timing-dependent under the full suite's load. Matters because a red full run hides real regressions.

## The wizard's FMS address setting isn't applied

`SetupSettings.fmsAddress` (`src/types.ts`) is only read by the setup probe
(`src/index.ts` passes it to `runSetupProbe`). Startup always adds the
hardcoded `10.0.100.5` (`FIELD_CONTROL_ADDRESS` in `src/trunkInterface.ts`),
and the FMS server, syslog and subnet scanner hardcode it too. A changed
setting would make the wizard check for an address pFMS never assigns. Either
apply it everywhere or drop the setting.

## scripts/test-trunk-switch.ts connects its WebSocket before pFMS is listening

`bun scripts/test-trunk-switch.ts` prints `PASS: pFMS came up`, then dies with
`WebSocket connection to 'ws://127.0.0.1:<port>/ws' failed: Failed to connect`
(Windows and Linux, 2026-10-13). It treats the `Radio connected at …` log line
as "up" and connects straight away, but the HTTP/WebSocket server starts
listening later in startup. Polling `/health` until it answers before
connecting works (that's what a standalone boot check did). Matters because the
script is the end-to-end check for live trunk switching and currently can't
report anything past its first line.

## fmsServer tests can still land on a Windows-reserved port

A full `bun test` on Windows (2026-10-13, 950 pass / 2 fail) failed both
`disconnectTeam closes the sessions of one team only` hooks with
`listen EACCES: permission denied 127.0.0.1:28100`. 28100 sits in a Hyper-V
excluded range (`netsh interface ipv4 show excludedportrange protocol=tcp`
listed 28020–28119). The file passes on its own (13/13, twice), so the
"free port" picked by `freeTcpPort()` in `src/fmsServer.test.ts` was free
when probed but refused when the server bound it. Matters because a red full
run hides real regressions.

## Robot tester's "one-shot" dhcpcd stays running

On steamboat, the dhcpcd the robot tester spawns on `TEST_INTERFACE`
(`eno1.99`) was still running (`dhcpcd: [manager] [ip4] [ip6]` plus its
proxies and `[BPF BOOTP] eno1.99`, parent = the pFMS process) 14 minutes
after the 2026-10-13 13:42 start, with no robot leasing. `startDhcp()` in
`src/robotTestMonitor.ts` runs it with `--oneshot --nobackground --timeout 1`
and retries from its `exit` handler, so it's expected to exit within seconds
when nothing answers. Only one instance, so not a leak, but it means the
tester sits in `dhcp_requesting` on a process that never times out, and the
retry/timeout path described in the code isn't what happens.
