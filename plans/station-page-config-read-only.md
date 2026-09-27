# Station page: match configuration is read-only

## Goal

Teams must not be able to change the match's configuration from their
station page (`/`). Editing the format, skip-auto, auto winner, challenge
window, timing, hand-off, and penalty cost belongs only on the match
controller page (`/match`). Teams should still _see_ what is about to run.

## Context

- The shared `MatchTimeline` component (`frontend/src/components/MatchTimeline.tsx`)
  has two modes: progress mode (when `progress` is passed) and config mode
  (when it isn't). Config mode renders the editing controls, all wired to
  `sendUpdateMatchConfig`.
- The station-page panel (`frontend/src/components/MatchPanel.tsx`) renders
  `<MatchTimeline config={config} />` during the `created` phase for joined
  stations, which put it in config mode and exposed every control to teams.
- `/match` (`MatchControlPage.tsx`) renders the same config-mode timeline
  inside its "Match Configuration" card. That one stays editable.
- The backend does not gate `updateMatchConfig` by role. Neither does it
  gate `startMatch`, `pauseMatch`, etc. — the match lifecycle relies on `/match`
  being a staff-only URL by convention, and station pages are unauthenticated
  (docs/match-system.md). So this is a UI fix, consistent with the rest of the
  match controls. Server-side gating would need `/match` to log in first,
  which is a separate design question.

## Decisions already made

- Fix at the component level with a `readOnly` prop rather than deleting the
  timeline from the station page: the bar itself (durations, skip-auto
  shading, shift colouring) is useful context for teams.
- In read-only mode, keep the format bar and add a one-line caption
  describing the settings that the bar alone can't show (auto winner mode,
  challenge timing / hand-off / penalty cost). No inputs at all.

## Steps

1. [x] Find every `MatchTimeline` call site and classify progress vs config.
2. [x] Add `readOnly` to `MatchTimelineProps`; hide the controls and render a
       summary caption instead, in both `OfficialTimeline` and
       `ChallengeTimeline`.
3. [x] Pass `readOnly` from both station-page panels in `MatchPanel.tsx`.
4. [x] Typecheck, prettier, tests. Update docs/match-system.md.
5. [x] Commit.

## Findings

- Only `MatchPanel.tsx` (station page) and `MatchControlPage.tsx` line ~471
  render the config-mode timeline. Admin, scoreboard, and the other
  `/match` uses pass `progress` and were never editable.

## Things not to do

- Don't gate `updateMatchConfig` on admin auth server-side without also
  making `/match` authenticate — it would silently break the controller page.
