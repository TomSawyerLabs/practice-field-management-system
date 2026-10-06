# /recordings page, and admin / video performance

## Goal

Cameron (2026-10-06):

1. The video admin UI (Match Video Recording, Field Timelapse, Recordings on
   Disk) moves off `/admin` onto its own page, **`/recordings`**.
2. "We have some performance issues it seems." Asked which: **all of** —
   `/admin` slow to load, `/admin` janky once loaded, videos/thumbnails slow.
   Find and fix every real cause.

Round 2 (after the first deploy, same day):

3. "/recordings is open to everyone. It should not allow reconfiguring of
   video settings." → `/recordings` becomes a **no-login viewing page**;
   all video _settings_ go back to `/admin`.
4. "/admin needs something more… maybe tabs." → **5 tabs**, Global E-stop
   pinned above them.
5. "Remove the match status from admin."

## Environment / context

- Pages are multi-page Vite entries: `frontend/<name>.html` →
  `frontend/src/roots/<name>.tsx`, listed in `frontend/vite.config.ts`
  (`rollupOptions.input` + the dev `stationRoutes` rewrite).
- Production: `src/staticServer.ts` maps clean URLs to `<name>.html`
  automatically. Caddy (`ops/servers/steamboat/sites.d/pfms.caddy`) gates
  every external path except `/admin`, `/scores`… behind the auth check and
  `try_files {path} {path}.html` — so `/recordings` works like `/timelapse`
  with **no Caddy change**.
- Admin sections live in `frontend/src/components/AdminPage.tsx`
  (`MatchRecordingSection` is inline, ~L1326–1597);
  `TimelapseSection.tsx`, `RecordingsInventorySection.tsx` are separate.
- steamboat (measured 2026-10-06): `recordings/` 21 GB, 145 dirs, 1258 files
  (621 under `.timelapse`; `active` 1.1 GB, `frames` 143 MB). Full stat walk
  of the tree: **0.01 s** — server-side sync walks are not the problem at
  this size. 144 match/clip mp4s, only 90 `.thumb.jpg`.
- Every websocket client gets ~200 kB on connect, 122 kB of it
  `matchHistoryState`; idle steady-state is a trickle. Bundles: useBackend
  415 kB, wrap 282 kB, admin 128 kB (minified).

## Decisions already made (don't re-ask)

- Path is `/recordings` (Cameron offered `/videos` or `/recordings`; the
  existing on-disk/API naming is "recordings").
- Fix all perf causes found, not just one symptom.
- `/recordings`: **anyone, no login** — browse/watch match videos, practice
  clips and the timelapse (so `/timelapse` opens up too). Delete, bulk
  delete, build film and delete film show only to a logged-in admin and stay
  admin-gated on the server. Settings (streams, retention, timelapse
  config, capture now) live only in `/admin` → Video.
- `/admin` tabs (URL hash like the team page): **Match** (field reset,
  out-of-match control, controller policy, Teams & Controls) · **Wi-Fi**
  (pending radio changes, Wi-Fi cards, robot Wi-Fi scan, 6 GHz watch, radio
  firmware) · **Video** (match recording streams, timelapse settings, link
  to /recordings) · **Scoring & integrations** (scoring, API keys, Slack,
  match audio) · **Access** (external access tokens). Global E-stop pinned
  above the tabs.
- Match status card removed from /admin. Its **Force Stop Match** button is
  the only soft stop anywhere (/match only aborts countdowns), so it moves
  next to the pinned E-stop, shown only while a match runs.

## Findings / gotchas

- **Admin auth is per websocket** (`adminConnections.has(ws)`), and
  `AdminAuthGate` sends its stored token once (`authCheckSent` never
  resets). After any reconnect — every deploy restarts pFMS — an open
  /admin still renders but the server refuses its admin actions. Fix: the
  socket layer re-sends the stored token on every (re)connect.
- Server already admin-gates every state change the public page could
  reach: `deleteRecording(s)`, `renderTimelapse`, `deleteTimelapseRender`,
  `captureTimelapseFrame`, `updateSetupSettings`. Only
  `requestRecordingsInventory` needs opening.

- `TimelapseSection` re-fetches `/api/timelapse` listing whenever
  `state.sessionBytes` changes — which is every 15 s tick while the fast
  timelapse is capturing — and re-renders up to 30 days of thumbnails.
- `MatchRecorder.thumbnail()` dedupes per file but has **no concurrency cap**:
  a table of rows without thumbnails spawns ffprobe+ffmpeg per row at once.
