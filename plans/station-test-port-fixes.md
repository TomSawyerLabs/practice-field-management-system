# Station test port and robot tester fixes

## Goal

Fix four `ISSUES.md` entries, one commit each, on `issues/station-test-port`:

1. No button starts a firmware update from station test port mode
2. `/test` progress bars keep animating after the operation ends
3. Robot checks keep running during a radio configure or firmware update
4. Robot tester can't complete a lease on dhcpcd 10.0.x, without breaking steamboat's 10.1.0

## Environment

- dhcpcd lab (scratch, not committed): WSL Ubuntu, `unshare -Urnm`, a veth pair with a
  scriptable Python DHCP server in its own network namespace. Real binaries: Ubuntu's
  10.0.6, Debian's `dhcpcd-base` 1:10.1.0-8 (steamboat's package, from
  snapshot.debian.org) and 10.5.2.
- Browser harness (scratch, not committed): the real `src/index.ts` with `DRY_RUN=1` and a
  loopback `RADIO_URL`, Vite, and a private headless Chrome over CDP. A preload locked
  `fetch` to loopback plus an in-process fake radio, and rejected everything else, reads
  included. It lifted `DRY_RUN` only for the synchronous start of the two operations, and
  faked the port VLAN and the DHCP lease, which need Linux.

## Decisions

- **`--reboot 2`.** See the table below. 0 and 1 fail on 10.0.x, and the default of 5 costs
  11 s in the case `--reboot 0` was added for.
- **`stopChecking()` abandons a check in flight**, using a run counter, rather than each
  caller guarding. That also covers link-down and `stop()`, which had the same race.
- **The phase is `ready` during an operation.** `checking` would be untrue, and `complete`
  claims the old results are current and also triggers the station's WPA key check.
- **`--reboot` is not chosen by version.** One value that works everywhere means no version
  probe to maintain.
- **`FirmwareUpdateDialog` is shared** by `/test` and the station card.

## Findings

- `--reboot 0` came from e60acc1 ("Fixes 30s delay when radio changes subnet"), so a
  replacement had to be tested on a radio that changed subnet, not only on a fresh lease.
- 10.0.6 `dhcp_request()` arms `dhcp_requestfailed` with `ifo->reboot`. 10.1.0 uses
  `ifo->request_time`, default 180 s, and skips the timer at 0.
- Results in the lab, in seconds to an address, each capped at 15 s like a real attempt:

| dhcpcd, `--reboot` | Fresh | Same radio | New subnet, NAK | New subnet, silent | 1.5 s ACK |
| ------------------ | ----- | ---------- | --------------- | ------------------ | --------- |
| 10.0.6, 0          | none  | none       | none            | none               | none      |
| 10.0.6, 1          | 5.1   | 5.7        | 6.8             | 7.8                | none      |
| 10.0.6, 2          | 6.1   | 6.4        | 5.9             | 9.9                | 7.5       |
| 10.0.6, default    | 4.8   | 5.6        | 7.5             | 11.0               | 7.6       |
| 10.1.0, 0          | 7.5   | 6.5        | 6.8             | 5.8                | 7.1       |
| 10.1.0, 1          | 5.5   | 7.0        | 5.9             | 7.5                | 7.7       |
| 10.1.0, 2          | 6.2   | 5.4        | 6.5             | 8.5                | 9.0       |
| 10.1.0, default    | 6.3   | 5.7        | 4.7             | 11.0               | 8.0       |
| 10.5.2, 2          | 6.4   | 5.5        | 7.1             | 9.7                | 7.5       |

- 10.0.6 with `--reboot 0` wrote up to 91,706 lines in one attempt. With no server, every
  version and value timed out cleanly at 11 lines.
- The monitor bugs went past the issue. Firmware updates didn't stop the factory probe,
  didn't refuse to overlap a configure, and left checks off for good after a failure. An
  operation ending after `stop()` restarted dhcpcd and the probe on a port that had gone.
- Python's default encoding here is cp1252. A staging script that read a doc without
  `encoding="utf-8"` turned `→` into `â†’`, and the pre-commit hook then copied that into
  the worktree because the file was partly staged. Nothing landed. Open files as UTF-8, and
  don't partly stage.
- Killing the Chrome launcher left its headless children alive, holding the debug port.
  End it with CDP `Browser.close`.

## Verification

- 17 of 17 headless Chrome checks. On `/test`, a failed bar and a finished one are both
  determinate with no animation. On the station card, Update Firmware shows on a failing
  check, opens the dialog, runs every step with the team kept, one bar and the button off,
  and goes once firmware is current. A rejected upload shows an error, and checks resume.
- The reported bug, Fix during an in-flight check: the panel went from "Running checks" to
  "Robot detected" with Team 1234 and one 30% bar, and reached "Detecting robot" only after
  the configure finished.
- New tests fail on the old monitor where the behaviour changed: the in-flight check, the
  firmware probe and restart, the overlap, and both `stop()` cases.

Not exercised: a real radio, the real `dhcpcd` on a real field port, or steamboat. After the
next deploy, `ps` on steamboat should show `dhcpcd` with `--reboot 2`, and a robot should get
a lease as before.

## Progress

- [x] `/test` progress bars
- [x] Robot checks during an operation
- [x] dhcpcd on 10.0.x and 10.1.0
- [x] Firmware button on the station card
- [x] Browser verification with a fake radio
- [x] Firmware updates always reach an end (found along the way)
- [x] Remove `ISSUES.md` entries
- [x] Full test run (889 pass, 0 fail), rebase, fast-forward master

## Things not to do

- Don't set `--reboot` to 0 or 1, and don't drop it for the default of 5.
- Don't test against field hardware, even in a dry run.
- Don't push or deploy.
