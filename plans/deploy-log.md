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

| What                   | State                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| Running on steamboat   | `c08e287`, graceful reload 9:02 PM PDT (04:02Z Oct 31) 2026-10-30              |
| `origin/master`        | `c08e287`                                                                      |
| Last published release | `build-20261030-2051-c08e287`                                                  |
| Addon                  | `mdns-socket-v0.2.0`, published 3:30 PM PDT (22:30Z), both binaries            |
| Release workflow       | Passed on `c08e287`                                                            |
| Checked after deploy   | Health, bundle version and journal clean; on-site `/ws` accepted through Caddy |

The last two deploys (`4c4b24a` at 8:42 PM PDT, `c08e287` at 9:02 PM PDT) ran inside
Team 8048's 7:00–10:00 PM PDT booking, with the user's yes. Nobody was there: no team
on a station, no DS connected, no recording that night.

The on-site check sends a read-only `subscribe` to `ws://pfms.tsl/ws` from this PC
(`10.255.0.77`). An outsider gets `This only works from the field network`; this got
its data, both before and after the Caddy `X-Forwarded-For` change went live. A laptop
on the team network hasn't been tried. Look for that refusal next time teams are on.

Earlier the same day: `67bb54e` at 5:17 PM PDT, `0586d9a` at 3:33 PM PDT.

## On local master only

About 18 user-facing changes, none live. Master moves as threads land work, so check
`git log origin/master..master`. The main ones:

- Stops: E-STOP on `/staff` and `/csa`, and kept on screen for a false DS match; a
  press on a disconnected page is queued, confirmed and shown; e-stops survive a
  restart; a warning when a robot says it's enabled through a stop; a Clear on `/match`
  for a robot that left a match still e-stopped.
- Security: strangers on `/ws` see no field state; firmware API needs the staff
  credential; admin passphrase moved to scrypt.
- Network: a team's internet rule ends when it leaves; a clear lost to a restart is
  recovered; the first commit after a start waits for robots; OFFSEASON DHCP fixes.

## Pending deploy

**Ready at `8a2dd38`.** Waiting only on the user's yes.

Checked on that exact commit at 12:06 AM PDT (07:06Z) 2026-10-31, on Windows: `bun run
typecheck` clean, `bun test` 1241 pass, 0 fail, frontend build passes. No addon or
dependency change. Independent review of `c08e287..ef08f3c` found nothing that should
hold a deploy, and its six findings were then fixed.

Do at deploy, in this order:

1. Confirm nothing is e-stopped. **This deploy isn't protected:** the running backend
   has no `eStopped` in `/health`, so `update.sh` won't wait, and the reload lifts any
   e-stop in force. Read `fieldEStop` and each station's `eStop` from `matchState` with
   a read-only WebSocket subscribe.
2. Back up `admin-auth.json` on steamboat: `sudo cp -p` to a dated name beside it. The
   upgrade to scrypt is one-way on the first admin login, and only a pre-upgrade copy
   allows a rollback. It also goes from `0644` to `0600` then.
3. `/health` idle, no team, no block. Push the exact commit, run `update.sh`.

Check after it:

- The three stale NAT rules go (`Removed the internet rule for …`):
  `iptables -t nat -S POSTROUTING | grep pfms-nat-slot`.
- No `has team X but the config says`. With no team on the field, nothing should
  commit. `Could not check the bridges` means recovery failed.
- An on-site page still shows robot dropouts, firmware and network stats: the
  `onFieldClient` move has never run on the real `src/index.ts` with real data.
- `/health` has `eStopped`, `estop-state.json` can be written, `release` passes.

After this, a forgotten e-stop blocks deploys for 10 minutes and `update.sh` gives up;
`./update.sh force` overrides it. A restored e-stop can't be cleared for about 10 s.

What teams would notice: nothing tonight. Internet visitors see a login page instead
of field status.

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
- **Setup-page restart idea dropped:** already solved by `edc128c` and `56185eb`.
- **This site has no host team,** so nobody needs to enter one.
- **Firmware uploads pin known releases** rather than hashing against the `checksum`,
  which is what the radio checks after decrypting, not a hash of the file. An unknown
  version can only be checked by the radio.

## Open questions for the user

1. Push and deploy `8a2dd38`, with the `admin-auth.json` backup?
2. Remove the delegates' merged worktrees?

## Findings / gotchas

- **The proxy change is not waiting.** Older threads call `trusted_proxies_strict`
  staged. It's live: ops `01d9534`, verified 1:48 PM PDT (20:48Z) 2026-10-30.
- The Second Robot thread's "wrong-radio fix, owner unconfirmed" is resolved: `1f50d5a`.
- `/health` on port 3000 returns nothing, which looks like a dead service. Use 9005.

- A worktree installed by pnpm has newer frontend TypeScript, and its frontend build
  fails on `NudgeSettings.tsx`. Steamboat installs from `bun.lock` and builds fine.
  Run a pre-deploy build in a `bun install` tree, not one of those.

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
- [ ] `8a2dd38` deployed, waiting on the user
