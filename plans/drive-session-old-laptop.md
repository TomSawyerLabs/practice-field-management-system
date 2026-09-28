# The old team's laptop keeps a slot's drive session after Apply

## Goal

When a slot changes team (staff press Apply now, or held Wi-Fi changes
apply), the previous team's Driver Station laptop must lose the slot's drive
session for good. Today it can win it back, after which the new team's only
laptop is reported as a duplicate DS and, when the slot joins a match, match
control is handed to the wrong laptop. Seen twice on 2026-09-27 (slot4:
840 → 751 → 4159; slot1: 972 → 751). Evidence and log excerpts are in
`plans/match-roster-team-identity.md`, section "Follow-up found".

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator` (pFMS), branch
  `master`. All the code is in the `if (StartFMS)` block of `src/index.ts`
  (drive sessions, DNAT, duplicate-DS blocking). There are no unit tests for
  that block; it is glue around iptables.
- Steamboat runs `e4e2768` (as of 2026-09-27 14:34); nothing from
  2026-09-27 afternoon is pushed or deployed yet.
- Other Claude threads are editing this working tree (scoreboard checks,
  ready-check). Only stage this task's hunks.

## Root cause (from the journal + code)

1. `radioManager.addConfigChangeListener` (DNAT cleanup) deletes
   `acceptedDsForStation[station]` synchronously but `removeDnatRule()` only
   deletes the `activeDnatRules` entry after an awaited `iptables -D`.
2. The "telemetry-only TCP message" path in the FMS message handler
   re-accepts any address that has a DNAT rule, without checking that the
   rule still belongs to the station's current team. A packet from the old
   laptop in the window of (1) re-accepts it.
3. Once accepted, the old laptop stays "fresh" because `touchDsActivity()`
   runs for any message carrying a team number, whatever the team. The stale
   sweep never clears it, so the new team's laptop is blocked as a duplicate
   for as long as the old laptop is on the network.
4. `addDnatRule()` has no per-station serialisation: five messages from one
   DS in the same second added five identical DNAT rules; `removeDnatRule()`
   removes one, leaving four routing the robot's traffic to the old laptop.

## Decisions already made (don't re-ask)

- Fix inside `src/index.ts`; no extraction of the drive-session code into a
  module this time (shared tree, other threads active, no test harness for
  that glue). A small pure helper for per-key serialisation goes in
  `src/utils.ts` with a unit test.
- Both belt and suspenders: close the race (delete the map entry before the
  await, serialise DNAT add/remove per station) AND validate the team on
  every re-acceptance path AND add a safety net in the 5 s sweep that
  clears a session whose DS's team no longer owns the station.
- Remember each DS laptop's team from its handshakes (`dsTeam` by IP) so the
  telemetry-only path and the sweep can check it.
- `removeDnatRule()` counts the station's rules in `iptables -t nat -S
PREROUTING` and deletes that many, so duplicates already in the kernel are
  healed without a restart.
- `trySetDSAddress()` hands the station straight to a newcomer when the
  accepted laptop's team no longer owns it, so the new team never sees even
  a brief "2 DSes" warning. The sweep is the backstop, not the main path.
- A queued DNAT add carries the team it was started for and is skipped if
  the slot changed hands before it ran.

## Plan / steps

1. `src/utils.ts` — `perKeySerializer()` helper + tests (`src/utils.test.ts`).
2. `src/index.ts` — `dsTeam` map; team-validity check in the telemetry-only
   path; `removeDnatRule()` deletes the map entry first and loops `-D`;
   per-station serialisation of add/remove; sweep safety net.
3. `docs/network.md` — describe the ownership rule and the sweep.
4. Typecheck, prettier, tests; commit only these hunks.

Current step: **done** — committed; not yet pushed or deployed.

## Findings / gotchas

- The backend's `iptables -D` is idempotent-by-check (`-C` then `-D`) and
  deletes one copy per call, which is why duplicates survived a removal.
- A queued add computed the gateway from the station's team at run time,
  so a drive start that raced a slot change could have built the new
  team's rule pointing at the old laptop. Fixed by passing the team.
- No unit tests exist for the drive-session glue in `src/index.ts`; the
  change is covered by typecheck, the helper's tests, and the full suite
  (638 pass). Real verification is on the field: after a slot changes hands
  with the old laptop still on Wi-Fi, the journal should show
  `DS takeover: … (that laptop is team N's, the station is not)` or
  `Clearing drive session: … laptop is team N's`, and no
  `Blocked duplicate DS` for the new team.

## Progress log

- [x] Diagnosis from steamboat's journal (see the roster plan).
- [x] Step 1 — helper + 5 tests.
- [x] Step 2 — wiring fixes, plus the two review fixes above.
- [x] Step 3 — docs/network.md.
- [x] Step 4 — typecheck, prettier, full suite 638/638, commit.
- [ ] Push and deploy to steamboat (needs Cameron's go-ahead).
- [ ] Confirm on the field with the journal lines above.

## Open questions for the user

None.

## Things not to do

- Do not touch `acceptedDsForStation` semantics for the duplicate-team case
  (same team on two stations picks a robot with the Drive button).
- Do not make liveness socket-based again (see the comment above
  `isDsStale`: ghost sockets pinned dead laptops in July 2026).
