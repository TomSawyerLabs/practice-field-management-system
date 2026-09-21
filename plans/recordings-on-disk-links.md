# Admin → Recordings on Disk: watch what's there, not just its size

## Goal

The admin page's **Recordings on Disk** section (added 2026-09-19, `100f4db`)
is an inventory and an eviction lever: how many recordings, how big, whose,
and a delete button. What it cannot do is show you the recording. Deciding
whether a directory is worth keeping — or whether a stream was pointed at the
wrong camera all evening — means going to the station page, or to a team's
practice-day link, neither of which an admin has to hand.

Cameron (2026-09-21): "'Recordings on Disk' admin section needs to have links
to view/thumbnails/etc."

So: every row gets a poster thumbnail, an inline player, per-stream downloads,
the metadata sidecars, and a link to the match summary when there is one.

## Environment / context

- Backend: Node 22 on steamboat (`node dist`), Bun locally. Recordings live in
  `recordings/<id>/` — one directory per match or practice run, holding
  `<slug>.mp4` per stream, `recording.json` (the manifest), and the sidecars
  `metadata.json` / `scores.csv` / `telemetry.csv`.
- ffmpeg 7.1 on steamboat; `MatchRecorder` already owns paths to `ffmpeg` and
  `ffprobe` (`FFMPEG_PATH` / `FFPROBE_PATH` env overrides).
- `GET /api/recordings/<id>/<file>.mp4` already streams video with Range
  support and `?download=1` for a friendly attachment name
  (`src/recordingsApi.ts`). It is unauthenticated on the field LAN; from
  outside, Caddy's cookie check guards all of `/api/*`.
- The inventory is scanned on demand and sent over the websocket
  (`MatchRecorder.inventory()` → `RecordingsInventory`), not broadcast.
- The public practice-day page (`/practice/<token>`) already plays videos and
  links the sidecars — this is the same idea for the admin, without tokens.

## Decisions already made (don't re-ask)

- **Thumbnails are generated on demand and cached on disk**, beside the video
  as `<slug>.thumb.jpg`. Generating at record time would leave every existing
  recording without one and add work to the end of a match, which is the
  busiest moment the recorder has. On demand means the cost is paid once, by
  whoever looks.
- **The poster frame comes from a little way in**, not from frame 0: a match
  recording starts on the pre-roll, so its first frame is an empty field
  during the countdown. 25% in, capped at 30 s, for anything longer than 8 s.
- **Thumbnails live inside the recording directory**, so deleting a recording
  (or the retention sweep) takes them with it, and they are counted in the
  directory's size like anything else. The practice-day zip lists its files
  explicitly, so thumbs don't ride along in a team's download.
- **The inventory carries each entry's files.** The table could not link to
  anything without them: the old entry only had a _count_ of usable videos.
  Directories with no manifest (interrupted matches, `pending-*` leftovers)
  list the `.mp4`s found on disk instead, so an orphan is still watchable.
- **Sidecars are served to the admin by the same route as video**
  (`/api/recordings/<id>/metadata.json`), reusing the practice API's
  `serveSidecar` rather than a second copy of it.
- **No `title=` tooltips** anywhere in the new UI (global instruction): the
  stream name, size, duration and status are all visible text.
- **All times are local**, as everywhere else in pFMS — the table already uses
  `toLocaleString` with no timezone override, which renders in the viewer's
  own zone. Checked 2026-09-21 while picking this work up.

## Plan / steps

1. [x] Survey: inventory scan, recordings route, practice-day page, the
       existing admin section.
2. [x] Types: `RecordingInventoryEntry.files` + `.sidecars`.
3. [x] `MatchRecorder.inventory()` fills them; `MatchRecorder.thumbnail()`
       generates and caches the poster frame (in-flight de-duped).
4. [x] `src/recordingsApi.ts`: `?thumb=1` on a video, and sidecar serving.
5. [x] `serveSidecar` moved to `src/httpApiUtils.ts`, practiceApi imports it.
6. [x] Frontend: thumbnail column, expandable row with a player per stream,
       downloads, sidecar links, match-summary link.
7. [x] Tests for the inventory's new fields and the thumbnail route.
8. [x] Docs (`docs/match-system.md`), typecheck, tests, frontend build, commit.
9. [ ] Deploy to steamboat and look at a real recording through it.

## Findings / gotchas

- `MatchRecording.file` is always set, even on a `failed` recording, and then
  points at a file that was never written. Anything linking to it must check
  the status, not just the name.
- A failed remux leaves `file` pointing at the first raw part (a `.part0.mp4`)
  with status `partial` — the thumbnail path has to tolerate any
  `[A-Za-z0-9._-]+\.mp4`, which is what the video route already allows.
- `-ss` before `-i` is a fast (keyframe) seek. On a file shorter than the seek
  point ffmpeg exits 0 having written nothing, so the generator checks the
  output exists and falls back to a seek of 0.

## Things not to do

- Don't generate thumbnails during the match-end finalize path.
- Don't widen `serveRecordingFile` to non-MP4 files: the practice-day route
  shares it and validates file names against the day's listed recordings.
