# Match Recording + Human Score Review (pFMS ↔ balls-counter)

## Goal

Integrate pFMS (this repo) with the balls-counter project so that:

1. Each pFMS match triggers a **special recording mode** in balls-counter — one
   recording per whole match, with metadata (match id, period boundaries,
   non-scoring periods, pauses/resumes).
2. A per-match **review page** lets human reviewers watch the match with the
   zoomed/cropped view of each goal (blue and red reviewed separately, in
   parallel), quasi-realtime or after the fact, using balls-counter's video
   tagging system.
3. Reviewers report back the **real scores** to pFMS match history.
4. Pause/resume during a match must be handled correctly (metadata must mark
   paused spans; review scoring must ignore/flag them appropriately).
5. **Stretch:** report match data to The Blue Alliance.

## Environment / context

- pFMS repo: this repo (branch: master)
- balls-counter repo: a sibling checkout in a separate private repo
  (note the space in its directory name)
- Tooling: bun (`bun run typecheck` etc.). Commit subjects are user-facing
  (posted to Slack on deploy) — prose, lead with user-visible effect.
- Date started: 2026-07-16

## Decisions already made (don't re-ask)

- Blue and red goals are reviewed **separately, in parallel** (two reviewers
  can work at once).
- One recording per whole match (not per period).
- Metadata must include non-scoring periods and pause/resume spans.

## Plan / steps

1. **[current] Explore both codebases** (two parallel Explore agents) —
   match lifecycle/state machine in pFMS; recording + tagging system in
   balls-counter.
2. Design the integration contract (who calls whom, transport, metadata
   schema, match id linkage, score report-back path).
3. Implement pFMS side: emit match lifecycle events / call balls-counter API;
   accept reviewed scores into match history.
4. Implement balls-counter side: match recording mode, per-match review page
   (per-goal cropped views), score report-back.
5. Handle pause/resume timeline correctness end to end.
6. Verify end-to-end (simulated match).
7. Stretch: TBA reporting.

## Findings / gotchas

### pFMS (explored 2026-07-16)

- **Match state machine**: `src/matchEngine.ts`, single `MatchEngine` class
  (instantiated `index.ts:221`). Phases (`MatchPhase`, `src/types.ts:416-425`):
  `idle | created | countdown | auto | autoPause | paused | teleop | endgame | postMatch`.
  250ms `tick()`; transitions in `transition()` (`matchEngine.ts:684-777`).
- **Integration seam**: `MatchEngine.addStateListener(fn)` (`matchEngine.ts:612`).
  Fires on _every_ broadcast (incl. DS heartbeats) — must debounce on phase
  change. Best template: `matchAudio.ts` `attachToEngine` (`matchAudio.ts:223-276`),
  which tracks `lastPhase`. Wire new modules in `index.ts` near lines 226/253.
- **Pause semantics**: `pauseMatch` (452) freezes tick, saves `prePausePhase`;
  `resumeMatch` (466) restores phase, resets `lastTickTime` — no match time
  lost. Also `autoPause` = the 3s non-scoring gap between auto and teleop.
  Countdown 3s; postMatch 3s ball-count period; auto-clear to idle after 2min.
- **Timing**: hardcoded `OFFICIAL_CONFIG` (`matchEngine.ts:30-37`): auto 20s,
  teleop 140s (10s transition + 4×25s shifts + 30s endgame), pause 3s.
  Sub-periods tracked on scoring side (`ProcessedScoreEvent.matchSubPeriod`).
- **End reasons** (`MatchEndReason`, types.ts:458): `normal | stopped | estop | abandoned`.
- **Match history**: `src/matchHistoryStore.ts` — snapshots on transition into
  `postMatch`; flat JSON file `match-history.json` (cwd), max 100 entries.
  Schema `MatchHistoryEntry` (types.ts:2112-2134) already has
  `redScore`/`blueScore` (summed from `scoringEngine`). **No match id field
  today** — entries keyed only by `matchNumber`/`startedAt`.
  Gotcha: `durationSeconds` is wall-clock so it _includes_ pause time.
- **Scores today** come from external scoring hardware POSTing `ScoreEvent`s to
  `POST /api/score` (`scoringApi.ts`, API-key auth via `apiKeyStore`).
- **Realtime**: single WebSocket `/ws` (`websocketServer.ts`), plus read-only
  `/ws/scores`. Frontend: React 18 + Vite + MUI, multi-page (one html+root per
  page), event bus in `frontend/src/hooks/useBackend.ts`.
- **HTTP surface**: pluggable `httpHandlers[]` (`index.ts:279-284`) — that's
  where a new inbound "reviewed score report" endpoint would go.
- **No tests**; verify = typecheck + manual. Pre-commit lefthook: typecheck +
  prettier --check.

### balls-counter (explored 2026-07-16)

- Python ≥3.11, uv + hatchling, single daemon: frame loop in
  `src/ball_counter/main.py` (`run()` line 229, loop line 324), FastAPI web
  server in a daemon thread (`web.py`, ~4000 lines, port 8080). Deployed on
  "sentinel" (RTX 4090) as systemd user service; config `configs/live.json`.
