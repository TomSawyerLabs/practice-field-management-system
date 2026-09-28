# Pending Wi-Fi changes as a list, with post-match release

Continues `plans/radio-reapply-loop-fix.md` step 6. The user's spec
(2026-09-27):

> Pending radio changes should not be locked to a slot. Pending is a list
> of changes. Adding a new change first looks at the pending list and sees
> if there is an earlier change that is being overridden and can be
> simplified. At apply time the list gets reconciled with reality and the
> minimum number of mutations to the state is computed and applied in one
> change. If one robot is removed and added back in the same block of
> changes it simplifies to a no-op. After a match, automatically stage a
> change that clears the configured robots, gracefully for a team with
> back-to-back matches. If a team has staged changes, give them a clear
> modal that the match admin needs to approve the change first. No station
> moves, ever.

## Model (backend, `src/radioManager.ts`)

```ts
type PendingChange =
  | { id; kind: 'enable'; ssid; wpaKey; internetAccess?; station: StationName /* preferred */ }
  | { id; kind: 'release'; ssid; reason: 'team' | 'postMatch' };
```

`changes: PendingChange[]` replaces `stagedChanges: Record<StationName, …>`.
Persisted to `staged-config.json` as `{ changes: [...] }`; the old
station-keyed file is migrated on load (null → release of the robot active
there, object → enable at that station).

**Simplify on add**

- `enable X`: drop any earlier `enable X` and `release X`. If X is then
  already active with the same key and internet flag, nothing is added
  (result `kept` if a release was dropped, else `noop`). A different key or
  flag for an active X is an in-place change at its current station.
- `release X`: drop any earlier `enable X`; if X is not active, nothing is
  added (`noop`). An earlier `release X` is replaced (a team's own Release
  wins over the post-match one).
- A robot already on the field never changes station. The old "duplicate
  SSID → move" branch is gone.

**Reconcile at apply** (`computeTarget()`): start from `activeConfig`,
apply the list in order. A release removes the robot wherever it is. An
enable of a robot not on the field takes its preferred station if free in
the target, else the first free station, else stays pending as
"unresolved" (field full). Mutations = stations whose target differs from
`activeConfig`; the target becomes `activeConfig` in one step and one
radio commit follows. Unresolved enables remain in the list.

**When the list applies**

- Nothing in the way (no match, no admin hold, list empty): a request is
  applied at once, as before.
- Otherwise the change waits: `hold` is `match`, `admin`, or the new
  `pending` (something else is already waiting, so batch with it).
- Waiting changes apply **only** when staff press **Apply now**. The hold
  lifting no longer applies them by itself. That is what makes the
  post-match release graceful: nothing leaves the field until the match
  admin applies, and by then every team that is playing again has re-joined
  or pressed Keep.
- The commit still defers while robots are enabled (unchanged).

**Post-match release**: on the transition into `postMatch`, a `release`
with reason `postMatch` is added for every robot on the field (setting
`releaseAfterMatch`, default on, admin page). Joining a match or pressing
Enable Wi-Fi / Keep removes that robot's release (`keepRobot`).

**Broadcast** (`pendingCommitState`): adds `changes: PendingChangeView[]`
(id, kind, ssid, resolved station or null, reason, secured, internet).
`stagedChanges` stays, now _derived_: per station, target vs active, so
the team page's projections, `StationStatus`, the status bar and the CSA
issues keep working unchanged. `RadioHoldReason` gains `'pending'`.

**Messages**: `cancelPendingChange { id }` (staff ✕ on a line);
`cancelStationChange { station }` stays for the team page and maps onto
the list (enables resolved to that station, releases of the robot there).

## Frontend

- `PendingRadioChangesPanel`: list from `changes`, one line per change with
  a reason ("the match is over and it hasn't asked to stay"), a ✕, and
  "can't join: the field is full" for unresolved enables.
- Team page `RobotRow`: a Dialog opens when this robot's change starts
  waiting. Enable: "Waiting for the match admin — nothing reaches the radio
  until they press Apply now on the match page" with Cancel. Post-match
  release: "The match is over, so your robot is queued to leave the field
  when the admin applies. Playing again? Press Keep" with Keep. Dismissed
  → the existing caption line stays.
- Admin `WifiChangesSection`: "Release every robot when a match ends"
  checkbox.
- `holdReasonText` for `pending`; `fieldIssues` wording.

## Steps

1. [x] Backend model, simplify, reconcile, apply-only-on-approval,
       persistence + migration, post-match release, keepRobot, setting.
2. [x] Socket handlers + index wiring + types.
3. [x] Tests (rewrite the held-change block; add simplify/reconcile/
       post-match cases).
4. [x] Frontend panel, team dialog, admin checkbox, wording.
5. [x] Docs (match-system.md, internals.md, configuration.md).
6. [x] Typecheck, tests, commit. Not deployed until the user says.

## Decisions made without asking (flag in the reply)

- All configured robots are released after a match, not only those that
  played (the spec said "all the configured robots"). A free-driving team
  that never joined sees the Keep dialog.
- Waiting changes never auto-apply on hold lift; only Apply now. After any
  match, someone on /match or /admin must press Apply once.
- The release-after-match behaviour is a setting so a field without a
  match admin can turn it off.
