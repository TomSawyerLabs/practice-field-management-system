# Multi-Site Adoption: Onboarding & Per-Field Customization

## Goal

Make pFMS deployable by **other FRC groups** at their own practice fields,
and let each deployment customize branding/styling/features without
forking. Two related asks from the user (2026-07-27):

1. Is there a clear "getting started" / onboarding + setup admin page?
   What do we need so it works well for others?
2. How do we add per-practice-field custom styles/features?

## Status

Research complete (three Explore agents: portability blockers, admin UI +
runtime config surface, new-deployment setup burden). Doc-accuracy fixes
committed (`f4f0744`). **Now executing Stage 0.**

## Decisions already made (don't re-ask)

Answered by the user 2026-07-27:

1. **Customization scope: full — branding + theme + feature toggles _and_
   field-layout config.** Station count/labels, VLAN mapping, and port
   names should eventually be configurable, not just cosmetics. This is
   the deep option: it touches `networkManager.ts` (the hardcoded
   `slot1..slot6` → VLAN `10..60` map, which already carries a
   `// TODO: load this map from the radio config`), `types.ts`
   (`StationNameList` is a fixed 6-tuple used as a type), and
   `routePreferenceManager.ts` (VLAN ids double as route-table ids).
   Sequence it **after** the Site Profile store exists, so layout config
   has somewhere to live.
2. **Build order: Stage 0 first** — getting-started guide + the cheap
   unblocking fixes. Chosen over the UI-visibility and Site Profile work
   because it unblocks adoption immediately and carries no risk to the
   running field.

## Environment / context

- Repo: `github.com/TomSawyerLabs/practice-field-management-system` (**public**).
- Reference deployment: host `steamboat`, `/opt/practice-field-management-system`,
  Caddy at `pfms.tsl` / `pfms.tomsawyerlabs.com`, backend port 9005.
- Docs were just reorganized into `docs/` (commit 0135539) — the new
  structure is the natural home for a "Getting Started" guide.

## Findings (own investigation, pre-agent)

- **No LICENSE file.** `package.json` says `"license": "ISC"` but GitHub
  reports `licenseInfo: null`. Repo is public, so adopters have no clear
  grant. **Blocker for outside adoption** — cheap to fix.
- **`frontend/src/public.html` is hard-branded**: ~600 lines of inline
  SVG path data (the org logo) plus a GitHub corner linking to
  `cinderblock/practice-field-wifi-configurator` — a **stale repo name**
  (now `TomSawyerLabs/practice-field-management-system`). Copy is generic
  ("Practice Field Wi-Fi"), so only the logo + link are site-specific.
- **`sounds/pause.wav` is missing.** `matchAudio.ts` expects a `pause`
  sound on match pause; `sounds/` tracks 10 files (abort, countdown1-4,
  end, getready, resume, start, warning) — no `pause.wav`. Pause is
  silent today. Affects every deployment, not just new ones.
- **`/firmware/` is gitignored** — a fresh clone has no radio firmware
  binaries. Need to confirm whether the firmware store auto-downloads
  (`firmwareStore.ts` is documented as doing a background download) or
  whether a new site starts unable to update radios.
- `.env` gitignored (FIRST API credentials for team avatars) — new
  deployments silently lose avatars with no sample `.env.example`.
- `known-ips.yaml` is tracked and generic (router/radio/FMS/syslog on
  10.0.100.x) — fine, but encodes the reference subnet.

## Portability blockers (verified, agent sweep)

Backend `src/` is **clean of org branding** (zero hits for tomsawyer/TSL/
steamboat/cinderblock). The lock-in is in assets, network literals, and
the deploy chain.

### Branding (mechanical, easy)

- `frontend/public/tomsawyerlabs.svg` (52 KB org logo) referenced as the
  favicon from **13 source HTML files** (`*.html:5`) — plus checked-in
  `frontend/dist/` copies.
- `frontend/src/public.html` — inline org logo SVG (~600 lines).
- Stale GitHub links to the old repo name
  `cinderblock/practice-field-wifi-configurator`:
  `frontend/src/components/StatusBar.tsx:249`, `public.html:67`.
- `frontend/scores.html:16,52` — Cast namespace
  `urn:x-cast:com.tomsawyerlabs.pfms`; `:58` — Cast receiver app ID
  `260A23F5` registered to **our** Google Cast account. Another group
  must register their own — casting will not work for them otherwise.
- Page `<title>`s are all site-neutral. Good.

### Network literals (the real work)

- **`10.0.100.5` (FMS host IP) — 6 independent literals, no constant**:
  `src/index.ts:112` (startup check **hard-fails** without it), `:601`
  (syslog bind), `:609` (pushed to radio, has a `// TODO: Load system IP`),
  `src/fmsServer.ts:15`, `src/subnetScanner.ts:207`, plus scripts.
