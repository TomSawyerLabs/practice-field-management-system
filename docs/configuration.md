# Configuration Reference

All configuration is via environment variables. In production they live in
`/etc/pfms/environment` (one `KEY=value` per line) and take effect on
service restart — no `systemctl daemon-reload` needed.

> **`.env` is development-only.** A `.env` file in the repo root is picked
> up by `bun run dev`/`bun run start` because bun loads it automatically.
> The production systemd unit runs `/usr/bin/node dist`, which does **not**
> read `.env` — the app has no dotenv dependency. Anything you need in
> production (including `FIRST_API_USERNAME` / `FIRST_API_AUTH_TOKEN`)
> must go in `/etc/pfms/environment`, or team avatars will silently be
> disabled.

## Core

| Variable         | Default             | Description                                                                                                                                                                                                                                            |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WEBSOCKET_PORT` | `3000`              | Port for the WebSocket + HTTP server. The reference deployment runs on `9005`.                                                                                                                                                                         |
| `RADIO_URL`      | `http://10.0.100.2` | URL for the radio management API                                                                                                                                                                                                                       |
| `WEB_ROOT`       | `frontend/dist`     | Built frontend the backend serves itself. Point elsewhere, or at a missing directory, to disable static serving and let a proxy handle it.                                                                                                             |
| `DRY_RUN`        | _(unset)_           | Set to any value to disable network operations (log-only mode for development)                                                                                                                                                                         |
| `LAN_URL`        | _(none)_            | URL devices on the field network use to open pFMS, e.g. `http://pfms.tsl/`. When set, `/health/site` fetches it on every address the name resolves to and returns 503 if any of them serves the public-only page — the check behind uptime monitoring. |

## Networking

| Variable                  | Default  | Description                                                                                                                           |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VLAN_INTERFACE`          | _(none)_ | Physical network interface for VLAN configuration (e.g., `eno1`). Required for routing.                                               |
| `VLAN_HOST_OCTET`         | `254`    | Host octet for the pFMS host's IP on each team VLAN (range: 220–254)                                                                  |
| `FIELD_PORTS`             | _(none)_ | Physical port bridging config: `VLANID:Name,...` (e.g., `201:Port A,202:Port B`). Requires `VLAN_INTERFACE`.                          |
| `IPTABLES_COMMENT_PREFIX` | `pfms-`  | Prefix for iptables rule comments (used to identify and flush rules)                                                                  |
| `KEEP_NETWORK`            | `false`  | Set to `true` to skip the startup network flush (same effect as the `/run/pfms-keep-network` flag file written by `systemctl reload`) |
| `MDNS_REFLECTOR`          | `false`  | Set to `true` to enable the mDNS reflector (bridges `.local` queries between main network and team VLANs). Requires `VLAN_INTERFACE`. |
| `MDNS_EXCLUDE_REQUESTERS` | _(none)_ | Requester IPs excluded from mDNS reflection                                                                                           |
| `MDNS_LISTEN_INTERFACES`  | _(none)_ | Extra interfaces the mDNS reflector listens on (comma/space separated)                                                                |
| `TRUSTED_PROXIES`         | _(none)_ | Comma-separated trusted proxy IPs/CIDRs for real client IP detection (see below)                                                      |

## FMS Protocol

| Variable                 | Default   | Description                                                                                                                                                                      |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FMS_ENDPOINT`           | `false`   | Set to `true` to enable the FMS server (TCP/1750 + UDP/1160)                                                                                                                     |
| `FMS_TCP_REPLY_STATIONS` | _(none)_  | Experimental: stations whose DS gets the FMS TCP station-assignment reply outside a match (`slot1,slot2` or `all`). For testing whether a TCP-only reply locks out local enable. |
| `FMS_LOG_DS_MESSAGES`    | _(unset)_ | Set to log verbose per-message DS TCP/UDP hex dumps (debugging)                                                                                                                  |
| `SYSLOG_ENDPOINT`        | `false`   | Set to `true` to enable the syslog server (radio log collection)                                                                                                                 |

## Robot Tester

