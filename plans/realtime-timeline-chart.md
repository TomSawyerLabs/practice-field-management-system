# Bespoke realtime timeline chart (replaces the Smoothie charts)

## Goal

The team page's Radio tab stacks eleven `react-smoothie` charts. Smoothie only
knows numeric lines, so booleans and enums were turned into 0/1 series
(`qualityExcellent`, `robotComms`, `eStop`…), every chart has its own time
axis, and nothing can show a moment in time (an enable, a field Wi-Fi update)
or a second robot.

Replace it with one purpose-built realtime chart:

- one shared time axis, stacked lanes;
- **typed tracks**: numeric samples, states (boolean or enum, held until they
  change), and events (a moment, or a span);
- sources at their own rates on one axis: robot battery (tens of Hz at the
  source), radio registers (~1 Hz, polled at 10 Hz), async state changes,
  field-wide events;
- the team's other robot overlaid on the same chart.

## Environment / context

- Frontend: React 18 + MUI 7, vite, `frontend/src`. Tests: `bun test` (picks
  up `frontend/src/**/*.test.ts`). Checks: `bun run typecheck`, prettier via
  lefthook.
- Team page: `/<ssid>` → `roots/control.tsx` → `ControlPage.tsx`; the chart
  lives in `RadioStatusCard` (Radio tab), which keeps its chart/table toggle.
- The model is shared: `src/timeline/series.ts` (the three track kinds) and
  `src/timeline/store.ts` (`FieldTimeline`: ingest, snapshot, hydrate). The
  server runs one (`websocketServer.ts`, fed from `broadcast()`); each page
  runs one (`frontend/src/timeline/live.ts`).
- Drawing is frontend-only: `frontend/src/timeline/lanes.ts`, `render.ts`;
  `components/TimelineChart.tsx` (full, or `compact` for a card) and
  `components/BatterySparkline.tsx` (the scoreboard).
- `react-smoothie` and `StationChart.tsx` are gone.
- Headless visual check: a fake backend on :3000 (`scripts/fake-timeline.ts`,
  no radio — see "Things not to do"), vite on :5173, Playwright from the
  scratchpad.

### What reaches the browser today (the chart's inputs)

| Source             | Message            | Rate                                                               | Notes                                                                                                                                      |
| ------------------ | ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Radio status       | bare `StatusEntry` | polled 100 ms, broadcast on change + 15 s heartbeat                | `timestamp` = `Date.now()` before the fetch. 60 s of history replayed on connect (as one array). Bare `{timestamp}` = radio not answering. |
| Robot/DS telemetry | `telemetry`        | coalesced to 4 Hz per station; a `dsStatus` change flushes at once | Source is ~40–50 packets/s per robot. `batteryVoltageMin` carries the sag between broadcasts. No history on connect.                       |
| Reconfigure        | `radioReconfigure` | on change                                                          | `since` while active; the end is the next `active:false`.                                                                                  |
| Match              | `matchState`       | on change, 250 ms ticks in a match                                 | No phase-start timestamps: the chart stamps a phase change when it sees it.                                                                |
| Dropouts           | `robotDropouts`    | on change                                                          | A real event log (≤50 per station per visit), finalized a few seconds late.                                                                |

## Decisions already made (don't re-ask)

- **Time base is server time.** Samples keep the server's timestamp; the
  renderer asks `getServerTime()` for "now". Nothing bakes the clock offset
  into a sample (the old charts converted each one).
- **One canvas**, drawn by a framework-free renderer; React only owns the
  controls row and the canvas element. No chart library.
- **Three track kinds**, no cross-dressing: `NumericSeries` (linear, or
  "hold" for registers that keep a value until the next report),
  `StateSeries` (change points, `null` = unknown, goes unknown when its source
  stops reporting), `EventSeries` (instants and spans, upserted by id).
- **Lane headers carry the values** (live, or at the crosshair). No hover-only
  tooltip, no `title=`: a tap sets the crosshair on a phone.
