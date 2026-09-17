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
   Releasing once the start horn is playing does nothing. Phases then run
   automatically: countdown → auto → pause → teleop → endgame →
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
  so pFMS can't use the bit to notice a disable, and its E-Stop bit has
  never been seen set.

### Admin Overrides

The `/admin` page provides safety overrides independent of the
self-service system: global e-stop, per-station e-stop / disable / enable,
clear e-stop, and force-stop match.

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
to overwrite). Edit the constants in that script — or just drop your own
recordings over the files — if you'd rather have something else.

## Match History

Finished matches are recorded (teams, per-alliance scores, auto winner,
end reason, duration) to `match-history.json` (last 100 matches). The
`/match` page shows recent history while the field is idle, including
reviewed scores when a match has been re-scored through the
[match review API](scoring.md#match-review) — a reviewed value overrides
the live sensor count, and disagreements are highlighted, with a link to
the recording review page when one was registered.

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
  each participating team's **station page** (last five matches), with one
  download button per stream. Downloads are served by the backend at
  `/api/recordings/<matchId>/<file>` with a friendly attachment name and
  Range support, so a browser can also scrub through them.
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

## WebSocket Message Reference

Match control happens over the app WebSocket. The main message types
(see `src/types.ts` for payloads):

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
