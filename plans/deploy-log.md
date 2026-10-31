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

6 commits ahead of `origin/master` at `9f483f8`. Nothing here is live. Master moves
as threads land work, so check `git log origin/master..master`.

| Commit    | Group    | Change                                                                   |
| --------- | -------- | ------------------------------------------------------------------------ |
| `ba4fbf7` | New      | A parked host robot is a note for field staff, and the slot to release   |
| `656230f` | New      | The field-full message says how many robots are the host's, parked       |
| `8d0c5ee` | Fix      | Field usage no longer counts a host robot left on with no Driver Station |
| `9f483f8` | Fix      | Every match sound plays at the same volume (from `28a988b`)              |
| `3b8eb42` | Internal | This log                                                                 |
| `e5956b3` | Internal | Plan                                                                     |

## Pending deploy

Not ready yet. Waits for the threads below, then needs the user's yes for that push
and deploy.

- Host Team's three features, committed with 948 tests passing there. Nobody has seen
  the alerts or the Host team card in a browser yet; do that first, headless with a
  fake radio.
- `issues/test-timing`, including a real fix: a late write failure in yesterday's
  SystemCore capture no longer stops today's.
- `/ws` guard, from `issues/ws-internet-guard`.
- The out-of-match e-stop fix, once the user picks a way.

The match sounds (`9f483f8`) are on local master. Its 33 tests and typecheck pass.

Before each deploy: `/health` idle, no team on the field, no second-laptop block
(`iptables -S FORWARD | grep br-slot`), no addon version change, and bookings below.

### Windows for it

| When                                                               | State                             |
| ------------------------------------------------------------------ | --------------------------------- |
| 7:00–10:00 PM PDT (Oct 31 02:00–05:00Z) tonight                    | Team 8048 booked. Don't deploy    |
| After 10:00 PM PDT tonight to Tue Nov 3 4:00 PM PST (Nov 4 00:00Z) | No bookings on the calendar       |
| Tue Nov 3 4:00–7:00 PM PST (Nov 4 00:00–03:00Z)                    | 5940 and guest 59402              |
| Tue Nov 3 7:00–10:00 PM PST (Nov 4 03:00–06:00Z)                   | Team 100, and 5940 until 10:00 PM |

Clocks go back Sunday Nov 1, so Tuesday is PST.

## Open threads

| Thread                                                                       | State           | Still owes                                                                                 |
| ---------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| [/ws guard](t3-thread://v1/mcp:7d79bf25-f956-4a49-b1b0-1fb9c3782fd5)         | Running         | The guard itself, on `issues/ws-internet-guard`                                            |
| [Host Team](t3-thread://v1/f7d8fef8-81d4-4951-bf87-522a1e36706e)             | Settled here    | Browser check above; entering the host team on `/admin`                                    |
| [Flaky tests](t3-thread://v1/mcp:d7345ee4-f3eb-40d8-aff9-b60f7c58ba86)       | Running         | Final measurement, then merge `issues/test-timing` and close its three `ISSUES.md` entries |
| [Second Robot 114](t3-thread://v1/48b5e116-7198-491d-a686-d98f6138fa21)      | Settled here    | Nothing of its own; its decisions moved below                                              |
| [Two robots](t3-thread://v1/mcp:cbdfa4a7-584a-40b4-b6fa-f3b425c2a741)        | Settled here    | Field checks below                                                                         |
| [Operator login](t3-thread://v1/mcp:3b1530c4-c729-4b09-9b8c-bc2ed9fca742)    | Settled here    | Nothing; the field E-Stop clear is logged in `ISSUES.md`                                   |
| [Station test port](t3-thread://v1/mcp:9549f2dc-42b3-4b56-8f1f-20494a572f81) | Settled here    | `roboRIO mDNS` check, below                                                                |
| [ip rules](t3-thread://v1/mcp:f5cd653d-9a06-4d7d-9f42-1b01bbf5ea8c)          | Settled here    | Field check below                                                                          |
| [Route preference](t3-thread://v1/09ae0186-a56b-4472-b552-10c07d37e4ef)      | Already settled | Confirmation next time a team reports a DS restart                                         |
| [Header icons](t3-thread://v1/mcp:24f7f39c-0516-4ee4-b00d-f611540237f7)      | Already settled | Nothing; thread closed DONE                                                                |

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
- **`plans/field-verification-checklist.md`, checks 1–7.** Check 7 times an
  out-of-match e-stop against the 1 s limit.
- **Host team:** open the admin card, then enter the host team on `/admin`.

## Decisions made

- **Field E-Stop clear stays open to anyone on site** (2026-10-30). Logged in
  `ISSUES.md` to revisit later.
- **An e-stop must act within 1 s, 250 ms at best** (2026-10-30). Logged in
  `ISSUES.md`. The roughly 8 s out of a match is the DS's documented retry interval,
  not a measurement, and doesn't meet this.
- **`28a988b` came over** as `9f483f8`, for the next deploy.
- **`/ws` got its own thread.**
- **Merged worktrees and branches removed.** `pfms-test-timing/base` stays while the
  flaky test thread runs.

## Open questions for the user

1. How should an out-of-match e-stop reach the robot within 1 s? The user has also
   said they don't want to cut comms. Recommended: bring back the narrow UDP 1110
   drop for e-stops, on DSes out of a match only, as it's the only proven way (about
   100 ms). Then try two ways with no cut at the field: answering a DS's open TCP
   socket at once, and whether a local-control DS obeys control packets at all.
2. Set an operator code on `/admin` → Access. Until then the lock does nothing.
3. Drop the setup-page restart idea? It's already solved: `edc128c` applies a trunk
   change at once, `56185eb` a radio URL. Recommended: drop.

## Findings / gotchas

- **`/ws` is still open.** Stops and clears stay reachable from the internet even with
  an operator code set (`ISSUES.md`). Not tried against the live site.
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
- [ ] Out-of-match e-stop within 1 s, waiting on the user
- [ ] Next deploy, waiting on the threads and then the user
