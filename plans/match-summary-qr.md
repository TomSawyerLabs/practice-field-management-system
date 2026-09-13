# Post-match QR code → match summary + video download

## Goal

Cameron (2026-09-13): after a match, the main screen (scoreboard) shows a QR
code that opens a match summary with a way to download that match's video.
The URL must work from the local network and from the internet, carry a
long unique code that grants access to that one match only, and the `/match`
page (local network) should offer the same links.

## Design

- **Share token.** The match engine mints `shareToken` (32 chars, base64url
  from 24 random bytes) at match start alongside `matchId`; it rides in
  `MatchState` (public socket → scoreboard sees it during postMatch) and is
  stored on the `MatchHistoryEntry`. Entries from before this change get a
  token backfilled on load. The token is the capability: knowing it grants
  read access to that one match's summary and files, nothing else.
- **Public API** (`src/publicMatchApi.ts`, no API key, token-gated):
  - `GET /api/public/match/<token>` → summary JSON (match number, times,
    duration, end reason, teams with alliance/station, scores incl. human
    review, auto winner, recordings with sizes/durations, review URL).
  - `GET /api/public/match/<token>/video/<file>` → the MP4 (Range,
    `?download=1` friendly name) — same code path as `/api/recordings`.
  - `GET /api/public/match/<token>/avatar/<team>` → cached team avatar PNG.
- **Summary page** lives in the scores bundle: `/scores?match=<token>`
  renders `MatchSummaryPage` instead of the scoreboard. Chosen because Caddy
  already lets external visitors reach `/scores` and `/assets/*` without the
  access cookie; a new HTML entry point would need a Caddy change.
- **QR on the scoreboard**: during `postMatch`, a card in the bottom corner
  with the QR (qrcode.react, already a dependency) and "Scan for match
  summary & video". URL = `<publicUrl>/scores?match=<token>`.
- **Public URL**: new setting `publicUrl` (env `PUBLIC_URL`, e.g.
  `https://pfms.tomsawyerlabs.com`), carried in the `serverInfo` heartbeat
  so every page can build share links. Falls back to the page's own origin
  (the Chromecast receiver already runs on the public name).
- **/match page**: each history row and the post-match view get "Summary"
  (opens the page) and a copy-URL button; the post-match view also shows the
  QR for phones in the room.
- **Internet reach**: `/api/public/*` must be exempt from Caddy's external
  access check. Staged in the ops working copy next to the `cast-config.js`
  line; **needs Cameron's OK**. Until then the summary page and downloads
  work on the LAN and for cookie-authenticated external users only.

## Plan / steps

1. [x] Types + token in engine/history + `publicUrl` setting + serverInfo.
2. [x] `publicMatchApi.ts` and wiring.
3. [x] `MatchSummaryPage`, scoreboard QR card, /match links.
4. [x] Docs (configuration, match-system, internals), typecheck, commit.
5. [x] Caddy exemption staged in the ops working copy (with the
       cast-config.js line) — not committed, awaiting Cameron's OK. pFMS
       deployed 2026-09-13 (LAN works now; internet needs the Caddy change
       and PUBLIC_URL / setup `publicUrl` = https://pfms.tomsawyerlabs.com).

## Findings / gotchas

- 12:03 first recorded match produced no video: ffmpeg rejects the generic
  `-rw_timeout` on RTSP inputs ("Option rw_timeout not found") although
  ffprobe (the Test button) accepts it. Fixed in d5c94a9 (`-timeout` for
  RTSP). Deployed 12:12.
- Links used `http://pfms.tsl` because no public URL was configured; the
  Caddy http→https redirect for `/scores` then dropped the query, landing on
  the plain scoreboard. `PUBLIC_URL=https://pfms.tomsawyerlabs.com` is now
  in `/etc/pfms/environment` (backup `environment.bak.20260913-121105`),
  confirmed in the `serverInfo` message. A query-preserving redirect is
  staged in ops with the other two Caddy lines (all await Cameron's OK).
- Cameron reports something "flashes at ~2 Hz like it's reloading" after a
  match; the Caddy log shows no repeated page loads, so it is a client-side
  render flash — which screen is still unknown.

## Things not to do

- Don't put the token in the match id or reuse the match id as the token:
  match ids are visible to every internal client.
- Don't gate the summary behind the external-access cookie: the whole point
  is a phone on cellular scanning the TV.
