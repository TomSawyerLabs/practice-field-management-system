# Setup & Deployment

## Requirements

Works with [`PRACTICE` or `OFFSEASON` firmware](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases)
on the VH-113 AP (or VH-109). `PRACTICE` is recommended for simplicity and
programmer connectivity.

Currently, only Linux is supported for network management due to
dependencies on `iptables` and `iputils-arping`. The app must run with
root privileges to manage VLAN interfaces and routing rules.

Starting pFMS on a non-Linux host **exits immediately with code 78** and
an explanation — there is no Windows or macOS networking layer yet.
Development on any OS still works with
[`DRY_RUN`](internals.md#dry-run-mode), which logs network operations
instead of performing them.

For how to keep pFMS running across reboots — systemd or Docker — see
[deployment.md](deployment.md).

## Install

1. System dependencies (Linux, for VLAN/routing):

   ```bash
   sudo apt install iptables iputils-arping fping dnsmasq-base conntrack tcpdump
   ```

   **All six are required whenever `VLAN_INTERFACE` is set** — the backend
   checks for them at startup and exits with code 78
   (`Missing required tools: …`) if any is absent, regardless of which AP
   firmware you run. See `checkRequiredTools` in `src/index.ts`.
   - `iptables` — MASQUERADE rules for site network ↔ robot routing
   - `iputils-arping` — duplicate address detection (used in OFFSEASON
     firmware mode)
   - `fping` — fast parallel pinging for the subnet scanner (device
     discovery on team VLANs)
   - `dnsmasq-base` — per-VLAN DHCP serving (used in OFFSEASON mode)
   - `conntrack` — connection-tracking cleanup for DS↔RIO NAT
   - `tcpdump` — robot telemetry packet capture on UDP 1150

   Also useful, but not startup-checked (they degrade silently if
   missing):

   ```bash
   sudo apt install alsa-utils dhcpcd5
   ```

   - `alsa-utils` — provides `aplay` for field match audio. Without an
     audio player (`aplay`, `paplay`, `ffplay`, `mpv`, `play`), the field
     speaker stays silent. You also need a real sound device.
   - `dhcpcd5` — required by the [robot tester](robot-tester.md) to lease
     an address on `TEST_INTERFACE`.

2. Both **bun** and a system **node** are needed: bun builds and runs the
   dev servers, while the systemd unit runs `/usr/bin/node dist` and
   `update.sh` uses `node` to parse the health endpoint.

3. JavaScript dependencies (the project uses [bun](https://bun.sh)):

   ```bash
   bun install
   ```

## Production Deployment

1. `bun run build` — compiles the backend to `dist/` and builds the
   frontend to `frontend/dist/`
2. `bun run start` (or `node dist`) — starts the backend from the compiled
   output
3. Configure a web server to serve the static frontend and proxy `/ws` and
   `/api/*` to the backend (examples below)

### Update Script

`./update.sh` pulls, builds, deploys static assets, and reloads the
service. If a match is running it waits (up to 10 minutes) for the field
to free up before reloading; `./update.sh force` reloads immediately. It
uses the backend's `/health` endpoint (which reports the current match
phase) to decide. On startup after a deploy, commit subjects since the
last deployed version are posted to the support Slack channel.

### Systemd Service

```service
[Unit]
Description=Practice Field Management System Backend
After=network.target

[Service]
EnvironmentFile=/etc/pfms/environment
WorkingDirectory=/path/to/practice-field-configurator
ExecStart=/usr/bin/node dist
# Graceful reload: preserve network rules across restarts
ExecReload=/bin/sh -c 'touch /run/pfms-keep-network && kill -HUP $MAINPID'
Restart=always

[Install]
WantedBy=multi-user.target
```

Environment variables live in `/etc/pfms/environment` (one `KEY=value`
per line — see the [configuration reference](configuration.md)). Changes
take effect on service restart without `systemctl daemon-reload`.

`systemctl reload` preserves iptables rules, route tables, and route
preferences across restarts — robots stay connected and laptops keep
their routing preferences. `systemctl restart` performs a full cleanup.
See [Graceful Reload](internals.md#graceful-reload).

### Reverse Proxy _(optional)_

**The backend serves the built frontend and `sounds/` itself**, so
`http://<host>:<WEBSOCKET_PORT>` is a working field with no proxy at all.
It applies the same URL rules described below — clean URLs get `.html`,
team-number URLs go to the team control page — so both paths behave
identically.

Add a proxy for TLS (casting needs a secure origin), a friendly hostname,
or the internal/external split. Set `WEB_ROOT` to override where the
backend looks for the built frontend, or point it at a directory that
doesn't exist to disable static serving entirely.

The frontend is a multi-page Vite build: each page is its own HTML file
(`admin.html`, `scores.html`, …), so a proxy serving the files directly
maps clean URLs with `try_files {path} {path}.html`, and team-number URLs
(`/1234`, `/1234-Bot`) rewrite to `control.html`. `/ws` and `/api/*`
proxy to the backend port (`WEBSOCKET_PORT`, `9005` in the examples
below).

#### Caddy

```Caddyfile
practice.example.com {
    @teamNumber path_regexp ^/\d

    route {
        rewrite @teamNumber /control.html

        reverse_proxy /ws localhost:9005
        reverse_proxy /ws/scores localhost:9005
        reverse_proxy /api/* localhost:9005
        reverse_proxy /admin/auth/* localhost:9005

        root * /path/to/frontend/dist
        try_files {path} {path}.html
        file_server
    }

    handle_errors {
        @404 expression `{err.status_code} == 404`
        rewrite @404 /404.html
        root * /path/to/frontend/dist
        file_server
    }
}
```

The reference deployment additionally splits internal and external
audiences — external visitors get a public-only page unless they carry a
valid access cookie (checked via `forward_auth` against
`/api/auth/check`), with `/scores` and `/admin` always reachable. See
[External Access](#external-access).

That split keys off the client's address, which has a trap: a device on the
field network that connects over IPv6 arrives from a global (ISP-delegated)
address, fails a `private_ranges` test, and would get the public page. That
happened to the reference field in August 2026 when the LAN name gained an
AAAA record. So the backend answers the proxy's `/api/auth/check` with `200`
not only for a valid access cookie but also for any client whose address is
inside a prefix on the host's **own interfaces** (read live from the OS —
nothing to configure, nothing that rots when the ISP renumbers). The proxy
must pass the client address in `X-Forwarded-For` (Caddy's `reverse_proxy`
does by default) and the proxy must be listed in `TRUSTED_PROXIES`, or the
backend ignores the header. Publish the backend's `/health/site` as
`/health` ahead of the access check with `LAN_URL` set, so uptime monitoring
goes red if LAN devices are ever shut out again:

```Caddyfile
        rewrite /health /health/site
        reverse_proxy /health/site localhost:9005
```

#### Nginx

```conf
server {
    listen 80;
    server_name practice.example.com;
    root /path/to/frontend/dist;

    # Clean URLs: /admin → /admin.html, /scores → /scores.html, etc.
    location / {
        try_files $uri $uri.html $uri/ =404;
    }

    # Team control pages: /1234, /1234-Bot → /control.html
    location ~ ^/\d {
        rewrite ^ /control.html break;
    }

    location /api/ {
        proxy_pass http://localhost:9005;
        proxy_set_header Host $host;
        client_max_body_size 100m;  # firmware uploads
    }

    location /ws {
        proxy_pass http://localhost:9005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Set [`TRUSTED_PROXIES`](configuration.md#trusted-proxies) so the backend
logs real client IPs instead of the proxy's.

## External Access

External access tokens grant trusted users the full internal UI from
outside the local network. Tokens are managed from the admin page —
create, view, and revoke as needed.

When an admin logs in, a token is automatically created and the browser
cookie is set. Tokens can also be created manually and shared as URLs
(`/admin/auth/<token>`). Visiting the URL sets an `HttpOnly` cookie
(365 days, refreshed on every page load). On subsequent requests from
external IPs, the reverse proxy uses `forward_auth` to ask the backend
whether the cookie is valid — the backend returns `200` (serve internal
UI) or `401` (serve public page). Revoking a token in the admin UI
invalidates it immediately.

The same check also answers `200` (no cookie needed) when the client's
address is on one of the host's own networks — how devices on the field
network that reach pFMS over IPv6 get the internal UI even though the proxy
does not consider their address private. Devices whose traffic arrives via a
VPN or a private-DNS service such as Cloudflare WARP are external from the
network's point of view and need the access link like anyone else.
