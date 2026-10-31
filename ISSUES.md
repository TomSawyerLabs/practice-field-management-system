# Known Issues & Technical Debt

## Check per-laptop `ip rule` entries on steamboat on a day with teams

The cleanup (`480bc89`) deployed in `0586d9a` with no team on the field, so two
things have only run against a fake kernel. Read-only on steamboat, while laptops
are driving or routed:

- `ip rule list` should show rules numbered from 32765 down, one per laptop, no
  duplicates. This is the first real use of `ip rule add ... priority N`.
- After a graceful reload (`systemctl reload`) with teams on, the journal should
  show `Restored route preference`, and those laptops' rules should still be there.

If rules don't appear, or the journal shows `Could not remove stale ip rule`, that
matters: Drive and auto-connect depend on them. Close this entry once both are
seen. Background: `plans/ip-rule-cleanup.md`.

## The WebSocket shows field state to the internet

`src/websocketServer.ts` sends every `/ws` socket the field's state on connect,
from anywhere, with no credential (seen 2026-10-30): radio and station status,
hostnames, the queue, setup settings and support issues with their client
addresses. No login credential or plain WPA key is in it, as far as checked: API
keys and access tokens go as summaries, setup secrets are masked, and pending
changes say only `secured`. Radio status does carry each station's `wpaKeySalt`
and the hash it salts. Field commands from outside are refused since
`plans/ws-internet-guard.md`, but reading isn't. Matters because a stranger can
watch who's on the field, read support reports and try guessing a team's Wi-Fi
key offline.

## NAT rules remain after a station is cleared

On steamboat at 4:46 PM PDT (23:46Z) on 2026-10-30, with `active-config.json`
empty since the 6:00 AM PDT clear and all six bridges down, `iptables -t nat -S`
still had `pfms-nat-slot1` for `10.1.0.0/24` and `pfms-nat-slot3` and
`pfms-nat-slot4` for `10.17.0.0/24`. Matters because the field's rules should
describe the teams on it, and stale ones confuse anyone reading them mid-incident.

## Admin login has no rate limit

`adminLogin` is open to any `/ws` client, and `src/adminAuth.ts` allows unlimited
tries against one round of salted SHA-256 with a 4-character minimum (seen
2026-10-30). Matters because it stays open from the internet on purpose, as the
external login (`plans/ws-internet-guard.md`), and a success opens everything.
Needs a decision: a limit shared by all outside attempts lets a stranger lock out
the external login, and per-address needs the proxy to pass the visitor's real
address, since pFMS sees Cloudflare's.

## Firmware API takes uploads with no credential

`POST /api/firmware/upload` and `/api/firmware/download` in `src/firmwareApi.ts`
have no auth and send `Access-Control-Allow-Origin: *` (seen 2026-10-30). Any
guest device, or any web page open on one, can add a firmware entry. Matters
because `/test` flashes radios from that store.

## A false Driver Station match hides E-STOP on /match

`MatchControlPage.tsx:469` returns `DsClientBlock` before `FieldEStopControl`
renders (seen 2026-10-30), so a device that only shares a DS's hostname has no
E-STOP on screen until someone presses "This isn't a Driver Station". Matters
because a false match isn't meant to get in the way of a stop.

## /staff and /csa have no stop button

Neither `StaffPage.tsx` nor `CsaPage.tsx` renders a stop control (seen
2026-10-30), including on the Safety Monitor's page. Matters because that role
is the one most likely to want one.

## An e-stop out of a match can take about 8 s

The user's limit (2026-10-30): an e-stop acts within 1 s, 250 ms at best. A robot
driven from a DS in local control, not in a match, misses that. pFMS can only take
that DS at its next TCP handshake, and it retries about every 8 s (3 s on a 2027
DS). That's the documented retry interval, not a measured stop; check 7 in
`plans/field-verification-checklist.md` times it. Live since `0586d9a` took the cut
off e-stops. A DS in a match stops at once, and the team page's Stop still cuts in
about 100 ms. Matters because this is the stop that has to work. Do this before
"Team Stop still cuts comms": both need the same answer.