- `src/radioManager.ts:693` — syslog IP fallback `'10.0.100.40'`, not
  env-backed at all.
- `src/index.ts:75` — `RADIO_URL` default `http://10.0.100.2` with a
  comment actively discouraging override.
- VLAN map + 6 stations are structural (`networkManager.ts:140`,
  `types.ts:59`) — fine for FRC, not a blocker.
- `eno1`-shaped interface assumptions: `portBridgeManager.ts:14` (name
  length budget), legacy-cleanup paths in `networkManager.ts`/`index.ts`.
- `192.168.69.x` factory-radio subnet is **vendor**-fixed, not site — OK.

### Deploy chain (no override mechanism)

- `update.sh:32,33` — `/opt/practice-field-management-system`, service
  name; `:48` — health check on **9005** while code defaults to 3000.
- `.claude/skills/update-service/*.service:9` —
  `WorkingDirectory=/home/cameron/...`; `:4` `Conflicts=` a legacy
  service.
- `.claude/skills/update-caddy/pfms.caddy` — every hostname
  (`pfms.tsl`, `*.tomsawyerlabs.com`), path, and the internal/external
  auth split. Effectively a template to rewrite wholesale.
- `.claude/skills/{deploy,steamboat}` — SSH host `steamboat` throughout.
- `environment.default` seeds **our** choices: `VLAN_INTERFACE=eno1`,
  `RADIO_CLEAR_SCHEDULE=0 6 * * *`, `America/Los_Angeles`,
  `TRUSTED_PROXIES=...,10.0.0.0/8`.

### Season-coupled logic (matters for the season roll, not just adopters)

- `matchEngine.ts:45-53` — REBUILT timing (fixed by design).
- **`shiftState.ts` encodes the 4-shift alternating-goal game in the type
  system** (`MatchSubPeriod` = shift1..shift4, `getAllianceScoringShifts`
  hardcodes winner=2,4 / loser=1,3), and `scoringEngine.ts` is written
  against it. A different season = rewriting types, not editing config.
  **Hardest structural coupling in the codebase.**
- `teamChecker.ts:31-35` — expected firmware `2.0.1` / image year `2026`.
- `firmwareStore.ts:35-45` — two GitBook CDN URLs with **expiring signed
  `?token=` query params**; these rot every season.

### Hygiene / leaks

- **No LICENSE file** (public repo, `package.json` says ISC).
- `samples/scan/result/sample.raw:91`, `second.raw:91` — the org's real
  Wi-Fi SSID + BSSID, **tracked in a public repo**.
- `.env` (untracked, correct) holds a live FIRST API token and the
  username `pfmstsl` — any copy of this working tree carries it. Needs a
  `.env.example` instead.
- `sounds/pause.wav` missing though `matchAudio.ts:19` declares `pause`.
- Sound-name contract duplicated between `src/matchAudio.ts` and
  `frontend/src/hooks/useMatchAudio.ts` — must stay in lockstep.
- `scoringApi.ts:349` — schema example says `Host: pfms.local:3000`,
  wrong for us _and_ everyone else.
- `useConnectivity.ts:32` — internet check hits
  `https://www.google.com/favicon.ico`; fails on filtered venue networks.

## Onboarding: what exists today

**There is no getting-started flow.** The only first-run experience in the
entire app is the admin passphrase-creation card
(`AdminAuthGate.tsx:139-202`). Beyond that:

- `/` (`MainPage.tsx:23-119`) renders identically configured or not — a
  hardcoded "Practice Field" heading, a team-number box, quick links. No
  "nothing is set up yet" state, no pointer to setup.
- `/match` has the app's best empty state ("No match in progress. Create a
  match…", `MatchControlPage.tsx:299`).
- `/admin` sections mostly render `null` when their state is missing.
  Good empty states exist for API keys, external access, Slack, scoring.
- `TestPage.tsx:146` is the **only** place a missing env var is surfaced
  in the UI ("Set the `TEST_INTERFACE` environment variable").
- **Startup check failures are invisible in the UI.** `appLogger`'s
  broadcast fn is only wired after `setupWebSocket()` returns, and all
  startup checks run before that — with no replay buffer. So a
  misconfigured install shows nothing anywhere; it just doesn't work.
  (`appLogger.ts:5,21`, `startupChecks.ts`.)

### Biggest first-boot footguns for a new deployer (ranked)

1. **`checkRequiredTools` exit 78.** `index.ts:108` demands `iptables,
arping, fping, dnsmasq, conntrack, tcpdump` unconditionally whenever
   `VLAN_INTERFACE` is set — our docs listed only three. **FIXED** in
   `docs/setup.md` + `docs/internals.md` this session.