| Variable         | Default  | Description                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `TEST_INTERFACE` | _(none)_ | Network interface for the robot tester CSA tool (e.g., `eth1`). See [robot-tester.md](robot-tester.md). |

## Scheduling

| Variable               | Default  | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `RADIO_CLEAR_SCHEDULE` | _(none)_ | Cron expression for scheduled configuration clearing (e.g., `0 6 * * *`) |
| `RADIO_CLEAR_TIMEZONE` | _(none)_ | Timezone for scheduled clearing (e.g., `America/Los_Angeles`)            |

## Scoring & Scoreboard

| Variable                         | Default                             | Description                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCORING_AUTO_REGISTER_LIMIT`    | `1`                                 | Max scoring elements auto-registered from incoming events. Set to `0` to require explicit configuration via the API.                                                                                                                                   |
| `SCORING_REQUIRE_KEY`            | `false`                             | Set to `true` to refuse unauthenticated scoring writes even before any API key exists. Without it, the scoring API is open until you create your first key — see [scoring.md](scoring.md#authentication).                                              |
| `CAST_RECEIVER_APP_ID`           | `260A23F5`                          | Google Cast receiver app ID for the scoreboard. The default is registered against **this project's** scoreboard URL, so casting won't work elsewhere until you register your own — see [scoreboard casting](#scoreboard-casting).                      |
| `CAST_NAMESPACE`                 | `urn:x-cast:com.tomsawyerlabs.pfms` | Cast custom-message namespace. Only change it if you also change it on your receiver.                                                                                                                                                                  |
| `VIDEO_PROXY_TARGET`             | _(none)_                            | Base URL of a WHEP/WebRTC stream server (e.g. MediaMTX, `http://10.255.0.20:8889`). Enables `/api/video-proxy/*` so the scoreboard's video view can play `whep:<stream>` sources over HTTPS. Only signaling is proxied; media flows directly over UDP. |
| `MATCH_RECORDING_STREAMS`        | _(none)_                            | Seed for the match video recorder: `name=url,name=url` (e.g. `all-field=rtsp://10.255.0.20:8554/all-field`). Streams saved in the admin panel take precedence. See [match video recording](match-system.md#match-video-recording).                     |
| `MATCH_RECORDINGS_DIR`           | `recordings`                        | Where recorded matches are stored (one directory per match id).                                                                                                                                                                                        |
| `MATCH_RECORDING_RETENTION_DAYS` | `30`                                | Recordings older than this are deleted by a daily sweep. The admin panel value wins.                                                                                                                                                                   |
| `FFMPEG_PATH` / `FFPROBE_PATH`   | `ffmpeg` / `ffprobe`                | Binaries used by the recorder. Recording is disabled (and says so in the admin panel) when ffmpeg can't be run.                                                                                                                                        |
| `PUBLIC_URL`                     | _(page's own origin)_               | Address the field is reachable at from anywhere, e.g. `https://pfms.example.org`. Used for the post-match QR code and share links (`/scores?match=<token>`). The setup UI value wins.                                                                  |

## Integrations

| Variable               | Default  | Description                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------- |
| `FIRST_API_USERNAME`   | _(none)_ | FIRST Events API username, for fetching team avatars (usually set via `.env`) |
| `FIRST_API_AUTH_TOKEN` | _(none)_ | FIRST Events API auth token                                                   |

Slack integration is configured through the admin UI, not environment
variables — see [support.md](support.md#slack-integration).

## Persistence Files

State files are JSON, written to the working directory by default:

| Variable               | Default                 | Holds                                                                                                                             |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE_CONFIG_FILE`   | `active-config.json`    | Active radio/station configuration                                                                                                |
| `STAGED_CONFIG_FILE`   | `staged-config.json`    | Staged (not yet committed) station configuration                                                                                  |
| `SAVED_TEAMS_FILE`     | `saved-teams.json`      | Saved team WiFi configs (auto-saved on configure)                                                                                 |
| `API_KEYS_FILE`        | `api-keys.json`         | Scoring API keys                                                                                                                  |
| `ADMIN_AUTH_FILE`      | `admin-auth.json`       | Admin passphrase hash + session tokens                                                                                            |
| `EXTERNAL_ACCESS_FILE` | `external-access.json`  | External access tokens                                                                                                            |
| `SUPPORT_ISSUES_FILE`  | `support-issues.json`   | Support issue reports                                                                                                             |
| `SUPPORT_CHATS_FILE`   | `support-chats.json`    | Support chat sessions                                                                                                             |
| `SLACK_CONFIG_FILE`    | `slack-config.json`     | Slack integration configuration                                                                                                   |
| `DEPLOY_ANNOUNCE_FILE` | `deploy-announced.json` | Last version announced to Slack. On startup with a new git version, commit subjects since then are posted to the support channel. |

Not configurable: `match-history.json`, `usage-data.json`,
`audio-config.json` (fixed names in the working directory).

## Scoreboard casting

Two ways to get the scoreboard onto a TV.

**Just open the URL on the TV.** Any smart TV, browser, or cheap HDMI
stick on the field network can display `http://<host>:<port>/scores`.
Nothing to register, no HTTPS required. The setup screen shows the exact
address to type. This is the recommended path unless you specifically
want the Cast button.

**Google Cast.** Casting requires a Cast _receiver application_, which
Google registers against one specific HTTPS URL. The built-in ID
(`260A23F5`) is registered against this project's own scoreboard, so it
will not serve yours — casting from another field silently does nothing
useful until you register your own:

1. Serve `/scores` over HTTPS on a real hostname (Cast refuses insecure
   origins).
2. Register a **Custom Receiver** at the
   [Google Cast Developer Console](https://cast.google.com/publish),
   pointing at `https://<your-host>/scores`.
3. Set `CAST_RECEIVER_APP_ID` to the ID you're issued and restart.

The backend serves these values at `/cast-config.js`, so no rebuild is
needed. If a reverse proxy serves the built frontend as static files (the
Caddy setup in `docs/network.md`), it must forward `/cast-config.js` to the
backend alongside `/ws` and `/api/*` — otherwise the scoreboard silently
falls back to the built-in IDs.

## Setup Wizard

| Variable            | Default             | Description                                                               |
| ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `SETUP_CONFIG_FILE` | `setup-config.json` | Wizard progress and any settings saved from the web UI (see caveat below) |

Settings saved through the setup UI are written to this file and **take
precedence over the matching environment variable**. Environment variables
remain the seed for a fresh install and still own everything the wizard
doesn't manage, so an existing deployment is unaffected until someone uses
the wizard. The UI shows which source a value came from.

`VLAN_INTERFACE` and `RADIO_URL` are read **once at startup**, so changing
them in the setup UI takes effect on the next restart.

Note that pFMS configures the host's networking itself — it assigns the
field-control address to the trunk interface at startup, and creates every
VLAN sub-interface and bridge when a station config is committed. The
setup UI reports on that rather than duplicating it, so there is nothing
to apply by hand.

To start setup over:

```bash
sudo systemctl stop practice-field-management-system
node dist/cli.js --clear-config          # add --all to also erase admin/API/Slack config
```

It refuses (exit code 1) if anything is still answering `/health`, so it
can't pull config out from under a running field. `--force` overrides that
check. Run `node dist/cli.js --help` for the full list.

## Misc / Debug

| Variable                    | Default | Description                                |
| --------------------------- | ------- | ------------------------------------------ |
| `RADIO_HISTORY_DURATION_MS` | `60000` | Radio status history retention window (ms) |

## Trusted Proxies

When running behind a reverse proxy (like Caddy), set `TRUSTED_PROXIES`
to enable real client IP detection:

```bash
# For Caddy running on localhost
TRUSTED_PROXIES=127.0.0.1,::1

# For Caddy on a specific network
TRUSTED_PROXIES=10.0.0.0/8

# Multiple proxies
TRUSTED_PROXIES=127.0.0.1,::1,10.0.0.0/8,192.168.1.0/24
```

This allows the application to read the `X-Forwarded-For` header from
trusted proxies to log the real client IP instead of the proxy's IP.
