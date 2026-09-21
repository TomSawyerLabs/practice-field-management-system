# Match System

pFMS runs self-service practice matches: teams join from their own station
pages, a match controller drives the lifecycle from `/match`, and the FMS
only ever takes control of stations that have joined. Stations that have
**not** joined receive no FMS packets and stay in free-drive mode.

## Timing

Matches follow the 2026 REBUILT official timing. Durations are **fixed**
(not user-adjustable) — the only per-match options are _skip autonomous_
and the _auto winner_ selection.

| Phase       | Duration | Notes                                                                       |
| ----------- | -------- | --------------------------------------------------------------------------- |
| `countdown` | 3 s      | Pre-start countdown; all joined stations disabled                           |
| `auto`      | 20 s     | Autonomous period                                                           |
| `autoPause` | 3 s      | Pause between auto and teleop; robots disabled                              |
| `teleop`    | 140 s    | Teleop clock total; the last 30 s displays as `endgame`                     |
| `endgame`   | 30 s     | Final portion of the teleop clock; triggers the warning sound               |
| `postMatch` | —        | 3 s counting window (balls in flight), then holds until cleared (see below) |

Other phases: `idle` (no match), `created` (match set up, teams joining),
`paused` (clock frozen, robots disabled — resume or abandon).

## Match Flow

1. **Create** — the match controller creates a match from `/match`. Teams
   can now join from their station pages.
2. **Join** — teams choose an alliance (Red or Blue, up to 3 stations
   each) from their station page. Joining hands the Driver Station to the
   field: it is disabled until the match starts — leave the match to drive
   freely. If the DS isn't talking to the FMS yet, the station page shows
   an advisory warning, but teams can still ready up once the ready check
   opens.
3. **Ready check** — so teams can't sit "ready" indefinitely, nobody can
   ready up until the controller **opens the ready check**. Then teams —
   and every required field-staff role — mark themselves ready. Any roster
   change (a late join/leave/swap/kick, or a config change) re-closes the
   check, so it always reflects the current lineup. Calling **Get Ready**
   (the attention sound) or asking for ready again while the check is open
   clears every team's ready flag, so each drive team confirms afresh; the
   check itself stays open and staff readiness is kept.
4. **Hold to Start** — once every joined team and every required staff
   role is ready, the controller **holds** the start button through the
   whole 3‑2‑1 countdown. Letting go before the robots enable aborts the
   start — output is cut immediately and a fault sound plays (the match
   returns to the setup state with everyone still joined and ready).
   Releasing once the start horn is playing does nothing. A joined team can
   also kill the countdown from their own station page by pressing **Not
   Ready**, so a start can abort for a reason the controller didn't
   trigger. Phases then run automatically: countdown → auto → pause → teleop → endgame →
   post-match.
5. **During the match** — only the match controller can pause, resume, or
   abandon. Teams can self-service disable, e-stop, or leave mid-match.
   **Resuming runs a 3-second "3… 2… 1…" countdown** before robots
   re-enable, so drive teams get the same warning they do at match start.
   Robots stay disabled — and the field keeps actively streaming that
   disable — for the whole countdown, and pressing Pause again during it
   cancels the resume and leaves the match on hold.
6. **Post-match** — a short 3-second counting period runs after the buzzer
   (balls in flight). The match then stays in post-match until the
   controller clears it, creates a new match, or **2 minutes** pass — then
   it auto-clears back to free play (scoring included). Matches ended by
   e-stop **never** auto-clear; a human must clear them.

## Field Staff Ready-Up

Field staff ready up from their own pages: `/staff?role=…` for the
**Head Referee**, **Scorekeeper**, and **Safety Monitor** roles.

- No staff role can ready until the controller opens the ready check.
- The controller can toggle any role to **not required** for a given
  match — a self-service field ignores them, and the choice sticks across
  matches (it resets only when the server restarts).
- Staff presence is tracked with a heartbeat; a role whose page disconnects
  for more than ~6 seconds loses its ready mark.

A device that is currently a **Driver Station** (its IP matches a connected
DS) cannot act as the match controller or field staff: `/match` and
`/staff` show a full-page notice with a QR code of the current URL so the
page can be reopened on a phone or spare device in one scan. The check is
live — plugging a DS in (or unplugging it) flips the pages without a
reload, and a blocked staff page also stops sending presence heartbeats.

