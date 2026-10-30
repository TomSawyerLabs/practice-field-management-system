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

| What                      | State                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| Running on steamboat      | `0586d9a`, graceful reload 3:33 PM PDT (22:33Z) 2026-10-30            |
| `origin/master`           | `4919f5a` (one plan commit past the deployed code)                    |
| Last published release    | `build-20261030-0329-6e290fb`                                         |
| Addon                     | `mdns-socket-v0.2.0`, published 3:30 PM PDT (22:30Z), both binaries   |
| Release workflow          | Failed on `0586d9a` and `4919f5a`: 17 tests in `src/wsAccess.test.ts` |
| Checked after that deploy | ip rules 485 to 3; tester dhcpcd cycles as `[ip4]`, no `[manager]`    |

The failed releases didn't affect steamboat, which builds from the repo. They only
mean no new single-file binary has published since `6e290fb`.

## On local master only

At `67bb54e`, 11 commits ahead of `origin/master`. Nothing here is live.

| Commit    | Group    | Change                                                                      |
| --------- | -------- | --------------------------------------------------------------------------- |
| `d7761ad` | Fix      | Driver Station laptops can clear an e-stop again                            |
| `d2be772` | Fix      | A second laptop keeps code deploys and cameras; only its DS is held off     |
| `881391a` | Fix      | With two robots, a laptop stays on the robot it chose                       |
| `e934b48` | New      | Operator pages can be locked with a code or QR; stops never need a login    |
| `1f50d5a` | Fix      | The robot tester always reaches the robot plugged into it                   |
| `a5e0415` | Internal | Dry runs can't write to a radio through station-network requests            |
| `fc15475` | Internal | Test: the WebSocket gate tests wait out the opening burst (the release fix) |
| `005ebfa` | Internal | Plan                                                                        |
| `99bf5f6` | Internal | Plan                                                                        |
| `013f647` | Internal | Plan                                                                        |
| `67bb54e` | Internal | ISSUES.md and plan: the field-day `ip rule` check                           |

## Pending deploy

**Ready now, at `67bb54e`** (the code of `1f50d5a` plus plan commits). Waiting only on
the user's yes. Anything later on master isn't part of this.

Checked:

- Field idle on 2026-10-30 at 4:46 PM PDT (23:46Z): `phase` idle, `active-config.json`
  empty since the 6:00 AM clear, all six bridges down, `ip rule` 3.
- No second-laptop block active, so the graceful reload adopts nothing the new code
  can't remove. Old rules had no port. Check again just before deploying.
- No addon version change since 0.2.0, which steamboat already has.
- Steamboat's checkout has no tracked changes, so `git pull` won't be blocked. curl
  8.12.1 is installed, which the pinned requests need.
- `1f50d5a`: `bun run typecheck` clean, `src/wsAccess`, `interfaceFetch`,
  `networkManager` and `operatorAuth` tests 79 pass, frontend build passes, run here.
  The station test port thread ran the full suite on that commit: 939 pass, 0 fail.
  All of that was on Windows.

Unproven until the push: `fc15475` on Linux. WSL can't install the dependencies.
The push's release run is the proof. If it fails again, steamboat is unaffected.

