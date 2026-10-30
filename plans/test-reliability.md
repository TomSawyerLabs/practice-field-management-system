# Test reliability

## Goal

A red `bun test` should mean a real regression. Fix three flaky or broken
checks from `ISSUES.md` at their root (no retries, no longer sleeps), and stop
built checkouts running tests twice.

## Decisions already made (don't re-ask)

- Side-issues go in `ISSUES.md`, not this diff.
- No e-stop changes. `robotPacketCapture`, `robotLinkWatch`, `robotDropouts`
  and `robotEStopWatch` stay untouched.
- Never against field hardware: fake radio and `DRY_RUN` only.
- No push and no deploy from this thread; it ends in a fast-forward of local
  master.

## Findings

**The double run was `dist/`, not `node_modules`.** The extra files in the main
checkout are `dist\*.test.js`. `tsc` compiles `src/**/*.ts`, tests included, and
`dist/` is gitignored, so a fresh worktree has none. The workspace link in
`node_modules` only reaches the 7 frontend tests, and it exists in every
checkout, so it can't explain a difference. On 2026-10-30 the main checkout
had 45 compiled tests (dated 2026-10-13) and ran 101 files. Reproduced here by
compiling to `dist/` (49 compiled tests): still 56 files and 747 tests with
`bunfig.toml` in place. Excluded in `bunfig.toml` rather than by changing the
build, because a checkout's existing `dist/` keeps its old tests either way.

**robotWifiScan flake.** `flush()` slept 30 ms while a scan and passphrase check
ran through several timers and a PBKDF2. A test that asserted before that chain
ended failed, and `scanOnce()` does nothing while a scan is still running, which
also explains the "goes quiet" failure. `card.busy` covers the chain: it is set
synchronously, and only microtasks run between the scan and the check.

**fmsServer port.** The test found a free port, closed it, and bound it later.
Windows can reserve a range in between, and here the dynamic range is
1024–65535, so most ports are candidates. The tests now bind port 0.

**fmsServer `settle()`.** Load also showed a second race in that file: a fixed
150 ms for the server to read a handshake (`a joined station gets its slot`
failed 1 of 12). Tests now wait on the server's own `message` event. `settle()`
remains only where a test asserts that something did not happen.

**test-trunk-switch.** `Radio connected` logs before the HTTP server listens.
The script now polls `/health`, and stops cleanly if it never answers.

## How load was applied

`compute-budget`: the machine is shared, so 6 `while(1){}` spinners and the test
were pinned to 2 logical cores (mask `0xC00`) with a 2-slot claim, rather than
loading every core. `cmd start /b /wait` loses the exit code, so a run counts as
passing only when it has no `(fail)` line and its summary says `0 fail`.

## Things not to do

- Don't trust an exit code from the pinned-load harness (above).
- Don't change `bun test` to a directory list: `bunfig.toml` also covers editors
  and bare `bun test <filter>` runs.
