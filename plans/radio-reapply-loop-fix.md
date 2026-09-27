# Stop the radio re-apply loop, and give staff a reset

Follow-up to `plans/radio-reapply-storm-2026-09-27.md` (the diagnosis).
The user saw the field cycle through configurations and asked for a
different fix, an admin "reset pFMS" button with a clear-radio option, and
automatic clearing of configured robots after a match, graceful for teams
with back-to-back matches.

## What the logs actually show about the "A → B → C → A" cycle

Applied configs 15:28–15:42 (from `Configuring stations:` blocks):

| Time     | Trigger                         | Config                                        |
| -------- | ------------------------------- | --------------------------------------------- |
| 15:28:43 | sync-check re-apply             | A = 581, 4159, 1967, 2813, 751, 1868          |
| 15:30:59 | sync-check re-apply             | A                                             |
| 15:32:37 | sync-check re-apply (new build) | A                                             |
| 15:34:07 | team request applied (no match) | B = A with red2 → 1854                        |
| 15:35:46 | sync-check re-apply             | B                                             |
| 15:37:29 | staff Apply now                 | C = 581, 1854, 751, 1967, –, 1868 (timed out) |
| 15:39:01 | sync-check re-apply             | C                                             |
| 15:40:36 | cold restart, hold lifted       | C, then D = 840, 581, 751, 1967, –, 1854      |
| 15:41:53 | staff Apply now                 | D + blue2 972                                 |

No config ever returned to an earlier one. The same config was re-sent up
to three times because the radio kept reporting a mismatch on **all six**
stations, including ones whose SSID never changed. The forward changes
between re-sends were teams shuffling slots (1854 slot2→slot6, 581
slot1→slot2, 840→slot1) and staff pressing Apply. So the cycle the user saw
was most likely the radio's _reported_ state versus pFMS's _active_ state
disagreeing and the overlay coming back every ~3 min, not pFMS rotating
between configs.

What the radio reported during the window is not in the logs (the
mismatch line only names the slots). That is the first thing to fix.

## Mechanics of the loop

`checkRadioConfigSync()` in `src/radioManager.ts` runs on every status
poll. Mismatch for 15 s (`RADIO_RECONCILE_DEBOUNCE_MS`) → `commitConfiguration()`
→ POST `/configuration` → radio `CONFIGURING` for 40–60 s (every page shows
the overlay, every robot drops Wi-Fi) → radio `ACTIVE` but still reporting
a mismatch → 15 s → again. There is no backoff, so a radio that ignores or
lags a config gets hammered for as long as it lags. The only thing that
ended today's storm was a cold restart.

`configureRadio()` waits 45 s (`ReconfigurationTimeout`) for `CONFIGURING`
to end; the practice firmware took longer at 15:37:29.

## Decisions

- Keep the self-repair (a real radio wipe must still fix itself, that was
  the 2026-07-24 incident) but make it back off: first repair after 15 s
  as now, then 1, 2, 4, 8 min between repeats, capped at 10 min; reset the
  moment the radio agrees. Log both sides' SSIDs on every mismatch line.
- Raise `ReconfigurationTimeout` from 45 s to 90 s. A timeout does not
  cancel anything on the radio; it just makes pFMS give up waiting and
  lets the sync check fire sooner.
- Admin page gets a **Field reset** card: "Clear all robots from the radio"
  (wires the existing, currently UI-less `clearAllConfigurations()`, also
  drops held requests) and "Restart pFMS" (same graceful exit `systemctl
reload` uses, so network rules survive and the mDNS cold-start crash is
  avoided; systemd `Restart=always` brings it back). Both refuse during an
  active match, both confirm first, both admin-gated like `clearMatchHistory`.
- `MdnsReflector.flushSendQueue()` must not take the process down on
  `EADDRNOTAVAIL` (seen on the 15:40 cold start).
- Automatic post-match release: design below, **not built until the user
  picks a policy** (it changes when teams lose Wi-Fi).

## Auto-release after a match — options for the user

Goal: stop stale robots piling up on the radio so each new match is not a
six-station reshuffle, without kicking a team that plays again soon.

1. **Release on idle-link timeout (recommended).** After a match clears,
   any station whose robot has not been linked to the radio for N minutes
   (say 15) is released. A robot that stays powered on keeps its slot; a
   team that packs up loses it quietly. Back-to-back teams are never
   touched. Uses the existing per-station `lastLinked` tracking. Needs a
   station-page notice ("your slot was released after 15 min offline").
2. **Release every joined station at match end, with a grace window.** Stage
   a release for each station that played, hold it for N minutes; joining a
   new match or re-requesting the slot cancels it, another team's request
   for the slot supersedes it. Stronger clearing, but a team that free-
   drives between matches would be cut off at the timer.
3. **Both**: 2 for stations that played, 1 for the rest.

Open question for the user: which option, and what N.

## Steps

1. [x] Sync-check backoff + both-sides logging + tests (`src/radioManager.ts`,
       `src/radioManager.test.ts`).
2. [x] `ReconfigurationTimeout` 45 → 90 s.
3. [x] `adminClearAllStations` / `adminRestart` messages, gated handlers,
       `sendAdmin…` helpers, Field reset card on `/admin`, docs.
4. [x] mDNS `EADDRNOTAVAIL` guard.
5. [x] Typecheck, tests, commit per step.
6. [ ] Auto-release: await user's pick.

## Things not to do

- Don't remove the self-repair. Don't gate it on the match phase alone;
  `shouldDefer` already parks commits while robots are enabled.
- Don't implement "Restart pFMS" as `SIGTERM`/full cleanup: that flushes
  the network rules and is the path that crashed at 15:40.
