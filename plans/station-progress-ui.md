# Per-station radio/firmware progress in test port mode

## Goal

When a radio configure or firmware update runs through a station's test port
mode, show its step-by-step progress in the inline panel on the station card.
`StationTestManager` already receives the callbacks; they were no-ops, so
pressing **Fix** on a passphrase mismatch showed nothing until the settling
banner appeared a minute or two later.

## Decisions

- **Embed progress in `StationTestState`** (`progress?`) rather than add a new
  message type. The on-connect replay of `getAllStates()` then gives a browser
  that loads the page mid-update the current step, and nothing reaches the
  global `firmwareUpdateProgress` / `radioConfigureProgress` handlers that
  `/test` listens to. Those two constructor callbacks on `StationTestManager`
  are gone.
- **A finished step clears when the settling it started ends** (no timer). An
  error stays until the next operation or the end of the session, so it can be
  read.
- **Requests refused before they start also show as errors.** The monitor only
  reports failures once it is under way, so "already in progress", "no WPA key"
  and the dry-run refusal used to reach only the server console. A refused
  second request must not overwrite a running operation's progress.
- **Progress counts as activity**, so a long reboot wait cannot hit the
  5-minute inactivity auto-exit.
- **Progress from a stopped session's monitor is dropped.** `stop()` does not
  abort an operation, so it could otherwise land on a new session.
- **A completed step drops the WPA key results**, since they describe the radio
  before the change. The old mismatch warning sat beside "Radio configured"
  otherwise.
- **The phase indicator's indeterminate bar hides while an operation runs**, so
  only one bar shows.
- **TestPage is untouched**; the inline view has its own small component.

## Findings

- `DRY_RUN` refuses the whole operation at the top of `configureTeamRadio`, and
  the radio addresses (`10.TE.AM.1`, `192.168.69.1`) are hard-coded, so
  `RADIO_URL` does not redirect them. A plain dry run can only exercise the
  refusal path. See the verification section.
- No UI sends `stationFirmwareUpdateRequest`: station firmware updates are only
  reachable over the WebSocket. Logged in `ISSUES.md`.

## Verification

Run on 2026-10-30 in a private headless Chrome against the Vite dev server and
the real `src/index.ts`, with `DRY_RUN=1` and a loopback `RADIO_URL`. A
throwaway preload (not committed) did the following:

- Replaced `fetch` so only loopback worked and `10.12.34.1` / `192.168.69.1`
  went to a fake robot radio. Everything else was rejected, reads included.
- Lifted `DRY_RUN` only for the synchronous start of `configureTeamRadio` and
  `startFirmwareUpdate`.
- Faked the port VLAN and the DHCP lease, which need Linux.

Results, driven by clicks on the station card except where noted:

- Fix, radio rejects: "Radio configuration failed: Radio rejected configuration
  (HTTP 400)…", and Fix is enabled again.
- Fix, success: `sending` 10%, `waiting_reboot` 30%, `complete`. One bar, and
  Fix disabled while running.
- Page reload mid-operation: the current step reappears.
- The success message clears once settling ends, and the old mismatch warning
  is gone as soon as the step completes.
- Firmware update (sent over the WebSocket, as no UI starts it): every step
  from `verifying` 5% to `complete`.
- `DRY_RUN` left in place: "Radio configuration failed: Dry run: the robot
  radio was not configured".
- A separate WebSocket client saw 0 global progress messages, and `/test`
  showed none of the steps.

Not exercised: a real radio, or the real `dhcpcd` lease after a configure.

The two interactive browsers (T3 preview, Chrome extension) hung on this page
while a headless Chrome profile showed it about 94% idle, so the hang was not
traced further and was not caused by the app's CPU use.

## Progress log

- [x] Backend: `StationTestState.progress`, manager handling, index wiring
- [x] Frontend: inline progress, Fix disabled while running
- [x] Tests: `src/stationTestManager.test.ts`
- [x] Docs: `docs/robot-tester.md`
- [x] Browser verification
- [x] Merge to local master

## Things not to do

- Do not push or deploy; the user does one big push after all threads finish.
- Do not change `StationStatus.tsx` (being refactored on
  issues/stationstatus-hooks). None of this needs it.
- Never run this against field hardware.
