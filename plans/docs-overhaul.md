# Documentation Overhaul

## Goal

Overhaul pFMS documentation: reorganize into a coherent structure, fix
doc-vs-code inaccuracies, and answer "GitHub markdown vs readthedocs".

## Decision: format

**Stay with GitHub-flavored markdown in-repo** (recommended to user, pending
their confirmation but proceeding since it's also the no-regrets path — all
content stays plain markdown either way):

- Audience is small (field staff, mentors, a few devs) — no need for hosted
  docs infra, versioned builds, or search at this scale.
- GitHub renders mermaid natively (README already uses it).
- If a docs site is ever wanted, MkDocs Material can be layered on the same
  markdown files with a nav config — nothing written now is throwaway.

## Current state (before)

- `README.md` (~37 KB) — everything: setup, pages, match system, scoring,
  support, network architecture, deployment, env vars. Too long, single file.
- `TECHNICAL.md` — startup sequence, config flow, match internals, reload.
- `ROBOT-TESTER.md` — robot tester deep-dive (good shape).
- `ISSUES.md` — known tech debt.
- `docs/vlan-decoupling-design.md` — one design doc.
- `frontend/README.md` — untouched Vite template boilerplate (worthless).
- `plans/` — per-task working plans (not user docs; leave alone).

## Known doc-vs-code inaccuracies found so far

- README says `WEBSOCKET_PORT` default `3000`; update.sh health-checks
  `localhost:9005`, Caddy/nginx examples proxy `9001`. Need code ground truth
  (and the examples should be consistent with each other).
- README says match timing "20 s auto, 5 s pause, 110 s teleop";
  TECHNICAL.md says defaults 15 s / 3 s / 135 s. Verify in matchEngine.
- TECHNICAL.md says postMatch "3s fixed, auto-resets to idle"; README says
  post-match holds until cleared or 2 minutes (matches recent commit
  "Auto-clear finished matches back to idle after 2 minutes"). TECHNICAL is
  stale.
- README says "npm install / npm run dev"; project uses bun (update.sh uses
  bun install/bun run; CLAUDE.md mandates bun run). Docs should say bun.
- README Development section says backend on :3000 "proxied by the frontend
  dev server" — verify vite proxy target.
- TECHNICAL.md startup says auto default 15s — verify all phase defaults.
- Env var table needs verifying against actual `process.env` reads (vars may
  be missing or renamed).

## Verified ground truth: match system (from matchEngine.ts et al.)

- Durations FIXED (not user-adjustable; only `skipAuto`/`autoWinner`
  settable): countdown 3s (hardcoded), auto 20s, autoPause 3s, teleop 140s
  total with endgame = last 30s (so ~110s pre-endgame), postMatch counting
  window 3s (`POST_MATCH_COUNT_SECONDS`).
  - README:54 wrong on pause (5s→3s). TECHNICAL.md:64-73 wrong on auto
    (15→20), teleop (135→140), and "configurable" labels.
- Post-match auto-clear: 2 min (`POST_MATCH_AUTO_CLEAR_MS`); e-stop-ended
  matches never auto-clear (and globalEStop cancels pending auto-clear).
- Phases: idle, created, countdown, auto, autoPause, paused, teleop,
  endgame, postMatch.
- Pre-match: createMatch → joinStationAlliance (max 3/alliance) → host
  opens ready check (`setReadyRequested`, only in `created`) → stations
  setReady + staff setStaffReady → startMatch (requires readyRequested, ≥1
  joined, all joined ready, every staff role ready-or-ignored).
- Staff roles: `headRef` ("Head Referee"), `scorekeeper`, `safety`. Ignore
  flags persist across matches (reset only on server restart). Roster/config
  changes call closeReadyCheck (clears readies, keeps ignores). Staff
  presence: 6s heartbeat timeout; stale ready cleared by 2s sweep.
- Hold-to-start abort: during countdown, joined station setReady(false) →
  abortCountdown → back to `created`, matchId nulled, stations stay
  joined+ready.
- E-Stop: any phase; backend-latched (never sends e-stop bit to DS, only
  disable); cleared only via adminClearEStop; DS-reported e-stop honored.
- A-Stop: armable in created/countdown/auto/paused-from-auto; cancelable
  only in `created`; auto-releases at teleop; DS 0x40 bit honored only while
  A-Stop meaningful.
- Re-enable (`undisable`): auto/teleop/endgame only, joined, not
  e/a-stop-latched; `disabledBy: 'admin'` needs admin to lift.
- Audio: sounds/ dir, names start/end/resume/warning/abort/pause/
  countdown1-4/getready; countdown voice = char-sum of matchId mod 4 (must
  match frontend useMatchAudio.ts); player detected from aplay/paplay/
  ffplay/mpv/play/afplay; ALSA device persisted to audio-config.json.
