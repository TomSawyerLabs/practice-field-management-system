# One Wi-Fi card for the robot scan and the 6 GHz watch

## Goal

Make it trivial to run pFMS's robot Wi-Fi scan and 6 GHz watch on a single
dual/tri-band card (pick the same card in both admin pickers). A card that
lacks a feature's band disables just that feature. Also have the robot scan
listen for `FRC-<team>[-suffix]` on 5 GHz and 6 GHz as well as 2.4 GHz, in
case a robot radio broadcasts there.

User (2026-10-12): "If a card is missing a band, then disable that associated
feature. but otherwise make it trivial to use a single dual/triband card to
do it all. I think you also should scan for FRC-###-\* SSIDs on 5GHz (and even
6GHz) just in case". The radio time lost to sharing (watch blind during a
join, longer scan cycle) was judged a non-issue.

## Environment / context

- Code: `src/robotWifiScan.ts` (robot scan, `WpaSupplicantRunner`,
  `attemptJoin`/`testJoin`), `src/sixGhzWatch.ts`, `src/wifiCards.ts` (admin
  card list + test joins), wiring in `src/index.ts` (~line 471–633), types in
  `src/types.ts` (`RobotWifiScanState`, `SixGhzWatchState`, `WifiCardInfo`),
  admin UI in `frontend/src/components/AdminPage.tsx`, docs
  `docs/robot-tester.md` (Robot Wi-Fi scan + 6 GHz watch sections).
- steamboat cards: `wlp0s20f3` Intel AC 9560 (2.4 + 5 GHz, robot scan) and
  `wlx90de80351083` MT7921AU (2.4/5/6 GHz, 6 GHz watch).
- steamboat has **no `iw`** (checked 2026-10-12: `iw: command not found`), so
  a card's bands can't be read before pFMS runs wpa_supplicant on it.
- Earlier plans: `plans/robot-wifi-scan.md`, `plans/competing-ap-6ghz-watch.md`,
  `plans/admin-wifi-cards.md`.

## Decisions already made (don't re-ask)

- Same card may be picked for both jobs; no separate "one card" setting.
- A band the card lacks disables only the feature needing it: robot scan
  needs 2.4 GHz; 6 GHz watch needs 6 GHz. Robot scan's 5/6 GHz are extras,
  scanned when the card has them.
- **One scan loop per card** (`src/wifiCard.ts`): the card scans the union of
  the bands its jobs want and hands every result to every job; joins
  (passphrase checks, staff test joins) borrow the radio through a lock, so
  scans wait for them. Avoids two jobs scanning 6 GHz twice.
- Bands come from the card's own wpa_supplicant (`get_capability freq`, after
  the country is set) and are remembered per card for the admin picker. An
  unknown card is assumed capable until pFMS has run it. (No `iw`.)
- The Wi-Fi country (`wifiCountry`, default US) now applies to every card
  pFMS runs, not only the watch's — the robot scan's 6 GHz needs it too.
- Staff test joins work on any running pFMS card, the watch's included (the
  join borrows the radio; the watch's own scanning still never joins).

## Plan / steps

1. `src/wifiCard.ts`: `WifiCard` (runner, status, country, freqs/bands, scan
   loop, radio lock, join + testJoin, line routing) and `WifiCardPool`.
   Band helpers (`bandOf`, `parseCapabilityFreqs`). Tests.
2. Rework `RobotWifiScanner` and `SixGhzWatch` into jobs on a `WifiCard`
   (attach/detach instead of runner start/stop; ingest from the card's scan;
   band problem → `problem`). Robot scan wants 2.4/5/6. Update tests.
3. Types: `RobotWifiScanState.problem`, `WifiCardInfo` (`use: 'pfms'`,
   `jobs`, `bands`), `WifiBand`.
4. `wifiCards.ts`: classify with jobs + known bands; test joins via the
   card. `index.ts`: pool wiring, drop the "can't be the robot scan's card"
   refusal, country to all cards.
5. Frontend admin: card chips, pickers (both allow the same card; disabled
   for missing band), wording, robot scan problem alert, 5 GHz channel label.
   Team/CSA wording that says "2.4 GHz network" stays (still the main one).
6. Docs (`docs/robot-tester.md`), checks, commit.
7. Deploy is a separate step — ask first.

Current step: done — committed `af79f1a`, deployed `c6dfb5e`; both jobs on `wlx90de80351083` since 2026-10-13 11:09.

## Findings / gotchas

- wpa_supplicant only reports `CTRL-EVENT-SCAN-RESULTS` on the control
  socket, so scans still wait a fixed settle time — now sized by channel
  count (`scanSettleMs`: 200 ms per channel, at least 5 s; a tri-band
  card's ~100 channels ≈ 20 s), then a 10 s rest.
- `get_capability freq` skips disabled channels, so 6 GHz shows only once the
  country is applied; read it each cycle (cheap) rather than once.
- Bands for a card pFMS has never run are unknown (no `iw` on steamboat),
  so the pickers allow it and the job reports a missing band once it runs.
  Known bands are in-memory only (re-learned at startup from configured cards).
- `fmsServer.test.ts` fails on this Windows machine with `listen EACCES
127.0.0.1:28038` (excluded port range) — environmental, unrelated.
- The pre-commit hook typechecks the whole worktree, so two threads with
  half-staged work in one tree block each other's commits. Here the E-stop
  thread's staged work and this one's deadlocked; it was verified standalone
  in a scratch worktree, then committed normally once the other thread
  landed `341c1ef`.

- steamboat's `NRestarts` climbs by one per deploy: the graceful reload is
  SIGHUP → exit → `Restart=always`. Not a crash; match each "Scheduled
  restart job" with a "Deploy announcement posted" line.

## Progress log

- [x] 1 `src/wifiCard.ts`: WifiCard + WifiCardPool, band helpers, tests (`src/wifiCard.test.ts`)
- [x] 2 RobotWifiScanner / SixGhzWatch are jobs on a card; robot scan wants 2.4/5/6
- [x] 3 types (`WifiBand`, `WifiCardJobName`, `WifiCardInfo.use: 'pfms'` + `jobs` + `bands`, robot `problem`)
- [x] 4 wifiCards classify by jobs + bands, test joins via the card; index pool wiring
- [x] 5 admin page: job chips, band notes, robot problem alert, channel per robot heard
- [x] 6 docs (`docs/robot-tester.md` "One card or two", `docs/configuration.md`), typecheck, tests — committed `af79f1a`
- [x] 7 deployed `c6dfb5e` 2026-10-12 23:38: `wlp0s20f3` 38 channels (2.4: 13, 5: 25), `wlx90de80351083` 98 (2.4: 11, 5: 28, 6: 59), watch learned the field AP's addresses, no scan errors. Optional next: both jobs on `wlx90de80351083` (a setting change on steamboat — needs the user's OK)
- [x] 8 both jobs on the MT7921AU (user's go-ahead 2026-10-13): steamboat
      `setup-config.json` `robotWifiInterface` `wlp0s20f3` → `wlx90de80351083`
      (backup `setup-config.json.bak-20261013-110844`), `./update.sh force` at
      11:09 with the field idle. One pFMS wpa_supplicant on the card, 98
      channels, the watch learned the field AP's addresses on the first
      combined scan, no scan errors. The AC 9560 (`wlp0s20f3`) is free again.

## Open questions for the user

None.

## Things not to do

- Don't install `iw` (or anything) on steamboat without per-change approval.
- Don't stage other threads' changes in `src/types.ts` / `src/matchEngine.ts`.
