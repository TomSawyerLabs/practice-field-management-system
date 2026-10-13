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

## Plan / steps

1. **Code + scripts** — `start`/`dev`/`once` → bun; `build` keeps
   `tsc --noEmit` as the type gate (deploy still stops on type errors) and
   stops emitting `dist/`. CLI help, comments, `update.sh`'s `node -pe`.
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
- [ ] 4. Steamboat (needs yes) — exact sequence below
- [x] 5. Docs — README, getting-started (system-wide bun install), setup,
     deployment, configuration, .env.example

### Step 4 sequence (not run — needs explicit approval)

1. Check the field is idle (`curl pfms.tsl/health` phase).
2. `ssh steamboat '~/.bun/bin/bun upgrade'` (1.3.11 → latest ≥1.4.2).
3. `.claude/skills/update-service/deploy.sh` — installs the new unit
   (`ExecStart=/home/cameron/.bun/bin/bun --no-env-file src/index.ts`),
   backs up the old one, daemon-reload. Doesn't restart.
4. On steamboat: `./update.sh force` (pull, build, reload → bun). Reload
   keeps the network.
5. Watch the journal, `/health`, a scoreboard, a test enable.
   Rollback: restore the `.bak.<timestamp>` unit and daemon-reload; check
   out the commit before this change and `bun run build` (that version's
   build still emits `dist/`); `systemctl restart`. Node 22 stays installed
   on steamboat until we're confident.

## Open questions for the user

1. Go ahead with step 4 on steamboat (bun upgrade, new unit, update.sh)?
   Recommendation: yes, at a quiet time — the field restarts once.

## Things not to do

- Don't test against the real radio / field (see memory: DRY_RUN still
  POSTs to RADIO_URL).
- Don't apply the unit to steamboat without explicit per-change approval.
