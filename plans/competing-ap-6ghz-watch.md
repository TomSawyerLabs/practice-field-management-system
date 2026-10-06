# 6 GHz watch — warn when another access point uses a team's network name

## Goal

Teams sometimes bring their own access point (a home VH-113, or a spare
radio) as a backup and leave it on. It advertises the same SSID and
passphrase as the field, so the robot radio joins whichever it finds first
— a coin toss, and when it loses, the robot never shows up on the field.

Asked 2026-10-04: "we need a new check and warning if we detect a competing
SSID … if we detect a second SSID configured, we should warn."

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator`, `master`, shared
  working tree (`frontend/public/tomsawyerlabs.svg` is someone else's
  uncommitted change — leave it).
- Robots join the field on **6 GHz** only. The field AP (`10.0.100.2`,
  firmware `VH-109_AP_PRACTICE_1.2.9-02102025`) serves each station's SSID on
  6 GHz, e.g. channel 13 @ 40 MHz on 2026-10-04.
- **Verified 2026-10-04:** a full 2.4 + 5 GHz scan from steamboat's
  `wlp0s20f3` heard **neither** of the two SSIDs the field was serving
  (`8-ubot`, `6036-DELTA`). The field AP does not announce team SSIDs off
  6 GHz, so the existing robot scan card (Intel AC 9560, no 6 GHz) cannot
  do this. `FRC-VH-COMPETITION` heard on 2.4/5 GHz is a **UniFi** site SSID
  (same base MACs as Tom Sawyer Labs / TwillTech / TSL IoT), not a VH radio.
- The user ordered a **USB Wi-Fi 6E adapter**, arriving 2026-10-05; deploy
  and test then.
- steamboat: kernel 6.14, wpa_supplicant 2.10, `wireless-regdb` 2025.07
  (`/lib/firmware/regulatory.db`), `linux-firmware` 20250317 (MediaTek
  mt79xx firmware present). cfg80211 regdomain is **`00` (world)**, which
  has **no 6 GHz** — a country must be set for 6 GHz to work at all.
- Existing pieces reused: `WpaSupplicantRunner` / `parseScanResults`
  (`src/robotWifiScan.ts`), wireless cards admin (`src/wifiCards.ts`),
  robot scan wiring in `src/index.ts` (~line 463).

## Decisions already made (don't re-ask)

- **A second card, its own job** ("6 GHz watch", setting
  `sixGhzWatchInterface`, env `SIX_GHZ_WATCH_INTERFACE`). The robot scan
  stays on the proven AC 9560; if the USB adapter misbehaves the robot scan
  is unaffected, and robot passphrase tests never pause the watch. One card
  cannot do both. Off unless a card is picked.
- **Scan only, never join.** The watch's wpa_supplicant never associates.
- **Country** comes from setting `wifiCountry` (env `WIFI_COUNTRY`,
  default `US`) written into the watch's wpa_supplicant config. This sets
  the host's regulatory domain (`00` → `US`) while the watch runs — needed
  for 6 GHz; in the US it only drops 2.4 GHz ch 12–13, which robots don't
  use here.
- **Scan every 6 GHz channel the card allows** (read with `wpa_cli
get_capability freq`), with `non_coloc_6ghz=1` so the driver doesn't
  skip channels with no co-located 2.4/5 GHz AP. A team AP can be on any
  channel.
- **Classification** (exact SSID match only — the radio joins exact names):
  - SSID the field is serving: BSSes outside the field's channel block
    (channel + width from AP `/status`) are **competing**. Within the
    block, one is presumed the field (strongest), any more are competing.
  - SSID the field isn't serving but a team has saved: **team AP** — warn
    the team to switch it off before connecting.
  - Anything else: shown on the admin page only.
- **Own-AP stall hint** (user, 2026-10-04: "only if the watcher is
  disabled"): when a stalled robot's passphrase check says the field's key
  works, the team page adds "if you brought your own access point … switch
  it off", and the CSA fix asks after it — only while the watch isn't
  watching (`isSixGhzWatching`: running and hearing 6 GHz).
- **Where it shows:** team page (robot list), CSA page issues, admin card
  with the card picker and everything heard on 6 GHz (BSSID, channel,
  signal, hidden ones included) for tomorrow's tuning.

## Plan / steps

1. `src/sixGhzWatch.ts`: pure helpers (6 GHz channel maths, capability
   parse, classify) + `SixGhzWatch` class over `WifiRunner`. Per-interface
   wpa_supplicant config (two cards must not share one file) and optional
   country in `WpaSupplicantRunner`. Tests.
2. Types: `SixGhzWatchState`, settings `sixGhzWatchInterface`,
   `wifiCountry` + validators; `WifiCardInfo.use: 'sixGhzWatch'`,
   `canSixGhzWatch`.
3. Wiring: `index.ts` (start/stop on setting change, field inputs from the
   radio status, saved SSIDs), `websocketServer.ts` (initial state),
   `wifiCards.ts` (card in use by the watch).
4. Frontend: `useSixGhzWatch` hook; `frontend/src/utils/sixGhzWatch.ts`
   wording (+ tests); team page alerts; CSA issues in `fieldIssues.ts`;
   admin card.
5. Docs: `docs/robot-tester.md` section, configuration table, README if
   it lists features.
6. Checks (typecheck, prettier, tests), commit.
7. 2026-10-05: plug in the adapter, deploy, pick it on /admin, verify.

Current step: **7** — built, committed and deployed 2026-10-04 (`cc59c00`);
waiting for the adapter. Tomorrow's checklist:

1. Plug the adapter into steamboat; `ls /sys/class/net` for its name
   (likely `wlx…`), `dmesg | tail` for the driver loading (mt7921u etc.).
2. Deploy (it is in the next deploy; the watch stays off until picked).
3. Pick the card on `/admin` → _6 GHz watch_ (needs the user's OK — it
   brings the card up and sets the host's regulatory domain to `US`).
   Expect "Listening", a channel count (59 if the card allows all of
   6 GHz), and `6 GHz watch on <iface>: N channels at country US` in the
   journal.
4. With a station configured: does the field's SSID appear, on the
   field's channel, marked **Field**? Or as _(hidden)_? Note the field's
   BSSIDs. If hidden, tighten the rule (see Findings).
5. Turn on a VH-113 / spare radio with a configured team's SSID: it should
   show **Competing** on /admin, an error on that team's page, a critical
   issue on /csa — within ~30–40 s. Switch it off: gone within ~2 min.

## Findings / gotchas

- **Live on steamboat 2026-10-05 18:28** (user: "yes"): adapter is a
  MediaTek MT7921AU (`0e8d:7961`, `mt7921u`, firmware 20241106) on USB 3,
  `wlx90de80351083`, MAC `90:de:80:35:10:83`. Turned on by adding
  `"sixGhzWatchInterface": "wlx90de80351083"` to `setup-config.json`
  (backup `setup-config.json.bak-20261005-182807`) + `./update.sh force`.
  Journal: `6 GHz watch on wlx90de80351083: 59 channels at country US`.
  `scan non_coloc_6ghz=1 freq=…` is accepted (no scan failures).
- **The field AP does not hide its SSIDs.** With no stations set up it
  broadcasts `no-team-1` … `no-team-6` on ch 13 (6015 MHz), BSSIDs
  `4a:da:35:b1:24:00`–`0f` (one per slot; all -57 dBm from steamboat).
  The watch now learns the field's address family (first five bytes) from
  those placeholders and keeps it, so a copy on the field's channel is
  caught even when louder; "strongest on the field channel is the field" is
  only the fallback before anything is learned.
- `/sys/module/cfg80211/parameters/ieee80211_regdom` stays `00` — it is the
  boot-time module parameter, not the current domain. The channel count
  (from `get_capability freq`, which skips disabled channels) is the proof
  the country took.
- The site's UniFi APs also broadcast on 6 GHz (Tom Sawyer Labs,
  TwillTech Secure, FRC-VH-COMPETITION on ch 37 and 53) — listed as
  "Other".

- `sixGhzWatch.scanOnce` sends `scan non_coloc_6ghz=1 freq=…`. If
  wpa_supplicant 2.10 rejects `non_coloc_6ghz` (unverified), the journal
  shows `6 GHz watch scan failed` every 30 s — drop the parameter then.
- `country=` in the per-card config plus `wpa_cli set country` at start;
  whether the regdomain actually changes is checked by the channel count
  (`get_capability freq` skips disabled channels). If it stays 0 with a
  6E card, check `cat /sys/module/cfg80211/parameters/ieee80211_regdom`
  and the kernel log for regulatory messages.
- UI checked in a browser against a scratch fake backend (admin card with
  all four kinds and a hidden network, CSA critical + warning, team page
  error alert) on 2026-10-04.
- wpa_supplicant only reports `CTRL-EVENT-SCAN-RESULTS` on its control
  socket, not stdout, so the watch waits a fixed settle time after each
  scan (6 GHz has up to 59 channels; passive dwell ≈ 100 ms each).

## Progress log

- [x] 1 watch module + tests (`src/sixGhzWatch.ts`, 17 tests; runner gets
      a per-card config file and optional country)
- [x] 2 types/settings (`SixGhzWatchState`, `sixGhzWatchInterface`,
      `wifiCountry`; cards get `use: 'sixGhzWatch'`, `canSixGhzWatch`)
- [x] 3 wiring (index.ts, websocketServer.ts, wifiCards.ts)
- [x] 4 frontend (team page alert, CSA issues, admin card; wording tests)
- [x] 5 docs (`docs/robot-tester.md#6-ghz-watch`, configuration table;
      README has no per-feature entry for the Wi-Fi scans, left alone)
- [x] 6 typecheck, prettier, full suite 823/823; committed
- [x] Own-AP stall hint, only while the watch isn't watching
- [x] Deployed `cc59c00` 2026-10-04 22:55 (user: "you can deploy now"). Robot
      scan restarted fine on its new per-card config
      (`/run/pfms-wifi/wpa_supplicant-wlp0s20f3.conf`; the old shared
      `wpa_supplicant.conf` is a harmless leftover in /run). Watch off,
      regdomain still `00`.
- [ ] 7 verify with the adapter (2026-10-05)

## Open questions for the user

None. (Answered 2026-10-04: the stall hint "passphrase is right but the
robot still isn't joining — is your own AP on?" — yes, but only while the
watch can't look: off, stopped, or hearing no 6 GHz. Built.)

## Things not to do

- Don't let the watch join anything, or touch any card but the chosen one.
- Don't install packages on steamboat without approval (`iw` is absent; we
  don't need it — wpa_supplicant sets the country and lists channels).
- Don't run the watch and the robot scan on one card.
