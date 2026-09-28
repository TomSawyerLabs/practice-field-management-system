# Robot Wi-Fi scan — see a team's robot before it joins the field

## Goal

Teams get their robot's SSID or passphrase slightly wrong (usually
capitalization) and the field never connects, with no hint why. The robot
radio (VH-109, `TEAM_ROBOT_RADIO` mode) also broadcasts a 2.4 GHz network
named `FRC-<team>` or `FRC-<team>-<suffix>`. If pFMS can hear that, it can
tell the team — and the CSA — what the robot is actually called, and even
whether the passphrase they typed works.

Asked for (2026-09-28), in order:

1. Scan for SSIDs of the form `FRC-###[-suffix]`.
2. Report on the team page, and per team on the CSA page, when one is seen.
3. Check whether it matches one of the team's saved robots.
4. Stronger warning when it only matches case-insensitively.
5. Optional: try joining it with the saved passphrase (first time seen) to
   check the passphrase.

Same request, small UI items: "Save for Later" goes away; the primary
button is **Enable Robot** (was "Enable Wi-Fi"); the add-robot form reminds
teams that capitalization matters.

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator`, `master`, shared
  working tree — other threads have uncommitted work (notably `src/index.ts`,
  `src/utils.ts`); stage only own hunks.
- **steamboat hardware (read-only check 2026-09-28):** Intel Wireless-AC
  9560 (CNVi, `iwlwifi`, firmware 46 loads fine), interface `wlp0s20f3`,
  **DOWN and unused** — no netplan / networkd config for it,
  NetworkManager inactive. `wpa_supplicant` 2.x and `wpa_cli` installed;
  the system `wpa_supplicant` runs D-Bus only (`-u -s -O DIR=/run/wpa_supplicant`)
  with no interface bound. `iw` and `rfkill` are **not** installed.
  Regulatory domain `00` (world): 2.4 GHz ch 1–11 active scan.
- pFMS service `practice-field-management-system` runs as **root** (no
  `User=`), `node dist`, env `/etc/pfms/environment`.
- The field AP's own `/scan` API reports only per-channel aggregates — no
  SSIDs — so it cannot do this.

## Decisions already made (don't re-ask)

- **pFMS runs its own `wpa_supplicant` on the chosen interface** (foreground
  child, private control dir `/run/pfms-wifi`), and drives it with
  `wpa_cli`. One tool does both the scan and the passphrase test, no new
  packages. The child dies with the service (systemd control group).
- **Off unless an interface is chosen.** New setting `robotWifiInterface`
  (admin page picker listing the host's wireless interfaces, env fallback
  `ROBOT_WIFI_INTERFACE`). Bringing a radio up on a host is not something to
  do by surprise. Enabling it on steamboat is the user's call after deploy.
- **Scan 2.4 GHz only** (`scan freq=2412…2472,2484`), every 20 s. Entries
  expire 90 s after last seen.
- **Matching:** strip `FRC-`, compare to the team's saved robot SSIDs
  (`1234`, `1234-Comp`). Exact → OK. Equal ignoring case → **critical**
  ("the field will never connect"). Team number matches but no saved
  robot does → info, offer to add it with the suffix prefilled.
- **Passphrase test:** only for a broadcast that matches a saved robot
  (exact or case-only), once per (broadcast SSID, saved-key hash); re-runs
  when the saved passphrase changes. One test at a time. The network is
  removed right after — no retries, no DHCP, no IP.
  Results: `ok` / `wrongKey` / `unreachable`. Wording must say the check
  used the robot's **2.4 GHz** network: a team who set a separate 2.4 GHz
  passphrase will see `wrongKey` even though the field (6 GHz) key is fine.
- Never send a passphrase to clients; results are keyed by SSID only.
- Full field: the add form's single button saves the robot ("Add robot")
  instead of a second "Save for Later" choice.

## Plan / steps

1. UI wording: Enable Robot, drop Save for Later, capitalization hints. Commit.
2. `src/robotWifiScan.ts` — pure helpers (parse `scan_results`, classify a
   broadcast against saved robots, parse wpa_supplicant event lines) + a
   `RobotWifiScanner` class over an injectable command runner. Tests.
3. Types: `RobotWifiScanState` message, setting + validator.
4. Wiring in `index.ts` (start/stop on setting change, saved-team lookups,
   broadcast) and `websocketServer.ts` (initial state).
5. Frontend: `useRobotWifiScan` hook; team page card + row chip + "add this
   robot" prefill; CSA issues in `fieldIssues.ts` (+ tests); admin card.
6. Docs: `docs/robot-tester.md` or `docs/network.md` section, configuration
   table.
7. Checks, commit.

Current step: **built, tested and committed; waiting on deploy and the go-ahead to turn it on at steamboat.**

## Findings / gotchas

- **Not yet proven on real hardware.** Everything above the runner is unit
  tested; the runner itself (spawning wpa_supplicant under stdbuf, wpa_cli
  output, the event lines) is written from wpa_supplicant's documented
  behaviour and has not run on steamboat. First things to watch on deploy:
  "Robot Wi-Fi scan starting on wlp0s20f3" then the status chip reading
  Listening; `journalctl -u practice-field-management-system | grep "Robot Wi-Fi"`.
- Unverified assumption: the robot radio's 2.4 GHz SSID carries the same
  suffix as the 6 GHz one (`FRC-1234-Comp` ↔ `1234-Comp`). If it turns out
  to be `FRC-1234` only, matching needs to fall back to team number.
- Bun on Windows resolves `/tmp` to a different place than Git Bash does;
  scratch files for bun scripts go in `.git/pfms-scratch/`.
- Committing index.ts from the shared tree: a hunk patch would not apply
  around another thread's reorders. Built the blob as HEAD + my edits,
  `git hash-object -w` + `update-index --cacheinfo` in a temporary index,
  then `git reset -- <paths>` on the real index.

- `wpa_supplicant` in the foreground prints `CTRL-EVENT-*` lines to stdout;
  through a pipe glibc block-buffers them, so spawn under `stdbuf -oL`.
- Wrong key shows as `CTRL-EVENT-SSID-TEMP-DISABLED … reason=WRONG_KEY`
  (and "4-Way Handshake failed - pre-shared key may be incorrect"); success
  is `CTRL-EVENT-CONNECTED`.

## Progress log

- [x] 1 wording — `8141ea0`
- [x] 2 scanner + tests (`src/robotWifiScan.ts`, 15 tests with a scripted
      fake wpa_supplicant)
- [x] 3 types (`RobotWifiScanState`, `robotWifiRecheck`, setting)
- [x] 4 wiring (index.ts, websocketServer.ts)
- [x] 5 frontend: team page card in the robot list with "Add as …" and
      "Check again"; CSA issues via `frontend/src/utils/robotWifi.ts`;
      admin "Robot Wi-Fi scan" card with interface picker and heard list
- [x] 6 docs (`docs/robot-tester.md#robot-wi-fi-scan`, configuration table)
- [x] 7 typecheck, prettier, full suite 686/686 — `f47d00f`
- [ ] Deploy, pick `wlp0s20f3` on the admin page (user's go-ahead), verify
      against a real robot

## Open questions for the user

1. OK to turn the scanner on on steamboat after deploy? It brings up the
   unused Intel card and briefly associates with robots' 2.4 GHz networks
   (no IP). Recommendation: yes.

## Things not to do

- Don't install `iw` or other packages on steamboat without approval.
- Don't let the scanner touch any interface other than the chosen one.
- Don't retry a passphrase test in a loop — robot radios may rate-limit or
  log it; once per key is the rule.