- **Colour**: within a lane, measure A blue / measure B orange; the other
  robot is always aqua (slots 1–3 of the dataviz palette, validated all-pairs
  in both modes against the card surface). State bands use status colours and
  carry a text label when wide enough. Noise is drawn as a shaded floor under
  the signal line and SNR is a figure in the Signal lane's header, not its
  own chart.
- **Rules and flags**: an enable, a disable, a stop, a match phase and a field
  Wi-Fi update draw a line through every lane (broken at the numeric lanes'
  headers so it never crosses out a reading). Everything else is a flag on
  the top strip only. Events at the same moment share one flag.
- **Events are derived in the browser** from state changes (enable/disable,
  comms lost/back, Wi-Fi linked/dropped, brownout) and are only raised when
  the previous state was known, so a page opened on an enabled robot does not
  claim it was enabled just now.
- **Raw packet/byte counters are not charted** (a monotonic ramp says
  nothing); packets/s is derived instead, off by default.
- The battery "relaxing floor" series is gone from this chart: the min
  envelope is drawn as a band at the time it happened. The scoreboard keeps
  its own floor until it is migrated.
- A station's tracks are cleared when a different robot (SSID) takes the
  station, not when the SSID merely blanks during a reconfigure.
- (2026-11-16, user) **4 Hz is the right rate for battery**, as long as each
  4 Hz sample carries min / max / average so nothing aliases away. No
  packet-rate stream.
- (2026-11-16, user) **On page load, replay whatever the server has** about
  the team's robots and the field (events, states), not just 60 s of radio.
- (2026-11-16, user) Hovering shows more: whose data it is (the robot's
  name), which measure, the value.
- (2026-11-16, user) `/overview` and the scoreboard battery cards move to the
  new chart, provided it is no heavier and shows the data better.
- (2026-11-16, user) Default lanes are fine for now; tune later.

## Plan / steps

