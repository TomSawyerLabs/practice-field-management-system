# Robot Network Tester

The robot network tester (`/test`) is a CSA diagnostic tool for verifying individual robot network configurations. It runs on a dedicated network interface, detects connected radios and roboRIOs, and checks their configuration against FRC requirements. It can also program radios and update firmware.

## Setup

Set the `TEST_INTERFACE` environment variable to a dedicated network interface:

```sh
TEST_INTERFACE=eth1       # Dedicated NIC (USB Ethernet adapter, etc.)
TEST_INTERFACE=eno1.10    # VLAN sub-interface on the trunk
```

The interface should **not** be managed by NetworkManager or have any existing IP configuration — the tester manages it entirely.

### Dedicated NIC vs VLAN

- **Dedicated NIC** — a separate physical port. Plug the robot's radio directly into it via Ethernet cable. The tester monitors carrier state to detect when a robot is plugged in/unplugged.
- **VLAN sub-interface** — useful when the robot is connected through the field AP. The VLAN ID must match the station (10 = slot 1 … 60 = slot 6). Link detection is skipped (VLAN link state mirrors the parent and is meaningless), so the tester treats the link as always up and relies on DHCP timeouts and device reachability to detect connections. To create one on the trunk — e.g. for a robot on slot 1 (VLAN 10):

  ```sh
  ip link add link eno1 name eno1.10 type vlan id 10
  ip link set eno1.10 up
  ```

  Then set `TEST_INTERFACE=eno1.10`.

## State Machine

The tester progresses through these phases:

```
disabled ─► link_down ─► link_up ─► dhcp_requesting ─► ready ─► checking ─► complete
                ▲            │                              │         │          │
                └────────────┘ (cable unplugged)            │         └──────────┘
                                                            │         (re-check every 1.5s)
                                                            │
                                                    (VLAN: all devices
                                                     unreachable → reset
                                                     to dhcp_requesting)
```

| Phase             | Description                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `disabled`        | `TEST_INTERFACE` not set                                                                           |
| `link_down`       | Polling carrier state at 5 Hz, waiting for a cable                                                 |
| `link_up`         | Cable detected. Adds `192.168.69.8/24` secondary IP for factory radio detection, starts DHCP       |
| `dhcp_requesting` | Running `dhcpcd --oneshot` to obtain a lease. Retries on failure. Rejects link-local (169.254.x.x) |
| `ready`           | DHCP lease obtained. Team number derived from IP (`10.TE.AM.x` → team TE×100+AM)                   |
| `checking`        | Running diagnostic checks against the radio and roboRIO                                            |
| `complete`        | Checks finished. Re-checks every 1.5 seconds while clients are connected                           |

`dhcpcd` runs with the `resolv.conf` and `hostname` hooks disabled: the tester only needs the leased IP (to derive the team number), so DNS servers and hostnames offered by the lease are never applied to the host. Whenever the tester releases the lease it also runs `resolvectl revert` on the interface, clearing any per-link DNS state left behind by leases acquired before this isolation existed.

### VLAN Reset

On a VLAN interface, if both the radio and roboRIO are unreachable and no factory-default radio is detected, the tester assumes the robot disconnected. It releases the DHCP lease, clears team state, and returns to `link_up` to await the next robot.

## Diagnostic Checks

When a team number is detected via DHCP, the tester runs three groups of checks every 1.5 seconds. The robot controller is identified first (roboRIO or SystemCore), because the radio's SystemCore mode is judged against it:

### Radio Checks

Fetches `GET http://10.TE.AM.1/status` and verifies:

| Check                  | What it verifies                                                                                             | Pass condition                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Radio Firmware**     | Firmware version string                                                                                      | Version starts with `2.0.1` (2026 season)                                                                                                                                                                                                                                                               |
| **Radio SystemCore**   | SystemCore mode                                                                                              | `systemcoreEnabled` matches the controller found: `true` for a SystemCore, `false` for a roboRIO; reported without judgement when no controller was found (skipped if firmware outdated)                                                                                                                |
| **Radio QoS BW Limit** | "Enable QoS BW Limit" checkbox (`qosEnabled`) and the robot's current `bandwidthUsedMbps` on its linked band | The checkbox is reported, never judged — both settings pass. The **warn** comes from the bandwidth: limiter on, from 90% of the ~4 Mbps cap (the robot is being throttled now, the cause of lag/dropouts); limiter off, only once usage is over the cap (nothing throttles it here, but an event will). |
| **Radio Team**         | Team number reported by radio                                                                                | Matches DHCP-derived team number                                                                                                                                                                                                                                                                        |
| **Radio mDNS**         | `radio.local` resolves via multicast DNS                                                                     | Resolves to `10.TE.AM.1`                                                                                                                                                                                                                                                                                |

