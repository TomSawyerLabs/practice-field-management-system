# /timelapse — admin timelapse viewer with an event timeline

## Goal

Cameron (2026-09-30):

1. A **`/timelapse` page for admins to watch timelapses**: a timeline with a
   high-performance scrub. The timeline also shows **detected robots,
   matches and enables**, decimated gracefully when there are too many in a
   short period. Not every captured video — **one logical timeline**.
2. Teams keep access to their own recordings (station page, `/practice/<token>`
   links) — unchanged.
3. **"Record while enabled" on by default for every team.**

## Environment / context

- Video source: the existing fast timelapse (`src/fieldTimelapse.ts`),
  `recordings/.timelapse/active/<localDay>/<slug>-HHMMSS.mp4`. Fragmented MP4
  (`empty_moov`), 1920×1714, 30 fps playback, `-g 30`. Rotated every 30 min,
  stopped during matches (phase not idle/created) and 5 min after the last
  telemetry packet.
- Measured on real chunks from steamboat (2026-09-27, an event day, copied
  read-only to `C:\Users\camer\pfms-timelapse-sample\`): **exactly 2.0 s of
  field time per frame** (900 frames / 1800 s; 825 / 1650 s) → 60× playback.
  A linear wall↔media map per chunk is accurate.
- 24 chunks that day but only 19 have a `timelapse.json` session entry — the
  others were cut short by restarts (deploys) and never got `closeChunk`.
  **The timeline must be built from disk, not the log.**
- steamboat: 387 GB free of 468 GB; `recordings/` 13 GB; `.timelapse` is
  167 MB of chunks + 87 MB of frames. `practice-recordings.json`: optIn
  `[1700, 6238, 8048]`, **0 practice runs ever recorded**.
- Robot/enable history: nothing persisted today except `usage-data.json`
  (radio-link sessions that bridge drops of up to 2 h, so too coarse for
  "robot detected") and practice runs (opted-in teams only). Matches:
  `match-history.json` (max 250 entries).
- Telemetry arrives per station through the coalescer in `index.ts`
  (`TelemetryUpdate.dsStatus.enabled`); radio link state through
  `radioManager.addStatusListener` (`stationStatuses[s].isLinked`).

## Decisions already made (don't re-ask)

- Day unit on the page is the **practice day, 04:00 → 04:00** (same as
  practice links), so a late session is one timeline.
- `/timelapse` is gated by `AdminAuthGate` like `/admin`. Data endpoints
  follow the existing `/api/timelapse/*` trust model (field network +
  Caddy cookie gate from outside).

## Design (my choices; reasons inline)

### Backend

1. **Field activity log** (`src/fieldActivityLog.ts`): precise spans, JSONL
   per local day under `.timelapse/activity/`. Kinds:
   - `robot` — station has a robot: radio linked **or** telemetry in the last
     15 s; keyed by the team configured on that station.
   - `enable` — `dsStatus.enabled` true→false per station (15 s silence = off).
   - `match` — copied from match history when an entry appears, so matches
     survive history roll-off (250 entries).
     Open spans are checkpointed to `activity/open.json` (every 30 s) and closed
     at their last-seen time after a restart.
2. **Chunk finalize**: when a chunk closes, write a sidecar
   `<base>.json` (start, end, media seconds, frames, size), remux to
   **faststart** (instant seeking; the match recorder does the same for the
   same reason) and build a **scrub sprite** `<base>.scrub.jpg` (160 px
   tiles, one per 10 output frames = 20 s of field time at 60×). A background
   queue backfills chunks that predate this, one at a time, never during a
   match.
3. **Matches fill the gap**: when a match recording finishes, derive a
   timelapse chunk from its MP4 at the same settings (keyframe-only decode of
   a file — seconds of CPU), so the logical timeline has no hole per match.
   Honors "don't run the timelapse decoder during a match".
4. **Timeline API** `GET /api/timelapse/timeline?from&to&stream` merges all
   of it into one response: segments (overlaps trimmed: earlier wins),
   archival stills, matches, robot spans, enable spans, streams, live chunk.
   Pure merge logic in `src/timelapseTimeline.ts` (unit-tested).
   `GET /api/timelapse/days` indexes practice days with video/activity.
   Backfill for days before the log: robots from usage sessions, enables from
   practice runs, matches from history.

### Frontend (`/timelapse`)

- Player: pool of `<video>` elements (current + preloaded next), sprite
  overlay canvas for instant preview while dragging, archival still in gaps.
- Timeline: two stacked canvases (static layer redrawn on view/data change;
  overlay with playhead/hover per frame). Lanes: video coverage + filmstrip
  (sprites) + archival frame ticks; matches; aggregate field lane; one lane
  per team (robot presence muted, enables solid).
- Decimation: per lane, spans whose gap is < 3 px at the current zoom merge
  into a cluster (count + duty shading + "×N" label when it fits).
- Scrub: pointer drag → sprite tile instantly + one in-flight video seek at
  a time (latest target wins). Wheel zoom around cursor, drag to pan, keys.
- Playback walks segments across gaps; speed menu; deep link
  `?day=&t=`.

### Default-on recording

- `PracticeStore` persists `optOut` (v2). Everyone records unless their
  station page unticks it. Old `optIn` lists are ignored (they are a subset
  of "everyone").

## Findings / gotchas

- (see Environment) chunks without log entries; exact 2 s/frame.
- **Finalize on the real 2026-09-27 day**
  (`C:\Users\camer\pfms-timelapse-sample\finalize-real.ts`): 24 chunks in
  46 s on the desktop (~2 s each; expect 2–3× on steamboat — background, one
  at a time). Every chunk measured 59.4–60.5× except two sub-10 s stubs
  (67×, 70× — startup latency dominates). Match 7 and 8 recordings
  (153–158 s) → chunks in ~10 s each, placed exactly into their gaps; the
  overlap with the live chunk's pre-roll was trimmed (media 0.12–0.18 s in).
- The ~2 min holes after each match on 09-27 are the post-match count
  (capture only ran in idle/created). It now also runs in `postMatch`.
- **Caching trap:** chunks are remuxed in place after they close, and the
  live one grows. The old API sent `max-age=86400` for every chunk; a cached
  fragmented copy mixed with range reads of the remuxed file would decode
  garbage. Unfinalized chunks now go out `no-store`
  (`FieldTimelapse.isChunkFinal`); the page must also reload a `<video>`
  when a segment goes from estimated to final.
- Telemetry-only presence first stretched `lastSeen` to "now" on every tick
  (the robot span ran 10 s past the last packet). Fixed: evidence time is
  the packet time unless the radio says linked.
- **Browser verification** (headless real Chrome via playwright-core in
  `C:\Users\camer\pfms-timelapse-sample\pw\check.mjs`, against
  `harness.ts`, which serves only the timelapse API plus a stub admin `/ws`;
  the full backend was NOT run locally because its deploy announcer posts to
  Slack). Real chunks + real robots/matches; **enables were synthetic**
  (no log existed on 09-27). Results: opens on the exact frame; 3 s of play
  = 3 min of field time; playback crosses chunk boundaries and skips gaps;
  61 scrub moves → 47 landed seeks; gaps show the archival still.
- Bugs found that way and fixed: the gap caption claimed "no robots" during
  a match whose recording wasn't in the sample (now "no timelapse video");
  the hover preview was clipped by the timeline's scroll box (now
  `position: fixed`); the URL throttle dropped the final scrub position
  (trailing write); a deep link outside the day's activity opened with the
  playhead off-screen; the header summary sat under the support widget.
- The in-app T3 preview host was unavailable; Playwright's bundled Chromium
  can't decode H.264 — use `channel: 'chrome'`.
- `frontend` ESLint is broken in this checkout (`typescript-eslint` not
  installed); not part of the pre-commit hook. Typecheck is the gate.
- Bash heredocs with backticks, and Python string literals containing
  `C:\Users`, both break. Write patch scripts with the Write tool
  (`C:\Users\camer\pfms-timelapse-sample\patch_*.py`) and keep Windows paths
  out of Python literals.

## Progress log

- [x] Survey code + steamboat data (read-only), sample day copied locally.
- [x] Practice opt-out default (store, state type, station card, docs) —
      `33e79c1`.
- [x] Activity log + wiring + tests — `fa9af4b`.
- [x] Chunk finalize (sidecar, faststart, sprite) + backfill queue + tests.
- [x] Match-derived chunks (+ capture resumes in post-match).
- [x] Timeline merge module + API + tests; verified on the real day.
- [x] `/timelapse` page (routing: vite input, dev route; the static server
      maps clean URLs already), link from Admin → Field Timelapse.
- [x] Verified in headless Chrome against the real sample day.
- [x] Docs (match-system.md, README), commits.
- [ ] Deploy to steamboat — needs Cameron's go-ahead (`deploy` skill). On
      first start it finalizes the existing chunks in the background (~24
      on disk; a few seconds each).
- [ ] After deploy: open `/timelapse` on a real practice night and check
      enables/robots against what happened; check the first match-derived
      chunk appears a few seconds after a match.

## Open questions for the user

1. **Storage with default-on recording.** Every enabled robot now gets its own
   full-rate clip (~5.5 GB per hour of enable time; overlapping robots each
   get their own copy). There is still no disk-pressure eviction
   (practice-recording plan item 19). Recommendation: a free-space floor
   that stops _new_ practice clips (deletes nothing) and warns on the admin
   page, until the eviction policy is decided.
2. With everyone on, the "nobody in Slack claims team N" note goes to the
   support channel once per team per day for every unclaimed team.
   Recommendation: fold those into one daily note.

## Things not to do

- Don't trust `timelapse.json` sessions as the list of chunks.
- Don't run the timelapse encoder during a match (derive from the match MP4).
