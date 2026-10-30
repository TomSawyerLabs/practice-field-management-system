# StationStatus: per-station selectors

## Goal

`ISSUES.md` "Global hook redundancy in StationStatus": `/overview` renders six
`StationStatus` cards and each subscribes to whole global states, so any update
re-renders all six. Make a station's card re-render only when that station's
data changes. Behaviour stays identical. Measure before and after, and verify
in a browser against a local dev server with a fake radio.

## Environment / context

- Branch `issues/stationstatus-hooks`, own worktree. Do not push or deploy;
  finish with an ff-only merge to local `master`.
- `StationStatus` is only mounted by `SlotGroup` on `/overview`.
- `useBackend.ts` keeps module-level `currentX` state, sets it, then dispatches
  a named event on `events`. Hooks copy the event into `useState`.

## Decisions already made (don't re-ask)

- `useStateSlice` in `useBackend.ts` reads the state during render and forces a
  batched re-render only when the slice changed by value. It does not use
  `useSyncExternalStore`, which rendered once per message on a burst: slot 1
  went from 4 to 14 counts per round when that was tried.
- The theme is built once at module scope in `frontend/src/roots/wrap.tsx`.
- `React.memo` is not used. `WrapAll` passes stable `children`, so nothing above
  the cards re-renders them.
- `RoutePreferenceBanner` keeps its global hooks: it is a small leaf that mostly
  returns null, and it does not re-render the card.
- Never point anything at the real radio: fake `RADIO_URL` plus `DRY_RUN`.

## Measurements

Counted with a temporary render counter in `StationStatus`, not committed. The
dev page runs under StrictMode, so one real render counts as two. Measured
2026-10-30 about 10:20 AM PDT (17:20Z) in a browser on `/overview`.

| Feed                                   | Slot   | Before    | After     |
| -------------------------------------- | ------ | --------- | --------- |
| Backend + fake radio, 22.9 s / 23.6 s  | 1      | 364       | 396       |
| Slot 1 is the only one moving          | 2 to 6 | 364 each  | 0 each    |
| Scripted feed, 108 / 105 rounds        | 1      | 4.0/round | 5.0/round |
| 10 global states, only slot 1 changing | 2 to 6 | 4.0/round | 0         |

Page total per round on the scripted feed went from 24 to 5. Slot 1 is about the
same per second on the fake radio (15.9 to 16.8 counts/s) and slightly higher on
the scripted feed.

## Browser verification

- Fake radio: slot 1 counters advanced, charts toggled on and off, and the slot
  5 settings dialog opened and closed. Slots 1 to 6 all rendered correctly.
- Scripted feed: over 84 s "Robot disconnected" moved from 12 to 14 min and
  subnet scan "Last Seen" from 13m to 14m, with 0 re-renders of those cards and
  no `console.error`.
- The fake radio received no POST. The backend's only blocked writes were to
  team roboRIO addresses, stopped by `DRY_RUN`.

## Findings / gotchas

- `WrapAll` called `createTheme()` on every render, so each
  `useReconfigProgress` update handed every `useTheme` consumer a new theme and
  re-rendered all six cards even with selectors in place.
- Time-derived text only stayed fresh because something unrelated re-rendered
  the card: "Robot disconnected (5 min ago)" in `WaitingForRobot`, subnet scan
  "Last Seen", recent-configuration tooltips. An unlinked station's radio data
  never changes, so selectors alone would freeze that text. `useSecondTick` and
  `LiveAge` keep it current.
- The first baseline (0.4 counts/s) was taken while the page was still loading,
  and the scripted baseline before it stalled. Neither is valid. The table above
  is from clean reruns of `HEAD`.
- This machine was heavily loaded during the work: even `netstat` timed out.

## Progress log

- [x] Baseline render counts
- [x] Selectors, per-station hooks, theme at module scope
- [x] Keep time-derived text fresh
- [x] After render counts
- [x] Browser verification
- [x] Typecheck and tests (750 pass, 0 fail), commit, merge to local master

## Things not to do

- No e-stop or `pfms-estop-*` changes.
- Leave `src/robotPacketCapture.ts`, `src/robotLinkWatch.ts`,
  `src/robotDropouts.ts` and `src/robotEStopWatch.ts` alone.
- No real-radio traffic, no steamboat writes.
