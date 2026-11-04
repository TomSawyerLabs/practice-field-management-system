# Deploy log

The one place for what pFMS is running, what is waiting to go out, and what each
open thread still owes. Owned by
[pFMS: deploys and recent changes](t3-thread://v1/mcp:b119bf7b-abb9-4a1c-b999-8675a10cf74f).

## Goal

One thread manages every pFMS push and deploy, so nothing goes out by accident
and nothing is lost between threads.

## Environment / context

- Repo: `C:\Users\camer\git\practice-field-configurator`, a shared tree.
  `TomSawyerLabs/practice-field-management-system`. Commit only your own paths:
  `git commit -- <paths>`.
- Ignore the older clone at `C:\Users\camer\git\practice-field-management-system`.
- Steamboat: `http://localhost:9005/health` gives `phase` and `version`. Port
  9005, not 3000. Everything read from steamboat here is read-only.
- Bookings: Google calendar "All Field Events"
  (`bea8g5ik32q9mljspkcmpc5a30brlpd5@import.calendar.google.com`), an import of
  the scheduler, so it can lag. pFMS itself knows nothing about bookings.
- Deploy: `ssh steamboat "cd practice-field-management-system && ./update.sh"`.
  It waits out a live match. See `.claude/skills/deploy/SKILL.md`.

## Rules (from the user, 2026-10-30)

- Pushing `master` or deploying needs the user's yes for that specific push and
  deploy, in this thread. No other thread pushes or deploys without that yes.
- Never force-push.
- Check for an active session before proposing a time, and say what teams notice.
- An addon version change needs its tag and release published before master goes
  out, or `bun run build` fails.
- Don't delete worktrees or branches without the user's yes.

## Deployed

| What                   | State                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Running on steamboat   | `8a6e6d2` (SystemCore low-battery recording limit), 3:38 PM PST (23:38Z) 2026-11-04, user's OK from the SystemCore thread |
| `origin/master`        | `8a6e6d2`                                                                                                                 |
| Last published release | `build-20261031-0000-8a2dd38`                                                                                             |
| Addon                  | `mdns-socket-v0.2.0`, published 3:30 PM PDT (22:30Z) 2026-10-30                                                           |
| Release workflow       | Passed on `8a2dd38`                                                                                                       |
| Checked after deploy   | Health, bundle, journal, NAT rules and on-site `/ws` data, listed below                                                   |

Before the deploy, at 1:08 PM PDT (20:08Z): phase idle, no team on any slot, no DS, no
pending radio commit, all six `eStop` false, no `fieldEStop`, no bookings. The admin
file is copied to `admin-auth.json.bak-before-scrypt-20261031` beside the original on
steamboat, `0600`, identical to the original at the time. It's the only way back from
the scrypt upgrade.

After it: `/health` reports `8a2dd38` and `eStopped:false`. All three stale NAT rules
removed, none left. No `has team X but the config says`, no `Could not check the
bridges`, no radio reconfiguration, nothing matching error or exception in the journal.
From this PC, `ws://pfms.tsl/ws` still delivers `robotDropouts`, `firmwareStoreUpdate`
and `networkStats`, and `https://pfms.tomsawyerlabs.com/` answers 200.

Seen since: the user confirmed the login page from outside (2026-10-31), and
`admin-auth.json` upgraded at 3:46 PM PDT (22:46Z), now `0600`.

Not seen on the real system yet:

- **Real data in those three messages.** The field was empty, so they prove delivery,
  not contents. The `onFieldClient` move gets its real test with teams on.
- **`estop-state.json`.** It doesn't exist until the first stop. The service runs as
  root in a directory that holds its other state, so a write should work, but none
  has happened.

Earlier deploys: `4c4b24a` at 8:42 PM PDT and `c08e287` at 9:02 PM PDT on 2026-10-30.

Those two ran inside
Team 8048's 7:00–10:00 PM PDT booking, with the user's yes. Nobody was there: no team
on a station, no DS connected, no recording that night.

The on-site check sends a read-only `subscribe` to `ws://pfms.tsl/ws` from this PC
(`10.255.0.77`). An outsider gets `This only works from the field network`; this got
its data, both before and after the Caddy `X-Forwarded-For` change went live. A laptop
on the team network hasn't been tried. Look for that refusal next time teams are on.

Earlier on 2026-10-30: `67bb54e` at 5:17 PM PDT, `0586d9a` at 3:33 PM PDT.

## On local master only

Only plan notes. Check `git log origin/master..master`.

## Pending deploy

Nothing waiting.

From this deploy on, `/health` has `eStopped`: a forgotten e-stop blocks `update.sh` for
10 minutes and it gives up; `./update.sh force` overrides it. A restored e-stop can't be
cleared for about 10 s.

### Windows for it

| When                                             | State                             |
| ------------------------------------------------ | --------------------------------- |
| Now to Tue Nov 3 4:00 PM PST (Nov 4 00:00Z)      | No bookings on the calendar       |
| Tue Nov 3 4:00–7:00 PM PST (Nov 4 00:00–03:00Z)  | 5940 and guest 59402              |
| Tue Nov 3 7:00–10:00 PM PST (Nov 4 03:00–06:00Z) | Team 100, and 5940 until 10:00 PM |

Clocks go back Sunday Nov 1, so Tuesday is PST.

## Open threads

The other threads manage their own work (user, 2026-10-30). This log only tracks
what's landed, and raises one only if it gates a deploy.

## Needs a day with teams

- **`ip rule`:** numbers from 32765 down, no duplicates; a graceful reload with teams
  on logs `Restored route preference`. `ISSUES.md` holds the steps.
- **Second laptop (`d2be772`):** the narrowed block has never met real iptables. A
  blocked laptop should still deploy code and see cameras.
- **Guest laptops (`881391a`):** real laptops on a team with two robots.
- **Two robots:** the Network page for both stations, then a real SystemCore with a
  roboRIO. Tue Nov 3 has 5940 and guest 59402, the first chance.
- **Robot tester (`1f50d5a`):** `roboRIO mDNS` still passes with a real robot. Its
  query now leaves from `192.168.69.8`. A failure is a false alarm, never a wrong write.
- **E-stop warnings and `Robot link`:** seen on a real occurrence.
- **DS restart:** next time a team reports one, read the new lines.
- **`plans/field-verification-checklist.md`, checks 1–7.** Check 7 is the important
  one: it times an out-of-match e-stop, and shows whether a DS obeys UDP alone. If
  so, the cut can go. Tonight's journal may already hold a sample:
  `grep 'e-stop:'`.
- **Operator code:** set one on `/admin` → Access next time there's a match.
- **E-stop wait on a real DS:** the cut, the `Waiting for DS` Clear buttons and the
  `e-stop:` timing lines are live, and none has run on a real stop yet.
- **Enabled-through-a-stop warning:** never fed by real robot telemetry.
- **Stops restored after a restart:** a DS going back under field control rests on unit
  tests. So does the cut holding on real packets.
- **`/ws` guard from a team laptop:** on-site is proven from a staff address only.

## Decisions made

- **Field E-Stop clear stays open to anyone on site** (2026-10-30). Logged in
  `ISSUES.md` to revisit later.
- **An e-stop must act within 1 s, 250 ms at best** (2026-10-30).
- **Out of a match, an e-stop cuts the DS's UDP 1110 traffic until the DS is seen to
  stop, and can't be cleared before that** (2026-10-30). The user would prefer no cut
  at all if UDP packets alone stop the DS, so check 7 tests that. pFMS already sends
  them.
- **`28a988b` came over** as `9f483f8`.
- **`/ws` got its own thread,** which has landed its guard.
- **Merged worktrees and branches removed.** `pfms-test-timing/base` stayed for the
  flaky test thread.
- **The batch's merged worktrees removed** (user's yes, 2026-10-31). Their branches
  stayed, because the yes covered worktrees only. All eight are fully on master.