## Anyone on site can clear the field E-Stop

`adminClearFieldEStop` is `staff`, and `/match` clears aren't behind the operator
code (`plans/operator-login.md`), so clearing the field E-Stop lets every robot run
again with no login. The user chose to leave it open for now (2026-10-30). Revisit
later: an operator login for the field clear only, with a team still able to clear
its own from its DS.

## Team Stop still cuts comms

The team page's **Stop robot** out of a match is the last user of the
`pfms-estop-slotN` cut (`teamStopCut` in `src/matchEngine.ts`, `setTeamStopCut`
in `src/networkManager.ts`). It stays because nothing else stops that robot yet.
Replace it with field control of that DS, the way e-stops work, then remove the
cut and `teamStopCuts` in `src/index.ts`. Matters because the user doesn't want
to cut comms, and it shouldn't ever be needed. Note a held DS takes the stop at
its next TCP handshake (about 8 s), not the cut's ~100 ms.

## Nothing warns that an e-stopped robot is still enabled

Since the cut came off e-stops (2026-10-30), a DS that ignores the field keeps
driving while `/match`, `/csa` and the team's page say E-STOPPED. The robot's
status bit crosses the field either way (UDP 1150, or `tele.dsStatus`), so pFMS
can see it. Matters because staff would believe a running robot is stopped.

## Unverified behaviour we depend on

Each needs a field visit. What to try and what each result means is in
`plans/field-verification-checklist.md`.

- **Re-enable after a DS-side disable (check 1).** `undisable()` clears the
  field's latch and resumes enable packets, but a DS that latched a local Enter
  disable may not follow. There's no clean sample: since telemetry began on
  2026-09-27, every disable followed by a re-enable was a dropped DS or a lost
  robot link.
- **2027 DS stop reporting (check 2).** pFMS can't see a Disable pressed on a
  2027 DS: `dsReportedStatus` only counts a disable after seeing the enabled
  bit, which that DS never sets (0 of 37,736 telemetry rows for team 5940, whose
  e-stop and a-stop bits were never set either). The field would show that
  robot as enabled. Whether the DS signals a stop some other way is unknown.
- **DSes that keep reporting outside a match (checks 3, 4).** pFMS drops a DS
  that streams status while not in a match, so it returns to local control. It
  doesn't always take: 590 drops from 2026-10-09 to 2026-10-28, repeating every
  15 s, including 173 in 43 minutes for one DS of team 2813 on 2026-10-25. Nobody
  has looked at such a laptop, so it isn't known if the team could still drive.

## Depends on things outside this repo

- The balls-counter deployed on sentinel runs from the unmerged branch
  `fix/package-for-latest-uv` (`897046d`, PR #1 open, mergeable, 9 ahead of
  master, as of 2026-10-30), not its master. A `git pull` on master there
  silently breaks match score recording.

## Not started

- The Blue Alliance reporting (from the match-review work) was scoped and
  never begun.

## SystemCore gaps

- pFMS can't read a SystemCore robot's own traffic yet. Since `cb0db29` it
  records UDP 1110 both ways but doesn't decode it, so outside a match there's
  no battery, link or dropout data for these robots. In a match, battery does
  show, because the DS reports it to the field. Waiting on a first capture
  (check 5 in `plans/field-verification-checklist.md`), then a parser:
  `plans/systemcore-robot-capture.md`.

## WebSocket gate test can catch the periodic serverInfo heartbeat

`src/wsAccess.test.ts` › `with an operator code > every stop still works after a
wrong code` failed once in 2 full `bun test` runs on a loaded machine
(2026-10-30, on top of `fc15475`): `expect(await phone.send(stop)).toEqual([])`
received a `serverInfo` about 10.6 s after the server started. That's the periodic
heartbeat (`src/websocketServer.ts:574`), not the opening burst `fc15475` waits
out. Matters because any test that expects no replies can land on a heartbeat.