- WS message names for match control verified (stationJoinAlliance etc. —
  see types.ts:574-828). No adminStart/Pause/Resume — those are station\*
  messages.

## Verified ground truth: config/env/ports

- README env table: all 24 entries real; but 9+ vars read in code are
  MISSING from it: FMS_LOG_DS_MESSAGES, KEEP_NETWORK,
  MDNS_EXCLUDE_REQUESTERS, MDNS_LISTEN_INTERFACES,
  RADIO_HISTORY_DURATION_MS, ACTIVE_CONFIG_FILE, STAGED_CONFIG_FILE,
  SAVED_TEAMS_FILE, FIRST_API_USERNAME + FIRST_API_AUTH_TOKEN (team
  avatars; set via .env in production).
- WEBSOCKET_PORT code default 3000 (index.ts:86). Production runs 9005
  (update.sh health check + update-caddy skill agree; set via
  /etc/pfms/environment, outside repo). README Caddy/nginx examples say
  9001 — stale; use 9005 in examples (or a placeholder noting prod value).
- FMS ports: TCP 1750 + UDP 1160 (fixed fn defaults, no env override),
  DS control UDP send port 1121, RIO→DS reply port 1150, FMS address
  10.0.100.5.
- /health returns { phase } — used by update.sh deploy gating.
- Vite dev proxy → localhost:3000 for /ws, /health, /api/team-avatar,
  /api/video-proxy only (selective list).
- HTTP route prefixes: /admin/auth/<token>, /api/auth/check, /api/score*,
  /api/match-review*, /api/firmware*, /api/team-avatar/:team,
  /api/video-proxy/*, /health, /ws/scores (scoreboard WS path).

## Planned structure (after)

- `README.md` — trimmed front door: what it is, hardware/firmware prereqs,
  quick start (bun), pages table (short), links into docs/.
- `docs/README.md` — docs index.
- `docs/setup.md` — install, production deployment, systemd, update.sh,
  Caddy/nginx, external access.
- `docs/configuration.md` — env var reference, trusted proxies.
- `docs/match-system.md` — match lifecycle, ready flow, hold-to-start,
  E-Stop/A-Stop, pause/recovery, audio (user-facing + internals merged).
- `docs/scoring.md` — scoring API, elements/sources/dedup, endpoints.
- `docs/support.md` — support widget, issue reports, chat, Slack setup.
- `docs/network.md` — architecture diagram, subnets, routing, DNAT,
  discovery, hostnames, mDNS reflector, field ports.
- `docs/robot-tester.md` — moved ROBOT-TESTER.md (updated).
- `docs/internals.md` — startup sequence, config commit flow, graceful
  reload, dry-run (from TECHNICAL.md, corrected).
- `docs/design/vlan-decoupling.md` — existing design doc moved.
- `ISSUES.md` → keep at root or docs/known-issues.md (TBD).
- `frontend/README.md` — replace boilerplate with real frontend notes.
- Root `ROBOT-TESTER.md`/`TECHNICAL.md` deleted (content moved). Consider
  leaving stub pointers if external links might exist (unlikely — private
  repo; delete cleanly).

## Progress log

- [x] Survey existing docs
- [x] Verify facts against code (env vars, ports, match timing, pages,
      scoring endpoints, WS messages) — 3 Explore agents; findings above
- [x] Write new docs/ structure (README index, setup, configuration,
      match-system, scoring, support, network, internals; robot-tester and
      design/vlan-decoupling moved with `git mv`)
- [x] Trim README (front door + pages table incl. previously-missing
      `/usage` + docs links)
- [x] Replace frontend/README.md (was Vite boilerplate; now real notes on
      the multi-page layout, roots/, dev proxy, add-a-page checklist)
- [x] Fix stale cross-references (design doc's related-files list)
- [x] prettier, commit

## Notes / follow-ups (not done in this pass)

- ISSUES.md kept at root (linked from docs index). BUGS.md is
  gitignored/local — untouched.
- Reverse-proxy examples now use port 9005 and the real
  team-number→control.html rewrite (old examples had a nonexistent
  /slot[1-6]→station.html rewrite). Full production Caddy config lives in
  the ops repo at servers/steamboat/sites.d/pfms.caddy (the local
  update-caddy skill copy was removed 2026-09-10).
- Stray empty dir `CUserscamergitpractice-field-configuratorplans/` at
  repo root (mangled-path accident from some tool) — flagged to user, not
  deleted.

## Things not to do

- Don't touch plans/ content (working notes, not docs).
- Don't invent behavior — every factual claim must come from code or
  existing docs verified against code.
- No `title=` attributes anywhere (n/a for markdown, but no HTML tooltips).
