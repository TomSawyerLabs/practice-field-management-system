# Queue TV view: the match queue on a cast or kiosk display, LAN only

## Goal

An optional display view of the match queue (now playing, on deck, up next,
the fill line) that a field can cast to a TV or open as a page on any screen,
beside the existing scoreboard and leaderboard views. The queue never leaves
the site: an internet visitor to the same page sees a notice, not the queue.

## Environment / context

- The display page is `/scores` (`frontend/src/roots/scores.tsx`). Its view is
  per display: `?view=…` overrides, else `localStorage['scoreboard-view']`
  (`frontend/src/utils/scoreboardView.ts`). Cast senders push it, the admin
  page's Displays list switches it per receiver (`castReceiverView`).
- The Cast receiver app is registered against the public HTTPS URL of
  `/scores`, so the queue view has to be a view of that page, not a new path.
  On site, split DNS points the public name at the host, so a TV on the LAN
  reaches it directly.
- `/scores` and `/ws/scores` are open to the internet (ops
  `servers/steamboat/sites.d/pfms.caddy`). `/ws/scores` is the read-only socket
  (`publicConnections` in `src/websocketServer.ts`).

## Decisions (don't re-ask)

- **A third `ScoreboardView`, `queue`**, not a new page or path: Cast needs the
  registered `/scores` URL, and every display control already speaks views.
- **On-site is decided by the server**, with the same rule as the field socket
  (`isOnSite` + `isCrossSite`). A cookie or admin login does not unlock it on
  the public socket: the read-only socket takes no logins.
- **`queueState` was already broadcast to every `/ws/scores` socket**,
  including internet ones (in `PUBLIC_SAFE_TYPES` since `1560449`), though no
  public page used it. Now it goes only to on-site public sockets.

## Plan / steps

1. [x] Explore: views, cast plumbing, public socket, Caddy.
2. [x] Server: public sockets judged on/off site; `queueState` only on site;
       initial queue state on connect; `queueOffSite` notice otherwise.
3. [x] `ScoreboardView` gains `queue`; receiver script, admin Displays chip,
       control chips on the scoreboard and leaderboard views.
4. [x] `QueueTvPage`: now playing, on deck, up next, the line; off-site notice.
5. [x] Link from `/queue`; docs (scoreboard view docs, README if it lists
       views); tests for the gate.
6. [x] Typecheck, tests, commit.
7. [ ] **Current:** deploy (deploy-owner thread), then confirm on a Cast TV at the field: the journal says `on site` for its scoreboard connection, and the queue is on screen.

## Findings / gotchas

- The Caddy log (`/var/log/caddy/pfms.log`) is root-only on steamboat, so
  whether Chromecasts arrive from a LAN address could not be read there. The
  public socket now logs its address and on/off-site verdict, which answers
  it after a deploy. A Chromecast that ignores DHCP DNS (hardcoded 8.8.8.8)
  would come through Cloudflare, read as off site, and show the notice.

## Progress log

- [x] Plan written
- [x] Server gate, view, admin/scoreboard/leaderboard chips, `/queue` link,
      docs. `bun run typecheck` clean, `src/wsAccess.test.ts` 115 pass (4 new),
      full suite 1317/1318 (the one failure, `adminAuth.test.ts` scrypt timing,
      passes alone: load flake), `vite build` clean. Not looked at on a TV yet.

## Open questions for the user

None yet.

## Things not to do

- Don't add a new public path for this: it would need a Caddy exemption and a
  new Cast receiver registration.