- **One RTSP camera, two goals**: `red-goal` and `blue-goal`, each with
  `crop_override` (the zoomed/cropped goal views already exist per goal).
  Alliance derived from goal-name substring red/blue.
- **Recording**: per-goal `RollingBuffer` (~60s ring, `buffer.py`) — TOO SHORT
  for a whole match; match recording needs a new continuous recorder.
  `save_clip` (`clips.py:34`) writes `{ts}_{goal}.mp4` (mp4v → ffmpeg H.264
  `+faststart`) + `.json` sidecar (per-frame `frame_idx`, `timestamp`,
  `signal`, `rising`, `event`; later keys: `auto_recorded`, `captures`,
  `annotations`, `flags`). Clips in `<config_dir>/clips/`.
- **Review UI** (`_REVIEW_HTML`, `web.py:1761`, served at `/scores`):
  reviewer tokens (`clips/reviewers.json`, admin = label starts `*`), marks =
  `{video_time, frame_idx, timestamp, n_balls}` saved per-reviewer into
  sidecar `annotations[token]`. Agreement endpoint (±2s window), flagging,
  admin trim.
- **Outbound to pFMS already exists**: `PfmsForwarder` (`pfms.py`) POSTs
  `{source, alliance, element, count}` to `{pfms_url}/api/score` with
  `X-API-Key: pfms_key`. Config keys `pfms_url` (`http://pfms.tsl`),
  `pfms_key`, `pfms_source`.
- **No match/session concept, no inbound "start recording" endpoint, no
  WebSocket** — SSE at `GET /api/events`, MJPEG at `/api/stream/{name}.mjpeg`.
  All persistence is flat files; no DB.