2. **No installer, and the deploy tree is undocumented.** `update.sh:44`
   hard-fails unless `/opt/practice-field-management-system/{internal,
public}` already exists; nothing creates it and `docs/setup.md` never
   mentions `/opt`. Worse, the generic proxy example points at
   `frontend/dist` while `update.sh` populates `/opt/.../internal` — so
   following the docs verbatim yields a deploy that never updates.
3. **Port 9005 vs documented 3000.** Hardcoded in `update.sh:48`,
   `pfms.caddy` ×5, `environment.default`. The `update.sh` one fails
   _silently_: health returns `unknown`, so the match-in-progress guard
   never engages and deploys interrupt live matches.
4. **All real production topology lives in `.claude/skills/`**, not docs —
   the only working systemd unit, Caddyfile, and env seed are
   steamboat-shaped artifacts a human deployer will never find.
5. **`.env` documented as working in production; it doesn't.** No dotenv
   anywhere; systemd runs `/usr/bin/node dist`. **FIXED** in
   `docs/configuration.md` this session.
6. **Untagged vs tagged field control.** `startupChecks.ts:93` adds
   `10.0.100.5/24` to the _bare_ interface, so field control must be the
   native VLAN — never documented. Getting it wrong = infinite
   `waitForRadio` retry loop with no error. **Partly FIXED** in
   `docs/internals.md`.
7. Missing `alsa-utils` / `dhcpcd` degrade silently (audio, robot tester).
   **FIXED** in `docs/setup.md`.
8. Browser match audio only reaches the web root via `update.sh:41` — a
   hand-rolled deploy has a working field speaker and silent browsers.
9. `/scores` needs HTTPS (Cast secure origin); a LAN-only deployer with no
   public DNS has no documented path.
10. `update.sh` runs `git pull` on the production checkout — any local
    edit on the box breaks all future deploys.

## Customization: what's configurable today

- **Runtime + persisted (admin UI):** admin passphrase, scoring API keys,
  external access tokens, Slack tokens/channel, match audio device. That's
  _all five_.
- **Runtime, not persisted (lost on restart):** match `skipAuto`/
  `autoWinner`, scoring element definitions, cast receiver swap/mute.
- **Env-only (restart required):** ~25 vars.
- **Build-time only, no runtime or env path:** _all_ theming/palette,
  favicon, page titles, product-name strings, alliance colors, Cast
  namespace.

### Theming reality

MUI `sx` props only — no CSS files, no theme module, no CSS variables.
Three duplicated `createTheme` calls (`wrap.tsx:82` — recreated every
render, a latent perf bug; `logs.tsx:7`; `scores.tsx:7`), all MUI-default
blue/purple. Branding actually lives in **~40 hardcoded hex literals**
(`MatchTimeline.tsx:15-16`, `MatchTimer.tsx:8,18-19`, `ScoreboardPage`
×5, `AdminPage` ×3, `MatchPanel` ×4, …) plus `src/utils.ts:40` (the one
shared alliance-color helper — which oddly lives in the **backend** and is
imported by the frontend). Also 13 inline `<style>` blocks hardcoding
`#121212`, and `scores.tsx:15` force-pins dark mode.

So: a runtime theme is a ~1-file change to _plumb_, but has near-zero
visible effect until the hex literals are funnelled through the theme.

### The established pattern for a new persisted setting

Slack config is the best reference — full chain documented in this plan's
research: `types.ts` message + type guard (client→server) and state +
guard (server→client) → store module with
`load/persist/getState/addListener/notifyListeners` → instantiate in
`index.ts` → `websocketServer.ts` import guard, `addListener(broadcast)`,
initial send on connect, handler gated on `adminConnections.has(ws)` →
frontend `useBackend.ts` cache + CustomEvent + hook + sender → an
`AdminPage.tsx` `<Card>` section. ~17 touch points, all mechanical.

Note: new admin state broadcasts to all _internal_ clients; only the
public `/ws/scores` socket is allowlisted (`websocketServer.ts:245`).

## Recommended plan (staged)

**Stage 0 — unblock adoption (cheap, do first)**

- Add a `LICENSE` file (ISC, matching package.json).
- `.env.example`; scrub the real FIRST token out of any shared copy.
- Remove the org SSID/BSSID from tracked `samples/scan/result/*.raw`.
- Fix stale GitHub URLs (`StatusBar.tsx:249`, `public.html:67`).
- Add `sounds/pause.wav` (or drop `pause` from the SoundName union).
- Write `docs/getting-started.md`: a linear, checkbox-shaped
  "field-to-first-match" guide including hardware, switch/VLAN trunk,
  native-VLAN gotcha, the `/opt` tree, minimum env set, first login.

**Stage 1 — make misconfiguration visible**

- Buffer startup-check results and broadcast them once the WS server is
  up; surface a dismissible "Setup issues" banner (admin + home).
