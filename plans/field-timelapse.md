# Long-term field timelapse

## Goal

An admin-enableable feature that, when the field has a video stream, builds a
**long-term timelapse of the field** — the shop across a season: field rebuilt,
game pieces moved, bumpers piled up, robots come and go.

Two capture modes, one mechanism:

1. **Daily (always, whether or not anyone is here).** A few full-resolution
   frames per day at fixed times, ideally with the bay lights driven to a known
   level first so every frame matches. This is the archival film.
2. **Active (robots on the field).** A much faster timelapse while robots are
   present, so a practice day collapses into a couple of minutes of video.
   **No light control in this mode** — the field is in use, do not touch the
   lights (Cameron, 2026-09-20).

Not a replacement for match/practice recording (`matchRecorder.ts`,
`practiceRecorder.ts`), which record full-rate video of specific windows.

## Environment / context

- Backend: Node 22 on steamboat (`node dist`), Bun locally. ffmpeg 7.1.
- Field stream today: `rtsp://sentinel.tsl:8554/all-field` — stitched panorama,
  **3686×3290 (12.1 MP), 30 fps, h264 Main, ~12.3 Mbit/s**. Measured
  2026-09-20 by ffprobe from steamboat.
- Source list is admin config: `SetupConfig.recordingStreams`
  (`RecordingStreamConfig[]`, ≤ 8 entries, `isStreamSourceUrl` validated).
- steamboat: i5-8259U (4c/8t), 16 GB, `/` = 468 GB with **390 GB free**;
  `recordings/` is 9.6 GB today. `/dev/dri/renderD128` exists (Iris Plus 655),
  so VAAPI decode is available if CPU becomes the constraint.
- `MatchRecorder.sweep()` deletes directories under the recordings root older
  than `recordingRetentionDays` (360 on steamboat) but **skips dot-prefixed
  names** — that is how `.practice-buffer` survives. A timelapse store must be
  either dot-prefixed or outside the recordings root; it must never be swept
  by age like a match.
- Admin surfaces already in place: `frontend/src/components/AdminPage.tsx` and
  `RecordingsInventorySection.tsx` (per-directory sizes, free space, days until
  full). A timelapse store should appear in that inventory.
- Lights are real and controllable: the TSL Home Assistant instance exposes
  ~80 `light.*` entities including dimmable bay groups
  (`light.bay_1_2_lights`, `light.bay_2_3_north_lights`, …). pFMS itself has
  **no** HA/light integration today — nothing in `src/` touches lights.

## Measurements (steamboat, 2026-09-20, daylight scene)

Single JPEG frame off the live stream (`-frames:v 1`), ~2.8 s wall per capture
including RTSP connect:

| Frame              | Size   |
| ------------------ | ------ |
| full-res `-q:v 2`  | 3.1 MB |
| full-res `-q:v 5`  | 1.8 MB |
| full-res `-q:v 8`  | 1.3 MB |
| 1920 wide `-q:v 3` | 879 KB |
| 1920 wide `-q:v 6` | 548 KB |
| 1280 wide `-q:v 5` | 280 KB |

h264 timelapse. **Retime the frames to 30 fps playback before encoding**
(`setpts=N/30/TB`, `-r 30`) — the first pass of these measurements left the
output at a 1 fps timebase, which inflated every figure by roughly 20×. x264's
rate control budgets bits per _second of output_, so a timelapse that plays at
30 fps costs a small fraction of the same frames laid out at 1 fps. All rows
below are the corrected form, encoded from one captured 60 s sample of the real
stream so they see identical content (1920 wide = 1920×1714):

| Setting                           | Per hour captured | SSIM (Y) vs crf 12 |
| --------------------------------- | ----------------- | ------------------ |
| 0.5 fps keyframe-only, crf 26     | 47 MB             | 0.881              |
| **0.5 fps keyframe-only, crf 30** | **19 MB**         | **0.824**          |
| 0.5 fps keyframe-only, crf 34     | 9 MB              | 0.755              |
| 1 fps, crf 26                     | 40 MB             | 0.903              |
| 1 fps, crf 30                     | 21 MB             | 0.857              |
| 1 fps, crf 34                     | 11 MB             | 0.796              |

