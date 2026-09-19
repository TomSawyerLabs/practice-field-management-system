# Record practice runs while enabled, with a per-day download link sent to mentors

## Goal

Teams already get a video of every match. Most field time is not matches — it is
a robot enabled from its own Driver Station for a minute at a time. Cameron
(2026-09-19) wants:

1. A simple opt-in checkbox on the driver (station) page: **Record while
   enabled**. Every time the robot is enabled outside a match, pFMS records the
   field streams from 3 s before the enable to 3 s after the disable.
2. Each recording carries its metadata: every ball scored while it ran (the
   full processed score event, not just totals) and the robot's telemetry
   (battery voltage, brownouts, RTT, packet loss, CAN utilisation, DS status).
   Match recordings get the same sidecars.
3. A link that downloads the whole set of videos for a team's practice day,
   usable from offsite (no login), including a single zip of everything.
4. That link is posted automatically to the team's mentors on Slack when their
   session is over.

## Environment / context

- Backend: Node 22 on steamboat (`node dist`), Bun locally for scripts/tests.
  Recordings live under `recordings/<id>/` next to `match-history.json`;
  steamboat's retention is 360 days, stream `all-field` from
  `rtsp://sentinel.tsl:8554/all-field`.
- ffmpeg 7.1 on steamboat; no `zip` binary there, so the zip is written by
  pFMS itself (`src/zipStream.ts`, store-only, ZIP64).
- Public paths are enumerated in Caddy (ops repo,
  `servers/steamboat/sites.d/pfms.caddy`): `/matches/*`, `/api/public/*`,
  `/assets/*`. The new page path `/practice/<token>` needs the same treatment —
  **a Caddy change Cameron must authorise per-change**; the API part
  (`/api/public/practice/…`) is already public by prefix.
- "Enabled" for out-of-match robots comes from the DS UDP status
  (`TelemetryManager` → `TelemetryUpdate.dsStatus.enabled`), not from the match
  engine (which only drives enable during matches).
- Slack: one bot in the pfms-support workspace (`slack-config.json`). Its
  granted scopes (checked 2026-09-19 via `x-oauth-scopes`): chat:write,
  files:write, channels:read, users:read, channels:history, emoji:read —
  enough to list users and DM them.

## Decisions already made (don't re-ask)

- **Continuous ring buffer while an opted-in team is on the field.** A 3 s
  pre-roll needs footage from before the enable, so ffmpeg pulls each stream
  continuously into 1 s MPEG-TS segments (`-f segment`, `-c copy`) while any
  opted-in team's DS is attached; segments older than ~15 s are deleted unless
  a run is being captured. Cost is one extra RTSP reader per stream, no
  transcoding.
- **One run per robot, never coalesced** (Cameron, 2026-09-19 review): each
  opted-in station's enable starts its own run and its disable ends it, 3 s
  padded, with a 2 s merge window for a quick disable/re-enable. Six robots
  running independently produce six files of the same field view, each cut
  to that robot's own times. The ring buffer is shared; the runs are not.
- **Not during matches.** While the match engine is in any active phase
  (countdown through postMatch) the match recorder owns the streams; practice
  runs are only captured in `idle`/`created`.
- **Practice day = local date of (time − 4 h)**, so a session that runs past
  midnight (6036 practised 01:01–02:12 on 2026-09-18) stays in one link.
- **One capability token per (team, day)**, minted when the first recording
  of that day lands, stored in `practice-recordings.json`. Same shape as match
  share tokens (32 base64url chars). The link lists that team's matches and
  practice runs for that day, individual downloads and one zip.
- **Metadata sidecars** are `metadata.json` (score events + telemetry samples
  for the window, plus participants and timing) and `telemetry.csv` /
  `scores.csv` for spreadsheets, written into the recording directory by both
  recorders from a shared rolling collector (`src/sessionMetadata.ts`).
- **Slack delivery is automatic, no admin table** (Cameron, 2026-09-19
  review): the link is DMed to every workspace member whose display name,
  real name or title contains the team number — the pfms-support convention
  ("Mark 5940", "Aidan Honnold (5940)", "Stephan Massalt (971/9584)"). One
  message per member per team per day. Individual DMs rather than a group
  DM because `chat.postMessage` to a user id needs only `chat:write`, which
  the bot has; group DMs would need `mpim:write`. Nobody claims the team →
  one note in the support channel, no link.
- **When to post:** once per team per practice day, the first time the team
  has been quiet for 20 minutes (no enable, no DS attached) after recording
  something, or at day rollover. Later recordings the same day extend the same
  live link; no repeat messages.
