# Driver Station laptop Wi-Fi check

When a team's Driver Station laptop drops off the field's Wi-Fi, pFMS can
see that it went quiet but not why. The laptop's own Windows event log
records every disconnect with a reason. The Wi-Fi check collects that and
uploads it to pFMS so field staff, or an agent, can review it afterwards.

## For teams

On the team page, open the **Network** tab and use **Wi-Fi check for this
laptop**:

1. **Download the check.** It saves `pfms-wifi-check.ps1`.
2. In Downloads, right-click it and choose **Run with PowerShell**. On
   Windows 11 that is under **Show more options**.
3. Wait for **Sent to pFMS**, then press Enter.

The check only reads. It changes no settings and never reads Wi-Fi
passwords or saved network profiles. It looks back 24 hours, so running it
after a session still catches the drops.

It prints what it found in the window: how many times the Wi-Fi
disconnected and why, driver errors, sleeps, whether Windows may power the
adapter off, battery power, weak signal, 2.4 GHz, and other network
connections that are up.

If it can't reach pFMS, it saves the report under `%TEMP%` and says where.

## What it collects

| Part                        | Source                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| Wi-Fi connects, disconnects | `Microsoft-Windows-WLAN-AutoConfig/Operational`, with reason text and code   |
| Network changes             | `Microsoft-Windows-NetworkProfile/Operational`                               |
| Errors and warnings         | System log, levels 1 to 3                                                    |
| Sleep, wake, AC/battery     | Kernel-Power 42, 105, 107, 506, 507                                          |
| Adapters                    | driver version and date, power management, advanced properties               |
| Wi-Fi right now             | `netsh wlan show interfaces`, `drivers`, `settings`                          |
| Power plan                  | active scheme and the Wireless Adapter power-saving setting                  |
| Driver Station              | team number from its settings, version, the `.dsevents` files for the window |
| Laptop                      | name, user, model, Windows version, time zone                                |

## Where reports go

`POST /api/diag/wifi-report` stores one JSON file per upload on the pFMS
host:

```
<pFMS working dir>/diag-reports/wifi/<YYYY-MM-DD>/<date>_<time>_team<N>_<ip>.json
```

`DIAG_REPORTS_DIR` moves the base directory. On steamboat that is
`~/practice-field-management-system/diag-reports/`. Each file wraps the
laptop's report with `receivedAt`, `sourceIp`, `teamFromIp` (the team on
the station whose Driver Station spoke from that address) and
`teamFromDriverStation`. `teamFromIp` only works when the laptop reached
pFMS over IPv4: pFMS knows Driver Stations by their IPv4 address, and a
laptop that reaches `pfms.tsl` over IPv6 arrives from its IPv6 address. The
team number set in the Driver Station covers that case, and
`report.addresses` lists the laptop's IPv4 addresses for matching by hand.
The files are owned by root, like everything else the service writes, and
readable by everyone on the host. The journal gets one line per upload:

```
Wi-Fi report <id>: team 840 (10.55.48.12, AHS-ROBOTIC-07), 3 Wi-Fi disconnects in the last 24 h
```

Reports are not served back over HTTP, because they carry laptop and user
names. Read them on the host. Uploads are capped at 16 MB, one every 10 s
per address, and 500 per day.

### Reviewing a report

Times in the report are UTC; `computer.utcOffsetMinutes` gives the
laptop's offset. The fields that answer "why did it drop":

- `report.events.wlanAutoConfig[]` with `id` 8003 is a disconnect.
  `data.Reason` and `data.ReasonCode` say who ended it: the laptop (policy,
  user, driver) or the access point.
- `report.problems[]` is the same summary the team saw on screen.
- `report.dsEvents[]` are the Driver Station's own event files, base64.
  Line their times up with the Wi-Fi disconnects.

Compare against the pFMS journal for the same minutes, and UniFi's system
log for which AP the laptop was on (see the incident note in
`plans/blue-ds-dropout-2026-09-27.md`).

## Why a download and not a one-liner

`powershell -Command "irm <url> | iex"` is the usual way to hand out a
script, but Microsoft Defender blocks that command line as
`Trojan:Win32/Commando.A!ml`. A `.cmd` wrapper around it is blocked the
same way. A downloaded `.ps1` run with **Run with PowerShell** works even
where the execution policy is `Restricted`, because Explorer's command
sets a process-only `Bypass` first. The script is pure ASCII because
Windows PowerShell 5.1 reads a file without a byte-order mark in the local
code page.
