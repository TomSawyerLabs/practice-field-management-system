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

h264 timelapse, encoded from one captured 120 s sample of the real stream so
all rows see identical content (1920 wide = 1920×1714):

| Setting                         | Per frame | Per hour captured |
| ------------------------------- | --------- | ----------------- |
| 1 fps, 1920w, crf 24 veryfast   | 393 KB    | 1.41 GB           |
| 1 fps, 1920w, crf 28 medium     | 249 KB    | 0.90 GB           |
| 1 fps, 1920w, crf 28 + hqdn3d   | 202 KB    | 0.73 GB           |
| **1 fps, 1920w, crf 32 medium** | 109 KB    | **0.39 GB**       |
| 1 fps, full-res, crf 30 medium  | 807 KB    | 2.91 GB           |
| 0.2 fps (1/5 s), 1920w, crf 28  | 335 KB    | 0.24 GB           |

Reference: recording the stream as-is is **5.5 GB/hour**.

Per-frame cost is high because consecutive timelapse frames share little
temporal redundancy and the sensor is noisy — the quality knob (crf), not the
frame rate, is what moves storage. 1 fps at crf 32 costs _less_ per hour than
0.2 fps at crf 28 and looks far better in motion.

CPU, measured live against the stream:

| Pipeline                                        | CPU (of one core) | Frames out |
| ----------------------------------------------- | ----------------- | ---------- |
| full decode + `fps=1` + scale + x264 veryfast   | 88 %              | 1 fps      |
| full decode + `fps=1` + scale + x264 medium¹    | ~135 %            | 1 fps      |
| **`-skip_frame nokey`** + scale + x264 veryfast | **21 %**          | 0.5 fps    |

¹ Derived from the offline encode of the 120 s sample (29.1 s wall at 557 %
CPU for 120 s of source), not measured live; the other two rows were measured
against the live stream.

`-skip_frame nokey` only decodes keyframes; the source's GOP is 2 s, so it
yields exactly 0.5 fps for about a quarter of the CPU. That is the cheap mode
if a 60× playback speed is acceptable.

### What that means in season terms

- **Daily mode:** 3 full-res `-q:v 2` frames/day = 9.4 MB/day = **3.4 GB/year**.
  Free, effectively. Keep the JPEGs forever; they can be re-rendered into a film
  at any resolution later, including 4K crops and pans.
- **Active mode**, at 1 fps / 1920w / crf 32 = 0.39 GB per captured hour:
  - a 3-hour practice night → 1.2 GB
  - 300 field-hours in a season → **~120 GB**
  - at 0.5 fps keyframe-only, roughly half that.

120 GB fits in the 390 GB free, but it is the same pool the match and practice
recordings grow into, and the eviction policy for those is still open
(`plans/practice-recording.md`, item 17). Active-mode chunks therefore need
their own retention (short, days-to-weeks) distinct from the daily frames
(long, years).

## Design sketch

**Store:** `<recordings>/.timelapse/` (dot-prefixed → the match sweep ignores
it), with

- `frames/YYYY/MM/YYYY-MM-DD_HHMM_<stream>.jpg` — daily archival frames,
  full-res, retention in years.
- `active/YYYY-MM-DD/<stream>-NNN.mp4` — active-mode chunks, retention in days,
  own sweep, own line in the admin inventory.
- `manifest.json` — what was captured when, and why (scheduled / robots present
  / manual), plus the light action taken.

**Daily capture** is a `cron` job (the dep is already in use in
`src/scheduler.ts`) per configured time-of-day. Sequence:

1. Skip entirely if a match is active or any robot is enabled — never strobe a
   field in use.
2. Fire the **pre-capture action**, wait `settleSeconds` (default 5 s).
3. `ffmpeg -frames:v 1 -q:v 2` per enabled stream (~3 s each).
4. Fire the **post-capture action**.
5. Retry once after a few minutes if the stream was unreachable.

**Active capture** starts when robots are present and stops when they leave,
reusing the practice recorder's presence signal (`TelemetryUpdate` per station,
15 s timeout) rather than inventing a second one. One long-running ffmpeg per
enabled stream, segmented into chunks so a crash costs one chunk. It pauses
while a match is running: the match recorder owns the stream with `-c copy`
then, and the timelapse for that window can be produced from the finished match
MP4 afterwards for free.

**Lights** are not built in as Home Assistant. The admin panel gets generic
**pre/post-capture actions**: method, URL, headers (bearer token stored
write-only), JSON body, plus a settle delay. That covers HA, Hue, Shelly, or a
shop-specific endpoint without pFMS learning any of them. The HA recipe to
document:

- pre: `POST /api/services/scene/create` with
  `{"scene_id":"pfms_timelapse_restore","snapshot_entities":[…]}`, then
  `POST /api/services/light/turn_on` `{"entity_id":[…],"brightness_pct":100}`
- post: `POST /api/services/scene/turn_on`
  `{"entity_id":"scene.pfms_timelapse_restore"}`

so the lights go back exactly as they were, including off.

**Rendering** is on demand, not at capture time: an admin/URL endpoint that
concatenates a date range (daily frames at N fps, or the active chunks) into
one MP4. Keeps the archive as source material rather than a baked film.

## Decisions already made (don't re-ask)

- Two modes, one feature; active mode never touches the lights.
- Storage sits under the recordings root but dot-prefixed, so the match
  retention sweep leaves it alone; separate retention per mode.
- Daily frames are archived as full-res JPEGs (re-renderable), active mode is
  encoded straight to h264 (JPEG frames at that rate cost 3–10× more).

## Open questions for the user

1. Active-mode rate/quality — recommend **1 fps, 1920 wide, crf 32**
   (0.39 GB/hr, 30× playback). Cheaper alternative: keyframe-only 0.5 fps
   (~0.2 GB/hr, a quarter of the CPU, 60× playback).
2. Active trigger — robots _present_ (DS/robot telemetry seen) or robots
   _enabled_? Present is simpler and catches the setup/teardown that makes a
   shop timelapse fun; enabled is maybe 3× less footage.
3. Daily times — fixed local clock (recommend 09:00 / 13:00 / 17:00) or
   sun-relative (dawn+1h, solar noon, dusk−1h)?
4. Light control — generic pre/post HTTP actions (recommended, HA recipe
   documented) or a first-class Home Assistant integration in pFMS?

## Progress log

- [x] 2026-09-20 Measured the real stream: 3686×3290 @30 fps, 12.3 Mbit/s.
- [x] 2026-09-20 Measured JPEG and h264 timelapse sizes + CPU on steamboat
      (tables above). Scratch files were left in `/tmp/tltest` on steamboat.
- [ ] Answer the four open questions.
- [ ] Config schema + validators (`src/types.ts`), admin UI.
- [ ] `src/fieldTimelapse.ts` — daily scheduler, active capture, sweep.
- [ ] Pre/post action runner + HA recipe in `docs/configuration.md`.
- [ ] Inventory row + retention controls in `RecordingsInventorySection.tsx`.
- [ ] Render endpoint.

## Things not to do

- Don't store the active mode as JPEG frames — 3–10× the bytes of h264 for the
  same frames.
- Don't run the timelapse decoder during a match; the match recorder is already
  on that stream and the timelapse can be derived from its MP4 later.
- Don't touch the lights when the field is in use, and never without a restore
  action that puts them back the way they were.
- Don't let the timelapse store be swept as if it were a match directory.
