# Record every match from the field video streams

## Goal

Every match gets a full video capture, separate from the score-review system,
and each drive team can download it right after the match. Cameron
(2026-09-13): pFMS gets a "stream URL" setting in the admin panel and picks
one (or more, if performance allows) stream(s) to record.

## Environment / context

- Video source: **restitchd / stitchd** on `sentinel` (code:
  `~/git/Personal Projects/Top Down`, deployed via its own CI + self-hosted
  runner; config owned by the ops repo at `servers/sentinel/restitch/`).
  stitchd replaced MediaMTX on 2026-07-31; it serves every output over RTSP
  on `:8554` and WebRTC on `:8889`, HLS via the dashboard on `:9000`. There is
  **no recording or segment retention** in stitchd (HLS segments live in the
  container's `/tmp`). Outputs (from `plans/stitchd-absorb-mediamtx.md`):
  `full` (hevc 7560x2688), `full-low` (h264 3600x1280), `the-field`
  (4096x1216), `john`, `entry`, `all-field` (h264 3686x3290, the public
  stream at `stream.tomsawyerlabs.com`).
- Recorder host: **steamboat** (pFMS). ffmpeg 7.1.1, 8 cores, 30 GB RAM,
  387 GB free on `/`. Recording is `-c copy` (remux, no transcode), so cost
  is disk write only: a 12 Mbps stream ≈ 1.5 MB/s ≈ 225 MB per 2.5-minute
  match.
- Existing pieces reused: `SetupConfigStore` / `SetupSettings` (admin-gated
  settings, env fallback), `MatchHistoryStore` (per-match entries with
  `matchId`, `startedAt`, `endedAt`; already carries `reviewUrl`),
  `httpHandlers` chain in `websocketServer.ts` (`/api/*` proxied by Caddy),
  match history UI in `MatchControlPage.tsx`, station page
  `ControlPage.tsx`.

## Decisions already made (don't re-ask)

- **Recording lives in pFMS**, not in stitchd (Cameron, 2026-09-13).
- **Streams are configured in the admin panel** as a list of named URLs,
  each individually enabled; env `MATCH_RECORDING_STREAMS` only seeds a
  fresh install (same precedence rule as every other setup setting).
- Independent of the review system: the recording is attached to the match
  history entry alongside `reviewUrl`, never replaces it.
- Stream URLs may use hostnames (e.g. `rtsp://sentinel:8554/all-field`).
  `isPrivateHostUrl` refuses hostnames because `radioUrl` receives WPA keys;
  a stream URL only pulls video, and the setting is already admin-gated.

## Design

- `src/matchRecorder.ts` — `MatchRecorder` attaches to the match engine.
  - Starts one ffmpeg per enabled stream as soon as the field is startable
    (ready check open, all joined teams + required staff ready) as a
    pre-roll, adopts the match id when the countdown starts (directory
    renamed; ffmpeg keeps writing), runs through pauses, stops 5 s after the
    phase leaves the active set. Pre-rolls whose match never runs are
    discarded (commit 86c1248, 2026-09-13).
  - ffmpeg: `-rtsp_transport tcp -rw_timeout 10s -i URL -c copy -f mp4
-movflags +frag_keyframe+empty_moov+default_base_moof` into
    `<dir>/<matchId>/<slug>.partN.mp4` (fragmented = playable even if the
    process dies). Clean stop = `q` on stdin, SIGKILL after 10 s.
  - If ffmpeg exits mid-match it is restarted into the next part file; on
    stop all parts are concatenated (`concat` demuxer, `-c copy`) and
    remuxed with `+faststart` to `<slug>.mp4`, parts deleted.
  - Writes `<dir>/<matchId>/recording.json` (self-contained index) and calls
    `historyStore.setRecordings(matchId, …)`.
  - Broadcasts `matchRecordingState` (per-stream status, active match, disk
    free, retention) to internal clients; state is also sent on connect.
  - Retention sweep at start and daily: delete match dirs older than
    `recordingRetentionDays` (default 30).
  - `testStream(url)` = ffprobe with a 10 s timeout → codec/size/fps.
- `GET /api/recordings/<matchId>/<file>` — serves the MP4 with Range support
  (in-browser scrubbing) and, with `?download=1`, a friendly attachment name
  `match-<n>_<date>_<stream>.mp4`.
- Settings: `SetupSettings.recordingStreams: {name, url, enabled}[]`,
  `recordingRetentionDays`. Env: `MATCH_RECORDING_STREAMS`
  (`name=url,name=url`), `MATCH_RECORDINGS_DIR` (default `recordings`),
  `MATCH_RECORDING_RETENTION_DAYS`.
- UI: admin "Match video recording" card (stream table with enable/test/
  remove, add row, retention, live status + disk free); match control
  history rows and the post-match view get per-stream download buttons;
  station pages get a "Match video" card listing the team's recent matches
  with download links.

## Plan / steps

1. [x] Types + validators + env seed.
2. [x] `matchRecorder.ts` + history store `setRecordings`.
3. [x] HTTP: `/api/recordings/…` with Range. WS: state broadcast, test message.
4. [x] Frontend: admin card, history/post-match buttons, station card.
5. [x] Docs (configuration, match-system, README) and typecheck. Committed
       as 091e337 (2026-09-13).
6. [~] Deployed to steamboat 2026-09-13 11:24 (recorder reports "ready, 0
   streams enabled"). Admin card restyled 11:38 (action button + state
   chip, commit 106e6ef). Still to do by hand: Admin → Match Video
   Recording → add `all-field` = `rtsp://10.255.0.20:8554/all-field`,
   Test, Enable, Save (admin passphrase needed — not done by Claude), then
   run a match and download from /match and a station page.

## Findings / gotchas

- steamboat cannot resolve the bare name `sentinel`; `sentinel.tsl` resolves
  only to IPv6 while stitchd listens on IPv4 (`0.0.0.0:8554`). Use the IP
  `10.255.0.20` in stream URLs.
- Manual check from steamboat: `ffprobe rtsp://10.255.0.20:8554/all-field`
  → h264 3686x3290 30 fps; an 8 s `-c copy` capture gave 11 MB at 12.4 Mbps.
- `isPrivateHostUrl` rejects hostnames by design (radioUrl carries WPA
  keys); stream URLs use the looser `isStreamSourceUrl` (rtsp/rtsps/http/
  https/rtmp/srt/udp, any host, no file:/pipe:/concat:).
- AdminPage already had a `formatBytes` (firmware section) — the recording
  card uses `formatRecordingBytes`.

## Open questions for Cameron

1. Which stream(s) to record first — `all-field` is the obvious default; the
   full 7560x2688 HEVC composite is ~4× the size and needs a capable player.

## Things not to do

- No transcoding on steamboat — `-c copy` only.
- Don't gate downloads behind API keys: drive teams on the guest network
  must be able to fetch them; external users already pass Caddy's cookie
  check for `/api/*`.
