# Setup wizard: settings take effect live, fewer "go do this" steps

## Goal

The setup wizard should walk the operator through the entire setup, with
as few "go do this yourself" steps as possible (user, 2026-10-12). Today
two settings — the trunk interface (`vlanInterface`) and the radio URL
(`radioUrl`) — are read once at startup, and the wizard tells the operator
to restart pFMS after changing them. Make both take effect when saved, then
audit every other wizard step for manual work.

## Environment / context

- **Work happens in the main checkout on `master`**
  (`C:\Users\camer\git\practice-field-configurator`), per the user
  (2026-10-12: no separate branches). The first commits were made in a
  worktree (`feature/setup-live-settings`) and fast-forwarded onto `master`;
  that worktree is left over (remove with care: unlink bun's workspace link
  first — see memory on junctions).
- Shared working tree: stage only my hunks; the pre-commit hook typechecks a
  mix of staged and worktree files, so commit split work with
  `%TEMP%\pfms-scratch\commit-staged-only.sh` (backup, `checkout-index` the
  listed files, set new files aside, commit, restore).
- Both settings resolve via `setupConfigStore.resolveSetting()` (wizard
  value wins over env); both are now read live.
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

1. Plan doc — done (`a3d7d8e`)
2. **DRY_RUN changes nothing outside the machine** — done (`3b13074`) (first, before
   any further local boots — see Findings)
3. Radio URL live — done (`9c5a45b`)
4. Trunk interface live ← next (commit), tests with a fake backend + dry-run boot
   against a fake radio
5. Audit results (Explore agent) → per-step fixes, separate commits
6. Remove the setup page's "restart pFMS after changing them" text and the
   ISSUES.md "Restart after a startup-only setting" entry
7. Docs (setup.md / getting-started.md) where they describe restarting

## Findings / gotchas

- **2026-10-12 incident: local DRY_RUN boots wiped the field radio.** This
  dev PC reaches the real radio at `10.0.100.2`. DRY_RUN only swapped the
  host network backend; RadioManager still POSTed, and its config-sync check
  "repaired" the real radio to the dry run's empty config after ~15 s.
  steamboat's journal: radio cleared 16:03:45 and 16:46:18 (my dry-run
  boots), and overwritten 17:34:26 with the main checkout's stale
  `active-config.json` SSIDs (1234, 972, 4159-Comp, 751, 840-Beta) by an
  instance running from there (not one of mine). steamboat re-applied each
  within ~34 s. User: never test on production hardware without explicit
  consent; DRY_RUN should actually not change anything.
- DRY_RUN write sites found (all unguarded before this work): radio
  `/configuration` POST and `/scan/start`; robot-radio configure and
  firmware upload (`robotTestMonitor`, despite its `dryRun` flag); DS UDP
  control packets (`matchEngine.sendDSPacket`) and FMS TCP station
  assignment (`fmsServer`); timelapse Home Assistant lights; Slack (posts,
  deploy announcer); web push; `conntrack -D` and `ip route flush` in
  index.ts; wpa_supplicant/wpa_cli on host Wi-Fi cards (robot Wi-Fi scan,
  6 GHz watch, test joins); mDNS reflector sends. Already guarded: network
  backend, dnsmasq, e-stop cuts, packet capture, subnet scanner.
- Local fakes are exempt: writes to a loopback URL still go through in a
  dry run, because `scripts/test-radio-reconcile.ts` runs with `DRY_RUN=1`
  (to avoid the Linux network backend) against a fake radio on 127.0.0.1.
- **Commit race in the shared tree:** another thread's `git commit` takes
  whatever is staged at that instant — twice on 2026-10-13 my staged files
  went into its commits. Commit with `git commit -- <paths>`.
- Staging two features that share files: `stage-hunks.py` (scratch, in
  `%TEMP%\pfms-scratch`) selects hunks by regex; Python text-mode pipes on
  Windows turn LF into CRLF, so send `git apply` bytes. Check the staged
  tree builds alone with `git checkout-index -a --prefix=.staged-check/` +
  `tsc -p .staged-check`.
- DRY_RUN design: reads stay live (radio status, team checks, scans) so the
  UI shows real data; every write is logged `[dry-run] Would …` and
  skipped. Backstop: in a dry run, `fetch` refuses any non-GET/HEAD request
  to a non-loopback host.

