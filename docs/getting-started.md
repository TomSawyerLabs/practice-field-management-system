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
- [ ] **A Linux host.** A NUC, a small server, a Pi 4/5. (The
      [single-file binary](deployment.md#single-file-binary) is built for
      x64 and arm64.) It must have:
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

> **Where field control lives:** by default pFMS adds `10.0.100.5/24` to
> the **bare** trunk interface (e.g. `eno1`), so field control is the
> native/untagged VLAN on the host's trunk port. If your switch tags field
> control on that port instead, set the **field-control interface** (setup
> wizard, or `FIELD_CONTROL_INTERFACE`) to `eno1.<VLAN ID>`, and pFMS
> creates that VLAN interface and puts the address there. A separate NIC,
> or a VLAN interface you already manage with netplan, works too. If the
> two disagree, the setup wizard's _Field control address_ check says so.

- [ ] Decide the host's trunk interface name (`ip link` — commonly
      `eno1`, `enp1s0`, `eth0`).
- [ ] Configure the switch: host port = trunk with the team station VLANs
      (10–60 by default) tagged, and field control either native or tagged
      (then set the field-control interface). The AP port carries field
      control untagged and the station VLANs tagged.
- [ ] **On your site router, add a static route: `10.0.0.0/8` → the pFMS
      host's site-network IP.** Without this, laptops can't reach robots.
      This is a one-time, team-agnostic change.

**Check:** from the host, `ping 10.0.100.2` reaches the AP.

---

## 3. Flash the AP firmware

