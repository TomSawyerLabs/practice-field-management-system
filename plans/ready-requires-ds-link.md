# Ready-up needs a live Driver Station link (match 64, 2026-09-27)

## Goal

Stop a team from pressing **Ready** while the field cannot hear its Driver
Station, so a match cannot start against a robot that will never enable.
Prompted by match 64 (2026-09-27, 13:54–13:57): team 4159 readied up, the
match ran, and their robot never enabled because their DS was never attached
to slot4.

## Environment / context

- Host: steamboat, pFMS PID 571425 (running `e4e2768`), journal
  `journalctl -u practice-field-management-system`, ground truth
  `~/practice-field-management-system/match-history.json` entry 64
  (`e2fc6b70-…`).
- "DS attached" in pFMS = a DS→FMS UDP status heartbeat (port 1160, 2 Hz)
  seen within the last 5 s for that station (`matchEngine.isDsAttached`,
  `DS_ATTACHED_TIMEOUT_MS`). The heartbeat is attributed to a station by
  team number → `radioManager.getStationForTeam` (SSID prefix). Legacy NI
  DSes only send it once they hold a station assignment from the TCP
  handshake (0x19 reply) and are receiving control packets.
- Related notes: `plans/blue-ds-dropout-2026-09-27.md` (matches 61/62,
  DS laptops falling off Wi-Fi mid-match) and
  `plans/out-of-match-enable-check.md` (handshake reply semantics).

## What happened to 4159 in match 64 (PDT)