Reference: recording the stream as-is is **5.5 GB/hour**, and a full-res JPEG
per second would be ~6.5 GB/hour.

**Frame rate is not what costs storage — quality is.** Doubling the frame rate
from 0.5 to 1 fps costs nothing measurable (19 MB/hr → 21 MB/hr) because the
extra frames predict from their neighbours; 1 fps at crf 30 is _better_ SSIM
than 0.5 fps at the same crf, for the same bytes. The only real cost of 1 fps
is CPU.

CPU is the real constraint. Measured live against the stream, x264 veryfast:

| Pipeline                        | CPU (of one core) | Frames out |
| ------------------------------- | ----------------- | ---------- |
| full decode + `fps=1` + scale   | 79–88 %           | 1 fps      |
| **`-skip_frame nokey`** + scale | **16–21 %**       | 0.5 fps    |

`-skip_frame nokey` only decodes keyframes; the source's GOP is 2 s, so it
yields exactly 0.5 fps for a fifth of the CPU of decoding all 30 fps just to
throw 29 of them away. That is the whole argument for it — storage is a wash.

VAAPI hardware decode would give 1 fps at keyframe-only cost, but is **not
available to pFMS on steamboat today**: `-hwaccel vaapi -hwaccel_device
/dev/dri/renderD128` fails with `Device creation failed: -22` even though the
node exists, most likely a missing driver or render-group membership. Chasing
it is a steamboat change needing separate authorisation; not on this feature's
path.

### What that means in season terms

- **Daily mode:** 3 full-res `-q:v 2` frames/day = 9.4 MB/day = **3.4 GB/year**.
  Free, effectively. Keep the JPEGs forever; they can be re-rendered into a film
  at any resolution later, including 4K crops and pans.
- **Active mode**, keyframe-only at crf 30 = ~19 MB per captured hour:
  - a 3-hour practice night → 57 MB
  - 300 field-hours in a season → **~6 GB**

Storage is therefore a non-issue for both modes, against 390 GB free and
9.6 GB of recordings today. Active chunks still get their own (shorter)
retention so a mistake in the trigger can't quietly fill the disk, but the
feature does not meaningfully compete with the match/practice recordings whose
eviction policy is still open (`plans/practice-recording.md`, item 17).

## What was built (2026-09-20)

`src/fieldTimelapse.ts` (engine), `src/timelapseApi.ts` (serving),
`frontend/src/components/TimelapseSection.tsx` (Admin → Field Timelapse),
config in `src/types.ts` (`SetupSettings.timelapse`), wiring in `index.ts`
and `websocketServer.ts`, docs in `docs/match-system.md`. Tests in
`src/fieldTimelapse.test.ts` (13, real ffmpeg against a generated source).

**Store:** `<recordings>/.timelapse/` — `frames/<day>/HHMM-<slug>.jpg`,
`active/<day>/<slug>-HHMMSS.mp4`, `renders/timelapse-<stamp>.mp4`, plus
`timelapse.json` (the log the admin list is drawn from; also what stops a
restart re-taking a slot it already took).

**Archival frames:** a 15 s tick, not `cron` — a slot fires if it is due and
its log entry for today is missing, within a 15 minute grace so a restart
catches a just-missed frame but 03:00 never stands in for 09:00.
`ffmpeg -frames:v 1 -q:v 2` per enabled stream, sequentially.

**Lights:** pre action → `settleSeconds` → shutter → post action, with the
post action in a `finally` so a failed capture still restores them. When the
field is busy the actions are skipped and the frame is taken anyway
(`lights: 'skipped-field-in-use'`) — a differently-lit frame beats a hole.

**Fast timelapse:** starts on any telemetry packet, holds 5 minutes past the
last one, stops when a match leaves idle/created. One ffmpeg per stream,
`-skip_frame nokey` (or `fps=1`), `scale=W:-2,setpts=N/30/TB`, `-r 30`,
x264 veryfast at the configured crf, fragmented MP4 with `-g 30` so a killed
process still leaves a playable chunk. Rotated every 30 minutes.

**Rendering:** on demand, one at a time, concat demuxer over the frame JPEGs
at the chosen fps and height.

### Verified against the real stream (2026-09-20)