- Add a `/admin` → **System Status** panel: which env vars are set, which
  tools were found, radio reachability, whether sounds are being served,
  detected firmware mode. This doubles as the support tool for remote help.

**Stage 2 — Site Profile (the per-field customization ask)**

One new persisted store (`site-config.json`) following the Slack pattern,
edited from a new `/admin` → **Site** section, broadcast to all clients:

- Identity: site name, short name, logo URL/upload, favicon, page-title
  suffix, optional support contact line.
- Theme: primary/secondary color, red/blue alliance colors, default
  light/dark, optional accent for the scoreboard.
- Toggles: which optional features/pages are enabled (scoring, support
  widget, staff roles + labels, usage page, robot tester, video view).

Then the unglamorous half: funnel the ~40 hex literals through the theme,
centralize `createTheme`, make the favicon/title runtime-swappable, and
move `utils.ts:40` out of the backend.

**Stage 3 — deployment ergonomics (optional, biggest payoff for others)**

- `scripts/install.sh`: create `/opt` tree, seed `/etc/pfms/environment`
  from a template, install the unit file with the right paths, print next
  steps. Replaces the tribal knowledge in `.claude/skills/`.
- Generalize `update.sh` (env-driven `DEPLOY_BASE`, `SERVICE`, port read
  from the environment file rather than hardcoded 9005).
- Ship a generic `caddy/pfms.caddy.example` in `docs/`, with the
  internal/external split as an opt-in block.

**Explicitly out of scope:** de-seasoning `shiftState.ts`. The 4-shift
REBUILT model is encoded in the type system and drives scoring
attribution; that's a rewrite, not a config option, and it's the same work
whether or not anyone else adopts pFMS.

## Progress log

- [x] Research: portability blockers, admin/runtime config surface, new
      deployment burden (3 agents)
- [x] Doc-accuracy fixes from the research (`f4f0744`) — missing apt
      packages, `.env`-in-production myth, native-VLAN requirement
- [x] **Stage 0 complete:**
  - [x] `docs/getting-started.md` — linear hardware→first-match
        walkthrough with per-step "how to tell it worked" checks, a
        no-hardware `DRY_RUN` path, and a symptom→cause troubleshooting
        table. Linked from README + docs index.
  - [x] `LICENSE` (ISC, © Cameron Tacklind — matches `package.json`;
        **change the holder if it should be the org**) + a License
        section in the README.
  - [x] `.env.example` documenting that `.env` is dev-only.
  - [x] Sanitized `samples/scan/result/{sample,second}.raw` — org SSIDs
        (`Tom Sawyer Labs`, `TwillTech Secure`) and BSSIDs replaced with
        example values, fixed-width columns preserved. These files have
        no code references (grep-verified), so they're inert fixtures.
  - [x] Fixed stale GitHub URLs → `TomSawyerLabs/practice-field-management-system`
        (`StatusBar.tsx:249`, `public.html:67`).
  - [x] Documented the missing `pause.wav` in `docs/match-system.md`
        rather than fabricating audio — the server `existsSync`-checks
        each sound, so a missing file is silent, not an error. **User
        should record/add a pause cue if wanted.**
- [ ] Stage 1 — make misconfiguration visible (startup-check buffer +
      `/admin` System Status panel)
- [ ] Stage 2 — Site Profile store (branding, theme, feature toggles)
- [ ] Stage 2b — field-layout config (station count/labels, VLAN map,
      port names) per decision #1; **depends on Stage 2's store existing**
- [ ] Stage 3 — installer + generalized `update.sh`

## Open questions for the user

1. **Scope of "custom styles"** — is this (a) branding only: name, logo,
   colors, favicon; (b) branding + field layout (station count/labels,
   port names); or (c) full per-site feature toggles (which pages/roles
   exist, whether scoring/support/staff are enabled)? Recommendation: do
   (a) + (c-lite) — a single "Site Profile" settings store — since (b)
   partly exists already via `FIELD_PORTS`.
2. **Config surface** — admin UI (persisted JSON, editable live) vs a
   config file vs env vars? Recommendation: **admin UI + JSON store**,
   following the existing `slackConfig` pattern, because the target
   adopter is a mentor, not a sysadmin, and env changes need a restart.
3. **How much do we support?** Documentation-only ("here's how"), or an
   actual guided setup wizard in the app? Recommendation: both, staged —
   docs first (cheap), first-run wizard second.
4. Does the user want a LICENSE added, and which? (ISC is already
   declared in package.json.)

## Things not to do

- Don't fork-per-site. The whole point is one codebase, per-site config.
- Don't put site config in env vars only — restart-required config is
  hostile to the non-sysadmin adopter.
- Don't touch the reference deployment (steamboat/Caddy/DNS) as part of
  this work — infrastructure changes need explicit per-change
  authorization.
