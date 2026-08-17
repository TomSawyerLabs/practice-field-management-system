# Match Startup / Ready-Up Flow Overhaul (pFMS)

## Goal

Rework practice-match startup so teams can't sit "ready" indefinitely, and make
the start deliberate and physically held:

1. **Host-gated ready check.** New flow:
   `join → wait for all teams to join → host "asks for ready" → teams AND
non-team staff (refs / safety monitors / scorekeepers) ready up digitally →
host starts when all required are ready`. Teams **cannot** ready up until the
   host opens the ready check.
2. **Hold-to-start.** The start control is press-and-hold: the host must hold it
   for the entire 3-2-1 countdown. Releasing **before** robots are enabled
   (before the `countdown→auto` transition) aborts: immediately cut auto output
   and play a **fault sound**. Releasing **after** robots are enabled (while the
   start horn plays) does nothing.
3. **Driver-station pop-up sound toggle.** The match pop-out window
   (`AStopPopout`) can play match audio, with a mute toggle. **Default muted**
   (pop-up is often next to the field speaker). Persist per device.

## Environment / context

- Repo: this repo (branch: master)
- Tooling: **bun** (`bun run typecheck`). Pre-commit lefthook = typecheck +
  prettier --check. No test suite; verify = typecheck + manual.
- Commit subjects are **user-facing** (posted to pfms-support Slack on deploy) —
  short prose, lead with the user-visible effect. End with Co-Authored-By.
- Shared working tree: only stage our own changes; other Claude threads may have
  uncommitted work. `.agent.status` append-only work log exists at repo root.
- Date started: 2026-07-20

## Decisions already made (don't re-ask)

- **Staff model (user, 2026-07-20):** _dedicated role pages that the match
  starter can toggle to "ignore"._ So: a fixed set of staff roles, each with its
  own page/device to ready up; the host can mark any role "ignored" (not required
  for this match) — which is how a self-service match with no staff still starts.
