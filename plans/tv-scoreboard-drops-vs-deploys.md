# Does deploying pFMS crash the TV scoreboard?

## Goal

Cameron reports (2026-09-18) that "almost every time we update pFMS, the
scoreboard crashes/resets", and asks whether the browser side can be made to
survive a backend restart without crashing or running out of memory — or
whether something else is going on. Establish which, from logs, before
changing anything.

## Short answer

**Deploys are not what kills the scoreboard.** Over the last week the Cast
receiver on the Warehouse TV rode through every deploy it was up for. What
does kill it is the TV's own Android process management (app freezer and
empty-process trimming on a 1.8 GB TV that is deep into swap), on its own
schedule — three times on 2026-09-18 alone, none of them at a deploy time.
The deploy just happens to be when someone looks at the TV.

## Environment / context

- TV: "Warehouse TV", TCL G10 4K Google TV, Android 12 (SDK 31),
  **wired**, `10.255.11.11`, adb over TCP on `:5555`
  (`adb connect 10.255.11.11:5555`). Uptime 120 days on 2026-09-18.
- TV memory: 1.8 GB total, ~50 MB free, ~340 MB of 650 MB swap in use.
  `ro.config.low_ram` unset, but ActivityManager is running with
  `CUR_MAX_CACHED_PROCESSES=16`, `CUR_MAX_EMPTY_PROCESSES=8`,
  `use_freezer=true`, `freeze_debounce_timeout=300000`.
- The TV's load average of ~25 is **not** CPU load: it is a dozen Realtek
  SoC driver kernel threads permanently in D state (`rtkaudio_flow_t`,
  `vsc_tsk`, `localDimmingDem`, …). CPU is ~93 % idle. Ignore it.
- The TV reaches steamboat over IPv6 using **temporary (privacy) addresses**
  that rotate; on 2026-09-18 it was `2600:1700:459:8a1f:cdd7:8fed:c7fe:4e07`
  (earlier `9556:…`, `4dd8:…`, `3957:…`, `940:…`). `adb shell ip -6 addr`
  lists them all. Two other regular `/ws/scores` clients:
  - `2600:1700:459:8a1f::3b3` — MAC `74:56:3c:4c:18:4f` (Gigabyte board):
    a PC with the scores page open around the clock. Reconnects ≤2 s after
    every deploy, never died on its own.
  - `…:95d2:21b1:603c:4646` — MAC `1c:69:7a:0d:50:32` (Dell): the laptop
    Cameron casts from. Its `/ws/scores` sessions are the sender page,
    open for seconds.
- Logs that answered this:
  - Deploys: `journalctl -u practice-field-management-system.service`
    (`systemd[1]: Started …` lines).
  - Receiver sessions: Caddy `/var/log/caddy/pfms.log`, filter
    `"/ws/scores"`; `ts` is the close time, start = `ts − duration`
    (memory: pfms-caddy-log-and-monitoring-gaps).
  - **Why the receiver died:**
    `adb shell dumpsys activity exit-info com.google.android.apps.mediashell`.
    This is Android's persistent per-process exit history (reason,
    subreason, importance, timestamp) and survives the tiny 64 KiB logcat
    ring buffer, which only covers the last ~30 min on this TV.

## Findings

### Deploys vs receiver sessions (Caddy log × journal)

| Deploy (backend `Started`) | TV receiver socket at that moment                                     | Outcome                                          |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 09-15 13:56:45             | up since 09-13 17:43                                                  | reload, back in 1 s, then up 22 h to next deploy |
| 09-16 12:21:34             | up since 09-15 13:56                                                  | back in 2 s, up to next deploy                   |
| 09-16 12:34:04 / 12:43:10  | stale-deploy reload loop (fixed by 3738c75); TV reloading every ~40 s | recovered 12:43, up 24 h to next deploy          |
| 09-16 12:50:25             | up since 12:43                                                        | back in 1 s, up 24 h to next deploy              |
| 09-17 13:16:29             | up since 09-16 12:50                                                  | reload took 5 s, then up until 16:08             |
| 09-18 12:11:53             | **not connected** (died 06:03)                                        | n/a                                              |
| 09-18 17:59:32 + 17:59:37  | **not connected** (died 16:47)                                        | n/a                                              |