- **No reboot test for steamboat's Caddy container** (2026-10-31). The user will wait
  for a power outage to prove it comes back. There's no bare-metal Caddy: the host's
  was retired by ops `e3e3a09`. After any outage, check pFMS answers through Caddy.
- **Setup-page restart idea dropped:** already solved by `edc128c` and `56185eb`.
- **This site has no host team,** so nobody needs to enter one.
- **Firmware uploads pin known releases** rather than hashing against the `checksum`,
  which is what the radio checks after decrypting, not a hash of the file. An unknown
  version can only be checked by the radio.

## Open questions for the user

None.

## Findings / gotchas

- **The proxy change is not waiting.** Older threads call `trusted_proxies_strict`
  staged. It's live: ops `01d9534`, verified 1:48 PM PDT (20:48Z) 2026-10-30.
- The Second Robot thread's "wrong-radio fix, owner unconfirmed" is resolved: `1f50d5a`.
- `/health` on port 3000 returns nothing, which looks like a dead service. Use 9005.

- A worktree installed by pnpm has newer frontend TypeScript, and its frontend build
  fails on `NudgeSettings.tsx`. Steamboat installs from `bun.lock` and builds fine.
  Run a pre-deploy build in a `bun install` tree, not one of those.
- `curl` in Git Bash on this PC fails HTTPS with `(43) A libcurl function was given a
bad argument`, before any request. It says nothing about the server. Use
  `Invoke-WebRequest`, or `curl` on steamboat.
- **A finished thread can start again at any moment.** On 2026-10-31 the "nothing
  running" check passed 13 s before the user messaged the `/ws` thread, which then
  committed from `issues-ws-internet-guard` while its removal was being prepared. Nothing
  was lost, because its work merged and its run ended, but re-check just before each
  removal, not once before the batch. Its idle session still held the folder, so
  `git worktree remove` emptied it, unregistered it and failed with `Permission denied`.
  That folder and `issues-station-test-port` are empty and harmless, and a further
  message to that thread will find no worktree.
- `git worktree remove` of a full `node_modules` takes minutes per tree on this PC.

## Things not to do

- Don't `git push origin master` while another thread is committing to it.
- Don't push before tagging a new addon version.
- Don't settle a running thread.
- Don't touch `frontend/public/tomsawyerlabs.svg` or `recordings/`.
- Don't touch the stale clone.

## Progress log

- [x] Plans, `ISSUES.md` and threads read (2026-10-30)
- [x] Sound commit traced
- [x] Next deploy's checks run
- [x] Finished threads settled
- [x] `67bb54e` pushed and deployed 5:17 PM PDT (00:17Z Oct 31), checked, release passed
- [x] `28a988b` brought over
- [x] `/ws` thread started
- [x] Merged worktrees and branches removed
- [x] Out-of-match e-stop within 1 s built, landed as `4c4b24a`
- [x] `4c4b24a` pushed and deployed 8:42 PM PDT (03:42Z Oct 31), checked, release passed
- [x] `c08e287` pushed and deployed 9:02 PM PDT (04:02Z Oct 31), checked, release passed
- [x] Next batch built and reviewed, on master at `8a2dd38`
- [x] `8a2dd38` pushed and deployed 1:09 PM PDT (20:09Z Oct 31), checked, release passed