## Stops, Disables, and Recovery

E-Stop and A-Stop are latched **backend-only** states — the FMS never
sends the e-stop or a-stop bit to the DS, only disable packets — so a DS
can never get stuck in a hardware-latched stop from an FMS action.

### E-Stop

- Emergency stop for the rest of the match. Triggered from the station
  page or match window (a single tap — field staff can clear a mistake),
  from the DS itself, or by field staff from `/admin`.
- Requires a human to clear from the admin console; matches ended by
  e-stop never auto-clear.
- After staff clear it, the team (or staff) can re-enable the robot
  mid-match.

### A-Stop

- Stops the robot for the rest of auto and **automatically re-enables it
  for teleop** — no clear action needed.
- Can be armed any time from joining the match (e.g. when a team knows
  their auto won't run) through the end of auto, including from the DS's
  A-Stop button.
- A pre-armed A-Stop can be cancelled up until the countdown starts —
  after that it latches, matching official FMS behavior.
- A DS asserting its A-Stop bit into teleop cannot keep the station down —
  the bit is only honored while an A-Stop is still meaningful.

### Accidental Disable Recovery

A stopped robot is recoverable mid-match:

- After an accidental disable from the console button, a **Re-enable**
  button appears on the station page and match window while robots are
  running. It clears the field's disable and resumes enable packets.
  Untested: whether a Driver Station that latched its own local disable
  (the Enter key) follows that back to enabled, or has to be re-enabled at
  the DS.
- A disable applied by field staff can only be lifted by field staff.
- Untested: whether a Disable — or an E-Stop — pressed on the 2027 Driver
  Station reaches pFMS. That DS never sets the "enabled" bit in its status,
  so pFMS can't use the bit to notice a disable. pFMS has never logged a
  `DS e-stop reported` line for a 2027 DS; every E-Stop on record came from
  a pFMS page. (The same path does work for a legacy DS — `DS a-stop
reported` has been logged from one — but nobody is known to have pressed
  E-Stop on the 2027 DS itself, so this is untested, not disproven.)
- A Driver Station's own E-Stop latches until the roboRIO reboots, by
  design, and the real FRC DS takes Space as E-Stop even when it isn't the
  focused window. The field cannot undo that one.

### Admin Overrides

The `/admin` page provides safety overrides independent of the
self-service system: global e-stop, per-station e-stop / disable / enable,
clear e-stop, and force-stop match.

**Global e-stop is field-wide in the strongest sense**: it e-stops all six
stations and sends E-Stop packets to every station whose Driver Station
address is known — including robots merely free-driving outside the match.
It is the only path in pFMS that stops robots across alliances. A
per-station E-Stop touches only that station; there is no code path by
which one team's E-Stop reaches their alliance partners.

## The Match Window

Tapping **Join** also opens a small match window for that station:

- **Before the match:** everyone's ready status with a Ready toggle,
  A-Stop pre-arm, and this robot's E-Stop (a single tap).
- **From the countdown:** the phase and timer, dominated by a giant A-Stop
  button through auto. It closes itself after the match (a checkbox lets
  it close at match start instead).
- A 🔊/🔇 toggle plays the match audio (countdown, horn, phase cues) for
  that station — off by default, since the window is often next to the
  field speaker.

Because it opens from the Join tap itself, no pop-up permission is
needed — just keep it open. If it got closed, allow pop-ups for the field
site (or use the **Pop Out** button) to bring it back.

## Auto Winner and the Match Timeline

The auto winner (which alliance's goal goes inactive first during teleop
shifts) can be set to scores-based, pre-selected (red/blue), or manually
chosen during a pause between auto and teleop.

The match timeline visualises the full match structure with shift
colouring: when the auto winner is known, solid red/blue sections show
which alliance is active during each 25-second shift. When unknown,
diagonal stripes indicate uncertainty.

## Match Audio

Sound effects play on phase transitions via a detected system audio player
(`aplay`, `paplay`, `ffplay`, `mpv`, `play`, or `afplay`). Place `.wav`
files in `sounds/`:

| Sound            | Played on                                                 |
| ---------------- | --------------------------------------------------------- |
| `countdown1`–`4` | Start of the 3-second countdown (see below)               |
| `start`          | Auto begins without a countdown (e.g. after pause)        |
| `end`            | End of auto, and normal match end                         |
| `resume`         | autoPause → teleop                                        |
| `resume321`      | Resume countdown — tones at 0/1/2 s, "live" tone at 3 s   |
| `warning`        | Teleop → endgame                                          |
| `pause`          | Match paused, or a resume countdown cancelled             |
| `abort`          | Match stopped, e-stopped, abandoned, or countdown aborted |
| `getready`       | Ready-check announcement                                  |

A spoken "3… 2… 1…" announcer plays when the countdown begins:
`countdown1.wav`–`countdown4.wav` are pre-timed clips (four different
voices) with the numbers at 0/1/2 seconds and the charge horn baked in at
exactly 3 seconds — no separate start sound plays after a countdown. The
voice is picked per match from the match id (char-sum mod 4, implemented
identically on the server and in the browser), so the field speaker and
every open page agree.

Each variant must remain a single clip: the server plays sounds through an
exclusive ALSA device, so separate clips would race each other and drop
sounds. The chosen ALSA device persists in `audio-config.json`.

Sounds are optional individually — at startup the server scans `sounds/`
and only registers the files that exist, so a missing clip means that
transition is silent rather than an error. The same files must also reach
the web root as `/sounds/*.wav` for browsers to play match audio
(`update.sh` handles this; a hand-rolled deploy must copy them).

`pause.wav` and `resume321.wav` are synthesized tones rather than
recordings, generated by `bun scripts/generate-sounds.ts` (pass `--force`
to overwrite). `getready.wav` is a recording that isn't produced by that
script; it was mastered to a −3 dB peak with its chime 8 dB below that, so
regenerate it with more gain if it's too quiet over the field speaker. Edit the constants in that script — or just drop your own
recordings over the files — if you'd rather have something else.

## Match History

Finished matches are recorded (teams, per-alliance scores, auto winner,
end reason, duration) to `match-history.json` (last 100 matches). Duration
is wall-clock from start to end and **includes any time the match spent
paused**, so it can exceed the sum of the periods. The
`/match` page shows recent history while the field is idle, including
reviewed scores when a match has been re-scored through the
[match review API](scoring.md#match-review) — a reviewed value overrides
the live sensor count, and disagreements are highlighted, with a link to
the recording review page when one was registered.

### Investigating a match incident

Start from `match-history.json` for the **whole day**, not the journal
window around the one match — the first two passes at the 2026-09-13
incidents both went wrong by reasoning from a single match's logs. Once the
right match and minute are identified, go to the journal for that minute.

Reading the journal: a station changing colour while already joined logs
`switched to`, a fresh join logs `joined`, and the controller's Swap button
logs `swapped to`. Note that journald drops pFMS lines under load, so a
missing line is weak evidence — confirm against `match-history.json` or a
packet capture before concluding anything from an absence.

## Match Video Recording

pFMS can keep a full video of every match, independent of the score-review
integration. In **Admin → Match Video Recording**, list one or more stream
URLs (anything ffmpeg can pull — for the field's stitchd/MediaMTX that is
`rtsp://<host>:8554/<stream>`), enable the ones to record, and **Test** each
before saving. Use the stream server's IPv4 address: on the reference field
the server can't resolve the bare hostname, and the FQDN resolves only to
IPv6 while stitchd listens on IPv4. From the next match on:

- One ffmpeg per enabled stream starts as soon as the field is startable
  (ready check open, every team and required staff role ready) — so the
  hold-to-start, the countdown and the first seconds of auto are on tape —
  keeps running through pauses, and stops 5 s after the match ends. A
  pre-roll whose match never starts (or is aborted in the countdown) is
  discarded. The video is copied as-is (no transcoding), so the only cost is
  disk: roughly 1 MB/s per stream at 8–12 Mbps.
- Capture goes to fragmented MP4 parts, which stay playable if anything dies
  mid-match. If the source drops, recording resumes into a new part; at the
  end the parts are joined and remuxed into a normal `+faststart` MP4.
- The files are attached to the match in **Match History** (`/match`) and on
  each participating team's **station page** (that team's last five
  recorded matches, matched by team number — not by slot, so a team never
  sees videos left behind by whoever used the slot before them), with one
  download button per stream. Downloads are served by the backend at
  `/api/recordings/<matchId>/<file>` with a friendly attachment name and
  Range support, so a browser can also scrub through them.
- **Admin → Recordings on Disk** lists everything still stored (matches and
  practice runs, with dates, teams and sizes), space used and free, the
  last week's growth rate and the days until the volume fills at that rate,
  and per-team totals. Any recording can be deleted there, or everything
  older than N days at once; deleted matches keep their history entry but
  lose their download buttons. This is the manual lever while the retention
  policy is being worked out.
- Each match directory carries a `recording.json` sidecar, and a daily sweep
  deletes matches older than the configured retention (default 30 days).

Environment seeds (`MATCH_RECORDING_STREAMS`, `MATCH_RECORDINGS_DIR`,
`MATCH_RECORDING_RETENTION_DAYS`) are in [configuration.md](configuration.md#scoring--scoreboard);
values saved in the admin panel win.

### Post-match QR code and match summary

When a match ends, the scoreboard shows a QR code in its corner. It opens
`/matches/<token>` — a summary of that match (teams, scores including
any human review, auto winner, duration) with a player and download button
for each recorded stream. The token is 32 random characters minted when the
match started; it grants read access to that one match and nothing else, so
the page needs no login and works from a phone on cellular as long as
`PUBLIC_URL` points at an address the field is reachable at (the reverse
proxy must serve `/matches/*` as the scores page and expose it, `/assets/*`
and `/api/public/*` without its access check). The `/match` page offers the same link ("Summary", "Copy
link") for every match in history and shows the QR code after each match.

### Record while enabled (practice runs)

Most field time is not matches: a robot is enabled from its own Driver
Station for a minute at a time. A team that ticks **Record while enabled**
on its station page (the Video card) gets a clip of every such enable,
from 3 s before the robot was enabled to 3 s after it was disabled.

How it works (`src/practiceRecorder.ts`):

- While any opted-in team is on the field (its DS or robot is sending
  telemetry) one ffmpeg per enabled stream pulls the source continuously
  into 1 s MPEG-TS segments under `recordings/.practice-buffer/`, and
  segments older than ~15 s are deleted. That ring buffer is what makes the
  3 s pre-roll possible; it costs one extra RTSP reader per stream and no
  transcoding. The buffer stops when no opted-in robot has been heard from
  for 15 s.
- An enable (the DS status's enabled bit, outside a match) starts that
  robot's run; its disable ends it. A disable followed by a re-enable within
  2 s stays one clip; a run longer than 20 minutes is split. Every robot gets
  its own clip cut to its own times — six robots running independently make
  six files of the same field view, not one.
- The segments spanning the window are joined (`-c copy`, `+faststart`)
  into `recordings/practice-<stamp>-<id>/<stream>.mp4` with the same
  `recording.json` sidecar matches have, so the retention sweep treats runs
  and matches alike. Padding is "at least 3 s": segments split on keyframes,
  so up to one GOP more can be included on either side.
- Matches are the match recorder's job. The buffer stops and a run in
  progress is closed the moment a match leaves the idle/created phases.

Runs are listed on the team's station page next to its matches, and are
indexed in `practice-recordings.json` (opt-in per team, runs, day tokens).

### Recording metadata: balls scored and telemetry

Every recording — match or practice run — gets three sidecars written by
`src/sessionMetadata.ts` from a rolling half-hour record of the field:

- `metadata.json` — every score event the goal sensors reported during the
  window, exactly as the scoring engine judged it (element, alliance, when
  the ball scored, phase/sub-period, whether it counted and why not), plus
  every robot's telemetry samples (battery voltage and the sag floor between
  broadcasts, RTT, lost packets, CAN utilisation, DS CPU, brownout, and the
  DS status: enabled, mode, E-Stop/A-Stop, robot comms).
- `scores.csv` and `telemetry.csv` — the same, one row per event/sample,
  with a `video_s` column (seconds into the recording) so a row can be found
  in the clip.

The window for a match is the recording's window (pre-roll to post-roll);
for a practice run it is the padded enable window.

### Practice day links

Each team gets one link per practice day, `/practice/<token>`, listing every
match and practice run the team was part of that day with the videos,
the sidecars, and one **Download everything** zip (store-only, ZIP64, built
by `src/zipStream.ts` — MP4s don't compress, and a day can exceed 4 GB).
A practice day runs 04:00–04:00 local, so a session past midnight stays
together. The token is 32 random characters minted with the day's first
recording; it grants that team's recordings for that day and nothing else,
the same model as the match summary link. The station page shows the link
("Today's videos") as soon as the first recording exists, with a copy
button, for taking home.

The data is at `/api/public/practice/<token>` (`src/practiceApi.ts`), which
like `/api/public/match/*` must be reachable without the external-access
check, and the page path `/practice/*` must be served as the scores bundle
by the reverse proxy exactly as `/matches/*` is.

### Sending the link to the team's mentors

When a team that recorded something has been quiet for 20 minutes (no robot
heard from, no run or match ending) — or the practice day rolls over — the
link is sent on Slack, once per team per day, as a direct message to
everyone on that team (`src/practiceNotifier.ts`). Who is on a team is read
off Slack names, which is how the pfms-support workspace already works:
any 1–5 digit number in a member's display name, real name or title
("Mark 5940", "Aidan Honnold (5940)", "Stephan Massalt (971/9584)",
"Christina Lee (Team 6036)"). Nothing to configure; a mentor who wants the
links puts their team number in their Slack name. Later recordings that day
land on the same live link; nothing is re-sent. A team nobody in Slack
claims gets nothing, and the support channel gets one note per team per day
saying so (the link itself is not posted there — it opens the team's
videos). This needs only the `users:read` and `chat:write` scopes the bot
already has.

## Long-Term Field Timelapse

**Admin → Field Timelapse** (off until switched on) keeps a record of the
field over a season, using the same streams as match recording. Two things
behind one switch:

- **Archival frames.** At a few fixed local times a day (default 09:00,
  13:00, 17:00), one full-resolution JPEG per enabled stream. On the
  reference field's 12 MP stitched stream that is about 3 MB a frame, so
  three a day is ~3.4 GB a year. They are kept as stills, not video, so a
  film can be re-rendered later at any size — including crops and pans a
  finished film would have thrown away.
- **A fast timelapse while robots are here.** Any packet from any Driver
  Station starts it; it keeps running for five minutes after the last one,
  so a practice night is one piece rather than confetti, and pauses during
  matches (the match recorder owns the streams then, at full rate). The
  default samples keyframes only, which costs about a fifth of the CPU of
  decoding every frame to keep one, and runs at 60× — a three-hour practice
  is three minutes of film, about 60 MB. "Every second" instead gives 30×
  and smoother motion for roughly the same disk, at most of a CPU core.

Everything lives in `<recordings>/.timelapse/` — `frames/<day>/`,
`active/<day>/` and `renders/`. The leading dot keeps it clear of the match
retention sweep; the timelapse sweeps itself, with separate retention for
frames (default: forever) and practice films (default: 60 days).

### Watching it, and taking it away

Everything is viewable in the admin section itself, no file browser needed:

- **Browse** a date range to get each day's frames as a strip of thumbnails
  (a small copy is written beside every archival frame at capture time, so a
  page of them costs ~40 kB each rather than 3 MB) and its practice films as
  play buttons. Clicking either loads it into a player at the top of the
  section — full-resolution frame, or the film with a scrubber.
- **Build one film for a date range** from either source: the daily frames
  encoded at a frame rate you pick (the season film), or every practice film
  in the range joined end to end. Joining is a stream copy when the chunks
  match, so it is near-instant; it falls back to a re-encode only if the
  capture settings changed partway through the range.
- **Films built** lists every film still on disk with its size, and plays,
  downloads or deletes each one. Rendering is on demand and one at a time, so
  it never competes with a match.

### Lights, and other pre/post actions

Every archival frame looks the same only if the field is lit the same way.
Rather than teach pFMS about any particular light system, the section takes
two optional HTTP calls — method, URL, headers, JSON body — fired either
side of the shutter, with a settle delay in between (default 5 s).

They are **skipped whenever the field is in use** (a match is running or any
robot is enabled). The frame is still taken; only the lights are left alone.
The post action also runs when the capture itself failed, so the lights are
never left up.

For Home Assistant, snapshot the lights into a scene first and restore that
scene afterwards, so they end up exactly as they were — including off:

```
Before:  POST http://homeassistant.local:8123/api/services/scene/create
         Authorization: Bearer <long-lived token>
         {"scene_id":"pfms_timelapse_restore",
          "snapshot_entities":["light.bay_1_2_lights","light.bay_2_3_lights"]}

         (then a second call, or a script that does both)
         POST http://homeassistant.local:8123/api/services/light/turn_on
         {"entity_id":["light.bay_1_2_lights","light.bay_2_3_lights"],
          "brightness_pct":100}

After:   POST http://homeassistant.local:8123/api/services/scene/turn_on
         Authorization: Bearer <long-lived token>
         {"entity_id":"scene.pfms_timelapse_restore"}
```

Only one call fits in each slot, so when two steps are needed (snapshot then
turn on), point the pre action at a Home Assistant script that does both.

**Header values are secrets.** The settings go out to every internal client
on connect — station pages are not authenticated — so header values are
masked (`••• unchanged •••`) on the way out and restored on the way back in.
The token itself never leaves the server after it is saved, and lives in
`setup-config.json` alongside the other settings. A Home Assistant token is
worth scoping: make it from a non-admin Home Assistant user, so a leak cannot
reconfigure the house.

Use **Capture now (with lights)** to prove the whole chain works; the frame
list says whether the lights ran, were skipped, or failed and why.

### What it costs

Measured on the reference field (3686×3290 @ 30 fps, 12.3 Mbit/s h264):

| What                                     | Cost                     |
| ---------------------------------------- | ------------------------ |
| One archival frame (`-q:v 2`, full size) | ~3 MB, ~3 s to take      |
| Fast timelapse, keyframes only, crf 30   | ~19 MB per hour on field |
| Fast timelapse, every second, crf 30     | ~21 MB per hour on field |
| CPU, keyframes only                      | ~20 % of one core        |
| CPU, every second                        | ~85 % of one core        |

Frame rate barely moves the disk cost; `crf` does. The frames are retimed to
30 fps playback before encoding, which is what keeps them cheap — encoding a
timelapse at its capture rate costs roughly 20× more for identical frames.

Files are served at `/api/timelapse/frame/<day>/<name>.jpg`,
`/api/timelapse/active/<day>/<name>.mp4` and
`/api/timelapse/render/<name>.mp4`, with Range support and the same trust as
`/api/recordings`; `?download=1` sends an attachment. What exists is listed at
`/api/timelapse/list?from=&to=`, scanned off the disk rather than from the
log, so the page is right even after files are tidied by hand.

## WebSocket Message Reference

Match control happens over the app WebSocket. The main message types
(see `src/types.ts` for payloads):

- **Field timelapse:** `captureTimelapseFrame` (admin takes a frame now,
  optionally running the light actions), `renderTimelapse` (build a film from
  the frames or the practice chunks), `deleteTimelapseRender` →
  `timelapseState` broadcasts.
- **Practice recording:** `setPracticeRecording` (a station page ticks
  "record while enabled" for its team), `requestPracticeDayLink` → a
  `practiceDayLink` reply to that client only; broadcast
  `practiceRecordingState`.
- **Recordings on disk (admin):** `requestRecordingsInventory` →
  `recordingsInventory` to that client; `deleteRecording`,
  `deleteRecordingsBefore`.
- **Station self-service:** `stationJoinAlliance`, `stationLeave`,
  `stationReady`, `stationStartMatch`, `stationPauseMatch`,
  `stationResumeMatch`, `stationAbandonMatch`, `stationSelfDisable`,
  `stationSelfEStop`, `stationSelfAStop`, `stationSelfUndisable`,
  `stationClearAStop`
- **Controller:** `matchCreate`, `matchCancel`, `matchAbortCountdown`,
  `matchSwapStation`, `matchKickStation`, `matchSetAutoWinner`,
  `matchRequestReady`, `matchStaffIgnore`, `matchClear`,
  `updateMatchConfig`
- **Admin:** `adminStopMatch`, `adminGlobalEStop`, `adminStationEStop`,
  `adminStationDisable`, `adminStationEnable`, `adminClearEStop`
- **Staff:** `staffReady`, `staffHeartbeat`
