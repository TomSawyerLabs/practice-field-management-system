# Robot tester's dhcpcd never timed out

## Goal

The tester's "one-shot" dhcpcd sat in `dhcp_requesting` indefinitely when nothing
answered, so its timeout and retry path never ran. Make that path actually work.

## Environment

- steamboat: Debian `dhcpcd-base` 1:10.1.0-8, `TEST_INTERFACE` = `eno1.99`
- WSL Ubuntu: dhcpcd 10.0.6, used as a lab
- Lab: `unshare -Urnm` namespace with a veth pair and a small Python DHCP server, so
  no route to anything. `/etc/passwd` is bind-mounted without the `dhcpcd` user,
  because privsep can't drop privileges in a user namespace.

## Decisions

- pFMS times each attempt itself. It keeps `--nobackground`, so it owns the process.
- 15 s per attempt, 5 s between attempts.
- A timed-out attempt logs nothing in pFMS. That's the normal state with no robot.

## Findings

Each of these was hiding behind the first: fixing only the flag would have left
the tester as stuck as before.

1. **`--waitip 4` was parsed as two things.** `--waitip`'s argument is optional, so
   it has to be `--waitip=4`. The `4` became a second interface, which is the
   journal's `4: interface not found` and the `[manager]` process title.
2. **`--timeout` does nothing under `--nobackground`.** `-B` clears
   `DHCPCD_DAEMONISE`, and that bit is what arms `handle_exit_timeout`. In the lab,
   `--waitip=4 --nobackground --timeout 1` was still running after 8 s.
3. **`--timeout 1` would have been fatal if it had worked.** A fresh lease with ARP
   probing took 6.7 s in the lab, and steamboat takes about 1 s to send its first
   DISCOVER.
4. **dhcpcd exits 0 on SIGTERM**, so a timed-out attempt looks like a lease to code
   that only checks the exit code.
5. **A dhcpcd started while another runs exits 0 with no lease** ("sending commands
   to dhcpcd process"). This, and finding 4, reach `handleDhcpSuccess` with no
   address, which used to return without retrying.
6. **`dhcpcd --release eno1.99` can't reach a `--ipv4only` instance**, because the
   family is part of the pidfile and socket name. That explains the "not running"
   lines in the journal. `--ipv4only --release` reaches it and waits for it to exit.
7. **`killDhcp()` ran `--release` alongside the next spawn**, a race that real
   retries would have hit constantly. Exit handlers of killed processes could also
   overwrite `dhcpProc` for the new one.
8. **dhcpcd's syslog output can't be turned off** (`-q` only affects stderr). An
   idle tester adds about 6 journal lines every 20 s, roughly 26k a day, on a host
   that logs about 15k a day and has a 4 GB journal cap.

## Things not to do

- Don't bring back `--timeout`, or pass `--waitip 4` with a space.
- Don't run `--release` on every retry: nothing is running by then, so it's only
  log noise.
- Don't run real dhcpcd tests against the field network; use the namespace.

## Progress

- [x] Reproduce and confirm the causes (lab plus steamboat journal)
- [x] Fix `src/robotTestMonitor.ts`, with tests in `src/robotTestMonitor.test.ts`
- [x] Update `docs/robot-tester.md`
- [x] Log the separate `--reboot 0` problem on dhcpcd 10.0.x in `ISSUES.md`
- [ ] Confirm on steamboat after the next deploy: `ps` shows `dhcpcd: eno1.99 [ip4]`
      coming and going, not `[manager]` staying up
