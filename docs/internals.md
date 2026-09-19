# Backend Internals

How the backend starts up, applies configuration, and survives restarts.
For the match state machine see [match-system.md](match-system.md); for
the network model see [network.md](network.md).

## Startup Sequence

1. **Check system tools** — if `VLAN_INTERFACE` is set, verifies
   `iptables`, `arping`, `fping`, `dnsmasq`, `conntrack`, and `tcpdump`
   are on the PATH. **All six are required regardless of firmware mode**
   (the check runs before the radio is reached, so firmware mode isn't
   known yet); any missing tool prints `Missing required tools: …` with an
   `apt install` hint and exits with code 78.
2. **Check interface IPs** — if `VLAN_INTERFACE` is set, verify the
   physical interface carries `10.0.100.5` (the FMS address) and **adds
   it if missing**. Note this is added to the bare parent interface, so
   field control must be the native/untagged VLAN on the trunk. If the
   interface doesn't exist at all, this logs an error and continues.
3. **Flush or preserve network rules** — on a fresh start, flush stale
   iptables rules and per-station route tables from a previous run. On a
   graceful reload, skip the flush to preserve existing rules (see
   [Graceful Reload](#graceful-reload)).
4. **Enable IP forwarding** — `sysctl -w net.ipv4.ip_forward=1` so the
   kernel routes packets between interfaces.
5. **Connect to radio (background)** — fetch `GET /status` from the radio
   at `10.0.100.2`, retrying every 10 s. Does **not** block startup. When
   the radio responds, firmware mode is detected and set on the
   RadioManager.
6. **Start RadioManager** — begins polling `GET /status` every 100 ms to
   track radio state and station connections.
7. **Start match engine** — initializes the match state machine with a
   200 ms heartbeat for joined stations.
8. **Start match audio** — detects an available audio player (aplay,
   paplay, ffplay, mpv, play, afplay) and loads sound files from
   `sounds/`.
9. **Start WebSocket server** — listens on `WEBSOCKET_PORT` (default
   3000), broadcasts radio status to connected frontend clients.
10. **Start subnet scanner** — periodic `fping` sweeps of each configured
    team's subnet (see [Device Discovery](network.md#device-discovery)).
11. **Start optional services** — syslog server, FMS server, scheduled
    configuration clearing (cron).
12. **Restore in-memory state** — on graceful reload, restores DNAT rules
    from kernel iptables, previous station config from the radio manager,
    and route preferences from kernel `ip rule` entries.

## When a Team is Configured

A frontend client sends a WebSocket message with
`{ station, ssid, wpaKey }`:

1. **WebSocket receives message** — `websocketServer.ts` validates the
   message and calls `radioManager.configure(station, { ssid, wpaKey })`.

2. **Stage or commit** — if `stage: true`, the config is saved in memory
   for later batch commit. Otherwise, `commitConfiguration()` fires
   immediately.

3. **Parse team number** — extracted from the SSID (format: `1234-...`),
   used to compute the team subnet `10.TE.AM.0/24`.

4. **Network config and radio config run in parallel** (`Promise.all`):

   **a. Network configuration** (`networkManager.ts` — only if
   `VLAN_INTERFACE` is set):

   Only stations whose configuration has changed are torn down and
   recreated (differential updates). For each of the 6 stations
   (slot1–slot6):
   - **Create VLAN sub-interface** —
     `ip link add link eno1 name eno1.slot1 type vlan id 10` (idempotent,
     skips if already exists with matching config)
   - **Create bridge** — `ip link add name br-slot1 type bridge` (the
     bridge is the L2 anchor — all IP/iptables/routes reference it)
   - **Enslave VLAN to bridge** — `ip link set eno1.slot1 master br-slot1`
   - If a team is assigned:
     - **Remove stale addresses** — removes only IPv4 addresses that don't
       belong to the new team (preserves IPv6 link-local)
     - **Check for conflicts** — `arping` to detect if the IP is already
       in use (OFFSEASON mode only)
     - **Add IP** — `ip addr add 10.TE.AM.254/24 dev br-slot1` (host octet
       configurable via `VLAN_HOST_OCTET`)
     - **Bring up** —
       `ip link set eno1.slot1 up && ip link set br-slot1 up`
     - **Add forwarding rules** —
       `iptables -A FORWARD -i/-o br-slot1 -j ACCEPT`
     - **Add MASQUERADE** —
       `iptables -t nat -A POSTROUTING -o br-slot1 -j MASQUERADE` so guest
       WiFi traffic is NATed to the team VLAN
     - **Add routing table entry** — per-station route for laptop route
       preferences
   - If no team: **bring down** — `ip link set br-slot1 down`
   - **Start DHCP server** _(OFFSEASON only)_ — serves
     `10.TE.AM.100–199`, gateway `10.TE.AM.254`. Skipped in PRACTICE mode
     since the AP handles DHCP (gateway = `10.TE.AM.4`).

   **Physical port bridging** (if `FIELD_PORTS` is configured): when a
   team requests a physical Ethernet port, the port's VLAN sub-interface
   (e.g. `eno1.p201`) is created and added as a second member of the
   station's bridge. Ports are managed at runtime via the team control
   page UI.

   **b. Radio configuration** (`radioManager.ts`):
   - **POST /configuration** — sends
     `{ stationConfigurations: { red1: { ssid, wpaKey }, ... } }` to the
     radio (internal slot names are translated to radio-native
     `red1`–`blue3` at the boundary)
   - **Wait for CONFIGURING** — polls in-memory status until the radio
     enters `CONFIGURING` (2 s timeout)
   - **Wait for ACTIVE** — polls until the radio exits `CONFIGURING`
     (45 s timeout), verifies final status is `ACTIVE`

5. **Result** — the robot connects to its team's SSID, gets a DHCP lease
   from the AP (PRACTICE) or the pFMS host (OFFSEASON), and is reachable
   at `10.TE.AM.x` from laptops on the site network.

## Robot Telemetry

Per-station robot telemetry (battery voltage, CPU, RTT, lost packets, CAN
utilization, brownout/e-stop/enabled flags, robot-code status) is parsed
from the FMS DS status messages (`src/telemetryManager.ts`) and broadcast
to frontend clients, throttled per station.

In addition, `src/robotPacketCapture.ts` runs `tcpdump` on UDP port 1150
(the RIO→DS reply port) and parses the robot→DS payloads directly. This
recovers battery voltage and robot status straight from the robot's own
packets, and feeds the same telemetry pipeline. It restarts automatically
if `tcpdump` exits.

## Usage Tracking

`src/usageTracker.ts` records per-station link sessions (team, first
seen, last seen, end; a session ends after 2 hours without link).
Persisted to `usage-data.json` and surfaced on the `/usage` page.

## Saved Teams

Team WiFi configs (SSID + WPA key) are auto-saved on radio configure,
keyed by SSID (`src/savedTeamStore.ts`, persisted to the
`SAVED_TEAMS_FILE` JSON). Clients receive the saved list with WPA keys
stripped; a hash lets the UI offer a "check passphrase" flow without
exposing the key.

## Graceful Reload

`systemctl reload` preserves network state across restarts:

1. **ExecReload** writes `/run/pfms-keep-network` then sends `SIGHUP`
2. **SIGHUP handler** stops DHCP servers but exits **without** flushing
   iptables, route tables, or ip rules
3. **Systemd restarts** the process (Restart=always)
4. **Startup detects** the flag file (or `KEEP_NETWORK=true`), skips the
   flush, and restores in-memory state from the kernel:
   - **DNAT rules** — parsed from `iptables -t nat -S PREROUTING` so stale
     rules are cleaned up if a DS reconnects with a different IP
   - **Previous station config** — initialized from the radio manager so
     future team changes properly tear down old routes/rules
   - **Route preferences** — rebuilt from `ip rule list` so laptop routing
     choices persist

This means robots stay connected and laptops keep their routing
preferences during service updates.

Hard shutdown (`SIGTERM`/`SIGINT`) performs full cleanup: stops DHCP,
flushes all iptables rules, per-station route tables, and ip rule
preferences.

## Clearing All Configurations

When the cron schedule fires (or manually triggered):

1. All entries in `activeConfig` are deleted
2. `commitConfiguration()` runs with an empty config
3. Radio bug workaround: since the radio rejects empty
   `stationConfigurations`, the code sends a syslog IP update instead,
   which has the side effect of clearing all station configs
4. Network side: all VLAN interfaces are brought down, addresses removed

## HTTP Routes

All HTTP traffic shares the WebSocket server port:

| Prefix                       | Purpose                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ws`, `/ws/scores`          | App WebSocket; read-only scoreboard WebSocket                                                                                                                                                                                                                                                        |
| `/health`                    | `{ phase, version }` JSON — `update.sh` waits out live matches on `phase`, and skips the reload when `version` (git short hash) already matches the commit being deployed                                                                                                                            |
| `/health/site`               | Uptime probe: 200 when the backend is up and at least one address of `LAN_URL` serves the internal UI and no address serves something else; refusals and timeouts are tolerated while another address works. Separate from `/health` so a failing check can never unblock `update.sh`'s match guard. |
| `/api/score*`                | [Scoring API](scoring.md)                                                                                                                                                                                                                                                                            |
| `/api/match-review*`         | [Match review API](scoring.md#match-review)                                                                                                                                                                                                                                                          |
| `/api/recordings*`           | Recorder status and match video downloads (Range-capable MP4; `?download=1` for an attachment) — see [match video recording](match-system.md#match-video-recording)                                                                                                                                  |
| `/api/public/match/<token>*` | Share-token access to one match: summary JSON, its video files, team avatars. No key or cookie — the token is the credential. Must be reachable without the external-access check (public)                                                                                                           |
| `/api/firmware*`             | Radio firmware list / upload / download                                                                                                                                                                                                                                                              |
| `/api/team-avatar/:team`     | Cached team avatar PNGs (fetched from the FIRST API)                                                                                                                                                                                                                                                 |
| `/api/video-proxy/*`         | WHEP signaling proxy for the scoreboard video view                                                                                                                                                                                                                                                   |
| `/admin/auth/<token>`        | Sets the external-access cookie from a token URL                                                                                                                                                                                                                                                     |
| `/api/auth/check`            | Proxy access check: `200` for a valid external-access cookie or a client on one of the host's own networks (`src/onLink.ts`), else `401`                                                                                                                                                             |

## Dry-Run Mode

With the `DRY_RUN` environment variable set:

- Network operations log what they would do but make no OS changes
- DHCP servers are not started _(OFFSEASON mode only — PRACTICE mode
  relies on the AP for DHCP regardless)_
- Radio communication still works normally (it's always live)

This allows development and testing on any OS without root access or a
real network stack.