| Time     | Event                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13:38:58 | 4159's DS (10.55.59.170) drives slot3; attaches, then flaps stale/attached at 13:39:41, 13:41:13, 13:41:33, 13:41:54 (laptop link already shaky).                                                                              |
| 13:46:09 | slot3 joins blue; DS handshake answered `assigned blue1 (0x19)`. The DS now holds a long TCP session with that answer.                                                                                                         |
| 13:47:52 | Staff move 4159's SSID to slot4 (`enableSavedRobot 4159 slot4`, "Duplicate SSID: holding a release of slot3 alongside slot4"). Applied 13:48:03: slot3/slot4 DNAT rules removed.                                               |
| 13:48:46 | slot4 joins red. **No DS IP known for slot4** so no "handing DS … to FMS control" and no TCP close: the DS keeps its stale slot3 session and never re-handshakes.                                                              |
| 13:49:07 | slot3 kicked; 1868 takes slot3 (13:49:21). From here nothing sends control packets to 10.55.59.170.                                                                                                                            |
| 13:52:21 | Ready check opened. 13:54:14 `stationReady slot4 true` accepted — `isDsAttached(slot4)` was false (never attached) but Ready is not gated on it, only an advisory caption on the team page.                                    |
| 13:54:58 | Match 7 (history #64) starts. "DS status after FMS enable" logged for slot2/3/5/6 — **not slot4**. 4159 never enables.                                                                                                         |
| 13:59:07 | Two minutes after the match: `DS 10.55.59.170: 1 rapid reconnects`, handshake `assigned red2`, `Drive started → slot4`, `DS attached to FMS: slot4`. The team (presumably) restarted the DS, which is what it needed at 13:48. |

Two defects, one fixed here:

1. **Ready was accepted with no DS.** Fixed by this plan: Ready needs
   `isDsAttached`, and a ready station whose DS goes quiet during setup is
   un-readied.
2. **A team moved between stations kept a stale handshake.** pFMS only
   forces a DS re-handshake (`disconnectDS`) when it knows the station's DS
   IP. After a slot move the new station has no IP yet, so the DS is never
   told. Not fixed here (see open questions).

## Why the July 2026 ready gate was reverted, and why it is safe now

`41829b9` (2026-07-17) gated Ready on `isDsAttached`; `267e94e`
(2026-07-19) reverted it because the signal read false for every DS. The
attribution goes through `getStationForTeam`, which reads the radio active
config, and that config was being wiped by deploys at the time (fixed
2026-07-24: "Deploys no longer wipe team radio configs, and any radio wipe
now self-repairs within seconds"). Since then every joined station logs
`DS attached to FMS: slotN` and `DS stale: slotN` reliably (all of
2026-09-27's matches show it), and a station whose team cannot be resolved
cannot join a match either, so the gate cannot lock out a team that the
roster accepts.

Insurance against a repeat: the match control page gets a **Ready anyway**
button per station, which sets ready with `force` and is exempt from the
stale sweep.

## Decisions already made (don't re-ask)

- Gate on the existing `isDsAttached` (UDP heartbeat within 5 s). No new
  detector: the heartbeat only flows when the DS holds a station assignment
  and is under field control, which is exactly "will obey match control".
- A ready station whose DS goes quiet during **setup** (`created`) is
  un-readied, mirroring staff whose page disconnects. The 3 s countdown is
  left alone (the start already snapshots; a drop there is handled by the
  mid-match re-enable in `594e4b8`).
- Staff override lives on the match control page, per station, only shown
  when the station is joined, not ready, the check is open, and the DS is
  offline.

## Plan / steps

1. [x] Reconstruct match 64 from the journal (above).
2. [x] `src/matchEngine.ts`: `setReady(station, ready, { force })` refuses
       ready without `isDsAttached` unless forced; `forcedReady` set;
       2 s sweep un-readies stale, unforced stations during `created`.
3. [x] `src/types.ts` + `src/websocketServer.ts`: `matchForceStationReady`
       message.
4. [x] `frontend`: team page Ready button disabled with "Waiting for Driver
       Station…" and a caption; control page row shows "DS offline" and
       **Ready anyway**; the "Waiting for X to press Ready" hint names the
       DS-offline stations.
5. [x] `docs/match-system.md` flow text; README unchanged (already generic).
6. [x] Tests in `src/matchEngine.test.ts`; existing helpers attach a DS
       before readying.
7. [x] Commit (`789280c`). Deploy is the user's call (field session may
       be live).

## Findings / gotchas

- The team page already had the caption "The Driver Station isn't talking
  to the field yet — you can still ready up" (`MatchPanel.tsx`, two places:
  station page and pop-out). 4159's drive team would have seen it.
- `dsReportedStatus` is the only place `lastDsHeartbeat` is stamped, and it
  is reached only through the UDP path in `index.ts` (`fms.on('message')`
  with `BatteryVoltage` in the payload). TCP-only telemetry (0x16 log
  packets) refreshes the DS _address_ liveness (`trySetDSAddress`) but not
  attachment, which is correct: a DS can hold TCP while ignoring the field.

- Shared working tree: while this was in progress another thread was
  finishing `plans/match-roster-team-identity.md` in the same files. Its
  `MatchControlPage.tsx` write at 14:23 dropped the ParticipantRow part of
  this change (import and hint survived); re-applied before committing.
  Check `grep -c "Ready anyway"` style markers after any peer write.
- Full `bun test` on this machine (2026-09-27 14:20) shows failures that
  are not this change: `@slack/web-api` is missing from `node_modules`
  (both `src/slackBridge.ts` and the stale `dist/` copy), the
  PracticeRecorder tests need `ffmpeg` on PATH, and "finishing a stopwatch
  run … finishedAt toBeGreaterThan(0)" is timing-flaky under full-suite
  load (passes 3/3 in isolation, passed in the first full run).
  `matchEngine.test.ts` alone: 48/48.

## Open questions for the user

1. Fix defect 2 as well? Recommendation: yes. When a station joins with no
   known DS IP, or a team's SSID moves to another station, close any FMS TCP
   session whose 0x18 handshake reported that team number so the DS
   re-handshakes and picks up the new slot. `fmsServer` would need to keep
   address → team from the handshake and accept a `disconnectTeam` event.
2. Deploy timing: the field was in use until at least 14:02 on 2026-09-27.

## Things not to do

- Don't gate Ready on robot comms (status bit 0x20) as well. 1868 joined
  match 61 with no robot on the field, which is a team choice; this gate is
  only about whether the field can talk to the DS.
- Don't un-ready during the countdown for a 5 s-old silence: it would
  abort starts for the whole field on one flaky laptop. Setup only.

## Progress log

- [x] Journal + match-history analysis of match 64
- [x] Engine gate + sweep + force (`setReady(station, ready, { force })`,
      `unreadyStationsWithoutDs`, `forcedReady`)
- [x] Message type + websocket dispatch (`matchForceStationReady`)
- [x] Frontend (team page + pop-out: greyed "Waiting for Driver Station…"
      with help text; control page: "DS offline" chip, **Ready anyway**,
      "(DS offline)" in the waiting-for hint)
- [x] Docs (`docs/match-system.md` Match Flow steps 2–3)
- [x] Tests green (48 in `matchEngine.test.ts`), typecheck green
- [x] Committed as `789280c` (on top of the peer thread's `7f02aa3`,
      roster identity — waited for it to land rather than split a shared
      test file). Not deployed: the field was live into the afternoon.