- **Video card on the station page** stays keyed by team number only (see
  `plans/match-video-privacy.md`), and shows the checkbox even before any
  recording exists so the opt-in is discoverable. Day-link tokens are not
  broadcast; the page asks for its own team's link.

## Plan / steps

1. [x] Survey recorder, history, public API, Slack bridge, station page.
2. [x] Types + `src/zipStream.ts` (+ test).
3. [x] `src/sessionMetadata.ts` rolling collector; `ScoringEngine.addEventListener`.
4. [x] `src/practiceStore.ts` (opt-in, recordings, day tokens, slack sent).
5. [x] `src/practiceRecorder.ts` ring buffer + runs (+ ffmpeg testsrc test).
6. [x] Match recorder writes the same sidecars.
7. [x] `src/practiceApi.ts`: `/api/public/practice/<token>` JSON, video, zip.
8. [x] `src/teamContactStore.ts`, Slack bridge posting helpers, `src/practiceNotifier.ts`.
9. [x] Wire websocket messages + index.ts.
10. [x] Frontend: station card checkbox + today link + run list; `/practice/<token>` page; admin contacts section.
11. [x] Docs (match-system, support scopes, configuration, README); Caddy change staged in ops (uncommitted).
12. [x] Typecheck, tests (91 pass), frontend build; commits below.
13. [x] Cameron authorised the Caddy change and the deploy (2026-09-19); reworked to per-robot runs and automatic Slack delivery.
14. [x] ops Caddy change pushed (cedfaae, CI run 35469957830 green); pFMS deployed twice (6148723, then 3e4ba78 with the public-route fix); /practice/<token> page and /api/public/practice/<token> answer from the internet; a bot DM to a user id works with the existing scopes (tested against Cameron Test).
15. [ ] First real use: a team ticks the box, enables, and the clip + Slack DM are checked end to end on the field.

## Findings / gotchas

- **Segment timing by mtime works.** With `-f segment -segment_time 1` on
  a 1 s-GOP source the end-to-end test produced a 10–11 s clip for a 4 s
  enable (3 s pad each side), and the TS→MP4 concat (`-c copy
+faststart`) needed no explicit `aac_adtstoasc` (ffmpeg inserts it).
- **Windows holds a just-closed segment briefly**, so `rmSync` of the
  buffer dir right after stopping ffmpeg can hit EBUSY. `stop()` treats
  that as best-effort; `start()` clears the directory anyway.
- **Out-of-match "enabled" comes from telemetry, not the match engine.**
  Both the DS UDP status (`TelemetryManager`) and the sniffed robot packets
  (`RobotPacketCapture`) carry `dsStatus.enabled`; the practice recorder
  listens to the coalesced telemetry stream, so either source works.
- **No `zip` on steamboat** — hence the in-process store-only ZIP64 writer.
- **Prettier pads markdown table cells**, so scripted edits to the docs
  tables must match on the cell text, not the whole padded line.
- **`handlePublicMatchRequest` claimed all of `/api/public/*`** and 404'd
  the practice API behind it; only visible in the live check, not in any
  test. Fixed in 3e4ba78 (own-prefix check + regression test). Any future
  `/api/public/<thing>` handler must be registered with that in mind.
- **A bot DM needs only `chat:write`**: `chat.postMessage` with a user id as
  the channel opened the IM itself (channel D0C2YNYCF45). Group DMs would
  need `mpim:write`, which is why delivery is one DM per member.

## Progress log

- 2026-09-19: plan written after survey; implementation starting.
- 2026-09-19: everything built and green locally (typecheck, 91 tests incl.
  a real-ffmpeg practice-run test, frontend build). Caddy change staged in
  the ops checkout, not committed. Not yet deployed.
- 2026-09-19 (later): Cameron's review → per-robot clips (no coalescing)
  and automatic Slack DMs by team number in Slack names; admin contact
  table removed. Caddy change deployed via ops CI; pFMS deployed; public
  route bug found live and fixed; 95 tests green.

## Open questions for Cameron

1. Caddy: `/practice/*` must join `/matches/*` in the public-path list, the
   https redirect and the `scores.html` rewrite. Staged in the ops repo when
   ready; needs your explicit yes.
2. (resolved) No extra Slack scopes needed with individual DMs.

## Things not to do

- Don't gate practice downloads behind an API key or login — the token is the
  credential, same as `/matches/<token>`.
- Don't broadcast day tokens to every LAN client.
- Don't run a second recorder during matches.
