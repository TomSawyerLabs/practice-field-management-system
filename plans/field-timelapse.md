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

**Rendering:** on demand, one at a time, concat demuxer — over the frame
JPEGs at the chosen fps for the season film, or over the practice chunks
(`-c copy`, re-encoding only if their settings changed mid-range) for a
date-range practice film.

**Viewing (added 2026-09-20, after Cameron asked):** the admin section plays
everything in place. A 480 px thumbnail is written beside each archival frame
in the same ffmpeg pass (~40 kB, so a gallery is affordable);
`/api/timelapse/list?from=&to=` scans the disk for what exists; the section
shows each day as a thumbnail strip plus play buttons for its practice films,
and a list of built films with play/download/delete.

### Verified against the real stream (2026-09-20)

`scripts.local/timelapse-live-check.ts` runs the real engine against
`rtsp://sentinel.tsl:8554/all-field`:

- archival frame: **3.45 MB**, 3.6 s per capture
- 56 s of field time → a 297 KB chunk, 1920×1714, 30 fps, 28 frames, 0.93 s
  of film = **60× speed, 19 MB per field-hour** — matching the prediction
- film renders from the frames and is served over `/api/timelapse/render/…`
- a practice film for a date range is a stream copy (289,432 → 289,466 bytes),
  i.e. seconds, not minutes
- the admin page was driven in a browser against this data: thumbnails load at
  480 px, and the player decoded a built film at 1210×1080

### Known gaps

- **Not deployed.** Everything above ran locally and on a scratch directory.
- Shutdown does not stop the encoder gracefully (neither does the practice
  recorder). The fragmented MP4 survives, but the last partial fragment is
  lost — at most a second of film.
- The frames are stills only: there is no "film the whole day at 1 frame a
  minute" mode between the two. Nobody has asked for one.
- Viewing is admin-only. There is no team-facing or public timelapse page,
  and no share link like the practice-day one.

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

## Home Assistant light control at TSL (2026-09-20)

Decisions from Cameron: target **`light.all_lights`**, **snapshot and
restore** around each frame, and **only when the shop is empty** — "if people
are here, the lights are already on."

What was checked, so a future session does not redo it:

- **steamboat already reaches HA.** `http://homeassistant.tsl:8123` answers
  200, `/api/` answers 401 without a token. Note the bare name
  `homeassistant` does **not** resolve on steamboat; `homeassistant.tsl` does
  (2600:1700:459:8a1f::793, also 10.255.0.9). No network or Caddy change is
  needed.
- **The bay lights are on/off only** (`supported_color_modes: ["onoff"]`), so
  there is no brightness to set — "full blast" just means on.
- **The groups hide per-fixture state.** `light.all_lights` reported "on"
  while light 2 of every row was off. So a snapshot must list the 32 leaf
  fixtures; snapshotting the group and restoring it would turn the normally-
  off ones on. Tree: `all_lights → main_lights + edge_lights → per-bay
main/edge groups → light.bay_{12,23,34,45}_{north,south}_{1..4}`.

### How it is wired now (2026-09-20, after Cameron asked for both)

pFMS talks to Home Assistant **natively**; hand-written HTTP calls remain as
the escape hatch. `TimelapseLights` is a union of three modes:

- `none` — the default.
- `homeAssistant` — base URL, token, and a list of entity ids. pFMS builds
  `scene/create` (snapshot) + `light/turn_on` before, `scene/turn_on` after.
  It expands each picked entity down to its leaf fixtures for the snapshot,
  at capture time, so the expansion follows changes made in HA.
- `http` — the operator's own list of calls per slot, up to four each.

The admin panel has an entity picker: **Connect** sends
`testTimelapseLights` (admin-only) → the server calls `/api/`, `/api/config`
and `/api/states` with the token → the page gets the light list back and the
HA version, and never sees the token. Verified end to end on 2026-09-20
against the real instance: with no token the UI shows "Home Assistant refused
the token (401)", which is the whole path working.

So for TSL the remaining setup is: **Home Assistant** mode, URL
`http://homeassistant.tsl:8123`, a token, and tick `light.all_lights`. The
32-leaf snapshot list no longer has to be pasted by hand — pFMS derives it.

### Not done, deliberately

No light has been switched. Firing the calls turns on every light in the
shop, which is a physical change to Cameron's building and needs his
per-change say-so at a time he picks. "Capture now (with lights)" is the way
to try it once the token is in.