- `checkRequiredTools()` exits the process when a tool is missing — fine at
  startup, wrong for a live switch; needs a non-exiting variant.
- Worktree cleanup: bun's workspace link is a junction; `rmdir` it before
  removing the worktree (see memory: junctions get deleted through).

## Progress log

- [x] Plan doc committed (`a3d7d8e`)
- [x] DRY_RUN changes nothing outside the machine — `src/dryRun.ts`, guards at every write site, fetch backstop; regression test in `radioManager.test.ts` fails with dry run off (`3b13074`)
- [x] Radio URL live (`9c5a45b`)
- [x] Trunk interface live (`edc128c`): `src/trunkInterface.ts`, rebuild in
      index.ts, waits for a match, retries every 30 s; wizard picker and
      "field network running" check; `scripts/test-trunk-switch.ts`
- [x] Missing tools no longer exit pFMS at startup (part of `edc128c`)
- [x] Clearing a wizard setting actually clears it (`ddb7231`) — found on
      the way: `undefined` was dropped by JSON
- [x] FMS server test flake on Windows reserved ports (`6492a87`)
- [x] Wizard audit (`plans/setup-wizard-audit.md`)
- [x] Restart text + ISSUES entry removed, docs updated (`edc128c`)
- [x] Admin passphrase step, second in the wizard (`b679889`)
- [x] Steps that pass mark themselves done (`a21fc4a`)
- [x] Inline "Lock scoring with a key" (`42f299b`)
- [x] Logged: several admin-page WebSocket actions have no admin check
      (`fedb4f2`, ISSUES.md) — not fixed, needs a per-message decision
- [x] **Install missing tools** (`821df11`) and **Install and enable the
      service** (`7d3e65d`), each committed on its own: built from HEAD by
      re-running my edit scripts in a temp tree (`build-split.py`), staged
      with `git update-index`, the other thread's files held at HEAD only
      while the hook ran, then restored and verified byte-identical
- [x] Wizard docs (getting-started.md, deployment.md) — landed inside the
      other thread's `353e9fa` (commit race, see Findings)
- [x] Item 7: custom sounds noted under multi-site Stage 2 — landed inside
      the other thread's `1640b9b` (same race)

## Open questions for the user

Remaining "go do this" steps from `plans/setup-wizard-audit.md`, with my
recommendation for each:

1. ✅ approved — **Missing tools** — an "Install" button in the Host step that runs
   `apt-get install -y …` as root (pFMS already is), streaming the output.
   Recommend yes; admin-only, refuses while apt is locked.
2. **Admin passphrase in the wizard** — the wizard is open to anyone until
   one is set. Recommend yes: an inline "set passphrase" field as the first
   step.
3. **Mark-done clicks** — auto-mark a step done when its checks all pass
   (steps needing a human confirmation already only pass once confirmed).
   Recommend yes.
4. **Deployment** — write and enable the systemd unit from the wizard on a
   systemd host (guard against a second instance). Recommend yes, but it's
   the riskiest; would want your OK on the design first.
5. **Scoreboard API key** — inline "create key" button instead of "go to
   /admin". Recommend yes (small).
6. **FMS_ENDPOINT** — user asked whether it's the fixed IP DSes reach.
   It's an on/off flag; the address is fixed (10.0.100.5). Proposed: run
   the FMS server by default whenever the field network is up, keep
   `FMS_ENDPOINT=false` as an off switch. Waiting on the user.
7. **Sounds** — user suggested making it part of the "theme" setup. No
   theme setup exists yet (Stage 2 of plans/multi-site-adoption.md).
   Decided (user, 2026-10-13): sounds belong to the theme; noted in
   plans/multi-site-adoption.md.
8. Not automatable, keep as instructions: OS/root, switch native VLAN,
   radio firmware flash, hearing the test sound, casting to a TV, Docker
   restart policy, HTTPS/domain.

## Things not to do

- **Never boot pFMS locally against the real radio.** Every local boot gets
  `RADIO_URL` pointing at a fake radio on 127.0.0.1, and no test touches
  real field hardware without the user's explicit consent (reads included).
- Don't create extra branches/worktrees for this — work in this worktree
  (user, 2026-10-12).
- Don't touch the main checkout's uncommitted work.
- Don't restart the process to apply a setting — that's what this removes.
- Don't deploy or push.
