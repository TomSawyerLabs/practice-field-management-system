# Out-of-match enable: did a recent change break it?

## Goal

Answer whether teams on the field but not in a match can still enable their
robot from their own Driver Station (freeplay), which they could before, and
if not, which change broke it and how to get it back.

## Environment / context

- Production: `steamboat`, checkout `/home/cameron/practice-field-management-system`,
  running `605a20a` (pulled 2026-09-25 16:44). Setup config at
  `setup-config.json` in that directory: `outOfMatchControl: true`,
  `controllerPolicy` unset (so nothing is policy-blocked).
- Investigation ran 2026-09-27 ~11:45–12:10 PDT, during a live field session
  with four teams (972, 840, 2813, 6238) on stations and three more (581,
  8048, 1967) whose DS was connected but no station configured.
- Read-only diagnostics only (journalctl, tcpdump on steamboat). No changes
  made to steamboat or to code.

## Decisions already made (don't re-ask)

- None locked in by the user yet; this is an assessment, not a fix.

## What the code does today

The FMS station-assignment resolver (`src/index.ts`, `resolveTeamSlot`)
answers a DS handshake with:

- assignment reply (0x19/0x1f, station slot) when the station has **joined** a
  match, or when its control system is policy-blocked (then a 500 ms loop
  also streams disabled packets);
- `'release'` = 0x19/0x1f with **status 2 "not in match"** for a known team
  not in a match (default, `outOfMatchControl !== false`);
- **no reply** when `outOfMatchControl` is `false`, or when the team has no
  station configured (`getStationForTeam` undefined).

Nothing on this path changed after 2026-09-16. Relevant history:

| Commit    | Date  | Deployed    | Change                                                                        |
| --------- | ----- | ----------- | ----------------------------------------------------------------------------- |
| `3e533cc` | 09-13 | 09-13 17:37 | status-2 reply added, **off by default**, explicitly "unverified on hardware" |
| `d031e11` | 09-15 | 09-15 13:56 | status-2 reply **on by default**, admin switch added                          |
| `6bfcadd` | 09-16 | 09-16 12:34 | policy-blocked robots held under field control (not active: no policy set)    |

Before 09-13, an out-of-match DS got **no reply at all** and kept local
control (that is the behaviour the user remembers). The 09-13 commit body and
`docs/network.md` both warn that if the DS treats status 2 as "connected,
waiting" it would park every freeplay DS instead of freeing it.

## Findings / evidence (2026-09-27)

Facts from `journalctl` and `tcpdump` on steamboat:

- **No out-of-match enable was observed in any capture.** Three captures of
  DS↔robot UDP (1110/1150) totalling ~6 minutes across the four released
  DSes: robots only ever showed `enabled` (status bit 0x04) during Match 4
  (12:03:41–12:04:41). Outside matches every robot sat disabled.
- **Team 6238 opted into "record while enabled" at 10:12** (practice
  recording store), the buffer ran from 11:23, and **no practice clip ever
  started** in 14 days of logs. The recorder is fed by robot→DS status
  packets sniffed on the team VLAN, so it _would_ see a local enable. 6238
  was on the field ~11:13–12:10 and in the released (status-2) state for
  ~30 minutes of that.
- **6238 joined a match at 11:13:55 and sat joined (held disabled) for 26
  minutes** without a match being started, then left. Looks like a team
  trying to get enabled by joining. Circumstantial. It then joined and left
  again at 12:05:38→12:06:06, 12:07:37→12:08:28 and 12:10:44, still with no
  match started in between.
- A 5-minute bucketed capture (12:06–12:11) of 1110 + 1160: every burst of
  DS→FMS 1160 status starts within a second of a `joined` log line and stops
  at `left`; released DSes sent none. No enabled bit outside a match.
