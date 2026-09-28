# Drive sessions belong to the robot, not the slot

## Goal

A Driver Station laptop drives a **robot**. Today pFMS records "which laptop
drives slot N" and then tries to notice when slot N changes hands. That is
the bug: when a slot changed hands on 2026-09-27, the previous team's laptop
kept (or won back) the slot's session, the new team's only laptop was
reported as a second DS, and joining a match handed control to the old
laptop (slot4: 840 → 751 → 4159; slot1: 972 → 751). Evidence is in
`plans/match-roster-team-identity.md`, section "Follow-up found".

Cameron's direction (2026-09-27/28): identifying things by slot is wrong.
Re-key the drive-session layer by robot so a slot changing hands cannot leave
a session behind, instead of patching the slot-keyed code with team checks.

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator` (pFMS), branch
  `master`. The drive-session glue lives in the `if (StartFMS)` block of
  `src/index.ts`.
- Robot identity = **SSID**. It is unique on the field: the radio manager
  clears an SSID from any other station before applying it. A team number is
  not unique (a team can put two robots on the field).
- A laptop identifies itself only by the **team number** in its DS handshakes
  and UDP status. It never says which SSID it wants.
- Kernel resources are physically per slot: the DNAT rule matches
  `-i br-slotN -d 10.TE.AM.254`, a duplicate block is `-o br-slotN`, and a
  route preference points at slot N's routing table. The slot is looked up
  from the robot at the moment a rule is built; it is never the key.
- Steamboat runs `d936144` (2026-09-27 17:33), which has the roster fix but
  none of this.
- Other Claude threads commit to this working tree. Stage only this task's
  files.

## Decisions already made (don't re-ask)

- **Replace the first attempt.** Commit `ec9094e` (unpushed) patched the
  slot-keyed code with team checks and a per-station serialiser. Cameron
  rejected it: it still indexes on the slot. The new work replaces it; amend
  `ec9094e` if it is still HEAD and unpublished, otherwise commit on top.
- **New module `src/driveSessions.ts`**, a class with injected effects, so the
  slot-changes-hands and robot-moves cases are unit-tested. `index.ts` only
  wires it to the radio manager, match engine, FMS server and iptables.
- **State is keyed by robot and laptop only:**
  - laptops: IP → { team, last activity }
  - sessions: robot SSID → laptop IP
  - blocked: robot SSID → set of laptop IPs (a second laptop for the same
    robot — the only thing "Multiple DSes" should ever mean)
- **Everything slot-shaped is derived** at the moment it is needed: the
  kernel rules, the match engine's per-station DS address, the broadcast to
  clients, the hold loop's "which laptop is on slot N".
- **Kernel rules are reconciled, not mutated in place.** One serialised sync
  computes the desired DNAT / block rules from sessions + current radio
  config, diffs them against what it installed, removes then adds. Concurrent
  handshakes cannot create duplicate rules, and there is no per-slot
  serialiser. Runs on every change and on the 5 s sweep, so drift heals.
- **Auto-drive** stays as before: a laptop whose team has exactly one robot
  on the field drives it. Two robots of one team still need the Drive button.
- **Slot changes hands** needs no special case: the old robot is no longer on
  any station, so its session ends; the new robot has no session, so the new
  team's laptop takes it with nothing in the way. A robot moving to another
  slot keeps its session and its rules follow it.
- **Graceful reload**: DNAT rules found in the kernel seed sessions (robot =
  whatever is on that slot now, if the rule's gateway matches its team) so
  robots stay connected; a laptop that never reappears is swept after 20 s.
  Leftover duplicate-block rules found in the kernel are removed.
- **Wire format unchanged**: `driveSessionState` is still keyed by station,
  computed fresh from the current mapping at broadcast time. Changing the
  client protocol is a separate step.
- The match engine is still keyed by station (`setDSAddress(station, ip)`).
  Out of scope here; this layer keeps it in step from robot-keyed state, so
  it can no longer hold a laptop for a slot its robot has left.

## Plan / steps

1. `src/driveSessions.ts` + `src/driveSessions.test.ts`.
2. `src/index.ts`: replace `acceptedDsForStation`, `activeDnatRules`,
   `blockedDsRules`, `dsTeam`, `dsLastActivity`, `trySetDSAddress`,
   `start/stopDrive`, add/remove DNAT, block/unblock, the stale sweep and the
   config-change DNAT cleanup with the module. Remove `perKeySerializer`.
3. `docs/network.md`: describe the robot-keyed model.
4. Typecheck, prettier, full suite; commit (amend `ec9094e` if still HEAD).

Current step: **done** — committed; not pushed or deployed.

## Findings / gotchas

- `routePreferenceManager.onConfigChange` clears a laptop's preference when
  its recorded slot's team changes, by iterating a snapshot and clearing by
  IP. If the session sync has already re-pointed that laptop to the robot's
  new slot, the manager can clear the new preference. The 5 s sweep re-runs
  the sync and restores it; accepted as self-healing within 5 s.
- The backend's `iptables -D` checks with `-C` and deletes one copy per call.
  Duplicates restored from the kernel are recorded with a count and deleted
  that many times.
- A config change triggers two sync passes (the ended session and the
  config change each ask for one), so a single failed iptables delete is
  usually retried before the call returns.
- The old restore parsed only DNAT rules; leftover duplicate-DS FORWARD
  drops from a previous process were never removed. Restore now reads
  both and the sync removes whatever is not wanted.
- `matchEngine.setDSAddress()` is also its liveness feed for the station's
  DS record, so it must be called on every message from a driving laptop,
  not only when the session changes.

## Progress log

- [x] Diagnosis from steamboat's journal (see the roster plan).
- [x] First attempt `ec9094e` (team checks on slot-keyed state) — rejected.
- [x] Step 1 — `src/driveSessions.ts`, 19 tests in `src/driveSessions.test.ts`
      replaying the 2026-09-27 slot4/slot1 incidents.
- [x] Step 2 — wiring: `src/index.ts` drive-session code is now ~260 lines
      shorter; `perKeySerializer` removed.
- [x] Step 3 — `docs/network.md` rewritten for the robot-keyed model.
- [x] Step 4 — typecheck, prettier, full suite 654/654, committed.
- [ ] Push and deploy (needs Cameron's go-ahead).
- [ ] Field check: after a slot changes hands with the old laptop still on
      Wi-Fi, no `Blocked duplicate DS` for the new team.

## Open questions for the user

None blocking.

## Things not to do

- Do not key any drive-session state by slot, and do not add "is this rule
  still current for the slot" checks — that was the rejected first attempt.
- Do not make liveness socket-based (ghost sockets pinned dead laptops in
  July 2026; see the comment above the staleness check).
- Do not auto-drive a team that has two robots on the field.
