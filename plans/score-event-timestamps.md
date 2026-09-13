# Score events carry the time the ball actually scored

Spans two repos:

- pFMS: `~/git/practice-field-configurator` (this plan lives here)
- balls counter: `~/git/Personal Projects/balls counter` (has a stub plan
  pointing here: `plans/score-event-timestamps.md`)

## Goal

The balls counter detects a ball some time after it crosses the goal
(peak-detection lag, RTSP/decoder latency, GPU contention, HTTP thread
scheduling, retries). pFMS currently stamps every score event with its
_receive_ time and evaluates match phase / REBUILT shift state / goal-off
grace at that moment. When detection lags, balls scored just before a
goal turned off (or just before auto ended) get counted as off-goal or in
the wrong period, and the live scoreboard is wrong.

Fix: every score event carries when the ball actually scored, and pFMS
attributes it against a recorded match timeline at _that_ moment rather
than at arrival. Live totals are recomputed from events, so late arrivals
land in the right period automatically.

## Decisions already made (don't re-ask)

- **Timing is expressed as `ageMs`, not an absolute timestamp.** `ageMs` =
  milliseconds between the score and the moment the HTTP request was
  sent. The server computes `occurredAt = receivedAt - ageMs`. This needs
  no clock sync between the counter and pFMS (a Pi without RTC can be
  minutes off after a power cycle). LAN transit is ~ms, negligible against
  the 3 s grace windows. `timestamp` (epoch ms) stays supported as a
  fallback for devices with trustworthy clocks; it is sanity-checked and
  ignored if implausible.
- **`ageMs` is recomputed at every send attempt** from a monotonic
  event time, so a retried/queued request stays accurate.
- **The counter's "moment of scoring" is the signal peak frame**, not the
  detection frame (threshold detector fires several frames after the
  peak, once the signal has fallen). YOLO uses the frame the track first
  appeared inside the ROI; the ML detector already reports the peak.
- **A configurable `pfms_capture_latency_ms`** (counter config, default 0)
  is added to `ageMs` to account for camera → decoder → Python pipeline
  latency, which frame read time cannot see.
- **pFMS keeps a match timeline** (one sample per matchState broadcast,
  ~4/s) and evaluates phase, sub-period, shift state and grace at
  `occurredAt` by interpolating remaining time from the nearest earlier
  sample. Timer-driven phase boundaries are back-dated to the instant the
  previous phase's clock ran out, so attribution is sub-tick accurate.
- **`phaseGraceSeconds` becomes a fallback** that only applies to events
  with no timing info (it was a workaround for exactly this lag).
- **Operator pauses are an off period.** Balls scored more than 3 s after
  a pause begins are `goalInactive` (robots are disabled; nothing
  legitimate can score). Previously pFMS counted them; the counter's
  review tally excluded them with no grace. Both now agree: 3 s grace,
  then excluded. This is a deliberate behaviour change.
- **Pre-match events don't count.** An event that _occurred_ before the
  countdown started (idle/created/countdown) but arrives after match start
  is `outsideMatch` — not counted in match totals, not shown as off-goal.
- **Auto winner uses the `auto` sub-period** (auto + autoPause) rather
  than `phaseBreakdown.auto`, which only matched the `auto` phase and was
  silently relying on the 5 s phase grace to sweep autoPause events in.
  Lag longer than the auto pause can still miss the winner computation;
  the pause duration is the lag budget.
- **Dedup, free-play batches and the sliding window use `occurredAt`.**
- **Tests use `bun test`** (`@types/bun` dev dependency). pFMS had no
  test runner; the timeline/attribution logic is exactly the kind of
  thing that needs one.

## Environment / context

- pFMS backend: Node/TS, `src/scoringEngine.ts`, `src/scoringApi.ts`,
  `src/shiftState.ts`, `src/matchHistoryStore.ts`, `src/index.ts`. Typecheck
  with `bun run typecheck`; lefthook runs typecheck + prettier on commit.
- Balls counter: Python 3.11, `uv`. Files: `src/ball_counter/pfms.py`
  (forwarder), `counter.py` (MotionEvent, threshold detector),
  `yolo_detector.py`, `ml_detector.py`, `stream.py` (frame read /
  GoalProcessor.process), `main.py` (loop, forwarder.send calls),
  `match.py` (review tally), `config.py`. Smoke tests:
  `uv run --extra web python scripts/smoke_match.py`.
- Counter runs as a user systemd service on `sentinel`; pFMS at
  `http://pfms.tsl`. Deploy of pFMS is via the `deploy` skill (not part of
  this task unless asked).

## Plan / steps

1. [x] Read both codebases; write this plan.
2. [x] pFMS `src/matchTimeline.ts`: sample recorder + `at(t)` + goal-active
       classification (shift grace, pause grace, outsideMatch).
3. [x] pFMS `ScoringEngine`: resolve `occurredAt` (ageMs > timestamp >
       receive), attribute via timeline, dedup/free-play on occurredAt, per-event
       `lagMs`/`timing`, source `lastLagMs`, score timeline from events.
       Re-attributes events when a timer-driven boundary is back-dated.
4. [x] pFMS API: accept `ageMs`; validate; return per-event attribution in
       the POST response (`events[]` receipts); update OpenAPI schema text.
