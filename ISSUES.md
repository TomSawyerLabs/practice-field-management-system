# Known Issues & Technical Debt

## Per-station firmware/radio configure progress not surfaced in UI

_in progress — issues/station-progress-ui_

When a firmware update or radio reconfiguration runs through station test port mode, the `StationTestManager` receives per-station progress callbacks from the `RobotTestMonitor`. These are currently no-ops — the inline test port mode UI only shows settling banners (derived from `StationTestState.testState.reconfiguredAt`), not step-by-step progress (e.g., "Uploading firmware... 30%").

To add detailed progress UI to the inline view, we'd need:

1. A per-station progress message type (e.g., `StationFirmwareUpdateProgress`) or embed progress in `StationTestState`
2. Corresponding frontend hooks and UI components
3. Care to avoid conflating with the global test monitor's progress handlers

## Operator pages have no login of their own

`/match`, `/staff`, `/csa`, `/test` and `/overview` need no credential, so the
server can only refuse them to Driver Stations (`staff` tier in
`src/wsAccess.ts`, seen 2026-10-30). A team's phone on guest Wi-Fi can open
`/match` and run the field. Matters because the guard stops accidents, not
someone who means it.

## A Driver Station can still clear an e-stop over the WebSocket

`adminClearEStop` and `adminClearFieldEStop` stay `anyone` in `src/wsAccess.ts`
(2026-10-30), left alone while e-stop behaviour is being reconsidered. Clearing
a latch is an operator action, so revisit them when that's decided. The stops
themselves (`adminStopMatch`, `matchAbortCountdown`, `stationPauseMatch`,
`adminStationDisable`, the e-stops) are `anyone` on purpose: a false match must
not block one.

## Timing-sensitive tests in a full run

`src/matchEngine.test.ts` › `a challenge run end to end > finishing a stopwatch
run stops the robot and ends the run` and `src/fieldTimelapse.test.ts` ›
`the callback releases the shutter, and both webhooks are called` each failed
once in a full `bun test` on 2026-10-30 (772 pass / 2 fail); the next full run
was 774/0 and both pass on their own. The first sleeps 3.4 s and expects
`finishedAt` between 0 and 2. Matters because a red full run hides real
regressions.

## Stop buttons

_in progress — issues/audit-unverified_

Both surfaces now ignore keyboard-synthesized clicks on E-Stop and make
A-Stop dominant through the countdown and auto. What's left:

- Deferred decision: mapping Space in the match window to A-Stop during auto
  would match driver muscle memory (and A-Stop self-releases), but global key
  handlers that stop robots can misfire. Not done on purpose.
- The station page's new layout has not been looked at on a real phone.

## Unverified behaviour we depend on

_in progress — issues/audit-unverified_

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

_in progress — issues/audit-unverified_

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

_in progress — issues/audit-unverified_

- Passive robot telemetry (`robotPacketCapture.ts`) only captures packets to
  UDP port 1150. A SystemCore robot talks to its DS mostly over UDP 1110, so
  check whether battery voltage shows up for a SystemCore robot that isn't
  in a match. Unverified on hardware.

## Setup and packaging

_in progress — issues/setup-and-packaging_

- The Linux standalone-binary targets compile but have never been run, and
  the binary has no self-update path (`update.sh` doesn't apply to it).

## A team on two stations: what still isn't per-robot

Own traffic (subnet scanner, radio/roboRIO HTTP) is pinned to the bridge since
`plans/two-robot-own-traffic.md`. These still aren't:

- `probeSystemCore` in `src/teamChecker.ts` sends unicast UDP with dgram, which
  can't pin to a bridge, so it follows the main routing table to one robot. The
  addon's `InterfaceSocket.send` only multicasts, so a pinned unicast send needs
  an addon change and a tagged `mdns-socket` release. Matters when a duplicated
  team's robots are not both SystemCores or both roboRIOs: the wrong robot can
  answer, or a SystemCore can read as "not found".
- `SubnetScanner.scanConntrack` maps a subnet to one station, so for a duplicated
  team every guest host lands on the last station, and `index.ts` auto-connects
  that laptop's route preference there. Conntrack has no interface to go by.
- The robot tester's firmware update and WPA check (`src/firmwareUpdater.ts`,
  `src/stationTestManager.ts`) fetch `10.TE.AM.1` unpinned. Not checked whether
  that goes wrong while the same team is also on a station.

