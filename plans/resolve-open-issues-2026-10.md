# Resolve open ISSUES.md entries (2026-10-12)

## Goal

Work through `ISSUES.md`: fix what can be fixed in code now, one commit per
issue, and surface the entries that need a user decision or real hardware.

## Environment / context

- Main checkout `C:\Users\camer\git\practice-field-configurator`, branch
  `master`, shared working tree. `frontend/public/tomsawyerlabs.svg` was
  already modified before this thread started — not ours, leave it alone.
- Checks: `bun run typecheck`, `bun test`, prettier via the lefthook
  pre-commit hook.
- No other T3 thread was running when this started (checked 2026-10-12).
- No deploys from this thread unless the user asks.

## Triage

### Fixable in code now (this thread)

1. Scoreboard challenge leaderboard never has data (`/ws/scores` gets no
   match history).
2. Silent paths in match control: abandoned matches not written to history;
   no warning when a joined station has no live DS endpoint.
3. Remaining silent-skip paths in RadioManager / NetworkManager
   (configure during reconfigure dropped; stale `enabledStations`;
   NetworkManager teardown retry/per-station errors).
4. `teamSubnet` duplication.
5. `setupWebSocket` positional-parameter sprawl → options object.
6. Route preference always uses IPv4 `ip rule` (IPv6 browsers).
7. Network backend built at module load → create lazily.
8. `postMatch` frozen team snapshot.
9. `matchRecorder` finishSession/adopt race with a just-spawned ffmpeg.
10. Two-robot team: remember a laptop's last robot after a lapsed session.

### Needs the user (decision) — not started

- OFFSEASON firmware docs: do the OFFSEASON code paths stay?
- DS-client guard hardening: user said "fine for now" (2026-07-24).
- Space → A-Stop in the match window: deliberately deferred.
- "Restart pFMS" action: needs a decision on how (systemd restart vs.
  in-process re-init) and who may trigger it.
- The Blue Alliance reporting: a feature, needs scoping.

### Needs hardware / field / ops — can't do from here

- Everything under "Unverified behaviour we depend on".
- Station page on a real phone.
- SystemCore passive telemetry on UDP 1110.
- Linux standalone binary run + self-update.
- pFMS own traffic to a duplicated team subnet (routing design, bigger).
- IGMP membership leak on steamboat (needs observation on the server).
- Ops proxy change for public match links (infra, needs per-change OK).
- Per-station firmware progress UI and StationStatus re-render: low value,
  left as logged.

## Progress log

All ten code items are done, one commit each, `ISSUES.md` updated in the same
commit:

- [x] 1 Scoreboard leaderboard — `556428c`
- [x] 2 Match control silent paths — `301c75b`
- [x] 3 RadioManager / NetworkManager silent skips — `ed8a7b8`
- [x] 4 teamSubnet consolidation — `5fd8a21`
- [x] 5 setupWebSocket options object — `8a2364c`
- [x] 6 Route preference IPv6 — `badf2ba` (unit-tested; not yet seen on
      steamboat with a real IPv6 laptop)
- [x] 7 Lazy network backend — `6577db1`
- [x] 8 postMatch frozen snapshot — `6028928`
- [x] 9 matchRecorder race — `cb3a013` (`scripts/test-recorder-adopt.ts`
      fails on the old recorder, passes now)
- [x] 10 Two-robot last-robot re-claim — `6fb8d54`
- [x] Stale restart entry rewritten — `97b0191`
- [x] Firmware docs corrected — `5a13573`
- [ ] Deploy — on hold at the user's request (2026-10-12)

## Findings / gotchas

- `bun test` takes ~5.5 min for the full suite (matchEngine.test.ts alone
  ~65 s, practiceRecorder.test.ts ~60 s) — run it in the background, and
  don't pipe it through `tail` (output is buffered until the end).
- Python on this machine can't see Git Bash's `/tmp`; put scratch patches
  under `.git/` and delete them afterwards.
- Partial staging of `src/index.ts`: `git diff` → keep hunks → `git apply
--cached --recount`.
- matchRecorder race: ffmpeg opens its output only after probing the
  stream (seconds on RTSP), so renaming the pre-roll dir in that window
  made it fail ("Error opening output files"). A symlink from the old name
  was rejected: the sweep/inventory/warm-up walk the directory and a link
  risks deleting through it. The fix defers the rename until every running
  ffmpeg's current part file exists (max 15 s).

## Open questions for the user

1. ~~OFFSEASON docs~~ — answered 2026-10-12: both firmwares are supported;
   PRACTICE is recommended because OFFSEASON's firewalls stop most teams
   uploading code. Docs fixed in `5a13573`, code paths stay.
2. Setup-page restart: the setup page says the trunk interface and radio URL
   are read at startup, so "restart pFMS" (the service, not the computer)
   after changing them. The ISSUES.md entry asks whether that page should
   offer the restart, and whether the graceful restart applies a new trunk
   interface. Waiting on the user: keep the entry, or drop it.

## Things not to do

- Don't touch `frontend/public/tomsawyerlabs.svg` (pre-existing change).
- Don't deploy or touch steamboat/ops without explicit per-change OK.