5. [x] pFMS `index.ts` auto-winner resolver → periodBreakdown.auto.
       `matchHistoryStore` builds the score timeline from event times and
       keeps updating the entry through the post-match count (it used to
       snapshot at the _start_ of postMatch and miss balls in flight).
6. [x] pFMS admin page: show per-source lag inline (and drop the `title=`).
7. [x] pFMS tests (`bun test`, 33 tests): timeline interpolation/back-dating,
       shift grace at occurredAt, pause grace, outsideMatch, ageMs vs receive,
       dedup by occurredAt, re-attribution, score timeline.
8. [x] Counter: MotionEvent `lag_frames` + `mono`/`wall`; per-frame read
       time ring in GoalProcessor; stamped once per frame in
       `StreamProcessor.process_frame`.
9. [x] Counter: PfmsForwarder → queued worker, batching, retry with
       backoff (4xx not retried), ageMs at send time, capture latency, logs
       the server's receipt per score. Worker survives exceptions.
10. [x] Counter: `main.py` passes event timing; manual scores = now.
        `match.py` tally gets pause grace. Config key + README.
11. [x] Counter smoke test for the forwarder (fake HTTP server):
        `scripts/smoke_pfms_forwarder.py`. `smoke_match.py` expectation
        updated for the pause grace.
12. [x] Docs: `docs/scoring.md`, counter README. Both repos committed.

## Findings / gotchas

- Threshold detector (`MotionCounter.process_frame`) emits the event on
  the frame where the signal falls below `fall_ratio × peak` — the peak
  (crossing) was 1–N frames earlier. `event.frame` is the detection
  frame. Clips/sidecars use `event.frame`; keep it, add `lag_frames` (a
  delta, so it works whichever detector's frame numbering `frame` is in —
  YOLO keeps its own counter that resets independently).
- The forwarder worker thread died on a `→` in a `print` under the
  Windows cp1252 console. Worker output is ASCII now and the loop body is
  wrapped so no exception can kill it.
- A goal that is off through a pause and then off by shift has been off
  continuously — no fresh 3 s grace at the shift boundary. Both pFMS
  (`isGoalOff` is one continuous predicate) and the review tally agree.
- Frame wall-clock in the counter is `datetime.now()` at read time
  (`timestamp_str`), formatted as a string — no numeric per-frame time
  existed. GPU path drains stale frames on read so the read time is close
  to "latest decoded frame", but decoder latency is invisible; hence the
  configurable capture latency.
- `phaseBreakdown` keys by raw phase (`auto`, `autoPause`, ...) while
  `periodBreakdown` keys by sub-period (`auto` covers autoPause). The
  auto-winner resolver used `phaseBreakdown.auto`, which only worked
  because the 5 s phase grace re-labelled autoPause events as `auto`.
- The match engine broadcasts every 250 ms tick; `remainingTime` is
  decremented by wall-clock deltas, so interpolating from the last
  sample is faithful. Frozen clock cases: `paused`, and `autoPause` with
  `awaitingAutoWinner` (tick stopped until a winner is picked).
- `ProcessedScoreEvent` is engine-internal; `ScoreState` only carries
  aggregates, so restructuring event fields doesn't touch the frontend
  beyond what's added deliberately.
- Old forwarder was fire-and-forget with a daemon thread per event and
  no retry: a pFMS hiccup silently lost balls. With accurate ages, a
  retry queue is now safe (late delivery still lands in the right period).
- `@types/bun` (for `bun test`) ships `bun-types` that only type-check
  against a newer `@types/node` than the project pins (tried 22.20 and
  24.13, both still fail inside bun-types' own .d.ts). Fixed with
  `skipLibCheck: true` in the backend tsconfig — the frontend already had
  it. `@types/node` stays at `^22.13.13`.
- `matchHistoryStore` used to snapshot scores the instant postMatch began;
  balls landing during the post-match count (and any lagging reports) never
  made it into history. Now the entry stays open until the field clears.

## Things not to do

- Don't rely on absolute device timestamps for attribution without a
  plausibility check; clock skew would silently mis-score.
- Don't change `MotionEvent.frame` semantics (clips, sidecars, review use
  it).
- Don't disable the phase grace outright; devices without timing info
  still need it.
- Don't route counter scores through the review endpoint; live scoring
  stays on `POST /api/score`.

## Progress log

- 2026-09-13: plan written. pFMS side implemented, tested (33 `bun test`
  cases) and committed as 6839df2. Counter side implemented, smoke-tested
  and committed. Both deployed 2026-09-13 ~15:12 PDT: pFMS on steamboat (origin/master 7840156, cherry-picked onto the remote tip from a temp worktree because a peer session had this tree dirty), counter on sentinel (897046d on branch fix/package-for-latest-uv, PR #1 still unmerged). Verified: new API live via pfms.tsl, counter holds a WebSocket to pFMS. Steamboat gotcha: its bun.lock had a `configVersion` line added by a newer bun that blocked `git pull`; discarded (metadata only).

## Open questions for the user

1. `pfms_capture_latency_ms` defaults to 0. Worth measuring on sentinel
   (e.g. film a clock visible to the camera and compare with the
   counter's logged frame time) and setting in `config.json`.
2. Deploy: both sides need deploying together-ish. Old counter + new pFMS
   is fine (no ageMs → receive-time fallback with phase grace, as before).
   New counter + old pFMS is also fine (unknown `ageMs` field is ignored
   by the old validator). So order doesn't matter.
