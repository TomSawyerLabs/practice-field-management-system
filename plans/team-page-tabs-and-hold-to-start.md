# Team page tabs, and a /match hold-to-start that survives phones

## Goal

1. The team page (`/<ssid>`, `ControlPage.tsx`) is one long scroll: robot list,
   match panel, video, port selector, radio status (charts/tables), network
   diagnostics, and other robots' network cards. Split it into tabs so a team
   sees one group at a time.
2. On `/match`, pressing "Hold to Start" reflows the page under the finger:
   the button's label widens ("Hold… release aborts") and re-wraps its row,
   then the whole Created view is replaced by the Active view at the
   countdown. On some phones the long press then lands on text, the browser
   starts a text selection (or long-press context menu), fires
   `pointercancel`, and the hold ends — aborting the start.

## Environment / context

- Frontend: React + MUI, `frontend/src/components/`. Team page root is
  `roots/control.tsx` → `ControlPage`. Match page is `MatchControlPage.tsx`.
- Hold logic lives at module scope in `MatchControlPage.tsx` (`beginHold`,
  `endHold`, `setHoldLatestPhase`) because the button unmounts mid-hold.
- Server countdown: `matchEngine.ts` sets `remainingTime = COUNTDOWN_SECONDS`
  (3) on entering `countdown` and ticks down.
- Checks: `bun run typecheck`, prettier via lefthook.

## Decisions already made (don't re-ask)

- The match panel (Join / Ready / Disable / A-Stop / E-Stop) stays **above**
  the tabs, always visible. It carries the stop buttons and mounts the
  `AStopPopout` controller; hiding either behind a tab is unsafe.
- The multiple-Driver-Station alert and team checks (modal + "all passed"
  line) also stay above the tabs — they're alerts, not a category.
- Tabs: **Robots** (saved robots, enable/release, add, verify) · **Radio**
  (radio status charts/tables) · **Network** (port selector, network card,
  other robots' network cards) · **Video**.
- Tab lives in the URL hash (`#radio`) so a reload keeps it; robot selection
  (`replaceState`) keeps the hash.
- Default tab: Robots when the team has no robot on the field, otherwise
  Radio.
- Chart data collection (`useUpdateCallback(handleStatusUpdate)` etc.) moves
  up to the page root so charts keep filling while their tab is hidden.
- /match: while the start is held, a full-screen overlay covers the page. It
  shows the 3-2-1 and hides the Created → Active reflow; the finger is always
  over a non-selectable element. The button's label no longer changes width.
  During the hold, `contextmenu` and `selectstart` are cancelled window-wide.
- The overlay disappears the moment robots enable (auto onward) so E-Stop and
  the rest of the controls are reachable; releasing then is a no-op anyway.

## Plan / steps

1. [x] Plan doc.
2. [x] Team page tabs (`ControlPage.tsx`).
3. [x] Hold overlay + selection/callout suppression (`MatchControlPage.tsx`).
4. [x] Typecheck, prettier, visual check (headless Playwright, Pixel 7).
5. [x] Commit (two commits, user-facing subjects, `Changelog:` trailers).
6. [ ] Real-phone check on the field after deploy: long-press hold on an
       Android phone and an iPhone through the full 3-2-1.

## Findings / gotchas

- `handleStatusUpdate` dedupes by timestamp, so registering it once at the
  page root and again inside `StationChart` is harmless.
- Visual check without a real backend: a throwaway WebSocket server on :3000
  (pattern from `scripts/fake-backend-ds-guard.ts`) feeding a `MatchEngine`
  state plus a canned `radioUpdate` and `savedTeamsState`, vite on :5173,
  and Playwright from a temp dir (not the repo). Synthetic CDP touch hold
  went created → countdown (overlay showing 3-2-1) → Autonomous with the
  overlay gone; a quick tap sent start then abort and returned to setup.
- Headless Chromium can't reproduce the long-press text-selection cancel
  itself, so the fix for that part is verified only by construction
  (overlay is `user-select: none` / `touch-callout: none`, and
  `contextmenu` + `selectstart` are cancelled while held). Needs a phone.
- The /match start button sits below the fold on a phone — the operator
  scrolls to it; unchanged here.
- `MatchVideoCard` returns `null` when recording isn't set up and there are
  no videos — the Video tab needs its own empty-state text.

## Progress log

- [x] Read ControlPage, MatchPanel, MatchVideoCard, MatchControlPage hold code.
- [x] Tabs implemented; tab in URL hash survives reload; Radio tab dot shows link state.
- [x] Overlay implemented; typecheck clean; headless mobile check passed.
- [ ] Real-phone long-press test.

## Open questions for the user

(none yet)

## Things not to do

- Don't put the match panel or E-Stop behind a tab.
- Don't leave the overlay up after robots enable — it would cover E-Stop All.
