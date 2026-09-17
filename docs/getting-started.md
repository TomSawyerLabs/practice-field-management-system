# Getting Started

A linear, start-to-finish guide for standing up pFMS at a new practice
field — from bare hardware to running your first match.

Work through it in order. Each step says how to tell it worked before you
move on. If you only want to poke at the software, skip to
[Try it without hardware](#try-it-without-hardware).

Reference material lives elsewhere: [setup.md](setup.md) for deployment
detail, [configuration.md](configuration.md) for every setting,
[network.md](network.md) for how the networking actually works.

---

## What you're building

pFMS is a Linux host sitting between your site network and a Vivid-Hosting
field AP. The AP broadcasts one Wi-Fi network per team; the host puts each
team on its own VLAN, routes between those VLANs and your site network,
and speaks the FRC FMS protocol to Driver Stations (both the NI Driver
Station and the 2027 FIRST Driver Station used with SystemCore).

```
Team laptops ── site network ── [ pFMS host ] ══ VLAN trunk ══ [ field AP ] ))) robots
                                     │
                              browser UI (you)
```

---

## 1. Gather hardware

- [ ] **A Vivid-Hosting VH-113 or VH-109 field AP.** This is the only
      supported radio.
- [ ] **A Linux host.** Anything that can run Node — a NUC, a small
      server, a Pi 4/5. It must have:
  - [ ] **A NIC that can carry a VLAN trunk.** This is the main
        requirement, and it's easy to overlook. The host tags traffic for
        VLANs 10–60 (one per station) plus your field-control network.
  - [ ] **A sound device**, if you want the field horn. pFMS plays match
        audio through ALSA (`aplay`). No sound card, no horn.
  - [ ] _(optional)_ **A second NIC** for the
        [robot tester](robot-tester.md) — a dedicated port a CSA plugs a
        robot into.
- [ ] **A managed switch** between the host and the AP that can do 802.1Q
      VLAN tagging. Both the host port and the AP port must be trunk
      ports.
- [ ] **A router** for your site network that you can add a static route
      to.

> **Naming note:** stations are `slot1`–`slot6`, mapped to VLANs
> 10/20/30/40/50/60 in that order. This mapping is currently fixed in the
> code, so your switch and AP have to match it.

---

## 2. Plan your addressing

pFMS uses three kinds of network:

| Network           | Address                  | Who owns it                           |
| ----------------- | ------------------------ | ------------------------------------- |
| Your site network | whatever you already use | your router                           |
| Field control     | `10.0.100.0/24`          | static; AP is `.2`, pFMS host is `.5` |
| Team VLANs        | `10.TE.AM.0/24` per team | the AP's DHCP (PRACTICE firmware)     |

Team subnets come from the team number: team 1234 → `10.12.34.0/24`, with
the robot radio at `.1`, the roboRIO at `.2`, and the pFMS host at `.254`.

> **The one trap that bites everyone:** pFMS adds `10.0.100.5/24` to the
> **bare** trunk interface (e.g. `eno1`), not to a tagged sub-interface.
> So **field control must be the native/untagged VLAN** on the host's
> trunk port. If you tag it instead, the AP is simply unreachable and the
> app waits forever for the radio with no error message.

- [ ] Decide the host's field-control interface name (`ip link` — commonly
      `eno1`, `enp1s0`, `eth0`).
- [ ] Configure the switch: host port = trunk, native VLAN = field
      control, tagged VLANs 10–60. AP port likewise.
- [ ] **On your site router, add a static route: `10.0.0.0/8` → the pFMS
      host's site-network IP.** Without this, laptops can't reach robots.
      This is a one-time, team-agnostic change.

**Check:** from the host, `ping 10.0.100.2` reaches the AP.

---

## 3. Flash the AP firmware

