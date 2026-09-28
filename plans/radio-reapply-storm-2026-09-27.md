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

1. 15:18:52 — config A (581, 4159, 1967, 2813, 751, 1868) applied and in
   sync; a match ran on it 15:18–15:27. No held changes were released at
   the 15:27:38 `Match cleared` (no "Hold lifted" line) and pFMS pushed
   nothing. Yet by 15:28:28 the radio's report disagreed with A on **all
   six** stations, including blue1 2813 which had not changed since 14:34.
   The radio's report changed on its own; an empty station list fits, a
   report of any earlier config does not. 15:28:43, 15:30:59, 15:32:37:
   the sync check re-sent A three times, radio still disagreeing.
2. 15:37:29 — a staff `applyConfig` whose single update **swapped two
   robots** (751 blue2→red3, 1967 red3→blue1). 15:38:14 —
   `Error applying config: Timeout waiting for status to not be CONFIGURING.
Is CONFIGURING`: the VH-109 (`VH-109_AP_PRACTICE_1.2.9-02102025`) sat in
   `CONFIGURING` past the 45 s wait. 15:39:01: all six mismatched again,
   re-sent.
3. 15:40:37 — the restart lifted the hold and applied a **rotation** in one
   update: 581 red1→red2 (into 1854's slot), 1854 red2→blue3, 840 into red1.
   This is the "A into B's slot, B into C's, C into A's" change the user
   watched. It was sent twice (once by the process that crashed, once by
   its replacement), then 972 was added at 15:41:53; by 15:44 the radio
   agreed with pFMS. So moves inside one POST do apply, at least
   eventually, but the one at 15:37 took over 45 s.
4. Each re-send put the radio back into `CONFIGURING` (the overlay), it
   came back `ACTIVE` still disagreeing, and 15 s later
   (`RADIO_RECONCILE_DEBOUNCE_MS`) pFMS sent again. The log never recorded
   what the radio reported, so "empty during a long internal reconfigure"
   versus "stale" is the open question; both code paths now log it.

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
