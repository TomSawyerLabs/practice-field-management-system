# Robot dropout warnings for teams

## Goal

Detect short robot connection dropouts (about 0.5–10 s), say whether a
brownout caused them, and show a lasting warning on the team's page. The
existing BROWNOUT chip lasts one telemetry sample (~¼ s), so nobody sees it.
Prompted by team 114 on 2026-10-29: about 1 s NetworkTables drops lined up
with brownouts down to 6.6 V (see `plans/team-114-nt-drops-2026-10-29.md`).

## Environment / context

- `src/robotPacketCapture.ts` sniffs DS→robot control (UDP 1110) and
  robot→DS replies (UDP 1150), each captured twice (ingress + forwarded).
  Replies carry the sequence of the control packet they answer, plus a status
  byte (brownout bit 0x10, enabled 0x04) and battery voltage.
- Both directions cross pFMS only for a legacy DS routed through pFMS (drive
  session on house Wi-Fi). Direct connections and the 2027 DS (replies to its
  source port) are invisible. That's acceptable: those teams aren't going
  through the field.
- `src/robotLinkWatch.ts` already classifies multi-second link failures per
  drive session (5 s tick). Dropouts are a different, sub-second scale and get
  their own module.
- Team page: `frontend/src/components/ControlPage.tsx` (route `/<ssid>`).
  Staff triage: `frontend/src/utils/fieldIssues.ts` on `/csa`.

## Decisions made

- Two kinds of dropout, because teams need to know which end to fix:
  - **robot**: the DS kept sending control packets, the robot answered none
    of them for ≥ 500 ms.
  - **laptop**: the DS sent nothing for ≥ 500 ms (laptop Wi-Fi / DS stall).
- Gaps over 10 s aren't dropouts (robot rebooted, battery swap, laptop
  left). Existing link-watch / radio messages already cover those.
- Cause is **brownout** when a reply in [start − 2 s, end + 3 s] has the
  brownout bit or a battery reading below 7.0 V. An event is finalized 3 s
  after it ends so the look-ahead is available.
- Brownout episodes are counted on their own (rising edge of the bit), with
  the lowest voltage, even without a dropout.
- History is per station + team for the current visit. It clears when a
  different team takes the station. Up to 50 events are kept.
- Each finalized dropout gets one journal line, which also gives us the
  sub-second history the journal lacked.

## Plan / steps

1. [x] Plan doc
2. [x] `src/robotDropouts.ts`: pure tracker plus unit tests
3. [x] Wire it into the capture and broadcast a `robotDropouts` state (initial
       send + on change, checked every 1 s), and log lines
4. [x] Team page card (`DropoutAlert` in `StationAlerts`, every tab):
       recent dropouts, cause, advice. Wording lives in
       `frontend/src/utils/robotDropouts.ts`
5. [x] `/csa` issue for recent dropouts
6. [x] Typecheck, full test suite (1311 pass), docs/network.md, commit
7. [ ] **Current:** deploy only with the user's OK, then watch the journal
       for `Dropout on` lines the next time a team browns out

## Findings / gotchas

- Telemetry is coalesced to ~4 Hz before broadcast. Detection must run on
  raw packets (in the capture callback), not on `TelemetryUpdate`.
- The field's stop cut (`pfms-estop-<slot>` FORWARD DROP on UDP 1110) drops
  control packets after the capture sees them arriving. Counting arriving
  copies would make every short stop look like a robot dropout. So robot
  silence counts only forwarded copies (source on the robot's /24, i.e. the
  masqueraded gateway `.254`), and laptop silence only arriving ones.
- A reply's sequence matches the control packet it answers, and that packet
  was already counted, so "unanswered" is the count minus one.
- Known limit: with two robots of one team, the laptop's arriving copy
  (on VLAN 3) resolves its station by team number, so it may be counted on
  the other robot's slot. That can only hide a laptop-side dropout, never
  invent one.
- Not verified visually: the card has only been typechecked and
  unit-tested, not rendered with real data.

## Progress log

- [x] Design (2026-10-29)
- [x] Implemented and tested (2026-10-29)
- [ ] Deployed
- [ ] Seen working on a real brownout

## Open questions for the user

1. Also DM the team on Slack when one happens? (Not doing this by default.)
2. Deploy once done? (Waiting for your yes.)