### Robot Controller Checks

Probes the NI SysAPI endpoint at `http://10.TE.AM.2/nisysapi/server` (POST request) for a roboRIO. If nothing answers, the same addresses get a **unicast** mDNS query for `_SystemCore._tcp` — a SystemCore answers with an SRV record (`robot.local`, port 1740) and its A record. Unicast matters: a robot behind its radio does not reliably receive multicast from the wired side.

For a **SystemCore**:

| Check                | What it verifies                        | Pass condition                                                      |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| **Robot Controller** | A SystemCore answered the service probe | Always pass when found (reports hostname and port)                  |
| **SystemCore IP**    | Address the SRV/A records point at      | Equals `10.TE.AM.2` (the static IP WPILib recommends for field use) |
| **SystemCore mDNS**  | Its hostname resolves via multicast DNS | Resolves to the SystemCore's IP                                     |

If neither answers, a single **Robot Controller** error is reported.

For a **roboRIO**, the XML response is parsed to extract system properties:

| Check                | What it verifies                                    | Pass condition                   |
| -------------------- | --------------------------------------------------- | -------------------------------- |
| **roboRIO Hostname** | `TAG_HOSTNAME` (101F000) property                   | Matches `roboRIO-TEAM-FRC`       |
| **roboRIO IP**       | `TAG_IP_ADDRESS` (D107000) from eth0 bag            | Equals `10.TE.AM.2`              |
| **roboRIO Image**    | `TAG_IMAGE_VERSION` (D15C000) property              | Contains `2026`                  |
| **roboRIO Team**     | Team number extracted from hostname                 | Matches DHCP-derived team number |
| **roboRIO mDNS**     | `roboRIO-TEAM-FRC.local` resolves via multicast DNS | Resolves to `10.TE.AM.2`         |

The roboRIO probe has a longer timeout (3s vs 1.5s) because the NI SysAPI is slower than the radio's HTTP server.

### Control System Policy (optional)

A field can state which robot control system it wants, from **Admin → Robot
control system**. Default is **No preference**, which adds nothing to the
checks. The other modes add a **Control System Policy** check:

| Mode                    | roboRIO robot                                                  | SystemCore robot                   |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------- |
| No preference (default) | no check                                                       | no check                           |
| Encourage SystemCore    | **warn** — allowed, but told the field is moving to SystemCore | pass                               |
| SystemCore only         | **fail** — told to see field staff                             | pass                               |
| No SystemCore           | pass                                                           | **fail** — told to see field staff |

The two block modes are enforced, not just reported: pFMS refuses to enable a
blocked robot **in a match and out of one**. In a match the enable gate skips
it; out of a match the field keeps its Driver Station under field control and
streams disabled packets, so the team cannot enable locally either. The
station page shows the reason.

Only a **positively identified** control system is blocked. If no controller
answered, nothing is blocked and no policy check is added — a dropped mDNS
probe must never strand a legitimate robot.

### Factory Default Check

Probes `http://192.168.69.1/status` in parallel with the team-IP checks. If the radio responds at the factory IP but **not** at the team IP, the radio hasn't been configured — this produces a **fail** result prompting configuration. If both respond, it's normal (the radio always keeps the factory IP alive as a recovery fallback).

## Handy Addresses