- The four DSes that received status 2 behave differently from each other on
  the TCP side, which suggests DS version differences:
  - 972 (10.55.153.222) and 2813 (10.55.69.79): kept reconnecting every ~8 s
    for an hour after the status-2 reply (13 and 3 "rapid reconnects"
    summaries), exactly like a no-reply DS.
  - 6238 (10.55.64.219): holds one long TCP session and streams 0x16 log
    data after being released.
  - 840 (10.55.48.12): holds the session idle.
- Released DSes send **no UDP status to the FMS (1160)**; only DSes with a
  station assignment do. DS→robot control bytes from released DSes were
  `0x00`/`0x02` (FMS-attached bit 0x08 clear; 972 in locally-selected
  autonomous mode). This is what a locally-controlled DS looks like, but a
  parked "waiting" DS may look the same from the server, so it is not proof.
- The admin page text for the switch's **off** state ("held disabled until
  they join a match") is wrong: off just returns to the pre-09-13 no-reply
  behaviour. Nothing holds an unjoined, unblocked robot disabled.

Conclusion: the only candidate is the status-2 reply turned on 09-15. Server
side evidence is consistent with "teams are not enabling out of match" but
cannot distinguish "cannot" from "did not try". A human at a DS settles it in
seconds (below).

### Side finding: routing loop for unprovisioned team subnets

DS packets to a robot whose team subnet has no VLAN on steamboat
(e.g. 581 → 10.5.81.2) bounce between steamboat and the UniFi gateway
(`10.255.0.1`, route `ip route get 10.5.81.2`) until TTL expires: the same
IP id seen on `eno1` In/Out with TTL 19, 18, 17, … Three such DSes produced
~6 000 pps each. Infrastructure; needs the user's per-change authorization
to touch (ops repo / UniFi).

## Recommended field test (needs a person at a DS)

1. Pick a team whose DS is connected and whose station is _not_ joined
   (staff page shows it unjoined; log shows `→ not in match (release reply
... status 2)` for their DS).
2. On the DS: is the **FMS Connected** indicator lit? Is **Enable** greyed
   out / does pressing it do nothing?
3. If locked: admin page → "Out-of-match robot control" → **Turn off**, then
   have the team **close and reopen the Driver Station**. The next
   handshake gets no reply (pre-09-13 behaviour) and Enable should work.
4. Report which DS version each result came from; the TCP behaviour above
   suggests versions differ in how they take status 2.

## Superseded (2026-10-04): status 2 DOES park DS 26.0

The 09-28 resolution below is wrong. On 2026-10-04 team 8 and 6036 (both DS
26.0) got identical status-2 replies and both DSes hid the Enable button;
6036 only enabled by pressing the DS's `[ ] \` key combo, which enables even
with the button hidden. See `plans/csa-fms-control-status.md`.

## Resolution (2026-09-28): it was never broken (WRONG — see above)

User, next day: "It was just a language issue. It was working the whole
time. Your wording in the admin made me think the inverse was correct."

- The status-2 "not in match" reply **works**: it releases a DS to local
  control, including a DS that was just in a match. Nothing broke on
  2026-09-15 or later.
- The confusion was the admin card: title "Out-of-match robot control", a
  chip reading **Enabled** / **Disabled**, and a button "Turn off". On a
  field where "enabled/disabled" means robot state, "Disabled" read as
  "robots are disabled" and "Turn off" as the way to free them. The user
  pressed it at 12:14 thinking it would free robots; with the switch off
  the old code sent no reply at all, which also leaves local control alone,
  so nothing visibly changed either way. Everything below about "status 2
  parks the DS" and the "is the button inverted?" reading is **wrong** and
  kept only as history.
- The server-side evidence (no out-of-match enable captured) was simply
  teams not freeplaying at that moment, and one team joining over and over.
