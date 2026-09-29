# Admin: wireless cards and test joins

## Goal

The admin page should show every wireless card ("network scanner") on the
pFMS host, whether each is in use — by pFMS's robot Wi-Fi scan, or by the
host itself — and, for cards pFMS may use, let staff have the card join an
SSID as a test and see what happened.

Asked 2026-09-29: "Admin interface should show available networks scanners,
and if they're in use or if they can be set to join an SSID for testing."

Builds on the robot Wi-Fi scan (`plans/robot-wifi-scan.md`, `f47d00f`,
deployed in `58d91a8`): pFMS runs its own `wpa_supplicant` on one chosen
card (`robotWifiInterface`) to hear robots' `FRC-<team>` 2.4 GHz networks.

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator`, `master`, shared
  working tree. Only `frontend/public/tomsawyerlabs.svg` is modified by
  someone else at the start of this task.
- steamboat: one card, Intel AC 9560 `wlp0s20f3`, DOWN and unused; the
  system `wpa_supplicant` runs D-Bus only with no interface; no `iw`, no
  `rfkill` tool (sysfs `rfkill*/soft|hard` still readable). pFMS runs as
  root. Scanner not turned on yet (no `robotWifiInterface` set) — that is
  the user's call (robot-wifi-scan plan, open question 1).
- Code: `src/robotWifiScan.ts` (scanner, `WpaSupplicantRunner`,
  `listWirelessInterfaces`), wiring in `src/index.ts` (~line 410),
  admin card `RobotWifiScanSection` in `frontend/src/components/AdminPage.tsx`,
  admin write gate `setupWritesAllowed(ws)` in `src/websocketServer.ts`.

## Decisions already made (don't re-ask)

- **Interpretation** (mine, stated to the user): list cards with their
  status; "can be set to join an SSID for testing" = a **Test join** action
  on cards pFMS may use. A test join only associates — no DHCP, no address,
  no routes — then disconnects, like the scanner's passphrase check. It
  reports connected / wrong passphrase / not found / failed, with the
  BSSID, channel and signal it saw.
- **In use by the host** = another `wpa_supplicant` or `hostapd` control
  socket for the card, a non-link-local address on it, or the default
  route through it. Up-but-idle (only a link-local address) is not "in
  use" — `wpa_supplicant` leaves cards up. Such cards cannot be test-joined
  or picked for the robot scan (a card already chosen stays selectable so
  it can be turned off).
- rfkill-blocked cards (sysfs) are shown as blocked, not usable.
- A card the robot scan owns does its test joins through the scan's own
  `wpa_supplicant` (the scan pauses for it). A free card gets a temporary
  `wpa_supplicant` for the test, stopped afterwards.
- Admin-only (`setupWritesAllowed`), one test at a time, refused while a
  match is running. Passphrases never leave the server or appear in logs;
  test results carry the SSID only.
- SSID is sent to `wpa_cli` hex-encoded (any SSID, no quoting problems);
  a WPA2 passphrase goes as the PBKDF2 PSK in hex. SAE needs the passphrase
  itself, so SAE refuses `"` and `\`.

## Plan / steps

1. `src/wifiCards.ts`: read card facts from sysfs/procfs (injectable root
   for tests), classify use; `attemptJoin` shared with the scanner; a
   `WifiCards` manager that runs test joins and keeps the last results.
   Tests.
2. Types (`WifiCardsState`, `WifiTestJoin` message), wiring in `index.ts`,
   handler in `websocketServer.ts`.
3. Admin UI: cards table with status + Test join form + recent results; the
   robot-scan picker shows each card's status and disables host-used ones.
4. Docs (`docs/robot-tester.md` robot Wi-Fi scan section), checks, commit.
5. Deploy only if the user asks. ← current: deployed; no real test join
   run yet.

## Findings / gotchas

- **Not proven on real hardware.** Everything above `WpaSupplicantRunner`
  is unit-tested against a scripted wpa_supplicant and a fake sysfs; the
  UI was checked in a browser against a dry-run backend on Windows (no
  cards there, so card and scan states were injected over a pass-through
  socket; the real server's refusal path — "not a wireless card on this
  host" — came back through the admin gate). First real use: steamboat's
  `wlp0s20f3` should read **Free (switched off)**; a test join logs
  `Wi-Fi test join on … : <outcome>` to the journal.
- Refactor: the scanner's passphrase check now goes through the shared
  `attemptJoin`, which sends the SSID as hex and a WPA2 passphrase as its
  PBKDF2 PSK (checked against the IEEE 802.11i vector: "password"/"IEEE").
  The scanner used to quote both and refused SSIDs/passphrases outside a
  safe character set; it now accepts any SSID and any printable WPA2
  passphrase.
- Bun `expect(promise).rejects` must be awaited or it is never checked —
  the first run of the refusal tests passed while asserting nothing.
- The admin page is behind the passphrase gate even locally (no passphrase
  set → "Set Admin Passphrase"). For a preview, inject
  `{type:'adminAuthResult', authenticated:true, …}` into the routed socket
  rather than setting a passphrase in the working copy.

## Progress log

- [x] Recon: scanner, runner, admin card, admin gate
- [x] 1 backend module + tests (`src/wifiCards.ts`, 16 tests; scanner
      tests updated and extended to 18)
- [x] 2 types + wiring (`WifiCardsState`, `wifiTestJoin`, admin-gated)
- [x] 3 admin UI (Wireless cards card, Test join dialog, recent results,
      picker shows card status)
- [x] 4 docs (`docs/robot-tester.md` → Wireless cards and test joins)
- [x] Deployed `ade56ed` (2026-09-29 14:31). Live on steamboat: one card,
      `wlp0s20f3` (iwlwifi, 18:cc:18:c6:42:6a), shown as Robot scan /
      "Listening for robots", test join available.
- [x] Round 2 (user, 2026-09-29: "try joining the SSID and then disconnect
      the moment it connects (or is denied)? we don't need to do a full
      DHCP"). It already associated only; tightened: the BSSID now comes
      from the CTRL-EVENT-CONNECTED line, so `disconnect` is the very next
      command after the answer (was: a `status` query first), then
      `remove_network`; the answer time is reported (`joinMs`). Found on
      steamboat: the card had `accept_ra=1`/`autoconf=1`, so an RA heard
      during a join could leave an IPv6 address or default route on it —
      `WpaSupplicantRunner` now holds both at 0 while pFMS has the card and
      restores them on stop (`holdIpv6Autoconf`). DHCP: pFMS's own dhcpcd
      shows as "[manager]" but was started for `eno1.99` only, so it doesn't
      touch the card.
- [ ] First real test join (none run yet)

## Open questions for the user

- None yet.

## Things not to do

- Don't touch any card that is in use by the host.
- No DHCP / addresses / routes on a test join.
- Don't turn the robot scan on at steamboat without the user's go-ahead.
- Don't install packages on steamboat (`iw`, `rfkill`) without approval.
