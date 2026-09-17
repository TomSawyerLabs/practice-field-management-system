# Scoring System

An HTTP API for tracking scores from external goal-watching devices
(sensors, cameras, referee tablets, ESP32s, etc.). Scoring detection is
the responsibility of the devices — they send events, and the server
translates them into points.

## Modes

- **Free play (default):** a 30-second sliding window shows a rolling
  count of recent scores. Events age out automatically. Recent scoring
  batches are also tracked for display.
- **Match mode:** scores accumulate from zero with per-phase breakdowns.
  Automatically activates when a match starts and returns to free play
  when the match clears.

## Key Concepts

- **Elements** — configurable scoring types (e.g. "speaker", "amp",
  "foul") with point values, optional phase restrictions, and
  deduplication windows.
- **Sources** — each device identifies itself; the server tracks health
  and event counts per source.
- **Deduplication** — when multiple sensors watch the same goal, events
  for the same element and alliance within a configurable window merge
  into one.
- **Fouls** — elements with `awardToOpponent: true` give points to the
  opposing alliance.
- **Timing** — match scoring depends on _when the ball scored_: auto or
  teleop, which shift, whether the goal was on. Detectors lag (video
  pipelines, peak detection, retries), so a device should report `ageMs`
  — how many milliseconds before it sent the request the score happened.
  The server keeps a timeline of the match and judges each event at
  `receiveTime − ageMs`, so a late report still lands in the right
  period and the live score is recomputed accordingly. No clock sync is
  needed. `timestamp` (epoch ms) is accepted as a fallback when it is
  plausible against the server clock. The response carries a receipt per
  event saying where it was attributed and whether it counted.
- **Phase restrictions** — elements can be limited to specific match
  phases (e.g. auto-only bonuses). For events with **no** timing
  information, a grace window (default 5 s, configurable as
  `phaseGraceSeconds`) assumes a report arriving just after a phase
  change scored just before it. Timed events ignore this.
- **Auto-registration** — unknown element names in incoming events are
  auto-created (1 point each) up to `SCORING_AUTO_REGISTER_LIMIT`
  (default 1); beyond the limit they're rejected as `unknown_element`.
  Set the limit to `0` to require explicit configuration.
- **Goal-active shift scoring (REBUILT)** — in match mode, balls scored
  while the alliance's goal is off don't count toward the match total.
  A goal is off during the other alliance's teleop shifts and while the
  match is paused by the operator; in both cases balls scored within 3 s
  of the goal turning off still count (they were in flight). Balls that
  scored before the countdown ended are not part of the match at all.
  Match scores break down by period: auto, transition, shifts 1–4, and
  endgame. The auto winner is decided from balls that scored during
  auto and the pause after it, judged by their own timing — a detector
  whose lag exceeds the auto pause can still miss that decision.

## Quick Start for a Scoring Device

```
POST /api/score?key=YOUR_KEY HTTP/1.1
Host: pfms.local:3000
Content-Type: application/json

{"source":"goal-1","alliance":"red","element":"speaker","ageMs":350}
```

`ageMs` is how long before sending the score actually happened; leave it
out only if the device reports instantly. Multiple events can be
submitted in one request; a batch that partially succeeds returns HTTP 207. The response lists a receipt per event (`events[]`) with the phase
and sub-period it was attributed to and whether it counted.

### Authentication

Via `X-API-Key` header or `?key=` query parameter. API keys are managed
through the admin panel at `/admin`. Once a key is created, authentication
is required for write endpoints. Unrecognized devices appear as "pending"
in the admin panel for one-click approval.

> **Open until the first key exists.** Until you create a key, the scoring
> API accepts writes from **any device on the network** — submitting
> scores, resetting them, and replacing the element configuration. That's
> deliberate: a new sensor works with no setup at all.
>
> Two ways to close it:
>
> - **Create an API key** in `/admin`. From then on writes need a key, and
>   unrecognized devices show up as pending for one-click approval.
> - **Set `SCORING_REQUIRE_KEY=true`** to refuse unauthenticated writes
>   outright, including before any key exists — so there's no open window
>   at all on first boot.
>
> The setup screen reports which mode the field is in, so you can verify it
> rather than assume. See the
> [security model](support.md#security-model--read-this-before-opening-a-field).

## Endpoints

| Endpoint             | Method | Auth     | Description                                                                                    |
| -------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `/api/score`         | POST   | Required | Submit score event(s); 207 on partial batch success                                            |
| `/api/score`         | GET    | None     | Get current score state                                                                        |
| `/api/score/reset`   | POST   | Required | Reset all scores                                                                               |
| `/api/score/config`  | GET    | None     | Get element configuration                                                                      |
| `/api/score/config`  | PUT    | Required | Replace element configuration                                                                  |
| `/api/score/mode`    | PUT    | Required | Set mode, sliding window size, `autoRegisterLimit`, `phaseGraceSeconds`, `batchTimeoutSeconds` |
| `/api/score/sources` | GET    | None     | List scoring sources and their status                                                          |
| `/api/score/schema`  | GET    | None     | Machine-readable API schema                                                                    |

Full API documentation is served at `GET /api/score/schema` as an
[OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0) spec in JSON. Point
any OpenAPI-compatible tool (Swagger UI, Redoc, code generators) at it, or
read it directly from tiny devices.

Score state is also broadcast in real time to all WebSocket clients as
`scoreState` messages, and read-only to scoreboard clients on the
`/ws/scores` WebSocket path (no auth — it backs the public `/scores`
page).

## Match Review

Recorded matches (see [match history](match-system.md#match-history)) can
be re-scored after the fact — e.g. from a video review station:

| Endpoint                      | Method | Auth     | Description                                       |
| ----------------------------- | ------ | -------- | ------------------------------------------------- |
| `/api/match-review`           | POST   | Required | Submit reviewed scores for a match (per alliance) |
| `/api/match-review/recording` | POST   | Required | Register a review-page URL for a match            |
| `/api/match-review/matches`   | GET    | None     | List recorded matches for reconciliation          |

Reviewed values override the live sensor counts in match history, and the
`/match` page highlights disagreements between the two.

The ball counter (balls-counter) depends on the read-only broadcast: it keeps
`/ws/scores` open and starts and stops its per-match recording from
`MatchState` (`phase`, `matchId`, `subPeriod`, `inactiveGoalAlliance`, pause
spans), joining on `matchId`, and its tally mirrors the 3 s in-flight grace.
Don't drop or rename those fields.
