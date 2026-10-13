# Deployment: systemd or Docker

pFMS needs to survive a reboot and start itself when the field powers on.
Two supported ways, and the setup wizard walks through whichever you pick.

Both need the **host's network namespace** and **NET_ADMIN** — pFMS
configures the host's VLAN interfaces, bridges, iptables rules, and
routing tables. There is no useful "isolated" deployment: an isolated
network namespace just gives pFMS a private sandbox to configure while
robots stay unreachable.

## Single-file binary

`bun run package` builds one executable, `release/pfms-<os>-<arch>`, with
everything inside it: the backend and bun runtime, the built frontend,
match sounds, the Driver Station Wi-Fi check script and (Linux) the
mdns-socket addon. Nothing else to copy — no git, bun or build on the
field host:

```bash
sudo ./pfms-linux-x64          # then open http://<host>:3000/setup
./pfms-linux-x64 --version     # short commit, full commit, target, build time
```

On first start of each version it unpacks its bundled files into
`.pfms-assets/<version>/` beside itself (the field speaker's `aplay` and
the addon loader need real files), or the temp directory if it can't
write there. The previous version's copy is kept; older ones are removed.
State files are written to the working directory, as with a checkout.

The binary still needs the **system packages** (`iptables`, `arping`,
`fping`, `dnsmasq`, `conntrack`, `tcpdump`) — it bundles the JavaScript
runtime, not the networking tools. The setup wizard tells you which are
missing and can install them with apt.

Cross-compile with a bun target (after `bun run build`):

```bash
bun scripts/build-binary.ts bun-linux-x64
bun scripts/build-binary.ts bun-linux-arm64      # Raspberry Pi 4/5, 64-bit OS
```

Notes:

- **It's large** (~90 MB) — that's the embedded JavaScript runtime.
- It ignores a `.env` or `bunfig.toml` in its working directory; settings
  come from the environment and the setup wizard, as in production.
- For a permanent install use systemd (below) with `ExecStart` pointing at
  the binary, or let the setup wizard's Deployment step write the unit.

## Which one?

|                                        | systemd                                   | Docker                                                |
| -------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Best for                               | A dedicated field host you control        | A host where you'd rather not install system packages |
| Dependencies                           | Installed with `apt` on the host          | Baked into the image                                  |
| Updates                                | `./update.sh` (git pull + build + reload) | Rebuild/pull the image, `docker compose up -d`        |
| Graceful reload keeps robots connected | ✅ `systemctl reload`                     | ❌ container restart is a full restart                |
| Sound                                  | Works directly                            | Needs `/dev/snd` passed in                            |

**Recommendation: systemd on a dedicated field host.** It's the
better-tested path here, and it's the only one that supports the graceful
reload that keeps robots connected across an update. Choose Docker if you
want dependencies self-contained or you're sharing the host with other
services.

## systemd

Install the packages ([getting started](getting-started.md#4-install-pfms)),
build, then install the unit:

```ini
[Unit]
Description=Practice Field Management System Backend
After=network.target

[Service]
EnvironmentFile=/etc/pfms/environment
WorkingDirectory=/path/to/practice-field-management-system
# --no-env-file: settings come from EnvironmentFile, never a stray .env
ExecStart=/usr/local/bin/bun --no-env-file src/index.ts
# Graceful reload: preserve network rules across restarts
ExecReload=/bin/sh -c 'touch /run/pfms-keep-network && kill -HUP $MAINPID'
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now practice-field-management-system
```

Or let the setup wizard do it: on a systemd host, the Deployment step's
**Install and enable the service** writes this unit (with the runtime,
entry point and working directory pFMS is running with now), reloads
systemd and enables it for boot. It doesn't start it — the copy you're
using is already running — so the service takes over from the next boot.

There's no `User=`, so it runs as root — which it needs, for VLANs and
iptables.

`ExecStart` needs bun's absolute path: `/usr/local/bin/bun` if you
installed it system-wide as in [getting started](getting-started.md#4-install-pfms),
otherwise whatever `command -v bun` prints (e.g. `/home/you/.bun/bin/bun`).
Use the same bun `update.sh` builds with — the build refuses a bun older
than `engines.bun` in `package.json`.

`systemctl reload` preserves iptables rules, route tables, and routing
preferences, so robots stay connected through an update.
`systemctl restart` does a full cleanup. See
[graceful reload](internals.md#graceful-reload).

## Docker

A `Dockerfile` and `docker-compose.yml` ship in the repo. Edit
`VLAN_INTERFACE` in the compose file to your trunk NIC first, then:

```bash
docker compose up -d
docker compose logs -f
```

What the compose file does and why:

- **`network_mode: host`** — required, see above.
- **`cap_add: NET_ADMIN, NET_RAW`** — `NET_ADMIN` for `ip`/`iptables`,
  `NET_RAW` for `arping` and the `tcpdump` robot-telemetry capture.
- **`restart: unless-stopped`** — otherwise the field doesn't come back
  after a power cycle. A container can't see its own restart policy, so
  the wizard can only remind you; verify with:
  ```bash
  docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' pfms
  ```
- **`./data:/app/data`** — all persisted state (setup answers, admin
  passphrase, API keys, match history, usage) is written to the working
  directory. Without this volume it dies with the container.
- **`/dev/snd`** — match audio. Omit if the host has no sound device.

Sounds and the built frontend are baked into the image, so the browser
audio problem that bites hand-rolled deployments doesn't apply here.

### Docker caveats

- **No graceful reload.** `systemctl reload` keeps robots connected across
  a restart by preserving network rules; restarting a container is always
  a hard restart. Mid-match updates are worse under Docker.
- **`update.sh` doesn't apply** — it assumes a git checkout and a systemd
  unit. Rebuild the image instead.
- **Untested.** The image has not been built or run — there was no Docker
  available where it was written. It's assembled from the same dependency
  list the backend checks at startup and the same build the systemd path
  uses, but treat the first `docker compose up` as a debugging session,
  not a deployment. Please report back what breaks.
- **The image carries devDependencies.** `node_modules` is copied whole
  from the build stage, so the image is larger than it needs to be. Fine
  for a field host; worth pruning if it ever gets published.

## Either way

Configuration lives in `/etc/pfms/environment` (systemd) or the compose
`environment:` block (Docker) — but anything set through the setup UI is
stored in `setup-config.json` and **takes precedence** over both. See the
[configuration reference](configuration.md).

To start setup over:

```bash
bun src/cli.ts --clear-config      # refuses while the backend is running
```
