# Deployment: systemd or Docker

pFMS needs to survive a reboot and start itself when the field powers on.
Two supported ways, and the setup wizard walks through whichever you pick.

Both need the **host's network namespace** and **NET_ADMIN** — pFMS
configures the host's VLAN interfaces, bridges, iptables rules, and
routing tables. There is no useful "isolated" deployment: an isolated
network namespace just gives pFMS a private sandbox to configure while
robots stay unreachable.

## Standalone binary (no dependencies)

`bun run package` produces `release/pfms-<platform>/` containing a single
executable plus the two directories it needs beside it:

```
pfms      the binary — no node, no bun, no npm install
web/      the built frontend
sounds/   match audio
```

Zip that directory, copy it to the field host, unzip, and run it:

```bash
sudo ./pfms          # then open http://<host>:3000/setup
```

The binary still needs the **system packages** (`iptables`, `arping`,
`fping`, `dnsmasq`, `conntrack`, `tcpdump`) — it bundles the JavaScript
runtime, not the networking tools. The setup wizard tells you which are
missing and can install them with apt.

Cross-compile with a bun target triple, e.g.:

```bash
bun scripts/package-binary.ts bun-linux-x64
bun scripts/package-binary.ts bun-linux-arm64      # Raspberry Pi
```

Notes:

- **Keep the three items together.** The binary looks for `web/` and
  `sounds/` next to itself. `bun build --compile` keeps each bundled
  module's build-time paths, so assets are deliberately kept outside the
  executable — a binary that read them from inside would appear to work on
  the build machine and fail everywhere else.
- **It's large** (~116 MB) — that's the embedded JavaScript runtime.
- **No auto-update.** `update.sh` assumes a git checkout; re-package and
  replace the directory instead.
- Only the Windows build has actually been run. Linux targets compile the
  same way but haven't been exercised on a field host.

For a permanent install, still use systemd or Docker below — point
`ExecStart` at the binary instead of `bun src/index.ts`.

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