pFMS supports the **`PRACTICE`** (recommended) and **`OFFSEASON`**
firmware images from
[Vivid-Hosting's release page](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases).

`PRACTICE` is simpler: the AP serves DHCP on team VLANs itself, and
programmers can reach robots directly. With `OFFSEASON`, pFMS has to run
`dnsmasq` per VLAN instead.

- [ ] Flash the AP and confirm it answers at `http://10.0.100.2/status`.

---

## 4. Install pFMS

```bash
sudo apt install iptables iputils-arping fping dnsmasq-base conntrack tcpdump
sudo apt install alsa-utils dhcpcd5   # audio + robot tester
```

All six in the first line are checked at startup — **the app exits
immediately with code 78 if any is missing**, regardless of which firmware
you run.

You need **both** [bun](https://bun.sh) (to build) and a system **node**
(the service runs `/usr/bin/node`).

```bash
git clone https://github.com/TomSawyerLabs/practice-field-management-system.git
cd practice-field-management-system
bun install
bun run build
```

**Check:** `bun run typecheck` passes and `dist/` exists.

---

## 5. Configure

Create `/etc/pfms/environment` — one `KEY=value` per line. A minimal
working field:

```bash
WEBSOCKET_PORT=9005
VLAN_INTERFACE=eno1
FMS_ENDPOINT=true
TRUSTED_PROXIES=127.0.0.1,::1
```

That's the minimum. Everything else is optional — see
[configuration.md](configuration.md) for the full list. Common additions:

| Want                        | Add                                                         |
| --------------------------- | ----------------------------------------------------------- |
| The CSA robot tester        | `TEST_INTERFACE=eth1`                                       |
| Nightly config wipe         | `RADIO_CLEAR_SCHEDULE=0 6 * * *` + `RADIO_CLEAR_TIMEZONE=…` |
| `.local` names across VLANs | `MDNS_REFLECTOR=true`                                       |
| Team avatars                | `FIRST_API_USERNAME=…` + `FIRST_API_AUTH_TOKEN=…`           |
| Physical field ports        | `FIELD_PORTS=201:Port A,202:Port B`                         |

> A `.env` file in the repo works for **development only** — bun loads it,
> the systemd unit does not.

---

## 6. Run it as a service

> Prefer containers? [deployment.md](deployment.md) covers the Docker path
> instead — same requirements, different packaging. The rest of this step
> is the systemd route.

Create the deploy tree that the update script writes into (**nothing
creates this for you**, and `update.sh` fails without it):

```bash
sudo mkdir -p /opt/practice-field-management-system/{internal,public}
sudo chown -R "$USER" /opt/practice-field-management-system
```

Install the unit file from [setup.md](setup.md#systemd-service), adjusting
`WorkingDirectory` to your checkout. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now practice-field-management-system
journalctl -u practice-field-management-system -f
```

**Check:** the log shows `OK: 10.0.100.5`, then the radio status poll
starting. `curl localhost:9005/health` returns `{"phase":"idle"}`.

Use `systemctl reload` for updates — it preserves iptables rules and
routes so robots stay connected. `restart` does a full cleanup.

---

## 7. Put a web server in front _(optional)_

**You can skip this.** pFMS serves the built frontend and the match sounds
itself, so browsing to `http://<host>:9005` already gives you a working
field. Add a reverse proxy when you want:

- **HTTPS** — required to cast the scoreboard to a TV (see below), and
  for a friendly hostname instead of a port number.
- **The internal/external split** — showing outside visitors a public-only
  page. See [External Access](setup.md#external-access).

If you do add one, point it at the backend port and let it proxy
everything; copy a config from [setup.md](setup.md#reverse-proxy). Serving
the static files from the proxy instead also works, but then you own two
copies of them — and the classic failure is serving a stale directory so
updates never appear, or missing `sounds/` so browsers are silent while
the field speaker works fine.

If you want to cast the scoreboard to a TV, `/scores` **must be served
over HTTPS** — the Google Cast SDK requires a secure origin. That means a
real domain name and a certificate.

**Check:** browse to the site. You get the home page with a team-number
box.

---

## 8. First run

> **There's a guided version of the rest of this.** Open **`/setup`** and
> it walks the same ground with live checks — host, trunk NIC, field
> control, radio, team VLANs, audio, scoreboard, and how to keep it
> running. Checks re-run every few seconds, so a step turns green the
> moment you fix it, and your answers are saved: stop partway, come back,
> and it picks up at the next unfinished step. Everything below is the
> manual equivalent.

1. **Set the admin passphrase.** Visit `/admin`. The first visit prompts
   you to create one (minimum 4 characters). Anyone can claim it while
   none is set, so do this before opening the field up.
2. **Assign a team to a station.** From the home page, enter a team
   number to open its control page, then set the SSID and WPA key and
   apply. The AP reconfigures in ~30 seconds.
3. **Check the network page.** `/network` should show the VLAN coming up
   and, once a robot connects, discovered devices on `10.TE.AM.x`.
4. **Pick an audio device.** `/admin` → Match Audio → select your output
   and hit Test. Without this, sounds stay off.
5. **Run a match.** Open `/match`, create a match, join from the team
   page, open the ready check, ready up, then hold the start button
   through the countdown. See [match-system.md](match-system.md).

Optional, when you need them:

- **Scoring devices** — `/admin` → API keys, then point devices at
  `/api/score`. See [scoring.md](scoring.md).
- **Field staff pages** — `/staff?role=headRef` (also `scorekeeper`,
  `safety`).
- **Support widget → Slack** — `/admin` → Slack Integration. See
  [support.md](support.md).
- **Access from outside the field** — `/admin` → External Access. See
  [setup.md](setup.md#external-access).

---

## Try it without hardware

You can run the whole app on any OS — no root, no AP, no VLANs:

```bash
bun install
cp .env.example .env      # DRY_RUN=1 is already set
bun run dev               # backend
cd frontend && bun run dev  # frontend on :5173
```

Network operations log what they _would_ do instead of touching the OS.
`scripts/` has harnesses for faking teams and driving match flows.

---

## When something's wrong

pFMS is quiet about misconfiguration — **startup problems appear only in
the service log**, not in the UI. Check there first.

| Symptom                                               | Likely cause                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exits immediately, code 78                            | A required tool is missing — the log names it                                                                                                                                     |
| Log repeats "waiting for radio"                       | AP unreachable. Field control probably isn't the native VLAN on the trunk                                                                                                         |
| Robots associate but are unreachable                  | Switch VLAN IDs don't match the `slot1→10 … slot6→60` mapping                                                                                                                     |
| Laptops can't reach robots                            | Missing `10.0.0.0/8` static route on the site router                                                                                                                              |
| Field speaker silent                                  | No audio device selected in `/admin`, or no ALSA player installed                                                                                                                 |
| Browsers silent, field speaker fine                   | `sounds/` never made it into the web root                                                                                                                                         |
| Team avatars missing                                  | `FIRST_API_*` set in `.env` instead of `/etc/pfms/environment`                                                                                                                    |
| Deploy interrupts a live match                        | `update.sh` health check port doesn't match `WEBSOCKET_PORT`                                                                                                                      |
| Scoreboard won't cast                                 | `/scores` isn't served over HTTPS                                                                                                                                                 |
| Some Wi-Fi devices intermittently can't load the page | Wired→wireless ARP isn't delivered (the AP drops broadcasts toward Wi-Fi clients). `arping`/`ip neigh` from the server shows the client INCOMPLETE — not a DNS or netmask problem |

`/logs` shows the live backend log stream once the app is up, and the
support widget on every page can file an issue with a screenshot attached.