So five deploys with the receiver up, five survivals. The reconnect logic
in `frontend/src/hooks/useBackend.ts` (1 s retry, 30 s silence watchdog,
version-mismatch reload capped at 3 per 5 min) is doing its job.

The 09-17 16:08:24 drop was not a deploy either: every client dropped in the
same second and reconnected within 2 s — a reverse-proxy restart, not pFMS.

### When the TV receiver actually died (and why, from the TV itself)

`dumpsys activity exit-info` for `com.google.android.apps.mediashell`
("Chromecast built-in"; the receiver page runs in its
`:cast_browser_process` child) on 2026-09-18:

| Time        | What died                                             | Android's reason                                          |
| ----------- | ----------------------------------------------------- | --------------------------------------------------------- |
| 06:03:56    | `cast_browser_process` (importance 100 = foreground)  | ISOLATED NOT NEEDED — its parent process had gone away    |
| 06:33–10:24 | main `mediashell` process, 6 times while idle         | FREEZER BINDER TRANSACTION ×5, TOO MANY EMPTY PROCS ×1    |
| 14:54:27    | `cast_browser_process` (foreground) + GPU + renderer  | **TOO MANY EMPTY PROCS** ("empty #9")                     |
| 15:46:58    | main `mediashell` (as Cameron's cast request arrived) | "Sync transaction while in frozen state" — then restarted |
| 16:47:05    | `cast_browser_process` (foreground) + GPU + renderer  | ISOLATED NOT NEEDED — parent gone                         |

These line up exactly with the Caddy receiver-socket ends (06:03:57,
14:54:28, 16:47:06). Deploys were at 12:11 and 17:59.

The mechanism: during a cast, Android treats the _main_ `mediashell`
process as cached/empty (the visible page lives in the child browser
process). A cached process on this TV gets frozen after 5 min
(`freeze_debounce_timeout`) and is one of only 8 empty processes allowed.
When the freezer kills it on a sync binder call, or the empty-process
trimmer evicts it as "empty #9", every child dies with it — including the
foreground receiver. The 2026-09-13 fix (screensaver off) removed _one_
way the receiver got backgrounded; it did not touch the freezer or the
trimmer, which is why the drops continue with different subreasons.

`dumpsys activity lmk` counts 468 low-memory kills since boot, 27 of them
at foreground-ish oom_adj ≤100. The TV is chronically out of memory.

### Things checked and ruled out

- **Frontend memory growth across restarts** — nothing accumulates on the
  public `/ws/scores` socket. The server sends only `matchState` and
  `serverInfo` on connect (no history array), and the receiver's Chromium
  processes were 40–70 MB PSS when killed, not ballooning.
- **The version-mismatch reload** — it is a real page reload on every deploy
  (the git hash is baked into the bundle, so it fires even for backend-only
  changes), but on this TV it completed in 1–5 s every time and the
  receiver came back. It is a cost, not the cause. See options below.
- **pFMS-side network events** — the 06:00 daily radio clear precedes the
  06:03 death by 4 min, but the `::3b3` client on the same LAN did not
  drop, and the TV's own exit record says the receiver died because its
  parent process went away.
- **Matches** — no match was running at 06:03, 14:54 or 16:47 (last matches
  ended 02:15 on 09-18).

## Decisions already made (don't re-ask)

- Do not change TV settings or reboot it without Cameron's per-change OK
  (same rule as the 2026-09-13 screensaver change).
- Don't disable IPv6 to "fix" the TV's path (memory: ipv6-stays-on).
- ADB is fine for _diagnosis_ on this field, but is not the shipping control
  path (plans/tv-display-control.md).

## Options (not built — reported for Cameron to pick)

TV side (each needs an explicit OK, and the TV is idle at the home screen
as of 18:45 on 09-18):

1. **Reboot the TV.** 120 days up, swapping, 468 LMK kills. Cheapest
   thing that will help for a while.
2. **Turn off the app freezer:**
   `adb shell device_config put activity_manager_native_boot use_freezer false`
   then reboot. Removes the "frozen state" kill, which was 6 of the 9 main-
   process deaths today. Google's remote config can reset `device_config`
   values; `device_config set_sync_disabled_for_tests persistent` pins them.
3. **Raise the cached/empty process caps:**
   `adb shell settings put global activity_manager_constants max_cached_processes=32`
   (empty cap is half of it). Trades off against swap on an already-starved
   TV, so less clear-cut than 2.
4. The long-term answers already planned: a wired HDMI kiosk
   (ops `steamboat-kiosk-display.md`) or the pFMS TV-control work
   (`plans/tv-display-control.md`) that can relaunch the cast itself.

pFMS side (worth doing regardless, none of them fix the TV):

5. **Tell someone when a registered cast display drops.** The server already
   tracks receivers per socket (`castReceivers` in `websocketServer.ts`);
   a Slack line to pfms-support when one closes and does not re-register
   within ~30 s turns "we noticed at the next deploy" into "we noticed in
   a minute". Small.
6. **Only reload on deploys when the frontend bundle actually changed.**
   Today the git hash is inlined via `__BUILD_VERSION__`, so every deploy
   reloads every screen. Moving the build id into the served HTML (a
   `<meta>` from a Vite `transformIndexHtml` hook) and comparing the fresh
   HTML's module `<script src>` against the running page's would skip the
   reload for backend-only deploys. Medium; reduces churn on every field
   screen, and each reload is a memory spike on this TV.
7. **Show "reconnecting…" on the scoreboard** once the socket has been down
   a few seconds, so a backend outage looks different from a dead TV.
   Small.

Side note: on 09-18 the backend was deployed twice five seconds apart
(17:59:32 and 17:59:37), which reloads every screen twice. Two deploy runs
overlapped — `update.sh` had no lock. Fixed 2026-09-19 (below).

## Done (2026-09-19)

- **Option 2 applied to the TV, with Cameron's OK, at 12:20:**
  `device_config put activity_manager_native_boot use_freezer false`, pinned
  with `device_config set_sync_disabled_for_tests persistent`, then
  `adb reboot`. Read back after boot: `dumpsys activity settings` shows
  `use_freezer=false`; screensaver settings from 09-13 survived. The reboot
  also cleared 120 days of swap (MemFree 50 → 106 MB right after boot).
  **Verify over the next days:** `dumpsys activity exit-info
com.google.android.apps.mediashell` should stop showing
  `FREEZER BINDER TRANSACTION`; the `TOO MANY EMPTY PROCS` kills (option 3
  territory) may remain.
- **Deploy lock + same-commit skip** (`update.sh`, `/health`): a second
  `update.sh` now waits on `flock` (`/tmp/pfms-update.lock`, fd 9 held
  across the script's self re-exec), and once it runs it skips the backend
  reload if `/health` already reports the commit being deployed — files
  are still synced, so the 09-16 stale-frontend case can't hide behind it.
  `force` overrides both the match guard and the skip. Takes effect on
  steamboat the first time the new script is pulled (the first run still
  reloads, because the old backend's `/health` has no version).

## Progress log

- [x] Deploy timeline from the journal (8 days)
- [x] Receiver session timeline from the Caddy log (since 09-12)
- [x] Identified which client address is the TV (`adb shell ip -6 addr`)
- [x] TV exit history for the Cast receiver (`dumpsys activity exit-info`)
- [x] TV process-management settings and memory state
- [x] Ruled out frontend memory growth, the reload, matches, and pFMS
      network events as the cause
- [x] Cameron picked: freezer off (option 2) — applied and verified
- [x] Deploy lock + same-commit reload skip built (not yet deployed)
- [ ] Deploy the lock change to steamboat
- [ ] Watch the TV's exit-info for a few days to see what kill reasons remain
- [ ] Options 3, 5, 6, 7 — still open for Cameron

## Things not to do

- Don't reason from the TV's logcat about deaths more than ~30 min old —
  the ring buffer is 64 KiB. Use `dumpsys activity exit-info`.
- Don't treat the TV's load average as a CPU problem; it is D-state driver
  threads.
- Don't remove the version-mismatch reload cap or the reload itself — the
  reload is what keeps every screen on the deployed bundle; the stale-
  deploy loop of 09-16 is what the cap prevents.
