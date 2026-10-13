# Setup wizard audit: "go do this" steps (2026-10-12)

Inventory behind `plans/setup-live-settings.md`. Each manual instruction in
the wizard (`src/setupProbe.ts`, `frontend/src/components/SetupPage.tsx`),
whether pFMS could do it itself, and what it would take. Line numbers are
as of `a3d7d8e`.

## Structural findings

- **The wizard can't be reached when startup fails.** With a trunk
  interface set, `checkRequiredTools` exits (code 78) before the web server
  starts (`index.ts:199-200`, `startupChecks.ts:103-118`). So the Host
  step's "missing tools" result is only ever visible with no trunk set.
  `platformGuard` exits at import on non-Linux (fine — DRY_RUN covers it).
- **The probe never touches the host** (`setupProbe.ts:10-13`). Fixes are
  shown as text in a `<pre>`; nothing runs them.
- **Every step needs a "Mark done" click**, even when the probe is green
  (`SetupPage.tsx:332-350`).
- **Probe vs runtime drift.** The probe uses the newly saved
  `vlanInterface` / `radioUrl` at once, the running app keeps the startup
  values — so a step can be green against a value pFMS isn't using.

## Per step

| Step         | Manual instruction (file:line)                                                                          | pFMS could…                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| host         | Set DRY_RUN or deploy on Linux (`setupProbe.ts:79`)                                                     | No — informational                                                                          |
| host         | Run as root (`:95`)                                                                                     | No — the systemd unit already does                                                          |
| host         | `sudo apt install <tools>` (`:111`, `:125`)                                                             | Yes: apt-get as root after a click (Debian/apt + internet; dpkg lock)                       |
| interfaces   | "Add VLAN_INTERFACE to /etc/pfms/environment" (`:176-177`, `:190`) — contradicts the UI, which saves it | Yes: say "pick it here"                                                                     |
| interfaces   | free-text NIC box (`SetupPage.tsx:97-105`)                                                              | Yes: picker from the probe's candidate list                                                 |
| interfaces   | `ip link set <nic> up` (`:203`)                                                                         | Yes: the backend manages links                                                              |
| interfaces   | "restart pFMS for it to take effect" (`SetupPage.tsx:103`)                                              | Yes: apply live (this plan)                                                                 |
| fieldControl | Make field control the native VLAN on the switch port (`:243`)                                          | No — switch config; already detected                                                        |
| fieldControl | "Check the trunk interface, then restart pFMS" (`:257`)                                                 | Yes: `checkInterfaceIps` runs on trunk apply                                                |
| radio        | Flash PRACTICE/OFFSEASON firmware (`:283`)                                                              | Partly — human flash; check for an upload API                                               |
| radio        | `curl -v <radioUrl>/status` (`:306`)                                                                    | Yes: show the fetch error pFMS already has                                                  |
| teamVlans    | "Assign a team to a station" from the home page (`:329-330`)                                            | Could be inline in the wizard                                                               |
| audio        | `sudo apt install alsa-utils` (`:365`)                                                                  | Yes: as host tools                                                                          |
| audio        | `bun scripts/generate-sounds.ts` (`:377`)                                                               | Yes: run it (check bun is on the host)                                                      |
| audio        | pick device, play test, "I heard it"                                                                    | Already in the wizard; hearing is human                                                     |
| scoreboard   | Create an API key in /admin, or set SCORING_REQUIRE_KEY (`:425-426`)                                    | Yes: inline create-key button; make require-key a setting                                   |
| scoreboard   | Open /scores and cast to a TV (`:438`)                                                                  | No — human; already a button                                                                |
| scoreboard   | `curl -v <videoProxyTarget>` (`:463`)                                                                   | Yes: show the error                                                                         |
| scoreboard   | Cast needs HTTPS (`SetupPage.tsx:183`)                                                                  | Hard — needs a domain/cert; could generate a Caddyfile                                      |
| deployment   | Install the unit, `systemctl enable --now` (`:546`, `:563`, `SetupPage.tsx:273-285`)                    | Yes on systemd (write unit, daemon-reload, enable — careful not to start a second instance) |
| deployment   | Docker restart policy (`:580`, `:594`)                                                                  | No — must be set outside the container                                                      |

## Settings that only apply after a restart

Wizard-backed: `vlanInterface`, `radioUrl` (this plan). Also `fmsAddress`
exists as a setting the probe reads but has no UI and the runtime ignores
(always `10.0.100.5`).

Env-only, read once at module scope in `src/index.ts`, not in the wizard:
`FMS_ENDPOINT` (in the docs' minimal config — without it DSes get no FMS),
`SYSLOG_ENDPOINT`, `MDNS_REFLECTOR`, `TEST_INTERFACE`, `VLAN_HOST_OCTET`,
`WEBSOCKET_PORT`, `FMS_TCP_REPLY_STATIONS`, `FIELD_PORTS`,
`TRUSTED_PROXIES`, `RADIO_CLEAR_SCHEDULE`/`_TIMEZONE`,
`IPTABLES_COMMENT_PREFIX`, `SCORING_AUTO_REGISTER_LIMIT`,
`MATCH_RECORDING_STREAMS` (fallback).

Already live: `robotWifiInterface`, `sixGhzWatchInterface`, `wifiCountry`,
`videoProxyTarget`, `publicUrl`, recording and timelapse settings.

## Docs steps the wizard doesn't cover

| Doc step                                                              | Where                          | pFMS could…                                                         |
| --------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| Hardware                                                              | `getting-started.md:32-54`     | Detect some (NIC, sound device)                                     |
| Switch trunks, native field-control VLAN                              | `:79-80`                       | Partly detected (fieldControl)                                      |
| Static route 10.0.0.0/8 → host on the site router                     | `:81-83`, `:293`               | Not detected; could infer                                           |
| Install bun/node, clone, build                                        | `:116-132`                     | Chicken-and-egg; could check the mdns-socket prebuilt               |
| `/etc/pfms/environment` (FMS_ENDPOINT etc.)                           | `:138-146`                     | Only VLAN_INTERFACE covered                                         |
| mkdir/chown `/opt/practice-field-management-system/{internal,public}` | `:170-176`                     | Yes, as root                                                        |
| Reverse proxy / HTTPS / LAN_URL                                       | `:195-218`, `setup.md:112-221` | Needs domain/cert; could generate config                            |
| **Admin passphrase at /admin**                                        | `:232-234`                     | Easy inline input — and the wizard is open to anyone until it's set |
| Assign a team, enable a robot, first match                            | `:235-246`                     | Only pointed at                                                     |
| `update.sh` health-check port = WEBSOCKET_PORT                        | `:297`                         | Detectable                                                          |