- `AutoRecorder` (`main.py:13`) coalesces activity → buffer-slice clips with
  2GB budget; match recorder must be a separate mechanism (don't entangle).

## Integration design

**Transport — extend the EXISTING channel (user decision, 2026-07-16):**
balls-counter already has the pFMS integration (`pfms_url`, `pfms_key`,
`pfms_source` → `PfmsForwarder` POSTs to `{pfms_url}/api/score`). Extend that
rather than adding a reverse push path:

- **balls-counter → pFMS subscription**: balls-counter opens a WebSocket to
  `{pfms_url}` (pFMS already broadcasts full `MatchState` on `/ws` /
  `/ws/scores`) in a reconnecting daemon thread, and drives its own
  `MatchRecorder` from phase transitions. No new pFMS outbound code, no new
  config on either side. On (re)connect pFMS sends current state → recovery
  free (reconnect mid-match ⇒ start late recording, note the gap).
- **Reviewed scores back on the same channel**: POST to
  `{pfms_url}/api/match-review` with `X-API-Key: pfms_key`, sitting next to
  the existing `/api/score` handler.

**Match identity:** new `matchId` (uuid) generated in `MatchEngine.createMatch`,
carried in `MatchState` (⇒ automatically in the WS broadcast) and
`MatchHistoryEntry`. This is the join key across both systems.

**pFMS changes needed for the subscription:** verify `/ws/scores` (read-only)
carries phase + matchId + matchNumber + teams + endReason; add whatever is
missing to that broadcast. No notifier module needed.

**balls-counter match recording** (new `src/ball_counter/match.py`):

- `MatchRecorder` — on match start, opens one incremental recording per goal
  (VideoWriter fed from the frame loop, NOT the rolling buffer), accumulates
  the same per-frame sidecar rows as `save_clip`, plus a `match` metadata
  object: matchId, matchNumber, teams, ordered timeline of
  `{phase, wall_ts, frame_idx}` events including pause/resume spans and
  endReason. On end: finalize both clips (H.264 re-encode), write sidecars
  with `match` block, write `clips/matches/{matchId}.json` index entry
  referencing the two clips.
- Recording runs THROUGH pauses (continuous video); paused spans are metadata.

**Review page** (balls-counter, `/match/{matchId}`):

- Lists both goal recordings; reviewer picks a goal (blue/red reviewed
  independently, in parallel by two people). Reuses review-UI marking
  interaction, adds match-period shading on the timeline (auto/autoPause/
  teleop/endgame/pause/postMatch) from the match metadata.
- Scoring periods for tally: auto, autoPause (balls in flight from auto),
  teleop, endgame, postMatch tail. Excluded: countdown, paused spans.
- "Submit final score" tallies marks within scoring periods, splits
  auto/teleop, POSTs to pFMS `POST /api/match-review` with
  `{matchId, alliance, score, autoScore?, reviewer, nMarks}` + X-API-Key.

**pFMS reviewed-score intake:**

- New http handler `POST /api/match-review` (API-key auth, same as scoring
  API) → `matchHistoryStore.applyReview(matchId, alliance, ...)` — stores
  reviewed scores in NEW fields (`reviewedRedScore`/`reviewedBlueScore`, plus
  reviewer + timestamp), never overwriting live scores. Broadcast history
  update over WS; match page shows reviewed score next to live score and
  links to the balls-counter review page for recent matches.

**Quasi-realtime:** MVP = review available as soon as the match ends
(finalize takes seconds). Live-during-match marking can come later via the
existing MJPEG + a marks-by-wall-clock-timestamp merge (sidecar frames carry
wall timestamps, so live marks map cleanly onto the finished recording).

**TBA (stretch, not in MVP):** deferred; would be a pFMS-side reporter using
the TBA write API. Noted only.

## Implementation phases

- **A (pFMS):** matchId in engine/state/history → notifier module + config →
  `POST /api/match-review` intake + reviewed fields → match page UI (reviewed
  score display + review link). Commit per coherent unit.
- **B (balls-counter):** MatchRecorder + frame-loop hook + match endpoints +
  match store.
- **C (balls-counter):** `/match/{id}` review page + score tally + submit to
  pFMS.
- **D:** end-to-end verification with a simulated match (video-file source ok).

## Progress log

- [x] Located balls-counter repo path (user confirmed).
- [x] Exploration of pFMS match system.
- [x] Exploration of balls-counter.
- [x] Integration design written down (channel decision confirmed by user).
- [x] pFMS Phase A implemented (2026-07-16), typechecks clean:
  - `matchId` (uuid) assigned in `startMatch`, cleared on `abortCountdown`,
    exposed in `MatchState` → broadcast on `/ws` + `/ws/scores`.
  - `MatchHistoryEntry`: new `matchId`, `review` (per-alliance
    `MatchReviewResult`), `reviewUrl` fields; store gains `applyReview()` +
    `setReviewUrl()`.
  - New `src/httpApiUtils.ts` (readBody/json/extractKey/checkAuth extracted
    from scoringApi for reuse).
  - New `src/matchReviewApi.ts`: `POST /api/match-review` (reviewed score,
    API-key auth), `POST /api/match-review/recording` (register review URL),
    `GET /api/match-review/matches` (reconciliation). Wired in `index.ts`.
  - Match page history rows: reviewed score shown (sensor count struck
    through when it disagrees), winner from best-known score, Review /
    Reviewed ✓ link button when a recording is registered.
- [x] pFMS committed: `889d155` on master (typecheck blocker cleared once the
      concurrent scoreboard-video thread landed `21c1eae`).
- [x] balls-counter implemented + committed (`9aafa10` on
      `fix/package-for-latest-uv`): `src/ball_counter/match.py` (MatchRecorder +
      PfmsMatchLink + store/spans/tally helpers), web endpoints (`/matches`,
      `/match/{id}`, `/api/match...`), main-loop frame feed, `public_url`
      config key, `websockets` added to the web extra. Smoke test
      `scripts/smoke_match.py` passes (recorder lifecycle, spans, tally, abort).
- [ ] **[current] End-to-end verification** via twin harnesses:
      pFMS `scripts/e2e-match-harness.ts` (real MatchEngine/HistoryStore/review
      API + WS broadcast, port 39871) ↔ balls-counter
      `scripts/e2e_match_review.py` (real link/recorder/web app, synthetic
      30fps camera, port 39872). Exercises pause/resume, tally exclusion,
      report-back.
- [x] Coordination: user requested `./.agent.status` append-only work log
      (repo root, timestamps) — read before repo actions, append when acting.
- [x] Deployed to the live field (2026-07-19, user-authorized): pFMS was
      already running the new code (deployed by other means; today's matches
      have matchIds). Sentinel: pushed branch (8518cea), safety-stash of
      redundant local packaging edits, checked out
      `fix/package-for-latest-uv`, `uv sync --all-extras` (websockets 16.1),
      added `"public_url": "http://sentinel.tsl:8080"` to configs/live.json,
      restarted service. Verified: /api/match 200, /matches 200, counting
      alive, ESTAB WebSocket from sentinel→pfms.tsl:80.
      Gotchas: sentinel service stdout is block-buffered (journal lines lag
      ~minutes — PYTHONUNBUFFERED apparently not set in current unit env;
      optional follow-up). Recordings/Review buttons only exist for matches
      played AFTER this deploy. PR #1 still open (branch not merged to
      master).
- [x] Shift-aware review (2026-07-19, committed pFMS `430ded1` + balls
      `4d18b93`, E2E PASS): MatchState broadcasts `subPeriod` +
      `inactiveGoalAlliance` (shared `src/shiftState.ts` logic, frozen during
      pauses); balls-counter records shift changes as timeline events, spans
      carry `sub`/`active`, tally counts only active-goal marks with the 3s
      balls-in-flight grace (mirrors scoring engine `GOAL_GRACE_SECONDS`);
      review UI dims inactive shifts, live badge shows sub-period,
      `goalInactive` reported separately. NOT YET DEPLOYED — needs pFMS
      deploy to steamboat (peers' undeployed commits would ride along) and
      balls-counter push+pull+restart on sentinel.
- [ ] Stretch (not started): The Blue Alliance reporting.

## Open questions for the user

(none yet)

## Things not to do

- Don't assume balls-counter and pFMS share a runtime — they are separate
  projects, likely separate processes/hosts on the field network.
