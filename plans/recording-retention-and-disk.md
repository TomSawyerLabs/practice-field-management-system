# Recording retention by kind, a free-space floor, and no team clips in match mode

## Goal

Cameron (2026-10-01), after "record while enabled" became the default for
every team (`plans/timelapse-viewer.md`, open question 1):

1. **Free-space checks** on the recordings volume.
2. **Teams' clips are deleted automatically after a week.**
3. The long-term **timelapses stay longer** (they already do — see below).
4. **Scrimmage match videos stay longer — about a month.**
5. **Don't save individual team videos in match modes.**

## Environment / context

- One retention number existed: `SetupSettings.recordingRetentionDays`
  (default 30, **360 on steamboat**), applied by `MatchRecorder.sweep()` to
  every non-dot directory under `recordings/` — matches and `practice-*`
  runs alike. The sweep ran at startup and every 24 h.
- Timelapse has its own store and sweep (`.timelapse/`): chunks 60 days,
  archival frames forever. Untouched by this work.
- Team clips cost ~5.5 GB per hour of enable time, one copy per enabled
  robot. steamboat: 387 GB free.
- Practice clips were already skipped from countdown through post-match
  (`isPracticePhase` = idle/created).

## Decisions already made (don't re-ask)

- **"Match mode" = a match is set up on the field (any phase but idle) OR
  the match queue is in use (line open, or a match queued / on deck).**
  Cameron picked this over "match set up only", "queue only" and a manual
  switch (2026-10-01).
- Team clips: **7 days** default (`practiceRetentionDays`). Match videos:
  the existing `recordingRetentionDays`, default **30**.
- Low space **pauses new team clips and deletes nothing early** — the
  week-long retention is what frees space. (My earlier recommendation, which
  Cameron said to implement.)

## Design

- `MatchRecorder.sweep()` picks the window per directory: `practice-*` →
  practice retention, everything else → match retention. Runs hourly, so a
  clip lives 7 days, not "7 days and up to another day".
- Free space is re-read every minute. Two floors:
  - **`recordingMinFreeGb`** (default 25): below it, no new team clips and
    the ring buffer stops. A run in progress is closed and kept.
  - **Hard floor, fixed 2 GB**: below it, match recording is refused too,
    with the reason in the recorder's status — a full disk would break more
    than video (match history, settings, logs are on the same volume).
- `PracticeRecorder` takes `pauseReason()`; index.ts answers with the
  match-mode rule or the low-space one. The reason is broadcast
  (`PracticeRecordingState.pausedReason`) and shown on the station card.
- Admin page: both retention numbers and the floor; a warning when low.

## Progress log

- [x] Settings + sweep by kind + hourly sweep + tests
      (`src/recordingRetention.test.ts`).
- [x] Free-space floors + tests (free space injectable via `freeBytes`).
- [x] Practice pause (match mode, low space) + station card text + test
      (real ffmpeg: a clip in progress is cut at the pause and saved).
- [x] Admin UI, practice-day page / Slack wording, docs.
- [ ] Not seen in a browser: the admin fields/warning and the station-card
      pause text are typechecked only.
- [x] Deployed 2026-10-01 16:04 PDT (`5425f4c`), 387 GB free at the time.
- [x] Low-space Slack note, unclaimed-team notes dropped, forgotten queue
      line auto-closes — built and tested 2026-10-01; deployed 21:19 PDT
      (`0e908b4`).
- [ ] steamboat's stored `recordingRetentionDays` is 360 — to become 90.

## Decisions from the walk-through (2026-10-01)

- **Match videos on steamboat: 90 days** ("90 days is fine"). The oldest
  recording there is 18 days old, so nothing is deleted by the change.
- **Low space is posted to the support channel, once per change.** Cameron
  said "#pfms-support or DM to admin"; the channel is what
  `slackBridge.postToChannel` reaches.
- **The "nobody in Slack claims team N" notes are dropped**, not batched.
- **A forgotten queue line closes itself** after 3 h open with nobody in it,
  nothing queued and no match on the field.

## Open questions for the user

1. Setting steamboat's saved `recordingRetentionDays` from 360 to 90: on the
   admin page (Match Video Recording → Keep match videos), or by me editing
   `setup-config.json` on the box at the next deploy?

## Findings / gotchas

- A robot that is already enabled when a pause lifts is not recorded until
  its next enable: the recorder acts on enable edges. Accepted — a pause
  lifting mid-enable is rare (queue closed while someone is driving).
- The queue line left open used to mean no clips at all, by the chosen
  rule. Fixed: it closes itself after 3 idle hours
  (`MatchQueue.closeLineIfIdle`). A restart restarts that clock.
- Low space is posted to Slack once per crossing; `/health/site` still does
  not report it.

## Things not to do

- Don't delete match videos or timelapse early to make room.
- Don't sweep `.timelapse` or `.practice-buffer` from the match sweep.