pFMS supports the **`PRACTICE`** (recommended) and **`OFFSEASON`**
firmware images from
[Vivid-Hosting's release page](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases).

Use `PRACTICE`. `OFFSEASON` works with pFMS, but its firewalls stop most
teams from uploading code to their robots, which is too much friction for a
practice field. On `PRACTICE` the AP serves DHCP on the team VLANs itself
(pFMS routes around that with NAT); on `OFFSEASON`, pFMS runs `dnsmasq` per
VLAN instead.

- [ ] Flash the AP and confirm it answers at `http://10.0.100.2/status`.

---

## 4. Install pFMS

```bash
sudo apt install iptables iputils-arping fping dnsmasq-base conntrack tcpdump
sudo apt install alsa-utils dhcpcd5   # audio + robot tester
```

All six in the first line are needed to run the field network,
regardless of which firmware you run. If any is missing pFMS still starts
but leaves the field network down; the setup wizard's Host step lists what
is missing and can install it for you (**Install missing tools**), after
which the field network comes up on its own.

pFMS is built with [bun](https://bun.sh) and runs on it by default (the
build needs at least the bun version in `engines.bun`, `package.json`).
Node works too: the build also compiles the backend to `dist/`, so
`node dist` runs the same checkout — Bun is just what we use. Install bun
system-wide so root (and the service) find it at `/usr/local/bin/bun`:

```bash
sudo apt install unzip   # the bun installer needs it
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
```

```bash
git clone https://github.com/TomSawyerLabs/practice-field-management-system.git
cd practice-field-management-system
bun install
bun run build
```

`bun run build` also downloads a small prebuilt native addon from the
project's GitHub releases (`native/mdns-socket`, which lets the robot
networks' mDNS work when one team runs two robots), so the host needs
internet access for the build. No Rust toolchain is needed.

**Check:** `bun run build` finishes, `frontend/dist/` exists, and
`native/mdns-socket/prebuilt/` holds a `.node` file.

---

## 5. Configure

Create `/etc/pfms/environment` — one `KEY=value` per line. A minimal
working field:

```bash
WEBSOCKET_PORT=9005
VLAN_INTERFACE=eno1
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
`WorkingDirectory` to your checkout — or let the setup wizard's Deployment
step write and enable it for you (**Install and enable the service**).
Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now practice-field-management-system
journalctl -u practice-field-management-system -f
```

**Check:** the log shows `OK: 10.0.100.5`, then the radio status poll
starting. `curl localhost:9005/health` returns `{"phase":"idle","version":"<git hash>"}`.

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
> it walks the same ground with live checks — host, admin passphrase,
> trunk NIC, field control, radio, team VLANs, audio, scoreboard, and how
> to keep it running. Checks re-run every few seconds, a step whose checks
> pass marks itself done, and settings take effect the moment you save
> them — no restart. Your answers are saved: stop partway, come back, and
> it picks up at the next unfinished step. Everything below is the manual
> equivalent.

1. **Set the admin passphrase.** The setup wizard asks for it second, or
   visit `/admin`: the first visit prompts you to create one (minimum 4
   characters). Anyone can claim it — and change the field — while none
   is set, so do this before opening the field up.
2. **Assign a team to a station.** From the home page, enter a team
   number to open its control page, then add the robot's SSID and WPA key
   and press **Enable Robot**. The AP reconfigures in ~30 seconds — later
   if robots are enabled or a match is set up (see
   [match-system.md](match-system.md#wi-fi-changes-and-matches)).
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
- **Operator code** — `/admin` → Access, so that teams can't run the field
  from their phones. See [support.md](support.md#operator-login).
- **Field staff pages** — `/staff?role=headRef` (also `scorekeeper`,
  `safety`).
- **Field network triage** — `/csa` on a CSA's tablet: shows only what is
  wrong (radio, Driver Station and robot links, host tables) and what to
  try; all clear shows almost nothing.
- **Match queue** — `/queue` for a scrimmage or event day: a schedule plus
  a fill line teams join from their page, and "Set up next match" on
  `/match`. See [match-system.md](match-system.md#match-queue).
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

| Symptom                                               | Likely cause                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Exits immediately, code 78                            | A required tool is missing — the log names it                             |
| Log repeats "waiting for radio"                       | AP unreachable. Field control probably isn't the native VLAN on the trunk |
| Robots associate but are unreachable                  | Switch VLAN IDs don't match the `slot1→10 … slot6→60` mapping             |
| Laptops can't reach robots                            | Missing `10.0.0.0/8` static route on the site router                      |
| Field speaker silent                                  | No audio device selected in `/admin`, or no ALSA player installed         |
| Browsers silent, field speaker fine                   | `sounds/` never made it into the web root                                 |
| Team avatars missing                                  | `FIRST_API_*` set in `.env` instead of `/etc/pfms/environment`            |
| Deploy interrupts a live match                        | `update.sh` health check port doesn't match `WEBSOCKET_PORT`              |
| Scoreboard won't cast                                 | `/scores` isn't served over HTTPS                                         |
| Some Wi-Fi devices intermittently can't load the page | Wired→wireless ARP isn't getting through — see below                      |

**Wi-Fi clients that work, then don't.** If a phone or laptop loads pFMS
sometimes and not others, the usual cause is that ARP from the server to
the client isn't being delivered, while the client→server direction works
fine. It looks intermittent because the server can answer only while it
still holds the client's neighbor entry, which it learns passively when the
client ARPs first; once that ages out (minutes), the server has to ARP the
client — the broken direction. `arping` the client from the server and
watch `ip neigh`: `INCOMPLETE` confirms it, and it is not DNS, not the
netmask, and not `rp_filter`.

To confirm and to get someone working for the day:
`sudo ip neigh replace <ip> lladdr <mac> dev <iface>` (undo with
`ip neigh del`). If that fixes it, the data path is fine. The real fix is on
the access point: look at proxy ARP, "multicast and broadcast control" or
broadcast filtering, and client isolation. A large flat subnet makes APs
more likely to suppress broadcast. An L2 loop or a mis-provisioned switch
port produce identical symptoms, so don't trust a controller's topology map
as evidence — check its event log for MAC flapping instead.

`/logs` shows the live backend log stream once the app is up, and the
support widget on every page can file an issue with a screenshot attached.
