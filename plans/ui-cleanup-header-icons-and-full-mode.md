# Status bar tap targets and StationStatus `full` mode

## Goal

Fix two `ISSUES.md` entries, as separate commits:

- "Page header icons are too small to tap on a phone": Get Help matters most.
  Check at 320 px and 390 px wide on touch sizes.
- "StationStatus `full` mode looks unreachable": establish whether it is dead.
  If so, remove it and whatever only it uses, including the deprecated
  `AllianceStatus`.

## Environment / context

- Branch `issues/ui-cleanup`, own worktree. No push, no deploy, steamboat
  untouched. Finish with `git -C C:/Users/camer/git/practice-field-configurator
merge --ff-only issues/ui-cleanup`; rebase again if other threads got in first.
- Verification: headless Chrome only, `DRY_RUN=1`, a loopback fake `RADIO_URL`,
  data directory in `%TEMP%`. Never the real radio.
- Checks: `bun run typecheck`, `bun test`.

## Decisions already made (don't re-ask)

- Touch sizing follows the repo's convention: `@media (pointer: coarse)`, as
  `STOP_TAP_TARGET` in `MatchPanel.tsx` does. Mouse users keep the 24 px bar.
- Dead code removal is `Changelog: internal`.

## Findings

- `StationStatus` is rendered from two places, `SlotGroup` and `AllianceStatus`,
  and neither passes `full`. `AllianceStatus` has no caller. Neither has a prop
  spread, so `full` is always undefined: dead.
- `full` was the only caller of `MatchPanel`. The team page uses
  `MatchPanelForControl`. Going with it: `stationChipLabel`,
  `sendStationJoin`, `useStationDsInfo`, `useStationMdnsActivity`, and the
  `stationJoin` WebSocket message, its handler, and the deprecated
  `MatchEngine.joinStation()`, which no script or test sends or calls.
- Kept: `FreeplayControl`, `FreeplayStopButton`, `StationChart`,
  `StationNetworkCard` and `useMdnsActivity` all have live callers.
- The dead `MatchPanel` was the only place showing `blockedReason` to a joined
  team. `535f015` (2026-10-04) moved the out-of-match notice to
  `FreeplayControl`, leaving the joined notice in `MatchPanel` only, so a joined
  team on the live page was never told why it would not enable. Fixed.

## Verification

Run 2026-10-30 in headless Chrome 155 over CDP, against the real `src/index.ts`
and Vite, with `DRY_RUN=1`, a loopback fake `RADIO_URL` and all data files in
`%TEMP%`. The harness was throwaway and is not committed. 79 of 79 checks passed
on the rebased commits, and the fake radio received no POST.

- At 320 and 390 wide with touch emulation, on `/`, `/1234`, `/overview` and
  `/1234` with Wi-Fi changes waiting: all three icons are 44x44, do not overlap,
  and hit-test to their own corners. No sideways scroll, and the statuses stay
  clear of the icons.
- A synthesized tap on Get Help opens the support widget. The first-visit callout
  stays on screen with its arrow on the button.
- At 1280 wide with a mouse: bar 24 high, icons 14 px, six overview cards.
- The Wi-Fi waiting and joined-and-blocked states were injected by rewriting
  inbound WebSocket frames, since the fake field cannot reach them on its own.
  The blocked notice was therefore seen rendering, not triggered by a real
  control-system block. Emulated touch is not a real phone.

## Gotchas

- In a worktree `.git` is a file, so scratch files can't go under it.
- lefthook typechecks the worktree, not the staged blobs, and it lost an unstaged
  hunk of a partially staged file (the notice in `MatchPanel.tsx`) during a
  commit. Commit a split file so the worktree typechecks, and keep a backup ref.
- MUI's round `IconButton` is not hit-testable in its corners, which leaves dead
  spots between neighbours, so the touch buttons are square.

## Progress log

- [x] Status bar tap targets
- [x] Remove `full` mode (`AllianceStatus.tsx` is gone; `SlotGroup.tsx` holds what is left)
- [x] Joined-team blocked notice, found during the removal
- [x] Timeline Total and Teleop labels overlapped on a phone, found in the check
- [x] Headless check at 320 and 390
- [x] Typecheck and tests (860 pass, 0 fail)
- [x] Rebase and fast-forward master

## Things not to do

- Don't run the backend without a fake `RADIO_URL`; `DRY_RUN` still POSTs to the
  radio.
- Don't open a visible browser.