`scripts.local/timelapse-live-check.ts` runs the real engine against
`rtsp://sentinel.tsl:8554/all-field`:

- archival frame: **3.45 MB**, 3.6 s per capture
- 56 s of field time → a 297 KB chunk, 1920×1714, 30 fps, 28 frames, 0.93 s
  of film = **60× speed, 19 MB per field-hour** — matching the prediction
- film renders from the frames and is served over `/api/timelapse/render/…`

### Known gaps

- **Not deployed.** Everything above ran locally and on a scratch directory.
- Shutdown does not stop the encoder gracefully (neither does the practice
  recorder). The fragmented MP4 survives, but the last partial fragment is
  lost — at most a second of film.
- The frames are stills only: there is no "film the whole day at 1 frame a
  minute" mode between the two. Nobody has asked for one.

## Decisions already made (don't re-ask)

All four settled by Cameron on 2026-09-20:

- **Active mode is keyframe-only, 0.5 fps, 60× playback** (`-skip_frame
nokey`). Chosen for CPU — a fifth of a core instead of most of one. Storage
  turned out not to distinguish the options, so 1 fps stays available as an
  admin setting but is not the default.
- **Active capture triggers on robots _present_**, not enabled: telemetry from
  any DS or robot starts it, and it keeps running through a hold window after
  the last packet so a practice night is one continuous piece rather than
  confetti.
- **Daily frames at fixed local clock times, default 09:00 / 13:00 / 17:00**,
  editable in the admin panel.
- **Lights via generic pre/post HTTP actions**, not a built-in Home Assistant
  integration. The HA snapshot/restore recipe is documented instead.

Earlier decisions, unchanged:

- Two modes, one feature; active mode never touches the lights.
- Storage sits under the recordings root but dot-prefixed, so the match
  retention sweep leaves it alone; separate retention per mode.
- Daily frames are archived as full-res JPEGs (re-renderable), active mode is
  encoded straight to h264.
- Retime to 30 fps playback at capture time, never store a 1 fps timebase.

## Progress log

- [x] 2026-09-20 Measured the real stream: 3686×3290 @30 fps, 12.3 Mbit/s.
- [x] 2026-09-20 Measured JPEG and h264 timelapse sizes + CPU on steamboat,
      then re-measured after finding the 1 fps-timebase error (tables above).
      Scratch files under `/tmp/tltest` on steamboat were removed.
- [x] 2026-09-20 All four open questions answered; see decisions above.
- [x] Config schema + validators (`src/types.ts`), with tests.
- [x] `src/fieldTimelapse.ts` — scheduler, active capture, sweep, render.
- [x] Pre/post action runner + HA recipe in `docs/match-system.md`.
- [x] Wiring in `index.ts`, state + admin commands in `websocketServer.ts`.
- [x] HTTP serving of frames, chunks and renders (`src/timelapseApi.ts`).
- [x] Admin UI section (`TimelapseSection.tsx`), README + docs.
- [x] Verified end to end against the live field stream.
- [ ] Deploy to steamboat, switch it on, and write the Home Assistant
      pre/post actions for the bay lights (needs a long-lived HA token and
      Cameron's per-change authorisation for anything touching HA).
- [ ] After a week, check the actual disk growth against the 19 MB/field-hour
      estimate and settle the retention numbers.

## Things not to do

- Don't store the active mode as JPEG frames — hundreds of times the bytes of
  a retimed h264 timelapse for the same frames.
- Don't encode a timelapse at its capture frame rate. Retime to 30 fps first;
  leaving the output at a 1 fps timebase costs ~20× the bytes for the same
  frames and the same visual quality. This cost a full round of measurements.
- Don't combine `-fps_mode passthrough` with `-r` — ffmpeg 7.1 refuses
  ("contradictory"). `setpts=N/30/TB` plus `-r 30` is the working form.
- Don't pipe an ffmpeg command into `ssh` from a heredoc without `-nostdin`;
  ffmpeg eats the rest of the script from stdin and the errors make no sense.
- Don't run the timelapse decoder during a match; the match recorder is already
  on that stream and the timelapse can be derived from its MP4 later.
- Don't touch the lights when the field is in use, and never without a restore
  action that puts them back the way they were.
- Don't let the timelapse store be swept as if it were a match directory.