## Light control: the webhook handshake (2026-09-21)

Cameron picked Home Assistant's built-in webhooks over a stored token, and
specified the sequence: receive request → record light state → turn lights on
→ wait for them to be on → notify pFMS → wait for pFMS to finish (or time
out) → restore after a short hold.

Facts established before building:

- **A webhook cannot answer.** `homeassistant/components/webhook/trigger.py`
  does `hass.async_run_hass_job(trigger.job, …)` and returns `None`, so
  aiohttp sends an empty `200` before the automation has run. Custom webhook
  responses have been requested since 2021 and are still unimplemented. A
  bare webhook therefore cannot report whether the lights came on.
- **So HA calls back.** `rest_command` gives the automation an outbound POST;
  pFMS waits on it with a nonce, shoots on arrival, and reports
  `lights: failed` if it never comes.
- **Addressing:** `pfms.tsl` is a CNAME to `steamboat.tsl` (10.255.0.5) and
  pFMS listens on `*:9005`; HA is 10.255.0.9 on the same /20, so
  `http://pfms.tsl:9005` works from HA. HA is 2026.9.3, supervised.
- **Webhook ids are capabilities**, so they are masked like a token. The
  admin page keeps the generated ids in component state only long enough to
  render the YAML — after a save or reload they are gone from the browser.

Verified over real HTTP both directions
(`scripts.local/webhook-handshake-check.ts`, a fake HA + the real API):

| Case                      | Result                                                       |
| ------------------------- | ------------------------------------------------------------ |
| HA confirms               | `lights: ran`, frame taken 528 ms after the start webhook    |
| HA never answers (3 s)    | `lights: failed`, frame still taken, done webhook still sent |
| Callback nobody asked for | `409 No capture is waiting for that nonce`                   |

### One timer, not two (corrected 2026-09-21)

Step 7's "restore after x seconds" is the _timeout_ on step 6, not an extra
hold: the lights go back the moment pFMS says it has the frame, and x (10 s
default) only applies when pFMS never answers. The admin page warns if x is
set below pFMS's own light-wait plus capture time, since Home Assistant would
otherwise restore the lights mid-shutter.

### Deployed 2026-09-22

`17366d1` is live on steamboat. `/api/timelapse/lights-ready` answers (a
bogus nonce gets `409 No capture is waiting for that nonce`), and the daily
frames are still running — 2026-09-22 09:00 was captured unattended.

### Still to do

- Cameron pastes the generated YAML into HA (a `rest_command` in
  `configuration.yaml` plus one automation) and picks the webhook mode in
  the admin panel. **Nothing inside Home Assistant has been changed by this
  work**, so light control is not active yet.
- Then track the automation in ops: append its `entity_id` to
  `homeassistant/ha-tsl/export.yaml` under a `pfms-timelapse:` key, run
  `cd homeassistant && bun run export`, write the comment header, commit.
  That repo exports from the box rather than deploying to it, so the
  automation has to exist in HA first. Cameron has said the webhook ids
  being committed there is fine (they are LAN-only capabilities, rotatable
  from the admin page in seconds).

## Wired up at TSL, end to end (2026-09-22)

Cameron said "can you do it all?", so the Home Assistant side was built too.
What now exists **inside Home Assistant** (2026.9.3, supervised):

| Object                             | What it is                                                           |
| ---------------------------------- | -------------------------------------------------------------------- |
| `configuration.yaml` → `notify:`   | `notify.pfms_lights_ready`, a `rest` notify platform posting to pFMS |
| `script.pfms_lights_ready`         | One step: call that notify with the nonce                            |
| `automation.pfms_timelapse_lights` | The seven-step sequence, triggered by the start webhook              |

And in pFMS on steamboat: `setup-config.json` → `timelapse.lights` is
`haWebhook`, pointing at `http://10.255.0.9:8123` with the two webhook ids
(backups of the file are beside it, `setup-config.json.bak-*`).

### Two traps, both hit for real

**`local_only` is judged on the source address, and IPv6 fails it.**
(Resolved 2026-09-22 with `connectAddress` — see "https, kept" below.)
`homeassistant.tsl` resolves to a _global_ IPv6 address, so steamboat's
request arrived from a GUA and HA logged
`Received remote request for local webhook …` and dropped it. The webhook had
answered `200` — HA answers unregistered and rejected webhooks identically —
so the only evidence was that log line and `last_triggered: null`. Fixed by
addressing HA as `http://10.255.0.9:8123` (its DHCP reservation). Not an
IPv6-disabling change: pFMS simply talks to this host over v4.

