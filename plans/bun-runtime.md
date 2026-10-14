# Run pFMS on Bun instead of Node

## Goal

Make Bun the only runtime pFMS needs. Today bun builds and tests, but the
service runs `/usr/bin/node dist` (tsc output), Docker runs on
`node:22-bookworm-slim`, and dev uses `tsx` (Node). Meanwhile the packaged
binary (`bun build --compile`) and the test suite already run on Bun — so the
two install paths run different runtimes. Requiring both is extra setup for
anyone adopting pFMS.

## Environment / context

- Bun 1.4.2 locally (Windows). Field host: steamboat (systemd unit
  `practice-field-management-system.service`, deploy via `update.sh`).
- Steamboat's unit lives in the repo at
  `.claude/skills/update-service/practice-field-management-system.service`.
- Setup wizard writes units via `src/systemdService.ts`
  (`currentExecStart()` = `[process.execPath, argv[1]]`).
- `src/` and `dist/` are both one level below the repo, so every
  `resolve(__dirname, '..', …)` (sounds, mdns addon, frontend) is unchanged
  when running `src/index.ts` directly.

## Decisions already made (don't re-ask)

- User approved the migration ("do it", 2026-10-13).
- No real field hardware during testing — fake `RADIO_URL`, `DRY_RUN=1`.
- Steamboat deploy needs a separate explicit yes (step 4). Keep Node
  installed there as a rollback.
