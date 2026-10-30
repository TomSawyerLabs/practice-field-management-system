# Backend Internals

How the backend starts up, applies configuration, and survives restarts.
For the match state machine see [match-system.md](match-system.md); for
the network model see [network.md](network.md).

## Startup Sequence

1. **Bring up the trunk** (`bringUpTrunk`, `src/trunkInterface.ts`) — if
   a trunk interface is set (setup wizard, else `VLAN_INTERFACE`):
   - **Check system tools** — `iptables`, `arping`, `fping`, `dnsmasq`,
     `conntrack` and `tcpdump` must be on the PATH, **regardless of
     firmware mode** (firmware mode isn't known yet). A missing tool, or
     a NIC that doesn't exist, doesn't stop pFMS: it starts without a
     field network, the setup wizard shows why, and the bring-up is
     retried every 30 s.
   - **Set the link up and check interface IPs** — field control must
     carry `10.0.100.5` (the FMS address); it is **added if missing**. By
     default that's the bare trunk interface (field control is the
     native/untagged VLAN). With a field-control interface set (setup
     wizard, else `FIELD_CONTROL_INTERFACE`), it goes there instead. A
     missing `<nic>.<VLAN ID>` is created as an 802.1Q sub-interface,
     unless the VLAN ID is a team station's on the trunk. Teardown takes
     the address off but leaves that interface in place.
   - **Flush or preserve network rules** — on a fresh start, flush stale
     iptables rules and per-station route tables from a previous run. On
     a graceful reload, skip the flush to preserve existing rules (see
     [Graceful Reload](#graceful-reload)).
   - **Enable IP forwarding**, the no-hairpin rule, and neighbour-table
     sizing.

   Changing the trunk in the setup wizard tears the old one down
   (`tearDownTrunk`: station VLANs and bridges, the field-control address,
   every pFMS rule) and runs the same bring-up on the new NIC, then
   restarts the packet capture and mDNS reflector and re-commits the
   stations — no restart. It waits while a match is running.

2. **Connect to radio (background)** — poll `GET /status` on the radio
   URL (setup wizard, else `RADIO_URL`, else `10.0.100.2`). Does **not**
   block startup. The RadioManager detects the firmware mode from the
   status `version`, again whenever it changes; a radio URL changed in
   the wizard is switched to at once.
3. **Start RadioManager** — begins polling `GET /status` every 100 ms to
   track radio state and station connections.
4. **Start match engine** — initializes the match state machine with a
   200 ms heartbeat for joined stations.
5. **Start match audio** — detects an available audio player (aplay,
   paplay, ffplay, mpv, play, afplay) and loads sound files from
   `sounds/`.
6. **Start WebSocket server** — listens on `WEBSOCKET_PORT` (default
   3000), broadcasts radio status to connected frontend clients.
7. **Start subnet scanner** — periodic `fping` sweeps of each configured
   team's subnet (see [Device Discovery](network.md#device-discovery)).
8. **Start the FMS server** (TCP 1750, UDP 1160 on `10.0.100.5`) — there is
   no switch for it: it starts whenever field control's address is on this
   machine, and follows the field network — stopped before a trunk
   teardown, started again once the trunk is back. Without the address it
   logs `Bind to 10.0.100.5 to enable FMS server` and pFMS carries on.
   DS telemetry, drive sessions and holding Wi-Fi changes while robots are
   enabled run either way.
9. **Start optional services** — syslog server, scheduled configuration
   clearing (cron).
10. **Restore in-memory state** — on graceful reload, restores DNAT rules
    from kernel iptables, previous station config from the radio manager,
    and route preferences from kernel `ip rule` entries.

## When a Team is Configured

A frontend client sends a WebSocket message with
`{ station, ssid, wpaKey }`:

1. **WebSocket receives message** — `websocketServer.ts` validates the
   message and calls `radioManager.configure(station, { ssid, wpaKey })`.

2. **Wait, defer, or commit** — the server decides when the radio changes:
   - **Waits** on the pending list (`staged-config.json`, an ordered list
     of enable/release changes named by robot) while a match is running,
     while one is set up or just over (unless `holdRadioChangesForMatch`
     is off — the match page's switch, `matchHoldWifi`), the admin "Hold
     Wi-Fi changes" box is ticked, or other changes are already waiting.
     Adding a change
     simplifies the list: a later change about the same robot overrides an
     earlier one, and release-then-enable cancels out. The list reaches
     the radio only when staff press **Apply now** on the match or admin
     page (`applyConfig`): it is reconciled against the active config,
     enables are placed on free stations, and one commit follows. When a
     match ends a release is queued for every robot on the field; joining
     the next match or asking again withdraws it (`releaseAfterMatch`
     setting). A set-up match nobody joins cancels itself after 10 minutes
     (`SETUP_AUTO_CANCEL_MS`); a team page can cancel an empty one early
     with `stationClearEmptyMatch` (`matchEngine.clearEmptySetup()`, refused
     once anyone has joined). However a set-up match is cancelled — those
     two or staff's `matchCancel` — `setupCancelledHook` then applies the
     waiting enables only (`applyPendingJoins()`); releases keep waiting
     for staff. Robot link transitions on the radio are logged
     (`Robot linked to the field radio` / `Robot dropped off the field
radio … after Nm`).
   - **Deferred** while any robot is enabled: the change is applied to the
     active config straight away, but `commitConfiguration()` waits and
     re-runs as soon as the last robot is disabled. "Enabled" means a DS
     reported enabled in the last 5 s (`ENABLED_REPORT_STALE_MS`): a DS
     unplugged while enabled never sends the disabled report, so its last
     one ages out, and a 5 s timer retries the deferred commit.
   - Otherwise `commitConfiguration()` fires immediately.

   Clients are told what is waiting and why (`pendingCommitState`: the
   list, a per-station summary of it, the hold reason, deferred changes),
   so a team sees "waiting for the match admin" rather than nothing.

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
   - **Teardown of the old team is best effort** — each step that fails
     (typically `iptables -D` of a rule that is already gone) is logged as
     a warning and the new team is set up anyway.
   - **Each station stands alone** — one that fails to set up is reported
     (`Network setup for slot1 (team …) failed`), doesn't stop the rest,
     and is torn down and set up again on the next pass even if its team
     is unchanged. The pass as a whole still rejects, so the commit shows
     as failed.
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
   - **One push at a time** — every POST (commits, the startup syslog IP,
     clear-all) is queued through `enqueueRadioPush()`, so a push that
     arrives mid-reconfigure waits its turn instead of being dropped.
   - **Diagnosing** — `curl -s http://10.0.100.2/status` from the field
     server. `stationStatuses.<station> = null` means the station is not
     configured on the radio, whatever `active-config.json` says: that
     file is written even when the radio push fails.

5. **Result** — the robot connects to its team's SSID, gets a DHCP lease
   from the AP (PRACTICE) or the pFMS host (OFFSEASON), and is reachable
   at `10.TE.AM.x` from laptops on the site network.

## Robot Telemetry

Per-station robot telemetry (battery voltage, CPU, RTT, lost packets, CAN
utilization, brownout/e-stop/enabled flags, robot-code status) is parsed
from the FMS DS status messages (`src/telemetryManager.ts`) and broadcast
to frontend clients, throttled per station.

In addition, `src/robotPacketCapture.ts` runs `tcpdump` on UDP ports 1150
(the RIO→DS reply port) and 1110 (DS→RIO control) and parses the payloads
directly. This recovers battery voltage and robot status straight from the
robot's own packets, counts the DS's joysticks, and feeds the same telemetry
pipeline. It restarts automatically if `tcpdump` exits.

The DS's own status (trip time, lost packets, CPU) only arrives while the DS
is under FMS control, so the capture also times the robot's link itself
(`RobotLinkTimer`): the roboRIO answers each control packet with the same
sequence number, so pairing them gives the field→robot→field round trip
(`robotLinkRttMs`, median over ~2 s) and the share of control packets left
unanswered within 1 s (`robotLinkLossPct`, over ~5 s). It covers the robot's
Wi-Fi leg, not the laptop's, and works out of a match.

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

## WebSocket Topic Subscriptions

On connect, `/ws` sends the small, page-wide state (match, scores, radio,
setup, support, …). The big or growing states are **topics**
(`TOPIC_MESSAGE_TYPES` in `src/types.ts`): `matchHistory`,
`practiceRecording`, `usage`, `timelapse`, `savedTeams`. They are not sent
on connect, and their broadcasts go only to sockets that subscribed
(`src/topicSubscriptions.ts`, routed in `broadcast()`):

```jsonc
{ "type": "subscribe", "topic": "matchHistory", "teams": [5940] } // teams optional
{ "type": "unsubscribe", "topic": "matchHistory" }
```

The server answers a subscribe with the current state, then sends each
change. `teams` narrows `matchHistory`, `practiceRecording` and `savedTeams`
to those teams' entries — a team page asks for its own. Match history goes
over the socket without `scoreTimeline` and `periodBreakdown`; the public
summary page (`/api/public/match/<token>`) is the only reader of those.

In the frontend, the hooks (`useMatchHistory({ team })`,
`usePracticeRecordingState({ team })`, `useSavedTeams({ team })`,
`useUsageState()`, `useTimelapseState()`) subscribe while mounted; the
socket's subscription per topic is the union of what mounted hooks want,
and it is re-sent on every reconnect (as is the admin token).

Measured on the 2026-10-06 data: every page got ~197 kB on connect before;
now most get 6–8 kB, a team's Video tab ~19 kB, `/match` ~48 kB, `/usage`
~33 kB.

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

| Prefix                          | Purpose                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ws`, `/ws/scores`             | App WebSocket; read-only scoreboard WebSocket                                                                                                                                                                                                                                                        |
| `/health`                       | `{ phase, version }` JSON — `update.sh` waits out live matches on `phase`, and skips the reload when `version` (git short hash) already matches the commit being deployed                                                                                                                            |
| `/health/site`                  | Uptime probe: 200 when the backend is up and at least one address of `LAN_URL` serves the internal UI and no address serves something else; refusals and timeouts are tolerated while another address works. Separate from `/health` so a failing check can never unblock `update.sh`'s match guard. |
| `/api/score*`                   | [Scoring API](scoring.md)                                                                                                                                                                                                                                                                            |
| `/api/match-review*`            | [Match review API](scoring.md#match-review)                                                                                                                                                                                                                                                          |
| `/api/recordings*`              | Recorder status, match / practice-run video (Range-capable MP4; `?download=1` for an attachment, `?thumb=1` for a cached JPEG poster frame) and the metadata sidecars — see [match video recording](match-system.md#match-video-recording)                                                           |
| `/api/public/match/<token>*`    | Share-token access to one match: summary JSON, its video files, team avatars. No key or cookie — the token is the credential. Must be reachable without the external-access check (public)                                                                                                           |
| `/api/public/practice/<token>*` | Share-token access to one team's practice day: JSON listing, each video and its `metadata.json`/CSV sidecars, and `/zip` for everything at once — see [practice day links](match-system.md#practice-day-links). Public, like the match route                                                         |
| `/api/firmware*`                | Radio firmware list / upload / download                                                                                                                                                                                                                                                              |
| `/api/team-avatar/:team`        | Cached team avatar PNGs (fetched from the FIRST API)                                                                                                                                                                                                                                                 |
| `/api/video-proxy/*`            | WHEP signaling proxy for the scoreboard video view                                                                                                                                                                                                                                                   |
| `/admin/auth/<token>`           | Sets the external-access cookie from a token URL                                                                                                                                                                                                                                                     |
| `/api/auth/check`               | Proxy access check: `200` for a valid external-access cookie or a client on one of the host's own networks (`src/onLink.ts`), else `401`                                                                                                                                                             |

## Who may send what

Every message a client can send has a line in `MESSAGE_ACCESS`
(`src/wsAccess.ts`), checked once before the server acts on it. A message
missing from the table is refused, so a new one has to be classified.

| Tier        | Who                                                                                       | Examples                                                              |
| ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `anyone`    | Team pages, and anything that stops robots                                                | Join, ready, `station`, `portBridge`, E-Stop, Stop match              |
| `staff`     | Any device that isn't a Driver Station. There is no staff login. An admin login overrides | Create and start a match, kick, force ready, radio programming        |
| `admin`     | An admin login, or anyone until the field has a passphrase, so first-time setup can run   | API keys, score reset, setup settings, restart, cast display controls |
| `adminOnly` | An admin login, always                                                                    | Slack config, audio device, clearing history, deleting recordings     |

`src/wsAccess.test.ts` checks that the table covers everything the server
handles, and follows the frontend's imports to check that a team page sends
nothing gated: a Driver Station laptop runs that page, and it has no login.

## Dry-Run Mode

With the `DRY_RUN` environment variable set, pFMS changes **nothing
outside the machine it runs on** (`src/dryRun.ts`). Reads stay live, so the
UI shows real data; every write is logged as `[dry-run] Would …` and
skipped:

- Host network: VLANs, bridges, addresses, iptables, routes, conntrack,
  DHCP servers — logged, not run
- The field radio: status is polled, but configurations and channel scans
  are never sent
- Robot radios on the test port: no configuration or firmware upload
- Driver Stations: no control packets and no FMS station assignment
- Host Wi-Fi cards: the robot Wi-Fi scan and 6 GHz watch don't start, and
  test joins are refused
- Field lights (timelapse), Slack, web push: nothing is sent; the mDNS
  reflector doesn't start

As a backstop, every non-GET HTTP request to another machine fails. Fakes on
the same machine still get their writes, which is how
`scripts/test-radio-reconcile.ts` exercises the radio against a stand-in on
127.0.0.1.

This matters on the field network: a dev machine there can reach the real
radio, and before 2026-10-12 a dry run would push its own (usually empty)
station config to it, taking every robot off Wi-Fi until the field server
put it back.

This allows development and testing on any OS without root access or a
real network stack.
