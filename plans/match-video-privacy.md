# Match videos must only show for the team that played them

## Goal

A team's match recordings should be visible to that team, not to whichever
team uses the field next. Raised by Cameron 2026-09-18 after 5940 practiced
alone the evening before.

## Environment / context

- pFMS on steamboat, checkout `~/practice-field-management-system`,
  history at `match-history.json`, recordings in `recordings/<matchId>/`.
- What happened: 5940 ran 16 matches on 2026-09-17, 18:00–20:38 PDT, all
  from slot 1, every one with an `all-field` recording (11 of 16 marked
  `partial`, i.e. ffmpeg restarted mid-match — separate issue). 6036 ran
  4 matches from slot 2 on 2026-09-18, 01:01–02:12 PDT.

## Findings

- **Cause of the visible leak:** the station page "Match Video" card
  (`frontend/src/components/MatchVideoCard.tsx`) listed matches where
  _either_ the team number _or the slot_ matched. Slots are reused, so the
  next team on slot 1 would see 5940's last five matches with download
  buttons. History entries only ever contain slots that had a team number,
  so the slot clause never added anything the team-number clause did not,
  except other teams' matches. Fixed 2026-09-18: team number only.
- **Remaining exposure (by design so far, not yet decided):**
  - The full match history (match ids, share tokens, recording file lists)
    is broadcast to every `/ws` client, including station pages
    (`src/websocketServer.ts`, `matchHistoryStore.addListener(broadcast)`).
  - `/api/recordings/<matchId>/<file>` has no auth on the LAN (deliberate,
    `plans/match-video-recording.md` "Things not to do").
  - The `/match` page is open to anyone on the field network (Caddy treats
    on-link clients as internal, no login) and lists every match with
    download icons.
  - A team can type another team's number on a station page and see that
    team's card. Nothing authenticates a team to its own number.
    So the fix hides other teams' videos from the normal flow; it does not
    make them unreachable to someone who goes looking.

## Progress log

- [x] Station card filters by team number only; docs wording updated.
- [ ] Decide whether the deeper exposure needs closing (see questions).

## Open questions for Cameron

1. Is "not shown in the normal flow" enough, or should other teams' videos
   be unreachable from the field network? Options, in increasing effort:
   a. Leave as is (staff page and API stay open on the LAN).
   b. Strip `shareToken` and `recordings` from the history sent to
   non-staff `/ws` clients, and gate `/api/recordings/*` behind the
   staff/admin session, keeping the token-scoped `/api/public/match/…`
   route as the way teams fetch their own video (the QR link). Station
   card would link to `/matches/<token>` for the team's own matches
   instead of the raw file. Recommended if privacy matters.
   c. Also put `/match` behind the staff passphrase.
2. Most of 5940's recordings were `partial`. Worth a look at why the
   `all-field` pull restarted so often that evening (stitchd/sentinel side
   or steamboat network) — separate thread.

## Things not to do

- Don't reintroduce slot-based matching in the station card.
- Don't gate downloads behind an API key (teams on the guest network need
  them without setup); use the share token route if gating is wanted.