Why not wait for the two running threads: neither is needed on the field tonight,
and the deployed version is worse than local master for a team with two laptops
(all of the second laptop's traffic to the robot is dropped) and for clearing an
e-stop from a DS.

Push the exact commit (`git push origin 67bb54e:master`), not `master`: the Host Team
thread is committing to it, and `ba4fbf7` onward hasn't been checked here.

What teams would notice: open pFMS pages reload once. The field is empty, so no robot
or radio is disturbed; a graceful reload keeps the network. A note posts to
pfms-support. The operator lock does nothing until someone sets a code.

### Windows for it

| When                                                               | State                                  |
| ------------------------------------------------------------------ | -------------------------------------- |
| Now to 6:30 PM PDT (Oct 31 01:30Z) tonight                         | Free. Recommended: 8048 gets the fixes |
| 7:00–10:00 PM PDT (Oct 31 02:00–05:00Z) tonight                    | Team 8048 booked. Don't deploy         |
| After 10:00 PM PDT tonight to Tue Nov 3 4:00 PM PST (Nov 4 00:00Z) | No bookings on the calendar            |
| Tue Nov 3 4:00–7:00 PM PST (Nov 4 00:00–03:00Z)                    | 5940 and guest 59402                   |
| Tue Nov 3 7:00–10:00 PM PST (Nov 4 03:00–06:00Z)                   | Team 100, and 5940 until 10:00 PM      |

Clocks go back Sunday Nov 1, so Tuesday is PST.

### Next deploy after that

- `issues/test-timing`, three commits at `fb9a40e`, not merged. `76b8f6b` is a real
  fix: a late write failure in yesterday's SystemCore capture no longer stops today's.
- Host Team's three features: `ba4fbf7` landed, the rest in progress in the shared tree.
- This log and the `ISSUES.md` notes that go with it.
- `28a988b`, if the user wants it (below).

## The match sound commit

`28a988b` (2026-09-28, every match sound at -14 LUFS) never landed under another
hash. It exists only on the stale clone's `master`, unpushed.

- `src/loudness.ts` and `src/sounds.test.ts` are on no ref here, and no commit
  message matches.
- `sounds/` and `scripts/generate-sounds.ts` haven't changed on master since
  `e838875` (2026-07-27). `end.wav`, `warning.wav` and `start.wav` match that commit's
  parent byte for byte, so the field still plays the old levels, with the quiet
  end-of-match buzzer.
- Its patch applies cleanly to current master (`git apply --check`).

## Open threads

| Thread                                                                       | State           | Still owes                                                                                 |
| ---------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| [Host Team](t3-thread://v1/f7d8fef8-81d4-4951-bf87-522a1e36706e)             | Running         | Three host features ("go ahead with all 3"); admin card never opened in a browser          |
| [Flaky tests](t3-thread://v1/mcp:d7345ee4-f3eb-40d8-aff9-b60f7c58ba86)       | Running         | Final measurement, then merge `issues/test-timing` and close its three `ISSUES.md` entries |
| [Second Robot 114](t3-thread://v1/48b5e116-7198-491d-a686-d98f6138fa21)      | Settled here    | Nothing of its own; its decisions moved below                                              |
| [Two robots](t3-thread://v1/mcp:cbdfa4a7-584a-40b4-b6fa-f3b425c2a741)        | Settled here    | Field checks below                                                                         |
| [Operator login](t3-thread://v1/mcp:3b1530c4-c729-4b09-9b8c-bc2ed9fca742)    | Settled here    | Field E-Stop clear decision; `pnpm-*` strays in its worktree                               |
| [Station test port](t3-thread://v1/mcp:9549f2dc-42b3-4b56-8f1f-20494a572f81) | Settled here    | `roboRIO mDNS` check; stash `4a0aa37`                                                      |
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
- **`plans/field-verification-checklist.md`, checks 1–7.** Check 7, how long an
  out-of-match e-stop takes, bears on the decision below.
- **Host team:** open the admin card, then enter the host team on `/admin`.

## Open questions for the user

1. Push and deploy? See "Pending deploy". Recommended: now, before 6:30 PM PDT.
2. Should clearing the _field_ E-Stop need an operator login, with a team still able
   to clear its own? Today anyone on the network can clear it. Recommended: yes.
3. Is up to about 8 s (3 s on a 2027 DS) acceptable for an out-of-match e-stop?
   Nothing has been measured. Recommended: decide after check 7.
4. Bring `28a988b` over as a new commit? Recommended: yes.
5. Set an operator code after the deploy. Until then the lock does nothing.
6. Keep or drop the setup-page restart idea, open since 2026-10-12
   (`plans/resolve-open-issues-2026-10.md`). No `ISSUES.md` entry remains.
7. Clean-up, all waiting on a yes:
   - 17 worktrees whose branches are fully merged (all but `issues-test-timing`).
   - `C:/Users/camer/AppData/Local/Temp/pfms-hotfix` (prunable),
     `C:/Users/camer/AppData/Local/Temp/pfms-test-timing/base`.
   - `pnpm-lock.yaml` and `pnpm-workspace.yaml` in `issues-operator-login`.
   - Stash `4a0aa37`.

## Findings / gotchas

- **`/ws` is the biggest thing not in any deploy.** Stops and clears stay open to the
  internet even with an operator code set (`ISSUES.md`). Not tried against the live
  site. Nobody has claimed it.
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
- [ ] Push and deploy, waiting on the user
- [ ] After the deploy: release run passes, version and health, no journal errors
