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

## The WebSocket takes field commands from the internet

Seen reading the code and the ops repo's `servers/steamboat/sites.d/pfms.caddy`
on 2026-10-30, not tried against the live site. Caddy exempts `/ws` from the
access check so external login works, and `src/websocketServer.ts` has no address
or `Origin` check. So a visitor with no cookie should be able to send every
`anyone` and `staff` message, such as `matchCreate`, `station` or
`adminGlobalEStop`. Matters because `docs/support.md` says pFMS assumes everyone
who can reach it is trusted. An address-based fix also needs
`plans/caddy-xff-perimeter-spoof.md` in the ops repo.

## Admin login has no rate limit

`adminLogin` is open to any `/ws` client, and `src/adminAuth.ts` allows unlimited
tries against one round of salted SHA-256 with a 4-character minimum (seen
2026-10-30). Matters because that socket reaches the internet (see above).

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

## Timing-sensitive tests in a full run

_in progress — issues/test-timing_

`src/matchEngine.test.ts` › `a challenge run end to end > finishing a stopwatch
run stops the robot and ends the run` and `src/fieldTimelapse.test.ts` ›
`the callback releases the shutter, and both webhooks are called` each failed
once in a full `bun test` on 2026-10-30 (772 pass / 2 fail); the next full run
was 774/0 and both pass on their own. The first sleeps 3.4 s and expects
`finishedAt` between 0 and 2. Matters because a red full run hides real
regressions.

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

## RawPacketLog daily-cap test fails often, even alone

_in progress — issues/test-timing_

`src/rawPacketLog.test.ts` › `stops at the daily cap, and starts again the next day` failed 2 of 3 runs of that file alone on an idle-ish Windows machine (2026-10-30), and once in a full `bun test` (746 pass / 1 fail): `Expected: 176, Received: 24` at line 59. `writes a pcap file per local day, header first` fails the same way (2026-10-30: 5 of 5 runs of the file alone showed a failure, and once in a full run). The test's `flush()` calls `log.close()` and then waits a fixed 50 ms. Matters because it turns a full run red on its own.

## Three more tests time out when the full suite runs under heavy load

_in progress — issues/test-timing_

A full `bun test` in the main checkout on a busy machine (2026-10-30, 1320 pass / 10 fail, 507 s) also failed `FieldTimelapse light handshake over webhooks > the callback releases the shutter, and both webhooks are called` (3.2 s), `a challenge run end to end > finishing a stopwatch run stops the robot and ends the run` (5.1 s) and two unnamed `recordings API` tests (5.5 s). Each passed in less loaded runs. The other 6 failures were the robotWifiScan flake, since fixed. Matters because a red full run hides real regressions.