- **Pop-up audio default (user, 2026-07-20):** default **muted**, per-device
  persisted toggle (mirror the scoreboard's mute pattern).

### Proposed defaults (mine — easy to change, flag if wrong)

- **Staff role set:** `headRef`, `scorekeeper`, `safety`. A single list constant
  (`StaffRoleList`) so it's trivial to add/remove roles.
- **Staff page URL:** `/staff?role=<role>` (bookmarkable per device), served by
  one `staff.html` entry; role read from the query. _Chosen over `/staff/<role>`
  because prod serves static files via Caddy extension-less rewrites
  (`/match`→`match.html`); a nested path wouldn't map without a new server rule,
  and infra is off-limits. `/staff` maps exactly like `/match`._ No role in the
  query → in-page role picker.
- **Fault sound:** reuse existing `sounds/abort.wav` (no new asset needed). A
  dedicated `fault.wav` can be dropped in later — the code will play a
  `'fault'`-named sound that falls back to abort if the file is absent, OR just
  reuse `'abort'`. (Start by reusing `abort`.)
- **Fault trigger unification:** ANY `countdown → created` transition is an
  abandoned start → play the fault sound + cut output. This covers the new
  hold-release, the existing host "Abort Countdown" button, and a team tapping
  "Not Ready" during countdown.

## Key findings (explored 2026-07-20)

### Backend match model

- `src/matchEngine.ts` — single `MatchEngine`. Phases: `idle | created |
countdown | auto | autoPause | paused | teleop | endgame | postMatch`.
- Ready is per-station only: `StationControlState.ready`
  (`src/types.ts:446-469`). Set via `setReady(station, ready)` (matchEngine
  ~353), gated only on `phase === 'created'` + `joined` (NOT on dsAttached —
  that gate was removed as unreliable, comment ~378-383).
- `startMatch()` (~416): requires ≥1 joined + all joined ready; → `countdown`
  (3s). `abortCountdown()` (~509): `countdown → created`, keeps stations
  joined+ready, disables + `sendPacketsToAll()`. `holdStart(ms)` (~412) blocks
  starts briefly (get-ready announcement).
- `MatchState` (`types.ts:506-535`) is the WS broadcast; add fields here and
  they flow to all clients automatically.
- **No non-team roles exist anywhere** — refs/safety/scorekeeper is entirely new.

### WS command layer

- Inbound message types + `isX` guards in `src/types.ts` ("Match Controller
  messages" ~683). Dispatched in `src/websocketServer.ts` `ws.on('message')`
  if/else chain (~559-1128); each match message → a `MatchEngine` method.
- Frontend senders: thin `send*` helpers in `frontend/src/hooks/useBackend.ts`
  (~893-1019); inbound fans out through an `EventTarget` bus; `useMatchState()`
  (~837) is the state hook. `onPlayGetReady` (~1385) shows the one-shot
  broadcast pattern (server → all clients play a sound) — template for a fault
  broadcast if needed.

### Audio

- Server: `src/matchAudio.ts` — `MatchAudio.attachToEngine` maps phase
  transitions → `aplay`/etc. `.wav`. Countdown is a single pre-timed
  "3…2…1…<horn>" clip; the ALSA device is **exclusive** so back-to-back clips
  race (why `holdStart` exists). On `countdown→(not auto/teleop)` it kills the
  clip and currently plays nothing. `postMatch` stopped/estop/abandoned →
  `abort.wav`.
- Browser: `frontend/src/hooks/useMatchAudio.ts` — mirror logic with preloaded
  `HTMLAudioElement`s. `MatchAudioBridge` renderless component mounted on
  `/match` and the scoreboard. `stopAllSounds()` exists. Scoreboard already has
  a persisted mute toggle (`ScoreboardPage.tsx`, `localStorage` key
  `scoreboard-muted`) — the pattern to copy for the pop-up.
- Sounds present in `sounds/`: abort, countdown1-4, end, resume, start, warning,
  getready. (No `pause`/`fault` file.)

### Frontend pages

- Page = `<name>.html` (frontend root) + `roots/<name>.tsx` + a `rollupOptions`
  input + a dev URL rewrite, all in `frontend/vite.config.ts` (rewrites ~62-92,
  build inputs ~158-171). That's the only routing surface.
- Host page: `frontend/src/components/MatchControlPage.tsx` — `CreatedView`
  (~203) holds the ready list + "📢 Get Ready" + **"Start Countdown"**
  (plain click → `sendStationStartMatch`) + "Cancel Match". `allReady` (~212).
- Team ready UIs: `MatchPanel.tsx` (Ready toggle ~350/629 → `sendStationReady`)
  and the pop-out `AStopPopout.tsx` (giant READY UP → `sendStationReady`). The
  pop-out is a **hand-built separate window** (not React DOM); it plays **no
  sound** today.

## Design

### Backend (`types.ts`, `matchEngine.ts`, `websocketServer.ts`)

**Staff types (`types.ts`):**

```ts
export type StaffRole = 'headRef' | 'scorekeeper' | 'safety';
export const StaffRoleList: StaffRole[] = ['headRef', 'scorekeeper', 'safety'];
export type StaffRoleState = { ready: boolean; ignored: boolean; connected: boolean };
```

**`MatchState` additions:** `readyRequested: boolean`,
`staffStates: Record<StaffRole, StaffRoleState>`.

**Engine additions:**

- `private readyRequested = false;` and `private staffStates` map + a
  `lastStaffHeartbeat` map (connection via heartbeat + stale sweep, mirroring
  `dsConnections`).
- `setReadyRequested(v)` — only in `created`. Turning off clears all station +
  staff ready.
- `setReady` rejected unless `readyRequested`.
- Any participant-set change (join / leave / swap / kick / updateMatchConfig)
  resets `readyRequested = false` and clears all ready (start check must be
  re-opened once the roster changes).
- `setStaffReady(role, ready)` — only in `created`, `readyRequested`, not
  ignored.
- `setStaffIgnored(role, ignored)` — match-starter action; only in `created`;
  ignoring clears that role's ready.
- `staffHeartbeat(role)` + sweep → `connected`.
- **Start gate** (`startMatch` + broadcast `allReady`): `readyRequested` && ≥1
  joined station && every joined station ready && every **non-ignored** staff
  role ready. A non-ignored role with nobody connected simply can't be ready →
  host must ignore it or wait (intended friction).
- `createMatch`/`clearMatch`/`cancelMatch`/`abandonMatch` reset
  `readyRequested=false` + staff ready/ignored.

**WS messages (types.ts guards + websocketServer dispatch + useBackend senders):**

- `matchRequestReady { requested }` → `setReadyRequested`
- `staffReady { role, ready }` → `setStaffReady`
- `staffIgnore { role, ignored }` → `setStaffIgnored`
- `staffHeartbeat { role }` → `staffHeartbeat`

### Fault sound (`matchAudio.ts`, `useMatchAudio.ts`)

- On `countdown → created`: after killing the countdown clip, **play the fault
  sound** (`abort`) instead of going silent. Same change in both server and
  browser mirror. Cutting output is already handled by `abortCountdown`
  (disable + resend). Gotcha: exclusive ALSA device — kill then play; small
  race acceptable (note it).

### Hold-to-start (frontend, `MatchControlPage.tsx`)

- Replace the "Start Countdown" click with a press-and-hold button:
  - `pointerdown` (enabled only when `allReady` && !getReadyHold) →
    `sendStationStartMatch()`.
  - `pointerup` / `pointercancel` / `pointerleave`: if the current phase is
    still `countdown` → `sendMatchAbortCountdown()` (fault). If phase is already
    `auto`/`teleop`/beyond → no-op (release during the horn is fine).
  - Visual: "HOLD TO START", fills/animates over the 3s; on release-abort the
    countdown aborts and the fault plays. Disable text-selection / blur.
- Backend needs no new method — `stationStartMatch` + `matchAbortCountdown`
  already exist; the fault comes from the audio change above.

### Team ready gating (`MatchPanel.tsx`, `AStopPopout.tsx`)

- Ready buttons disabled until `readyRequested`; show hint "Waiting for the host
  to open the ready check." (In the pop-out, the READY UP button greys out with
  the hint.)

### Staff role page (`staff.html`, `roots/staff.tsx`, `components/StaffPage.tsx`,

`vite.config.ts`, `useBackend.ts`)