**`continue_on_error` does not cover a missing service, and that left every
light in the shop on.** The first automation called `notify.pfms_lights_ready`
directly, with `continue_on_error: true`. The notify platform had not loaded
yet (legacy notify needs a full restart), so the action raised a
_misconfiguration_ error, which `continue_on_error` explicitly does not
suppress — the run aborted at that step and the restore never executed. The
lights were restored by hand from the snapshot scene the run had already
created.

The fix, since HA has no try/finally: the call to pFMS goes through
`script.turn_on`, which is fire-and-forget, so nothing that happens inside it
can abort the automation. Re-tested with the notify service still missing:
lights on, script failed internally, wait and restore both ran, all 32
fixtures returned to their exact prior states — including `bay_45_north_4`,
which is off while its three siblings are on. That fixture is the proof the
group is being expanded to leaves rather than snapshotted whole.

The admin page's YAML generator now emits the same shape (rest_command +
script + automation) rather than the direct call it had before.

### Restart

Adding the `notify` platform needed a full HA restart (no `notify.reload`
exists; `rest_command.reload` does, which is why the generated YAML prefers
`rest_command` for anyone doing this by hand). All timers were idle first;
HA was back in ~40 s.

## https, kept (2026-09-22)

Cameron wanted `https://homeassistant.tomsawyerlabs.com`, not a bare IP. That
works **and** keeps `local_only: true`, because only the _last hop into HA_
has to be IPv4:

- The HA box answers 443 on its v4 address (10.255.0.9) with a real Let's
  Encrypt certificate for the public name.
- Its own Caddy then forwards `X-Forwarded-For: 10.255.0.5` to HA core, and
  HA trusts 127.0.0.1 as a proxy, so the client reads as private → local.

Proven before writing any code, with a throwaway `local_only` webhook and
`curl --resolve` (no lights touched): the same POST was **dropped** via the
public name over IPv6 and **accepted** via the same name pinned to v4.

So pFMS gained an optional **`connectAddress`**: connect to this address,
keep the hostname. That is `curl --resolve` semantics — SNI and certificate
verification are untouched, only the address is pinned. Implemented over
`node:https`, because Node's `fetch` offers no per-call address or family
control and `dns.setDefaultResultOrder` would change every lookup the
process makes.

Live config: `baseUrl = https://homeassistant.tomsawyerlabs.com`,
`connectAddress = 10.255.0.9`. Verified against the deployed build on
steamboat: `pinnedFetch` to `/api/` returned 401 in 45 ms — a completed TLS
handshake checked against the hostname, over the pinned v4 address.

### Not needed: the `onlink` Caddy matcher

Worth recording since it came up. `ops/containers/caddy-custom/onlink` solves
exactly this class of bug — "a LAN device arrives from a global, ISP-delegated
address and is treated as a stranger" — but on Caddy's side of the fence. It
cannot change HA's verdict, because HA runs its own `is_local()` further down.
Using it would mean setting `local_only: false` and having Caddy police
locality instead, which is weaker here: the HA box has its own globally
routable IPv6 address and its own Caddy, so a Caddy rule on steamboat does
not necessarily sit in front of every path to HA. Pinning the address keeps
HA's own check doing the work.

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
- [x] Viewer: thumbnails, day browser, in-page player, film library,
      date-range practice films (2026-09-20).
- [x] Worked out the Home Assistant wiring (2026-09-20): reachability,
      on/off-only lights, per-fixture snapshot, and the three calls to paste
      (above). Multi-call slots and empty-shop-only light control are built.
- [x] Fixed a leak found on the way: the settings message every station page
      receives carried the action headers, so a token would have gone out on
      the field network. Masked now.
- [x] Native Home Assistant mode with an entity picker, plus the custom-HTTP
      escape hatch (2026-09-20). Group expansion is done by pFMS.
- [x] Webhook handshake mode built and verified over real HTTP (2026-09-21).
- [x] Home Assistant side built and verified (2026-09-22): notify platform,
      script, automation; pFMS switched to webhook mode over IPv4.
- [ ] Watch a real scheduled capture (13:00/17:00) and confirm
      `lights: ran` rather than a timeout.
- [ ] Track the automation and script in ops (`homeassistant/ha-tsl`).
- [ ] Deploy to steamboat and switch it on.
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
