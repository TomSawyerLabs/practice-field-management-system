# Known Issues & Technical Debt

## A second laptop on a robot gets through in gaps

On 2026-10-28, 5:05:44 to 5:09:07 PM PDT (00:05-00:09Z), team 114's second
laptop `10.55.231.82` logged `Blocked duplicate DS` and `Unblocked duplicate DS`
every ~6 s, in step with its TCP flap, while `10.55.150.65` was driving the
robot. `driveSessions.disconnected()` lifts the block when the TCP connection
closes. Matters because the block exists to keep a second DS off a robot, and it
opens each time that DS flaps.

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

Deferred decision, not done on purpose: mapping Space in the match window to
A-Stop during auto would match driver muscle memory (and A-Stop self-releases),
but global key handlers that stop robots can misfire.

## Unverified behaviour we depend on

Each needs a field visit. What to try and what each result means is in
`plans/field-verification-checklist.md`.

- **Re-enable after a DS-side disable (check 1).** `undisable()` clears the
  field's latch and resumes enable packets, but a DS that latched a local Enter
  disable may not follow. There's no clean sample: since telemetry began on
  2026-09-27, every disable followed by a re-enable was a dropped DS or a lost
  robot link.
- **2027 DS stop reporting (check 2).** pFMS can't see a Disable pressed on a
  2027 DS: `dsReportedStatus` only counts a disable after seeing the enabled
  bit, which that DS never sets (0 of 37,736 telemetry rows for team 5940, whose
  e-stop and a-stop bits were never set either). The field would show that
  robot as enabled. Whether the DS signals a stop some other way is unknown.
- **DSes that keep reporting outside a match (checks 3, 4).** pFMS drops a DS
  that streams status while not in a match, so it returns to local control. It
  doesn't always take: 590 drops from 2026-10-09 to 2026-10-28, repeating every
  15 s, including 173 in 43 minutes for one DS of team 2813 on 2026-10-25. Nobody
  has looked at such a laptop, so it isn't known if the team could still drive.

## Depends on things outside this repo

- The balls-counter deployed on sentinel runs from the unmerged branch
  `fix/package-for-latest-uv` (`897046d`, PR #1 open, mergeable, 9 ahead of
  master, as of 2026-10-30), not its master. A `git pull` on master there
  silently breaks match score recording.

## Not started

- The Blue Alliance reporting (from the match-review work) was scoped and
  never begun.

## SystemCore gaps

- pFMS can't read a SystemCore robot's own traffic yet. Since `cb0db29` it
  records UDP 1110 both ways but doesn't decode it, so outside a match there's
  no battery, link or dropout data for these robots. In a match, battery does
  show, because the DS reports it to the field. Waiting on a first capture
  (check 5 in `plans/field-verification-checklist.md`), then a parser:
  `plans/systemcore-robot-capture.md`.

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

## pFMS crashes at startup if the mDNS reflector can't join multicast

With `MDNS_REFLECTOR=true` and no default route, `socket.addMembership(MDNS_ADDR)`
in `src/mdnsReflector.ts` throws `ENODEV: no such device, setsockopt` inside the
`bind` callback. Nothing catches it, so the whole process dies. Reproduced
2026-10-30 in an empty network namespace holding only `lo` and a dummy NIC; adding
a default route makes it start. Matters because the systemd unit only orders on
`network.target`, which doesn't promise a route: a host booting before its network
is ready could crash-loop, and one optional feature shouldn't take the field down.

## Robot tester can't complete a lease on dhcpcd 10.0.x

`dhcpcdArgs()` in `src/robotTestMonitor.ts` passes `--reboot 0`. dhcpcd 10.0.6
(Ubuntu 24.04, seen in WSL) arms its REQUEST timeout from the `reboot` value, so
every offer fails on the spot and it spins on `offered` / `failed to request the
lease` at thousands of lines a second. 10.1.0 (steamboat, Debian) has a separate
`request_time` and isn't affected. Matters because another site on a 10.0.x
distro would get no tester lease and a flood of log lines.

## StationStatus `full` mode looks unreachable

`StationStatus` takes a `full` prop that switches on `FreeplayControl`, `MatchPanel`, `StationNetworkCard`, the mDNS table and the full chart set, but its only callers (`SlotGroup` and the deprecated `AllianceStatus` in `frontend/src/components/AllianceStatus.tsx`) never pass it. Worth deciding whether that code is dead and removable.

## Page header icons are too small to tap on a phone

Seen 2026-10-30 at 320px wide: the status bar's Get Help, Scoreboard and GitHub
icons are 14×14 px and 4 px apart, on every page. Get Help is the one a team
needs when something is wrong.

## No button starts a firmware update from station test port mode

`stationFirmwareUpdateRequest` is handled on the backend and
`sendStationFirmwareUpdateRequest` exists in `frontend/src/hooks/useBackend.ts`,
but nothing calls it. The inline panel on a station card shows firmware progress
now, yet the only way to start an update there is a hand-sent WebSocket message;
users have to go to `/test`, which only drives the dedicated test interface.

## /test progress bars keep animating after the operation ends

In `frontend/src/components/TestPage.tsx`, `RadioConfigureSection` and
`FirmwareUpdateSection` pass `variant={configuring ? 'determinate' : undefined}`
to `LinearProgress`. `undefined` means indeterminate, so a finished or failed
operation shows a looping green or red bar under its result.

## Robot checks keep running during a radio configure or firmware update

Seen with a fake radio on a station test port (2026-10-30): pressing Fix while a
check was in flight left the phase on "Running checks...", and partway through
the reboot wait it dropped to "Detecting robot..." with the team number gone,
before the configure had finished. `docs/robot-tester.md` says both operations
stop the periodic checks. The operation itself still completed.

## RawPacketLog daily-cap test fails often, even alone

`src/rawPacketLog.test.ts` › `stops at the daily cap, and starts again the next day` failed 2 of 3 runs of that file alone on an idle-ish Windows machine (2026-10-30), and once in a full `bun test` (746 pass / 1 fail): `Expected: 176, Received: 24` at line 59. The test's `flush()` calls `log.close()` and then waits a fixed 50 ms. Matters because it turns a full run red on its own.

## Three more tests time out when the full suite runs under heavy load

A full `bun test` in the main checkout on a busy machine (2026-10-30, 1320 pass / 10 fail, 507 s) also failed `FieldTimelapse light handshake over webhooks > the callback releases the shutter, and both webhooks are called` (3.2 s), `a challenge run end to end > finishing a stopwatch run stops the robot and ends the run` (5.1 s) and two unnamed `recordings API` tests (5.5 s). Each passed in less loaded runs. The other 6 failures were the robotWifiScan flake, since fixed. Matters because a red full run hides real regressions.