- Fixed 2026-09-28: status-2 release restored for unjoined, unheld DSes;
  admin card reworded to "Freeplay outside matches", chip **Allowed** /
  **Held**, buttons "Hold robots" / "Allow freeplay"; station page and docs
  reworded to match. The "Held" mode (assign + stream disabled packets with
  `Admin disabled` game data) and the uplink hairpin DROP rule stay — both
  were asked for and are correct.

## User feedback (2026-09-27 ~12:15)

- User turned the admin switch **off** at 12:14:21 (`updateSetupSettings
{ outOfMatchControl: false }`) and reports a robot on the field that cannot
  be enabled. At that moment five stations were joined (held disabled until
  match start by design) — which robot they mean is not yet known.
- User wants the DS itself to show a message like "admin disabled" when the
  field is holding a robot because of the switch.
- User wants the routing loop fixed sooner rather than later.

## Decisions already made (don't re-ask)

- Switch **off** now really holds: unjoined DSes are assigned a slot and the
  hold loop streams disabled packets with game data `Admin disabled`
  (`AdminOff` on a 2027 DS), the same path as a policy block. Station page
  shows `heldReason`; joining a match lifts it. Switch **on** sends **no
  reply** again (pre-09-13 behaviour). User's 12:20 question "is the button
  just inverted?" matched the evidence: on = status 2 = parked, off = silence
  = free. Status 2 is treated as parking the DS from here on; the reply code
  stays in fmsServer but nothing sends it.
- Routing loop fix lives in pFMS (`networkManager.dropHairpinForwarding`):
  `iptables -I FORWARD -i eno1 -o eno1 -j DROP` with the `pfms-` comment so
  the normal flush/cleanup covers it. Installed at `configureNetwork`. It is
  a firewall change on steamboat, so the **deploy needs the user's explicit
  yes** even though the code is committed.

## Plan / steps

- [x] Rule out code changes after 09-16 on the enable path (only matchEngine
      changed; all new gates are behind `joined`).
- [x] Confirm live settings on steamboat (switch on, no controller policy).
- [x] Look for any out-of-match enable in traffic and recorder logs (none).
- [x] Implement "switch off = held + DS message" (index.ts hold loop and
      resolver, matchEngine `setOutOfMatchHold` / `dsProtocolFor`,
      `heldReason` in types, MatchPanel alert, AdminPage wording, docs).
- [x] Implement the hairpin DROP rule in networkManager.
- [x] Switch on = no reply (status 2 parks DSes).
- [x] User said "do it" (12:4x). Deployed `57ea647` at 12:50 and `2a4188b`
      at 12:53 (the first deploy installed no hairpin rule: KEEP_NETWORK
      skips the flush and configureNetwork only runs on a radio commit, so
      the rule is now also installed at startup). Verified on steamboat:
      service active, `-A FORWARD -i eno1 -o eno1 … pfms-no-hairpin -j DROP`
      present, unjoined DSes logged as held ("out-of-match control off").
- [x] ~~Switch on = no reply~~ — wrong, reverted 2026-09-28 (see Resolution).
- [x] 2026-09-28: restore status-2 release; reword admin card, station page
      alert, docs, code comments.
- [ ] **Current:** deploy the 2026-09-28 fix (master also carries other
      threads' undeployed commits — user's call when).
- [ ] Verify on the field after deploy: Allowed → DS enables out of a match
      and after leaving one without a restart; Held → DS shows "Admin
      disabled" and cannot.

## Things not to do

- ~~Do not "fix" the status-2 release reply again.~~ Superseded 2026-10-04:
  status 2 parks DS 26.0; see `plans/csa-fms-control-status.md`.
- Do not label robot-related switches "Enabled"/"Disabled"; on this field
  those words mean robot state.

- Do not flip the admin switch or touch steamboat/UniFi from a session
  without the user's explicit per-change yes.
- Do not read "DS attached to FMS" log lines as parked DSes: they fire when a
  station joins a match (the DS starts sending 1160 status).
- Do not use `Practice recording started` silence as proof on its own; it
  only covers opted-in teams.
