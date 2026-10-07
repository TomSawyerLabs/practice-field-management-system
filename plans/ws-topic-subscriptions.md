# Send heavy state only to pages that use it (websocket topic subscriptions)

## Goal

Cameron (2026-10-06): "fix the full download issue — it's only going to get
worse and slower over time." Every `/ws` client gets ~200 kB on connect
(ISSUES.md entry, claimed in `fd11a19`) and every change re-broadcasts the
same big states to every client.

## Environment / context

- Connect handler: `src/websocketServer.ts` `wss.on('connection')` sends ~20
  states unconditionally. All later pushes go through one `broadcast(msg)`
  keyed by `msg.type` (public `/ws/scores` sockets already filtered by
  `PUBLIC_SAFE_TYPES`).
- Measured on pfms.tsl (2026-10-06), per connect: `matchHistoryState`
  122 kB, `usageState` 28 kB, `practiceRecordingState` 15 kB,
  `timelapseState` 12 kB, `savedTeamsState` 10 kB, rest small.
- Growth: match history has 75 entries (249 kB file), capped at 250
  (`MAX_ENTRIES`) → ~400 kB per connect at the cap. `usage-data.json` 253
  entries, 37 kB. Practice runs: 7-day retention.
- Consumers (hooks in `frontend/src/hooks/useBackend.ts`):
  - `useMatchHistory`: `/match` (MatchControlPage, all matches), team page
    Video tab (MatchVideoCard, **one team**), `/recordings` (share tokens,
    all), ScoreboardPage (`/scores` — public socket, never receives it).
  - `usePracticeRecordingState`: MatchVideoCard only (one team's runs +
    optOut list).
  - `useUsageState`: `/usage` only.
  - `useTimelapseState`: `/timelapse`, Admin → Video, `/recordings`.
- Open pages reload themselves on a server version change
  (`useBackend.ts` serverInfo handler), so old frontends don't linger
  without subscriptions after a deploy.

## Decisions already made (don't re-ask)

- Fix it properly (subscriptions), not just trim payloads.

## Plan / steps

1. ~~Server: `src/topicSubscriptions.ts` — per-socket topic
   registry, `subscribe`/`unsubscribe` messages, optional team filter;
   `broadcast()` routes topic messages only to subscribers, filtered and
   serialized once per distinct filter. Unit tests.~~
2. ~~Connect handler: stop sending the topic states unasked; send the
   current state on subscribe.~~
3. ~~Client: refcounted `useTopic(topic, teams?)` in useBackend; the hooks
   subscribe while mounted; re-sent on every (re)connect.~~
4. ~~Team page subscribes with its team; `/match` everything; `/recordings`
   needs no history (share tokens come with the inventory).~~
5. ~~Measure per page before (pfms.tsl) / after (local, same data).~~
6. ~~Commit, ISSUES.md entry closed~~ — `01f9578`.
7. **(current)** Deploy — waiting on Cameron's go-ahead. After deploy:
   re-run the per-page measurement against pfms.tsl, and open a team with
   real practice clips (e.g. `/6036#video`) to confirm its Video tab lists
   them.

## Findings / gotchas

- Also made topics: `savedTeams` (9 kB, grows with every team seen; only
  the team page reads it, for its own SSIDs).
- Match history entries: `scoreTimeline` is 61% and `periodBreakdown` 10%
  of their size; only MatchSummaryPage uses them, via
  `/api/public/match/<token>`. Stripped from the socket copy → full
  history 122 kB → 43 kB.
- `/recordings` only needed history for share tokens → the server joins
  them into the inventory (`shareToken` on `RecordingInventoryEntry`).
- Gotcha: `usePracticeDayLink` (inside useBackend) also called the history
  and practice hooks, unfiltered — the team page then asked for everything.
  Found by logging sent frames; now team-scoped.
- Usage (`usage-data.json`) has no cap: 253 sessions since July (~100 kB a
  year). Now only `/usage` receives it; left as is.
- Measured, same data, bytes in a page's first 8 s (before → after):
  `/` 197 → 6 kB, `/5940` 197 → 8, `/6238#video` 197 → 19, `/match`
  198 → 48, `/admin` 197 → 6, `/recordings` 243 → 7, `/timelapse` 197 → 6,
  `/usage` 199 → 33, `/csa` 197 → 6.

- ScoreboardPage's challenge leaderboard reads match history, but `/scores`
  is on the public socket which never gets it → that leaderboard is always
  empty. Separate bug → ISSUES.md.

## Progress log

- [x] Deleted `C:\Users\camer\pfms-perf-sample` (checked: no junctions)
- [x] Claimed ISSUES.md entry (`fd11a19`)
- [x] Server module + tests (11)
- [x] Wire server
- [x] Client hooks (+ team page scoped, usePracticeDayLink fixed)
- [x] Measure + verify (protocol checks, page renders, 852 tests)
- [x] Commit, close issue (`01f9578`); scoreboard leaderboard bug logged
- [ ] Deploy (needs go-ahead)

## Open questions for the user

1. Deploy to steamboat? (Recommended: yes.)

## Things not to do

- Don't `rm -rf` a directory without checking it for junctions first (see
  memory: junction-worktree-remove-deletes-repo).
