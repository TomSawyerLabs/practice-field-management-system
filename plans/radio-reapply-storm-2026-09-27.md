# Radio re-apply storm on 2026-09-27 (15:28–15:39 PDT)

## What was seen

Every pFMS screen kept showing "Reconfiguration in progress..." for about
40 s at a time, roughly every three minutes, during the 15:28–15:39 window.
The user asked whether the 15:31 deploy of `524bbbc` had broken something.

## Answer: not the deploy

The events are the radio-config self-repair in
`RadioManager.checkRadioConfigSync()` (`src/radioManager.ts`, added
2026-07-24) firing on **all six slots**:

| Time     | PID    | Build                 | Slots mismatched |
| -------- | ------ | --------------------- | ---------------- |
| 11:38:26 | 29640  | pre-deploy            | slot6            |
| 15:28:43 | 597733 | pre-deploy (e4e2768)  | all six          |
| 15:30:59 | 597733 | pre-deploy            | all six          |
| 15:32:37 | 608044 | post-deploy (524bbbc) | all six          |
| 15:35:46 | 608044 | post-deploy           | all six          |
| 15:39:01 | 608044 | post-deploy           | all six          |

The first two all-six events happened on the old process, before the deploy
reloaded the service at 15:31:55. The 14-day journal baseline has zero
occurrences before today (no journald suppression notices today, so the
absence is meaningful). None of the seven newly deployed commits touch the
sync check, the status poll, or `translateRadioUpdate`; `7f02aa3` only
factored `teamOfSsid()` out of `getTeamForStation()`.

The storm stopped on its own. Since 15:41:53 there have been no re-applies,
and at 15:44 the radio reported `ACTIVE` with the same six SSIDs as
`active-config.json`.

## What actually happened (best reading of the logs)

1. 15:28:43 — post-match auto-clear (`Match cleared`). Held Wi-Fi changes
   from the between-match roster shuffle were released. Immediately after,
   the sync check fired for all six slots and re-applied the config.
2. 15:37:29 — a staff `applyConfig`. 15:38:14 —
   `Error applying config: Timeout waiting for status to not be CONFIGURING.
Is CONFIGURING`: the VH-109 (`VH-109_AP_PRACTICE_1.2.9-02102025`) sat in
   `CONFIGURING` for more than the 45 s wait.
3. Each re-apply put the radio back into `CONFIGURING` (the overlay), then
   the radio came back `ACTIVE`, the check still saw a mismatch for longer
   than the 15 s debounce (`RADIO_RECONCILE_DEBOUNCE_MS`), and re-applied
   again. The log does not record what the radio's `stationStatuses`
   contained at those moments, so whether the radio was reporting stale
   SSIDs or an empty station list during that window is not proven.

The 15:35:46 re-apply landed while a match was being set up ("Holding radio
change ... (match)" lines precede it). The sync check has no match guard, so
a re-apply during setup drops every robot's Wi-Fi for the reconfigure.

## Unrelated: the 15:40:36 manual restart

An SSH session with the user's key from 10.255.0.1 ran a full stop/start
at 15:40:36 (not `update.sh`, not a reload). The new process died within a
second:

```
Error: setMulticastInterface EADDRNOTAVAIL
    at MdnsReflector.flushSendQueue (dist/mdnsReflector.js:407)
```

systemd restarted it (`restart counter is at 1`) and PID 611198 has been
healthy since 15:40:37. A cold start races the team-VLAN interfaces coming
up; a `reload` (what `update.sh` does) preserves them and does not hit this.
Worth a fix: `mdnsReflector` should catch `EADDRNOTAVAIL` from
`setMulticastInterface` instead of letting it take the process down.

## Open questions / possible follow-ups (not started)

1. Log the radio's reported SSIDs alongside the mismatch line so the next
   storm shows whether the radio is stale or empty.
2. Give `checkRadioConfigSync` a match guard (skip while a match is in
   `created`/active phases, or at least while robots are joined), and/or
   raise the debounce after a re-apply so a slow radio can't chain them.
3. Make `MdnsReflector` survive `EADDRNOTAVAIL` on a cold start.

## Things not to do

- Don't roll back `524bbbc`; it is frontend-only and the storm predates it.
- Don't restart the service to "fix" the overlay; a cold start is what
  crashed at 15:40, and the storm clears when the radio settles.