Once a team number is known, the page lists the addresses a mentor reaches for, as links: the radio config page (`http://10.TE.AM.1`, also `http://radio.local` from the robot's network or `http://192.168.69.1` on a factory-fresh radio), the roboRIO web config (`http://10.TE.AM.2`, also `http://roborio-TEAM-frc.local`) or the SystemCore dashboard (`http://10.TE.AM.2/configure`, also `http://robot.local/configure`) depending on which controller answered — both while none has — and the Driver Station's static IP (`10.TE.AM.5`, mask `255.0.0.0`).

The links only answer from the robot's own subnet. A laptop on the guest Wi-Fi gets there while driving that station from its station page (route preference), on a physical field port, or wired straight to the radio; from anywhere else they are a reference to copy, not a click.

## Robot Wi-Fi scan

Separate from `/test`, pFMS can listen for the network every robot radio
broadcasts on 2.4 GHz — `FRC-1234` or `FRC-1234-Suffix` — and compare it
with the robots each team has saved. The field joins the robot on 6 GHz as
`1234-Suffix`, the same name without `FRC-`, so this is the quickest way to
catch a name typed with the wrong capitals, which otherwise just never
connects.

**Setup:** on `/admin` → _Robot Wi-Fi scan_, pick a spare wireless card
(or set `ROBOT_WIFI_INTERFACE`). pFMS runs its own `wpa_supplicant` on that
card, controlled from `/run/pfms-wifi` with `wpa_cli`, and scans 2.4 GHz
every 20 seconds. Nothing else on the host is touched, and the card must
not be used for anything else. Linux only.

**What teams see** on their page, per robot network heard for their team:

- **Matches a saved robot** — a green note.
- **Differs only in capitals** — an error saying the field will never
  connect, with **Add as 1234-Suffix** to save it under the right name.
- **Not saved** — a note with the same **Add as …** button.

**A robot taking too long to join.** When a station is set up for a team's
robot, the radio is up, and the robot still hasn't linked after **60
seconds** (counted from the latest of: the team taking the station, the
radio coming up, the robot last being linked) — and pFMS can hear the
team's `FRC-…` network — the team's page warns that the robot hasn't
joined, and says what pFMS hears:

- **The name the field is set up for** (exactly, or only the capitals
  differ): pFMS tries the passphrase the field is using on the robot's
  network once, by itself, and reports **correct** (so look at the radio:
  still starting, out of range — power-cycle it; and, unless the
  [6 GHz watch](#6-ghz-watch) is listening, is the team's own access point
  on, with the robot joined to it?), **wrong**, or that it couldn't finish. A capitals-only difference is an error on its own: the
  field will never connect, and **Add as …** fixes it.
- **Another name from the team** (e.g. set up for `1234-Comp`, hearing
  `FRC-1234`): a warning with **Add as …**, and no test until the team
  asks.

**Test connection** runs the test again, or for the first time when the
names differ — at most once every 30 seconds per station. A test joins the
robot's network once and leaves straight away: no DHCP, no address, no
retries. Nothing is tried just because a robot is heard. The test uses the
field's own passphrase (the station's set-up, which is what the field is
failing with) on the robot's **2.4 GHz** network, which can be given its
own passphrase when the radio is configured. A team that did that sees
"wrong" even though the field's 6 GHz passphrase may be fine; the wording
says so.

**What CSAs see:** `/csa` lists a robot taking too long to join — critical
when the passphrase is wrong or only the capitals differ, a warning
otherwise, with what to try — as well as a capitals mismatch on any robot
heard (critical) and a robot on the air that its team has not saved (a
note). `/admin` shows every robot network heard, with its signal, what it
is saved as, and the field's passphrase result when there is one.

### Wireless cards and test joins

`/admin` → _Wireless cards_ lists every Wi-Fi card on the pFMS host with
its driver and MAC, and what it is doing:

| Status         | Meaning                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free           | Nothing uses it. It can be picked for the robot scan, or test-join a network.                                                                                    |
| Robot scan     | The robot Wi-Fi scan owns it. Test joins go through the scan's own `wpa_supplicant` (the scan pauses for them).                                                  |
| 6 GHz watch    | The [6 GHz watch](#6-ghz-watch) owns it. It only scans, so no test joins.                                                                                        |
| Testing        | A test join is running on it.                                                                                                                                    |
| In use by host | Another `wpa_supplicant` or `hostapd` controls it, it has an address (other than link-local), or the host's default route goes through it. pFMS leaves it alone. |
| Blocked        | rfkill (software or the hardware switch) has its radio off.                                                                                                      |

The robot-scan and 6 GHz watch pickers show the same status per card and
won't let you pick one the host or the other job is using (a card already picked stays selectable, so it
can be switched off). The list refreshes every 10 seconds.

**Test join** (Free or Robot scan cards, admins only, not during a match,
one at a time): enter an SSID — robot networks already heard are suggested
— and a passphrase if it needs one. pFMS scans every band for it, joins its
strongest access point once, and leaves: association only, no DHCP, no
address, no routes, so the host's networking is untouched. It disconnects
the instant `wpa_supplicant` says the join succeeded or was refused, and the
result says how long that answer took. While pFMS has a card (for the robot
scan or a test) it keeps the card's IPv6 autoconfiguration (`accept_ra`,
`autoconf`) off, and puts it back when it lets go, so a router advertisement
heard in that moment can't leave the card with an address or a route. On a
free card it starts a `wpa_supplicant` just for the test and stops it
afterwards. The
result lists as **Joined**, **Wrong passphrase**, **Not heard**, **Needs a
passphrase**, **No answer** or **Failed** (with wpa_supplicant's reason),
alongside the band and channel, signal, WPA2/WPA3, access point and time
taken. The last ten are kept until pFMS restarts.

The passphrase is used for that one test and never stored, logged or sent
to any page. It reaches `wpa_cli` as the derived WPA2 key in hex, and the
SSID as hex, so no name or passphrase can break the command. WPA3 (SAE)
needs the passphrase itself, so there it cannot contain `"` or `\`.

## 6 GHz watch

Teams sometimes bring their own access point — a home VH-113, or a spare
radio — as a backup, and leave it on. Set up with the same network name and
passphrase as the field, it competes with the field for the robot: the
robot radio joins whichever it finds first, and when that is the team's
own, the robot never shows up on the field. The field announces team
networks only on 6 GHz, so this needs a card that can hear 6 GHz (the
robot scan's card may not; an Intel AC 9560 can't).

**Setup:** on `/admin` → _6 GHz watch_, pick a 6 GHz-capable wireless card
(or set `SIX_GHZ_WATCH_INTERFACE`) — not the robot scan's; one card does one
job. pFMS runs its own `wpa_supplicant` on it and only ever scans: it never
joins anything. Every 30 seconds it scans every 6 GHz channel the card
allows (including channels with no 2.4/5 GHz access point pointing at
them). 6 GHz needs a Wi-Fi country: the watch sets the host's regulatory
domain from _Wi-Fi country_ (`wifiCountry`, `WIFI_COUNTRY`, default `US`).
The kernel keeps one for the whole host, so it applies to every card, and
it stays set after the watch is switched off. Linux only.

**What it looks for** — names match exactly, capitals included, as the
robot radio's do:

- **Competing** — a network name the field is serving right now, from an
  access point that isn't the field. An access point outside the field's
  channel (the AP's own channel and width) is never the field; on the
  field's channel the strongest is taken to be the field and any more
  compete with it. The team's page shows an error ("Another access point is
  broadcasting your robot's network … switch it off"), and `/csa` shows a
  critical issue on that team's station.
- **Team's own AP** — a team's saved robot name while the field isn't
  serving it. Most likely the team's own access point, before they take a
  station: a warning on their page and on `/csa`, to switch it off before
  connecting.

`/admin` lists everything heard on 6 GHz — name (or _hidden_), access
point, channel, signal, and what pFMS made of it — plus how many channels
the card can scan and the field's channel. A card that offers no 6 GHz
channels (it doesn't do 6 GHz, or the country doesn't allow it) is reported
there and on `/csa`. Access points not heard for two minutes drop off.

## Factory Default Radio Detection

A background probe runs every 2 seconds, fetching `http://192.168.69.1/status`. This works because the tester adds `192.168.69.8/24` as a secondary IP on the test interface at link-up, giving it a route to the `192.168.69.0/24` subnet.

When a factory-default radio is detected:

- If no DHCP lease exists yet: shows a "Radio Detected" check result with the radio's firmware version and (if present) team number
- If a configured team number is already detected: the full `checkFactoryDefault()` in the periodic check cycle handles it
- If the radio has a team number but isn't providing DHCP: shows a warning suggesting a network path issue

The factory probe also triggers an immediate DHCP retry if the tester is waiting for a lease — this helps when the radio is slow to start its DHCP server after being plugged in.

## Radio Configuration

The test page can program a radio in `TEAM_ROBOT_RADIO` mode without being on the field management VLAN.

### Flow

1. **Detection** — The tester detects the radio via factory probe (`192.168.69.1`) or DHCP (team IP)
2. **User input** — User clicks "Configure Radio" and enters:
   - Team number (1–25599)
   - 6 GHz WPA passphrase (minimum 8 characters)
   - Optional: 2.4 GHz WPA passphrase (defaults to the 6 GHz key)
   - Optional: SSID suffix (e.g., team number 1234 with suffix "Bot" → SSID `1234_Bot`)
3. **Send** — POST to `http://<radioIp>/configuration` with:
   ```json
   {
     "mode": "TEAM_ROBOT_RADIO",
     "teamNumber": 1234,
     "ssidSuffix": "Bot",
     "wpaKey6": "password123",
     "wpaKey24": "password123",
     "channel": 0
   }
   ```
4. **Reboot wait** — The radio reboots. The tester polls `http://192.168.69.1/status` every 2 seconds (up to 2 minutes), waiting until the radio reports the new team number.
5. **Reset** — On success, the tester kills DHCP, clears all team state, restarts the factory probe and DHCP to pick up the newly configured radio.

### Mutual Exclusion

Radio configuration is mutually exclusive with firmware updates — only one can run at a time. Both stop the periodic health checks and factory probe during their operation and restart them afterward.

### Error Recovery

If configuration fails at any point, the tester:

- Sends an error progress message to the frontend
- Restarts the factory probe
- Restarts health checks (if a team number was detected before the configure attempt)
- Clears the `radioConfiguring` flag

## Firmware Updates

When the radio firmware check fails, the tester can update firmware in-place.

### Flow

1. **Verify** — Confirm radio is reachable, verify WPA key matches current config (SHA-256 hash comparison)
2. **Get firmware** — Retrieve binary from the firmware store (auto-downloads in background when outdated firmware is first detected)
3. **Upload** — POST firmware binary to `http://10.TE.AM.1/api/upgrade`
4. **Wait** — Poll for radio to reboot and come back online
5. **Reconfigure** — Re-apply team configuration (unless "skip reconfigure" was checked)
6. **Verify** — Confirm radio comes back with correct firmware and config

## WebSocket Messages

### Server → Client

| Message type             | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `robotTestState`         | Full tester state: phase, link status, team number, IP, checks array |
| `firmwareUpdateProgress` | Firmware update step, message, progress percentage, elapsed time     |
| `radioConfigureProgress` | Radio configure step, message, progress percentage, elapsed time     |

### Client → Server

| Message type            | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `firmwareUpdateRequest` | Start firmware update (includes WPA key, optional skip-reconfigure flag) |
| `radioConfigureRequest` | Start radio configuration (team number, WPA keys, optional SSID suffix)  |

## Architecture

```
TestPage.tsx (React)
    │
    │ WebSocket
    ▼
websocketServer.ts ──► robotTestMonitor.ts (state machine)
                           │
                           ├─► teamChecker.ts (diagnostic checks)
                           │     ├─ checkRadio()        → GET 10.TE.AM.1/status
                           │     ├─ checkRoboRIO()      → POST 10.TE.AM.2/nisysapi/server
                           │     ├─ checkFactoryDefault()→ GET 192.168.69.1/status
                           │     └─ checkMdns()         → raw mDNS multicast query
                           │
                           ├─► firmwareUpdater.ts (firmware update flow)
                           │     └─ POST 10.TE.AM.1/api/upgrade
                           │
                           └─► configureTeamRadio() (radio programming)
                                 └─ POST <radioIp>/configuration
```

### Key Files

| File                                   | Purpose                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/robotTestMonitor.ts`              | Core state machine: link detection, DHCP, factory probe, check scheduling, firmware update, radio configure |
| `src/teamChecker.ts`                   | Standalone check functions: radio status, roboRIO NI SysAPI, factory default detection, mDNS resolution     |
| `src/firmwareUpdater.ts`               | Firmware update flow: verify, upload, reboot wait, reconfigure                                              |
| `src/firmwareStore.ts`                 | Firmware binary storage and background download                                                             |
| `src/types.ts`                         | Type definitions: `RobotTestState`, `CheckResult`, `FirmwareUpdateProgress`, `RadioConfigureProgress`       |
| `frontend/src/components/TestPage.tsx` | React UI: stepper, check results, firmware update dialog, radio configure dialog                            |
| `frontend/src/hooks/useBackend.ts`     | WebSocket hooks: `useRobotTestState()`, `useFirmwareUpdateProgress()`, `useRadioConfigureProgress()`        |
