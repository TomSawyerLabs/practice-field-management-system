# Pin all robot tester traffic to its interface

## Goal

With a team on a station and on the tester, the tester's plain requests reached the robot
on the station. Reads described the wrong robot, and a configure or firmware update would
have written to a radio on the field. Pin everything the tester sends, on the dedicated
test interface and on a station's test port. Background: `plans/two-robot-own-traffic.md`.

## Decisions

- **`fetchOnInterface` carries the writes too.** It gained `form` for multipart: the file is
  a path curl reads, never an argument, in a quoted `--form` part, and other fields use
  `--form-string` so a value starting with `@` can't name a file. `Expect:` is turned off,
  because curl would otherwise pause a second for a `100 Continue` that fetch never asks for.
- **`fetchOnInterface` enforces DRY_RUN itself** (`dryRunRefusal`, own commit). The backstop
  only wrapped `fetch`, so moving configure and firmware to curl would have removed it. The
  field radio has been wiped by dry runs before.
- **`CheckSource` is `{ ifname }`.** `{ ip }` and `multicastMdnsQuery` had no callers left.
  `routedSystemCoreProbe` stays: `TeamChecker` has no bridge when pFMS doesn't run the
  station networks.
- **`checkFactoryDefault` requires a source.** Only the tester calls it.
- **`rp_filter` is left alone.** pFMS doesn't set it anywhere, steamboat is loose, and strict
  fails safe. Documented in `docs/robot-tester.md`.
- **The firmware step keeps running after a port goes away, and fails.** Before pinning, a
  session stopped mid-update could have reconfigured a station's robot by the route.

## Findings

- `curl --interface NAME` on 8.5.0 binds the device only. The kernel picks the source from
  the pinned route, so a request to `10.TE.AM.1` leaves from the lease even though
  `192.168.69.8` is the interface's first address. `if!NAME` isn't needed.
- Strict `rp_filter=1` on the port drops replies when the bridge route wins: curl exit 28.
  Steamboat, read 2026-10-30 4:00 PM PDT (23:00Z): `all=0`, `default=2`.
- curl says only `Couldn't bind to 'x'` on exit 45, so `fetchOnInterface` now says
  "Network interface x is not available". A port deleted while a request waits gave a
  timeout, exit 28, with a short message.
- Real dhcpcd 10.0.6 installed metric 1004 on ifindex 4, confirming `man dhcpcd`.
- The main checkout's prebuilt addon was 0.1.0, which has no `sendTo`. Lab runs need 0.2.0,
  from the `mdns-socket-v0.2.0` release, or the SystemCore probe quietly finds nothing.
- The pinned mDNS query leaves from the interface's first address, `192.168.69.8`, not the
  lease. Fake robots answer it. A radio holds that subnet, but a real roboRIO doesn't.

## Verification

Sealed namespaces in WSL as root, with no route out: a station bridge holding `.254` with
a fake robot, plus two veth test ports with a fake robot each, all on the same addresses
and each holding `192.168.69.1`. Real `RobotTestMonitor`, `updateRadioFirmware`,
`StationTestManager`, dhcpcd and addon 0.2.0. Scripts were scratch, in
`%TEMP%/stp-thread/pin`. 22 of 22 checks passed:

- Radio, roboRIO, mDNS and factory checks reached the test port's robot.
- `POST /configuration` arrived there, and `POST /firmware` delivered all of a 3 MiB image
  from a path containing `;`, a space and quotes, with the same field names as before.
- The update's own reconfigure arrived there too.
- The WPA check passed against the test port's radio. The station's radio holds a different
  key, so reaching it would have shown a mismatch.
- Two sessions at once each reached their own radio at `192.168.69.1`.
- **The station's robot logged nothing** from all of that. One unpinned `fetch` at the end
  did reach it, which proves the collision was live throughout.

Also passed: the pinned SystemCore probe on a veth, with a SystemCore on the test port and a
roboRIO on the station. HTTP, mDNS and the factory check on a real VLAN sub-interface.

Not exercised: real radios or roboRIOs, a real field port, or steamboat.

## Progress

- [x] Reproduce, and settle the source address and `rp_filter` questions
- [x] Dry-run refusal in `fetchOnInterface`
- [x] Pin the firmware updater, monitor, WPA check and checks
- [x] Multipart upload, and a readable error for a missing port
- [x] Remove `{ ip }` and `multicastMdnsQuery`
- [x] Tests, docs, `hostTools` reason, `ISSUES.md`
- [x] Lab on veth and VLAN
- [ ] After a deploy, on a real robot: does `roboRIO mDNS` still pass? If a real roboRIO
      ignores a query from `192.168.69.8`, the check will say "no response" on a healthy
      robot. That is only a false alarm on a diagnostic, and the fix would be sending the
      query from the lease.

## Things not to do

- Don't call plain `fetch` from tester code. A test in each file fails if it does.
- Don't load the firmware image into an argument.
- Don't test against field hardware. The lab has no route out, and that is why it can write.