- `/staff/<role>` → `staff.html`; role parsed from the path (fallback: in-page
  picker). Sends `staffHeartbeat` on an interval, shows a big READY UP button
  (enabled only when `readyRequested` && !ignored), the role's ignored/connected
  state, and the overall match ready summary. Uses `useMatchState()`.

### Host staff panel (`MatchControlPage.tsx` CreatedView)

- New "Ask for Ready" / "Retract ready check" button → `matchRequestReady`.
- Staff roles panel: each role shows connected + ready, with an
  **Ignore / Require** toggle → `staffIgnore`. `allReady` extended to include
  non-ignored staff.

### Pop-up sound toggle (`AStopPopout.tsx`, `useMatchAudio.ts`)

- New `localStorage` key `pfms-match-popup-muted`, **default '1' (muted)**.
- Add a 🔇/🔊 toggle button to the pop-out DOM (setup + match modes).
- Play audio from the React `AStopPopout` component (opener tree; audio unlocked
  by the Join click) when `joined && !muted`. Refactor `useMatchAudio` to accept
  an `enabled` flag (default true) and reuse it; `stopAllSounds()` on mute.
  (Station pages don't mount `MatchAudioBridge`, so no double-play.)

## Plan / steps (commit per phase; typecheck each)

1. **[current] Backend: ready-request gate + staff roles + start gate**
   (types, matchEngine, websocketServer, useBackend senders). Typecheck.
2. **Fault sound on abandoned start** (matchAudio.ts + useMatchAudio.ts).
3. **Host UI: Ask-for-Ready + staff panel + Ignore toggles + hold-to-start**
   (MatchControlPage, useBackend).
4. **Team ready gating** (MatchPanel, AStopPopout READY UP disabled pre-ask).
5. **Staff role page** (staff.html, roots/staff.tsx, StaffPage, vite.config).
6. **Pop-up sound toggle** (AStopPopout + useMatchAudio `enabled` refactor).
7. **Verify** end-to-end (drive the flow), update README if needed.

## Findings / gotchas

- **Shared-tree commit blocker (2026-07-20):** the pre-commit hook runs
  `bun run typecheck` = project-wide `tsc --noEmit && tsc --noEmit -p frontend`.
  A peer (scoreboard-video-agent) has `frontend/src/components/ScoreboardPage.tsx`
  uncommitted and **broken** (`dense`/`fill` errors, `plans/scoreboard-6team-density.md`).
  → NO commit (even backend-only) passes the hook until their file compiles. Do
  not `--no-verify` and do not touch their file. Plan: implement all phases,
  hold commits until the tree is green (or coordinate). Backend `tsc` passes now.
- Backend Phase 1 typechecks clean on its own (first `tsc` in the chain passes).

## Progress log

- [x] Explored backend match model, audio, WS layer, frontend pages
      (2026-07-20). Two Explore agents; findings above.
- [x] User answered scope questions: dedicated staff role pages w/ host "ignore"
      toggle; pop-up audio default muted.
- [x] Phase 1 — backend ready-check gate + staff roles + start gate
      (types.ts, matchEngine.ts, websocketServer.ts, useBackend senders). Backend
      typechecks clean.
- [x] Phase 2 — fault sound on abandoned start (matchAudio.ts + useMatchAudio.ts;
      reuses abort.wav; unified for all countdown→created transitions).
- [x] Phase 3 — host UI: Ask-for-Ready + Field Staff panel w/ Ignore/Require
      toggles + hold-to-start button (module-level window release watcher survives
      the created→countdown unmount; defeats implicit pointer capture for iOS touch;
      closes the quick-tap race via holdAbortWanted). + "keep holding" countdown hint.
- [x] Phase 4 — team ready gating: Ready buttons show "Waiting for host…" and are
      disabled until the check opens (MatchPanel ×2, AStopPopout READY UP).
- [x] Phase 5 — staff page: staff.html + roots/staff.tsx + StaffPage.tsx +
      vite.config (`/staff` dev rewrite + rollup input). URL `/staff?role=…`; prod
      `try_files $uri.html` serves it with no infra change (confirmed via README).
- [x] Phase 6 — pop-up sound toggle: useMatchAudio gains `enabled`; AStopPopout
      plays audio scoped to the open pop-out serving that station (no 6× echo on
      overview pages), 🔊/🔇 toggle in the window, default muted, persisted.
- [x] Engine verification: scripts/test-ready-check.ts — 15/15 PASS (gate,
      staff start-gate, ignore-clears-ready, roster re-close, cross-match persist).
- [x] README updated (pages table + match flow steps 2-6).
- [ ] **BLOCKED on commit:** peer's ScoreboardPage.tsx still breaks the
      project-wide pre-commit typecheck. Holding all commits until it compiles.
- [ ] Interactive UI verification (hold-to-start feel, pop-up audio toggle,
      staff page) — pending; engine logic + typecheck done.

## Open questions for the user

1. Staff role set — proposed `headRef`, `scorekeeper`, `safety`. Add/rename?
   (Trivial to change; not blocking phase 1.)

## Things not to do

- Don't gate ready on `dsAttached` — that signal was removed as unreliable.
- Don't play a second server clip back-to-back without killing the first — the
  ALSA device is exclusive (dropped audio).
- Don't reset staff `ignored` on roster change OR on a new match — it PERSISTS
  across matches (session-level config: a self-service field ignores staff once,
  a staffed event requires once). Only `ready` resets per match; `ignored`
  resets only on server restart. (Default at startup: all roles required.)
- Don't add `title=` tooltips anywhere (global rule).
