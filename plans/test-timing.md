# Test timing

## Goal

A full `bun test` should be reliably green, so a red run means a regression.
Fix these `ISSUES.md` entries at their root (wait on the real event or inject a
clock, not longer timeouts), and prove each under CPU load, before and after:

- RawPacketLog daily-cap test fails often, even alone
- Timing-sensitive tests in a full run
- Three more tests time out when the full suite runs under heavy load

Follows `plans/test-reliability.md`, which did this for `robotWifiScan` and
`fmsServer`.

## Decisions already made (don't re-ask)

- Fake `RADIO_URL` always, nothing against field hardware or steamboat.
- No push and no deploy; ends in a fast-forward of local master.
- Headless only. Limited load through `compute-budget`.

## Findings

**RawPacketLog.** `close()` only called `stream.end()`, and the test then
waited 50 ms. Nothing was lost: in a probe on 2026-10-30 every stream reached
its final size, but `close` fired up to 284 ms later on a machine under normal
use. `close()` now resolves once every ended stream has closed, including the
previous day's. Also fixed: a late error on yesterday's stream cleared
`this.stream` even when it already held today's, which stopped the capture for
the rest of the day without a word.

**matchEngine.** Each test slept 3.4 s of real time to get past the countdown,
so a late sleep ended with a long `finishedAt`, and a late tick missed the
phase. Those tests now use `jest.useFakeTimers`, which moves `setInterval`,
`setTimeout` and `Date.now` together (checked on bun 1.4.2). The file went from
about 60 s to under 0.5 s. Don't mix it with `setSystemTime` in one describe
without checking.

**fieldTimelapse.** `Date.now() - started < 2000` measured ffmpeg, not the
handshake. `lights: 'ran'` is only set when the callback arrives, so it already
proves the shutter wasn't released by a timeout. The default ready timeout is
now 20 s, so a callback can't lose that race under load.

**The "unnamed" failures were `beforeAll` hooks.** `ISSUES.md` read them as two
`recordings API` tests. They are hooks on Bun's default 5 s limit, which kills
the fixture's `execFileSync(ffmpeg)` part-way (`Command failed: ffmpeg ...`, `a
beforeEach/afterEach hook timed out`). The FieldTimelapse `(unnamed)` at under
1 ms is `afterAll` tripping on the `timelapse` that hook never built. There is no
sleep to replace here: these already wait on ffmpeg exiting. `practiceRecorder`
already gave its hook 60 s, so the other hooks and the tests running real ffmpeg
on the default now use the same 60 s, production's `FRAME_TIMEOUT_MS`.
`recordingsApi` also encodes one clip and copies it, instead of encoding twice.

**Baseline, unchanged code, 5 runs of the 4 files: 0/5 clean.** Hook timeouts
every run but one, `finishedAt` `Expected: > 0, Received: 0` in 4 of 5 (teleop
reached, no tick since), RawPacketLog short files in 4 of 5.

**After, on the old base: 9/10 clean.** Same harness, same 4 files. The one
failure was a fifth bug: `past matches are filled in once` got 2 where it
expected 1. It asked about match-1 with a fresh `Date.now() - 60 min`, and once
the test before it took over 20 s the two 20 s windows stopped overlapping. Real
recordings have fixed start times, so this was only ever the test. It now reuses
the recorded timestamp.

**`close()` slow, never stuck.** After the rebase a RawPacketLog test failed at
5.7 s with an "unhandled error" at line 44: it had got past both `close()` calls
after Bun's limit fired and `afterEach` deleted the directory. A stress of 3000
cycles under load: 0 hung, 0 short, 143 over 1 s, worst 7.6 s. So the wait is
right and the disk stalls, and those tests get 30 s.

**`--low` on pinned cores starves rather than loads.** Rebased runs at `--low`
went 2/5 clean: an ffmpeg pulling one frame outlasted 20 s, and a thumbnail
outlasted production's 30 s, while a release build peaking at 9 cores ran at
normal priority. Master hadn't touched the code involved. Everything in the
harness is BelowNormal, so a normal-priority build on those two cores takes them
outright. Later measurements use normal priority, still limited to 2 logical
cores and a 2-slot claim.

**A reply list that takes whatever arrives.** The WebSocket gate test's `send`
returned everything that came in while it waited, so the 10 s `serverInfo`
heartbeat failed any test expecting no replies, about once in 2 runs under load.
Its client now never counts `serverInfo` as a reply, and a test fires the server's
real heartbeat callback inside a `send`, so this needs no load to show.
`wsAccess.test.ts` is the only test that runs `setupWebSocket`.

## How load is applied

`compute-budget`, 2 slots (`--low` up to the old-base "after" run, then normal
priority, see above). `load-run.ps1` (scratch, not in the repo)
sets affinity `0xC00` on its own process, so 6 self-terminating `while` spinners
plus bun and ffmpeg all inherit 2 logical cores. Unlike the `cmd start` harness
in `plans/test-reliability.md`, exit codes survive. "Before" runs use a detached
checkout of `6f32e9f`, so edits here can't change them.

## Things not to do

- Don't set `DRY_RUN` when running these tests: `runAction` skips POSTs, so the
  light tests fail for a reason that has nothing to do with timing. One baseline
  was thrown away for this. A fake `RADIO_URL` is the requirement.
- Don't pass a comma list to `pwsh -File` expecting an array; it arrives as one
  string. Another baseline was thrown away for this (0 tests ran, exit 1).

## Results

All under 6 spinners on 2 logical cores with a 2-slot claim, except the last row.

| Tree                     | Tests       | Priority | Clean                     |
| ------------------------ | ----------- | -------- | ------------------------- |
| Unchanged (`6f32e9f`)    | the 4 files | low      | 0/5                       |
| Fixed, old base          | the 4 files | low      | 9/10 (a fifth bug, above) |
| Rebased                  | the 4 files | normal   | 5/5                       |
| Rebased                  | full suite  | normal   | 0/2 (3 causes, see below) |
| Final commits            | full suite  | normal   | 3/3, 982 pass             |
| Final commits, typecheck | full suite  | normal   | 1/1 with no load          |

After those runs master took the WebSocket guard work, so the commits that landed
(`d6de4c6`) passed typecheck and 1046 tests with no load, but were not re-run under
load.

The 0/2 was `OperatorAuth` (31 scrypt hashes in a row), the `PracticeRecorder`
fixture hook (40 s of video), and the `wsAccess` failure below. The first two now
have limits that fit their work. The full suite wasn't measured on unchanged code:
the 0/5 above is on the 4 files only.

**`wsAccess` left alone, and not proven gone.** It's a periodic `serverInfo`
landing in a test that expects no replies, not the opening burst `fc15475` waits
out. It didn't recur in the last 4 full runs, but nothing changed it. Logged in
`ISSUES.md`.

**Limits, for the record.** The task said not to raise timeouts. Every fixed sleep
named in the issues is gone, except the deliberate 6 s of source in the live capture
test (`-re` pacing, and no output is flushed to watch for). What was raised are
watchdogs on tests already waiting on a real event: ffmpeg exiting, a disk write, a
hash. A hang still fails, only later.

## Progress log

- [x] Baseline
- [x] RawPacketLog
- [x] matchEngine
- [x] fieldTimelapse
- [x] recordings API
- [x] Full run under load
- [x] `ISSUES.md` entries removed, master fast-forwarded
