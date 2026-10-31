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

| What                      | State                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| Running on steamboat      | `67bb54e`, graceful reload 5:17 PM PDT (00:17Z Oct 31) 2026-10-30             |
| `origin/master`           | `67bb54e`                                                                     |
| Last published release    | `build-20261030-1647-67bb54e`                                                 |
| Addon                     | `mdns-socket-v0.2.0`, published 3:30 PM PDT (22:30Z), both binaries           |
| Release workflow          | Passed on `67bb54e`, the first pass since `6e290fb`                           |
| Checked after that deploy | Health, bundle version, journal clean; 0 blocks adopted; 12 changes announced |

The deploy before it was `0586d9a` at 3:33 PM PDT (22:33Z), whose `release` run failed
on 17 tests in `src/wsAccess.test.ts`. `fc15475` fixed that, proven on Linux by the
`67bb54e` run.

## On local master only

Master moves as threads land work, so check `git log origin/master..master`. Nothing
here is live. What matters in it:

| Commit    | Group | Change                                                                   |
| --------- | ----- | ------------------------------------------------------------------------ |
| `4c4b24a` | Fix   | An e-stop stops a robot outside a match within a second; clears wait     |
| `d530216` | Fix   | Field commands no longer work from the internet without a login or link  |
| `c4e9323` | Fix   | Someone on the internet can no longer pose as a device on the field      |
| `9f483f8` | Fix   | Every match sound plays at the same volume (from `28a988b`)              |
| `ba4fbf7` | New   | A parked host robot is a note for field staff, and the slot to release   |
| `656230f` | New   | The field-full message says how many robots are the host's, parked       |
| `8d0c5ee` | Fix   | Field usage no longer counts a host robot left on with no Driver Station |
| `76b8f6b` | Fix   | A late write failure in yesterday's capture no longer stops today's      |

The rest are tests and plans, including the flaky test work.

## Pending deploy

**Ready at `4c4b24a`.** Waiting only on the user's yes.

Checked on that exact commit, on Windows: `bun run typecheck` clean, `bun test` 1055
pass, 0 fail, frontend build passes.

Not seen for real:

- The e-stop wait on a real DS, and the `Waiting for DS` Clear buttons in a browser.
  The cut rule itself is the one Team Stop already runs on steamboat.
- The `/ws` guard was proven behind a loopback Caddy with the live proxy settings, not
  on the live site. After deploying, check that `/match` works from on site and that
  the journal shows no on-site client refused.
- Host features in a browser. They stay dormant here: this site has no host team.

No addon version change. The `/ws` thread's admin login limit isn't in `4c4b24a`; it
goes out in the deploy after. Its optional Caddy logging change is that thread's to
raise with the user.

Before each deploy: `/health` idle, no team on the field, no second-laptop block
(`iptables -S FORWARD | grep br-slot`), and bookings below. Push the exact commit
(`git push origin 4c4b24a:master`).

What teams would notice: open pFMS pages reload once. Nobody on site loses anything.
A note posts to pfms-support.

### Windows for it

| When                                                               | State                             |
| ------------------------------------------------------------------ | --------------------------------- |
| 7:00–10:00 PM PDT (Oct 31 02:00–05:00Z) tonight                    | Team 8048 booked. Don't deploy    |
| After 10:00 PM PDT tonight to Tue Nov 3 4:00 PM PST (Nov 4 00:00Z) | No bookings on the calendar       |
| Tue Nov 3 4:00–7:00 PM PST (Nov 4 00:00–03:00Z)                    | 5940 and guest 59402              |
| Tue Nov 3 7:00–10:00 PM PST (Nov 4 03:00–06:00Z)                   | Team 100, and 5940 until 10:00 PM |

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
- **Setup-page restart idea dropped:** already solved by `edc128c` and `56185eb`.
- **This site has no host team,** so nobody needs to enter one.

## Open questions for the user

1. Push and deploy `4c4b24a`?

## Findings / gotchas

- **`/ws` is still open until the next deploy,** and so is the 8 s out-of-match e-stop.
- **The proxy change is not waiting.** Older threads call `trusted_proxies_strict`
  staged. It's live: ops `01d9534`, verified 1:48 PM PDT (20:48Z) 2026-10-30.
- The Second Robot thread's "wrong-radio fix, owner unconfirmed" is resolved: `1f50d5a`.
- `/health` on port 3000 returns nothing, which looks like a dead service. Use 9005.

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
- [ ] Next deploy, waiting on the user
- [ ] After it: release run, version and health, on-site `/match`, no journal errors