## Subnet scanner ignores DRY_RUN

`src/index.ts` never passes `dryRun` to `SubnetScanner`, so the
`[dry-run] Would fping` branch is dead and a DRY_RUN instance sweeps real team
subnets. Matters because this PC reaches the real field network.

## Flaky under load: robotWifiScan "capitals-only difference is still tested automatically"

_in progress — issues/test-reliability_

`src/robotWifiScan.test.ts` › `the scanner > capitals-only difference is still tested automatically` failed once in a full `bun test` run (2026-10-13, 941 pass / 1 fail, while another thread's uncommitted work was in the tree) and passes on its own (`bun test src/robotWifiScan.test.ts`, 29/29). Looks timing-dependent under the full suite's load. Matters because a red full run hides real regressions.

Also seen: `the scanner > a robot that goes quiet drops off the list` failed once in a full run (2026-10-13, 977 pass / 1 fail, with CPU-heavy binary builds running alongside); 29/29 three times on its own.

## The wizard's FMS address setting isn't applied

_in progress — issues/setup-and-packaging_

`SetupSettings.fmsAddress` (`src/types.ts`) is only read by the setup probe
(`src/index.ts` passes it to `runSetupProbe`). Startup always adds the
hardcoded `10.0.100.5` (`FIELD_CONTROL_ADDRESS` in `src/trunkInterface.ts`),
and the FMS server, syslog and subnet scanner hardcode it too. A changed
setting would make the wizard check for an address pFMS never assigns. Either
apply it everywhere or drop the setting.

## scripts/test-trunk-switch.ts connects its WebSocket before pFMS is listening

_in progress — issues/test-reliability_

`bun scripts/test-trunk-switch.ts` prints `PASS: pFMS came up`, then dies with
`WebSocket connection to 'ws://127.0.0.1:<port>/ws' failed: Failed to connect`
(Windows and Linux, 2026-10-13). It treats the `Radio connected at …` log line
as "up" and connects straight away, but the HTTP/WebSocket server starts
listening later in startup. Polling `/health` until it answers before
connecting works (that's what a standalone boot check did). Matters because the
script is the end-to-end check for live trunk switching and currently can't
report anything past its first line.

## fmsServer tests can still land on a Windows-reserved port

_in progress — issues/test-reliability_

A full `bun test` on Windows (2026-10-13, 950 pass / 2 fail) failed both
`disconnectTeam closes the sessions of one team only` hooks with
`listen EACCES: permission denied 127.0.0.1:28100`. 28100 sits in a Hyper-V
excluded range (`netsh interface ipv4 show excludedportrange protocol=tcp`
listed 28020–28119). The file passes on its own (13/13, twice), so the
"free port" picked by `freeTcpPort()` in `src/fmsServer.test.ts` was free
when probed but refused when the server bound it. Matters because a red full
run hides real regressions.

## Robot tester's "one-shot" dhcpcd stays running

_in progress — issues/robot-tester-dhcpcd_

On steamboat, the dhcpcd the robot tester spawns on `TEST_INTERFACE`
(`eno1.99`) was still running (`dhcpcd: [manager] [ip4] [ip6]` plus its
proxies and `[BPF BOOTP] eno1.99`, parent = the pFMS process) 14 minutes
after the 2026-10-13 13:42 start, with no robot leasing. `startDhcp()` in
`src/robotTestMonitor.ts` runs it with `--oneshot --nobackground --timeout 1`
and retries from its `exit` handler, so it's expected to exit within seconds
when nothing answers. Only one instance, so not a leak, but it means the
tester sits in `dhcp_requesting` on a process that never times out, and the
retry/timeout path described in the code isn't what happens.

## StationStatus `full` mode looks unreachable

`StationStatus` takes a `full` prop that switches on `FreeplayControl`, `MatchPanel`, `StationNetworkCard`, the mDNS table and the full chart set, but its only callers (`SlotGroup` and the deprecated `AllianceStatus` in `frontend/src/components/AllianceStatus.tsx`) never pass it. Worth deciding whether that code is dead and removable.