- **Bun is preferred, not required.** Node stays a supported runtime
  (`node dist`), not CI-tested. (User, 2026-10-13: "Node works fine … We
  just prefer Bun"; "Supported, but not CI tested is fine".) Dropping the
  `dist/` emit in step 1 had broken that — restored, and the docs that
  said "Node can't run it" / "64-bit Linux only" corrected.

## Plan / steps

1. **Code + scripts** — `start`/`dev`/`once` → bun; `build` runs `tsc`
   (type gate — deploy still stops on type errors — and the `dist/` Node
   runs; briefly `--noEmit`, which broke Node, since restored). CLI help, comments, `update.sh`'s `node -pe`.
2. **Production entry points** — unit files (repo copy, docs, wizard) run
   `bun --no-env-file src/index.ts`; Dockerfile runtime stage on
   `oven/bun:1-slim`. `--no-env-file` keeps today's behavior: production
   doesn't read `.env` (Bun auto-loads `.env` from the cwd otherwise, and
   the unit's cwd is the repo).
3. **Verify under Bun (Linux, not the field)** — full `bun test`; boot in
   dry run with a fake radio; WebSocket screens (Bun replaces the `ws`
   package with its own); dgram multicast/broadcast; the napi
   `mdns-socket` addon; SIGHUP keep-network reload.
4. **Steamboat** — needs user's yes: install new unit, `update.sh`, watch.
5. **Docs** — README, getting-started, setup, deployment, configuration.

## Findings / gotchas

- No recorded reason Node was kept; the 2026-04 npm→bun move only touched
  the package manager.
- `scripts/test-trunk-switch.ts` already spawns `bun src/index.ts`
  (process.execPath under bun), so the app has booted on Bun in dry runs.
- Bun auto-loads `.env` from the cwd → use `--no-env-file` in production.
- Running source directly: `git pull` changes the code before the build's
  type check runs. The running process is unaffected (modules already
  loaded), but a crash-restart between pull and build would boot the new
  code. Previously `dist/` stayed on the old build until `tsc` succeeded.

- **bun 1.3.11 (steamboat's) fails matchEngine tests on Linux; 1.4.2
  passes.** Same Linux box (WSL), same tree, `bun test
  src/matchEngine.test.ts` twice each: 1.4.2 → 77/77 both runs; 1.3.11 →
  75/77 and 76/77 (`a challenge run end to end > finishing a stopwatch run
  stops the robot…`, `a relay with driver-station hand-offs > the runner
disabling itself…`, `…admin Disable right behind an admin Enable…` — which
  one varies). Not root-caused; possibly timing semantics in the old bun.
  Hence `engines.bun: ">=1.4.2"` enforced by `scripts/check-bun-version.ts`
  as the first step of `bun run build` — update.sh then stops before
  reloading. **Steamboat must `bun upgrade` before the switch.**
- Linux checks under bun 1.3.11 (WSL, root, `/tmp` scripts, not committed):
  dgram `reuseAddr` + `addMembership(group, iface)` +
  `setMulticastInterface/TTL/Loopback` work; the napi addon opens beside a
  dgram socket on 5353, its threadsafe callback delivers 200/200 burst
  packets, `close()` idempotent. Boot in dry run: `/health` answers, `ws`
  (Bun's built-in replacement) connects and streams 500+ state messages,
  SIGHUP → "Graceful exit", code 0. No runtime errors in the log.
- The addon sets `IP_MULTICAST_LOOP 0` deliberately — a same-host dgram
  socket won't hear its sends. Not a Bun issue.
- `scripts/test-trunk-switch.ts` connects before the server listens (fails
  on Windows too, pre-existing) — logged in ISSUES.md, not fixed here
  (another thread is editing that script).
- Full suite on Windows, bun 1.4.2: 950 pass / 0 fail.
- `bun.lock` written by 1.4.2 is unchanged by `bun install` on 1.3.11 (no
  `configVersion` churn on steamboat's `git pull`).
- Side fix committed separately (`299e6bc`): the wizard wrote
  `ExecStart=<binary> /$bunfs/root/pfms` for the packaged binary.

## Progress log

- [x] 1. Code + scripts — scripts, tsconfig `noEmit`, tsx removed, cli
     help, comments, update.sh health parser on bun
- [x] 2. Production entry points — wizard (`--no-env-file`), steamboat unit
     in `.claude/skills/update-service/`, Dockerfile on `oven/bun:1-slim`
- [x] 3. Verify under Bun — see findings; found the 1.4.2 floor
- [x] 4. Steamboat — done 2026-10-13 13:42 PDT, approved by the user
     ("do it. and bring the other threads' change along")
- [x] 5. Docs — README, getting-started (system-wide bun install), setup,
     deployment, configuration, .env.example

### Step 4 as run

1. Field idle (`/health` phase `idle`, version `c6dfb5e`).
2. `~/.bun/bin/bun upgrade` on steamboat: 1.3.11 → 1.4.3.
3. Full suite on HEAD (all 39 unpushed commits, incl. other threads'
   FMS_ENDPOINT removal and leaderboard work): 950 pass, 2 fail — a
   Windows-reserved-port flake in `fmsServer.test.ts` (passes alone,
   logged in ISSUES.md). Pushed `c6dfb5e..13c7a62` (fast-forward).
4. `deploy.sh`: only the ExecStart line changed; backup
   `/etc/systemd/system/practice-field-management-system.service.bak.20261013-134149`.
5. `./update.sh` (no force): old node process logged "Graceful exit:
   network rules preserved", bun started with `KEEP_NETWORK=true`. FMS
   server TCP 1750 + UDP 1160, mDNS reflector, Slack, screens reconnected;
   deploy announcement posted (40 changes). `bun.lock` clean on steamboat.
6. After a minute: same PID, no restarts, RSS ~96 MB, `/health` idle on
   `13c7a62`, cmdline `/home/cameron/.bun/bin/bun --no-env-file src/index.ts`.

Rollback if needed: restore the `.bak.20261013-134149` unit and
daemon-reload; check out `aabc14e` (last commit before the switch) and
`bun run build` (that version still emits `dist/`); `systemctl restart`.
Node 22 is still installed on steamboat.

Left as is: `/etc/pfms/environment` still has `FMS_ENDPOINT=true`, which
the code no longer reads (harmless). Stale `dist/` in the checkout is
unused.

## Open questions for the user

(none)

## Things not to do

- Don't test against the real radio / field (see memory: DRY_RUN still
  POSTs to RADIO_URL).
- Don't apply unit changes to steamboat without explicit per-change approval.
- Steamboat's service runs the same `~/.bun/bin/bun` that `update.sh`
  builds with, so a `bun upgrade` there changes the field's runtime on the
  next reload.