- Can't profile live `/admin` without the passphrase → profiled locally:
  metadata-only copy of steamboat's recordings in
  `C:\Users\camer\pfms-perf-sample\` (mp4s are empty placeholders, so
  uncached thumbnails fail there in ~1.5 s instead of generating), dry-run
  backend run from that dir (`DRY_RUN=1 MATCH_RECORDINGS_DIR=…`), Vite on
  5173, local passphrase `localperf`.
- **Measured /admin load (local, real data):** 25 thumbnail requests summing
  53.8 s of request time (max 3 s), 19 timelapse stills up to 2 s each, the
  timelapse listing 575 ms — yet each endpoint alone is fast: cached thumb
  6 ms local / ~25 ms prod, listing 20 ms local and prod. **Cause: browser
  HTTP/1.1 limit of 6 connections per origin** (pfms.tsl is plain http);
  every uncached thumbnail holds a slot for ffprobe+ffmpeg while everything
  else on the page queues behind it.
- Thumbnail generation on steamboat: ffprobe 0.24 s + ffmpeg 0.49 s, works.
  15 of the newest 40 recordings (recent practice clips) have no thumb yet —
  never requested, so the first admin view pays for them all at once.
- Idle /admin: no long tasks over 10 s (dev build). DOM 2418 nodes, 82 imgs.
  Initial load: 3 long tasks, 666 ms total, longest 301 ms (dev build).
- `/api/timelapse/list` and thumbnails answer without admin auth on the LAN
  (Caddy gates them externally). Not changed here.
- Practice clips are finished by `PracticeRecorder`, which has no hook into
  `MatchRecorder`; the thumbnail warm-up finds them with a 5-minute rescan
  (a readdir of ~145 dirs) instead of new wiring.
- With `loading="lazy"`, `/recordings` only requests the thumbnails in view;
  the uncached ones in the sample sit past row 25 (behind "Show all").
- The T3 preview browser host dropped mid-task; measurements were finished
  with headless Chromium (`playwright-core` in
  `C:\Users\camer\pfms-perf-sample\harness\`, `bun measure.ts <url> <label>`;
  it logs in with `localperf`, clicks Show all and scrolls).
- **Before/after (local copy, Show all + scroll, 42 thumbnails, 54 real
  uncached clips):**

  | Run                   | Slowest thumb | Total thumb time | Scroll → all in |
  | --------------------- | ------------- | ---------------- | --------------- |
  | A: before (`3e6349f`) | 3.9 s         | 45.1 s           | 5.5 s           |
  | B: after, cold (cap)  | 3.4 s         | 37.8 s           | 4.6 s           |
  | C: after, warmed      | 0.21 s        | 4.4 s            | 1.7 s           |

  Warm-up made all 54 in 25 s. The ~0.9 s on the timelapse listing in these
  runs is the Vite dev server (≈200 module requests on the same 6
  connections, StrictMode double-fetch); curl times it at 20 ms.

## Plan / steps

1. ~~Profile locally~~ — done, see Findings.
2. ~~`/recordings` page~~ — `a5fd57e`.
3. ~~Perf fixes~~ — timelapse listing refetch `3e6349f`; thumbnail warm-up
   and cap `4559638`.
4. ~~Typecheck, tests (836 pass), production build~~ — done.
5. ~~Deploy to steamboat~~ — `42fddcd` deployed 2026-10-06 15:38. The log
   showed `making 54 missing thumbnail(s) in the background` at 15:39:17
   (one minute after start); thumbnails went from 90 to 144 of 144 mp4s
   with no failures. `http://pfms.tsl/recordings` → 200, title Recordings.
6. ~~Round 2~~ — log redaction `bc5ab21`, admin re-auth on reconnect
   `9407804`, tabs + public /recordings + /timelapse `574aa3e`. Verified
   locally with headless Chromium (`harness/e2e.ts`: 20/20; and
   `harness/reconnect.ts`: delete accepted after a real backend restart,
   log shows `token: '***'`). 841 tests pass.
7. **(current)** Deploy round 2 — waiting on Cameron's go-ahead.

## Progress log

- [x] Mapped code, routing, Caddy; measured steamboat disk + ws traffic
- [x] Local profile (load is request-queue bound, not render bound)
- [x] /recordings page (`a5fd57e`)
- [x] Timelapse listing no longer refetches every 15 s (`3e6349f`)
- [x] Thumbnail background warm-up + on-demand cap of 2 (`4559638`)
- [x] Verified: tests, typecheck, prod build emits `recordings.html`,
      headless before/after measurement
- [x] Logged the 122 kB `matchHistoryState`-on-connect issue in ISSUES.md
      (bigger fix, out of scope)
- [x] Deployed `42fddcd` to steamboat; warm-up filled all 144 thumbnails
- [x] Server log no longer records passphrase / tokens (`bc5ab21`)
- [x] Open admin pages re-authenticate after reconnect (`9407804`)
- [x] /admin tabs, match status removed, Force stop beside E-STOP;
      video settings only in Admin → Video; /recordings and /timelapse
      open to anyone, admin controls only for admins (`574aa3e`)
- [ ] Deploy round 2 (needs go-ahead)

## Open questions for the user

1. Deploy round 2 to steamboat? (Recommended: yes.)
2. steamboat's journal (last 30 days) holds 3 admin login / set-passphrase
   messages **with the passphrase in plain text**, and every admin
   reconnect logged its session token. Recommended: change the admin
   passphrase after deploying, and consider vacuuming the pFMS journal —
   both are server changes that need an explicit yes.
3. "Open to anyone" is on the field network only: Caddy still sends
   external visitors to /recordings through the external-access check.
   Opening it to the internet would be a Caddy (ops) change.

## Things not to do

- Don't touch Caddy/ops — not needed, and needs per-change authorization.
- Don't bypass the admin passphrase on steamboat to profile.
