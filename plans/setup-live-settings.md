# Setup wizard: settings take effect live, fewer "go do this" steps

## Goal

The setup wizard should walk the operator through the entire setup, with
as few "go do this yourself" steps as possible (user, 2026-10-12). Today
two settings — the trunk interface (`vlanInterface`) and the radio URL
(`radioUrl`) — are read once at startup, and the wizard tells the operator
to restart pFMS after changing them. Make both take effect when saved, then
audit every other wizard step for manual work.

## Environment / context

- Worktree `C:\Users\camer\.t3\worktrees\practice-field-configurator\feature-setup-live-settings`,
  branch `feature/setup-live-settings`, based on local `master` at `0abbba1`
  (includes 14 unpushed commits from `plans/resolve-open-issues-2026-10.md`).
- The main checkout has another thread's uncommitted work (cancel-match /
  field E-Stop) in `src/index.ts`, `websocketServer.ts`, `types.ts`,
  `matchEngine.ts` — that's why this work is in a worktree. Expect merge
  conflicts with it in `src/index.ts`.
- Both settings resolve via `setupConfigStore.resolveSetting()` (wizard
  value wins over env) at `src/index.ts:159-160`, into module constants.
- Checks: `bun run typecheck`, `bun test` (~5.5 min, run in background),
  `DRY_RUN=1 bun src/index.ts` for a boot test (run from a temp cwd — it
  writes state files into the cwd).

## Decisions already made (don't re-ask)

- Radio URL: apply live on save. No restart, nothing to tell the operator.
- Trunk interface: rebuild the network **in-process** on save, no restart.
  Refuse during a match (user: "this is during setup anyway, no matches").
- Audit the whole wizard; for each manual step, automate it or record why
  it can't be.
- No deploy, no push without asking (deploy on hold).

## Design

### Radio URL

- `RadioManager.setApiBaseUrl(url)`: switch the polling target, mark
  disconnected, poll at once.
- Firmware mode is detected by `RadioManager` from the status `version`
  whenever it changes (it already sees it every poll), instead of index.ts
  calling `waitForRadio(RadioUrl)` — which retried the startup URL forever,
  so a corrected URL would never have been picked up.
- index.ts listens to `setupConfigStore` and calls `setApiBaseUrl` when
  the resolved URL changes.

### Trunk interface

What references the trunk NIC itself (everything else hangs off the
`br-slotN` bridges, which don't care which NIC feeds them):

- VLAN sub-interfaces `<nic>.slotN` (bridge members), port VLANs
- `10.0.100.5/24` on the NIC (`checkInterfaceIps`)
- the no-hairpin FORWARD rule (`-i <nic> -o <nic>`)
- internet-access MASQUERADE (`-o <nic>`)
- `RadioManager.radioManagementInterface` (VLAN parent for commits)
- robot packet capture (sniffs on the NIC), port bridge manager
- mDNS reflector (only started when a trunk exists)

Approach: uniform tear-down of the old trunk + full (non-KEEP_NETWORK)
bring-up of the new one, then re-commit the active config and re-sync
drive sessions / e-stop cuts. Same code as startup, so the two paths can't
drift. Network ops go in a new module (testable against a fake backend);
index.ts orchestrates the services.

## Plan / steps

1. Plan doc ← current
2. Radio URL live (commit)
3. Trunk interface live (commit), tests with a fake backend + dry-run boot
4. Audit results (Explore agent) → per-step fixes, separate commits
5. Remove the setup page's "restart pFMS after changing them" text and the
   ISSUES.md "Restart after a startup-only setting" entry
6. Docs (setup.md / getting-started.md) where they describe restarting

## Findings / gotchas

- `checkRequiredTools()` exits the process when a tool is missing — fine at
  startup, wrong for a live switch; needs a non-exiting variant.
- Worktree cleanup: bun's workspace link is a junction; `rmdir` it before
  removing the worktree (see memory: junctions get deleted through).

## Progress log

- [ ] Plan doc committed
- [ ] Radio URL live
- [ ] Trunk interface live
- [ ] Wizard audit
- [ ] Audit fixes
- [ ] Restart text + ISSUES entry removed
- [ ] Docs

## Open questions for the user

(none yet)

## Things not to do

- Don't touch the main checkout's uncommitted work.
- Don't restart the process to apply a setting — that's what this removes.
- Don't deploy or push.
