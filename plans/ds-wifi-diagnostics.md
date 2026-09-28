# Driver Station laptop Wi-Fi diagnostics, collected into pFMS

## Goal

Give teams a one-step way to run a Wi-Fi diagnostic on their Driver Station
laptop, served by pFMS, that uploads what Windows recorded about the laptop's
Wi-Fi to the pFMS backend. An agent later reads the stored reports on
steamboat to work out why DS laptops drop off the Wi-Fi mid-match.

Why: on 2026-09-27 the DS laptops dropped off the Wi-Fi repeatedly
(`plans/blue-ds-dropout-2026-09-27.md`). UniFi proved it was not one AP, not
RF, and DS-laptops-only, but UniFi records no disconnect reason. The laptop's
own WLAN-AutoConfig log does.

## Environment / context

- DS laptops: Windows 10/11, Windows PowerShell 5.1 (no PS7-only syntax: no
  `??`, no ternary, no `-Parallel`). Usually not run as admin.
- pFMS reaches them over the site Wi-Fi at `http://pfms.tsl` (steamboat,
  Caddy in front). Caddy gates `/api/*` for non-local clients with the
  access cookie, so everything lives under `/api/diag/`.
- pFMS's working dir on steamboat is `~/practice-field-management-system`;
  reports land in `diag-reports/wifi/<day>/` there.
- Pieces: `diag/ds-wifi-report.ps1` (collector), `src/diagReportApi.ts`
  (+ test), wired in `src/index.ts`, UI `LaptopWifiCheck` on the team page's
  Network tab, docs `docs/ds-wifi-check.md`, packaged beside the binary by
  `scripts/package-binary.ts`.

## Decisions already made (don't re-ask)

- Delivery: download `pfms-wifi-check.ps1` from the team page, right-click,
  **Run with PowerShell**. Not a one-liner, not a `.cmd` (see Findings).
  No compiled binary: nothing to sign, readable by anyone.
- One-shot, not a resident agent: Windows keeps the event log, so running it
  after a session still captures the drops. Default look-back 24 h.
- Stored one JSON file per upload; not served back over HTTP (laptop and
  user names); reviewed on the host.
- Never collect Wi-Fi keys or profile XML.

## Plan / steps

1. [x] Plan doc.
2. [x] Collector script.
3. [x] API: script (text, `?download` attachment), upload with 16 MB cap,
       10 s per-IP rate limit, 500/day cap, team tag from the station whose
       DS has that IP, else the DS's configured team.
4. [x] Tests (8, `src/diagReportApi.test.ts`).
5. [x] End-to-end on this Windows machine under PowerShell 5.1 against the
       real handler: download with internet-zone mark, Explorer's exact
       "Run with PowerShell" command under `-ExecutionPolicy Restricted`,
       uploaded and stored.
6. [x] UI card on the team page's Network tab (tab no longer needs a robot).
7. [x] Docs + README link + binary packaging.
8. [x] Committed as `048368f` and pushed. Built and verified in a clean
       worktree at HEAD with only these changes (typecheck, tests, prettier,
       frontend build), then fast-forwarded `master` with a compare-and-swap.
9. [x] Deployed `7234307` to steamboat 2026-09-28 13:54:55 on the user's
       go-ahead, with the 20 other sessions' commits it carried. Discarded
       steamboat's one-line `"configVersion": 0` bun.lock change first
       (backup in `/tmp/bun.lock.steamboat-*`). Verified: `/health` and the
       frontend bundle both `7234307`; the script from `pfms.tsl` carries
       `$Server = 'http://pfms.tsl'`; a real download from this desktop, run
       with Explorer's command under Restricted, uploaded through Caddy and
       was stored and journaled. That test report was then deleted. Zero
       Defender detections.
10. [ ] **Current step:** ask a team with drops to run it; review the first
        real reports under `~/practice-field-management-system/diag-reports/wifi/`.

## Findings / gotchas

- **IPv6 arrivals get no `teamFromIp`.** The live test came from
  `2600:1700:459:8a1f:…` because the laptop reached `pfms.tsl` over IPv6;
  pFMS's station → DS map holds IPv4 addresses, so `teamFromIp` was null.
  The DS's own team number (from its settings file) covers it; teams'
  laptops without the DS installed show as `teamunknown`. A possible fix is
  to match the report's `addresses[]` (the laptop's IPv4s) instead of the
  source address. Not built.
- Report files are root-owned (the service runs as root): reading is fine,
  deleting needs `sudo`.

- **Concurrent sessions clobber `src/index.ts`.** While this was being
  built, another session's commit routine (sync worktree to staged, restore)
  dropped this work's hunks from the working tree, and a third session later
  re-added them in a different order. Committing from a clean worktree at
  HEAD sidestepped it.

- **Defender blocks `irm <url> | iex`.** Running
  `powershell -NoProfile -Command "irm 'http://127.0.0.1:18765/api/diag/wifi.ps1' | iex"`
  on this machine was detected as `Trojan:Win32/Commando.A!ml` (Defender
  events 1116 at 13:04:36 and 13:04:50, 2026-09-28) and the process launch
  failed with "Access is denied". A `.cmd` wrapper around the same command
  line is the same thing. Plain `powershell.exe` launches kept working.
- **Run with PowerShell beats Restricted.** Control: a MOTW'd script under
  `-ExecutionPolicy Restricted` is refused ("running scripts is disabled").
  Explorer's command (`if((Get-ExecutionPolicy) -ne 'AllSigned') {
Set-ExecutionPolicy -Scope Process Bypass }; & '<file>'`) under the same
  policy ran it and uploaded. No Defender detection.
- `iex` of a script with a top-level `param()` block works fine in 5.1 (it
  was tested before the one-liner was dropped).
- Launching 5.1 from a PowerShell 7 parent leaks PS7's `PSModulePath`, so
  `Get-ExecutionPolicy` fails to autoload. Test harness artifact only; reset
  `PSModulePath` to the machine value when testing.
- The script must stay pure ASCII: 5.1 reads a BOM-less file in the local
  code page. The server also sends it with CRLF.
- Windows' disconnect reason comes through structured:
  `data.Reason` and `data.ReasonCode` on event 8003 (this desktop's own:
  "disconnected due to a policy disabling auto connect", code 5).
- Reading the WLAN-AutoConfig log as a non-admin user is untested (this
  machine's shell is admin). The script records any read error in
  `report.errors` rather than failing.

## Progress log

- [x] Built, tested, end-to-end verified locally
- [x] Committed and pushed (`048368f`)
- [x] Deployed `7234307` (2026-09-28 13:54) and verified end to end through Caddy
- [ ] First real report reviewed

## Open questions for the user

1. Worth making `teamFromIp` work for laptops that arrive over IPv6, by
   matching the report's IPv4 addresses? My recommendation: only if real
   reports come in untagged; the DS's own team number covers most laptops.

## Things not to do

- Don't reintroduce a copy-paste `irm | iex` one-liner or a `.cmd` wrapper
  around one: Defender blocks it on the team laptops.
- Don't put non-ASCII characters in `diag/ds-wifi-report.ps1`.
- Don't upload through `readBody` from `httpApiUtils`: it caps at 64 KB.
- Don't send a PowerShell 5.1 string body without an explicit UTF-8 byte
  encoding: 5.1 encodes string bodies as ISO-8859-1.