1. [x] Research, plan doc.
2. [x] **Phase 1 — engine + Radio tab**
   - [x] `timeline/series.ts` + tests
   - [x] `timeline/store.ts` (ingest from today's messages) + tests
   - [x] `timeline/lanes.ts`, `timeline/render.ts`
   - [x] `TimelineChart.tsx`; swapped into `RadioStatusCard`
   - [x] Headless check (dark + light, phone width, two robots), commit
3. [x] **Hover detail**: the lane under the pointer lists each robot's
       reading by name, the nearest one in bold with a ring on its line;
       state lanes say how long the state has lasted.
4. [x] **Phase 2 — server-side timeline with backfill.**
   - [x] Model moved to `src/timeline/`; the server's copy is fed from
         `broadcast()`.
   - [x] Coalescer adds battery max and average; the chart draws the average
         with a min–max band.
   - [x] `timeline` topic (team-filtered): one `timelineSnapshot` on
         subscribe, then the ordinary live messages.
5. [x] **Phase 3 — Smoothie retired.** `/overview` cards use a compact
       `TimelineChart` (all robots' history via `useTimelineBackfill(null)`),
       the scoreboard uses `BatterySparkline`, `react-smoothie` removed.
6. [ ] **First look on the field** with a real robot and radio (current —
       needs a deploy by the deploy thread and someone at the field).

## Findings / gotchas

- Telemetry is throttled for a reason (`telemetryThrottle.ts`): unthrottled it
  was 56 of 58 kB/s on the scores socket and lagged Chromecast scoreboards.
  Full-rate data must be a subscription, never a broadcast.
- `telemetry.csv` is fed from the same 4 Hz stream — nothing full-rate leaves
  the server today.
- The radio history array is replayed by `processHistory` as staggered
  `update` events 200 ms later ("so Smoothie can render"). The new store
  takes the array directly (`history` event) and ignores entries at or before
  the newest it has, so the replay is harmless.
- `dsStatus` from packet capture hard-codes `radioPing`/`rioPing` true and
  `aStop` false; the DS's own UDP status carries the real ones.
- `dataAgeMs` is the radio's own number (time since the AP heard the robot
  radio), not something pFMS computes.
- The DS UDP status rate is described three ways in the code (~50/s, 2 Hz,
  ~2/s) — unverified. State tracks treat 3 s of silence as "unknown".
- Radio status is change-driven with a 15 s heartbeat, so an idle unlinked
  station is only confirmed every 15 s: radio tracks go unknown after 20 s.
- A snapshot is uncompressed JSON: 473 kB for two robots and a full ten
  minutes with the fake backend (its data-age register moves ten times a
  second, which is the worst case). `/overview` asks for every robot, so up
  to ~1.5 MB there. Times go as deltas and values to three decimals; if it
  ever matters, the next step is sharing one time column between the five
  telemetry series, or `perMessageDeflate` for large frames.
- The scoreboard's socket (`/ws/scores`) takes no subscriptions, so its
  sparklines still start empty and fill over 40 s, as the old ones did.
- The scoreboard's "↓" figure changed meaning: it was a floor that relaxed
  towards the current voltage over ~5 s; it is now the lowest reading in the
  40 s the sparkline shows.
- `processHistory` used to replay the radio history as up to 600 staggered
  `update` events ("so Smoothie can render"), each re-rendering every
  `useLatest` user. It now sends one.
- The fake backend must send `version: 'unknown'` in `serverInfo`: any other
  version that differs from the frontend build makes the page reload itself
  (up to its cap), which looked like four sockets opening at start.
- A module imported with `import('/src/timeline/live.ts')` from Playwright's
  `page.evaluate` is a second instance, not the page's: useless for
  inspecting the live store.

## Progress log

- [x] 2026-11-16: inventory of sources and consumers; design.
- [x] 2026-11-16: phase 1 built. 34 unit tests (`frontend/src/timeline/*.test.ts`).
      Headless Chromium against `scripts/fake-timeline.ts` (two robots of one
      team, a 90 s looping story): dark and light at 900 px, a 390 px phone
      with a tap crosshair, look-back by drag, the 30 s window, and all twelve
      lanes on. No console errors. Not yet seen with a real robot or radio.
- [x] 2026-11-16: hover detail with robot names (`3cd2b8d`). Headless: desktop
      hover on each lane kind and on the other robot's line and strip; phone tap.
- [x] 2026-11-16: phase 2 (`5cfeec0`). Unit tests for dump/load, snapshot →
      hydrate → live, the team filter and the coalescer; one test against the
      real `setupWebSocket` (subscribe returns the team's snapshot, once).
      Headless: chart full 2.5 s after opening the page.
- [x] 2026-11-16: phase 3. Headless: `/overview` with three robots' compact
      charts and hover; `/scores` with three sparklines. Production
      `vite build` and the full suite (1415) pass.
- [ ] First look on the field with a real robot (lane defaults, scales,
      how busy the flags get in a real match).

## Open questions for the user

(none: the first two were answered 2026-11-16, see Decisions)

### How to look at it without the field

```
PORT=3100 bun scripts/fake-timeline.ts          # fake backend, no radio
cd frontend && bunx vite                        # proxies /ws to :3000 by default
# → http://localhost:5173/1967-Elsa#radio
```

`vite.config.ts` proxies to :3000; for other ports use a throwaway config
that `mergeConfig`s it (kept inside `frontend/` so its imports resolve, not
committed). The fake backend starts with 300 s of story behind it
(`HISTORY=<s>`, `START_AT=<s>` to shift where "now" is) and answers the
`timeline` subscription, so the team page and `/overview` are full at once;
`/scores` needs ~40 s. On `/overview` the charts are behind each card's
chart button.

## Things not to do

- Never point a test at the real radio: this PC reaches it. Visual checks use
  a fake backend only.
- Don't broadcast full-rate telemetry to every socket (and the user doesn't
  want a packet-rate stream at all: 4 Hz with min/max/average).
- Don't broadcast `timelineSnapshot`: it is only ever the answer to a
  subscribe.
- Don't add a second y-scale to a lane; a new unit gets its own lane.
- No `title=` attributes or hover-only detail.
