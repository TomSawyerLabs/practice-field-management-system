# Practice Field Management System

A web interface for configuring practice field access points, running
self-service matches, and enabling team laptop ↔ robot routing.

**Teams bring their robot exactly as it's set up at home.** There's no
radio reprogramming and no kiosk: a team enters the SSID and WPA key its
robot already uses, once, and the field AP serves that network. pFMS
remembers it for the next visit. Laptops stay on the site's ordinary
Wi-Fi with internet, and everything they use at home just works across
the field's routed network: Driver Station by team number, code deploys,
`roboRIO-TEAM-FRC.local`, `limelight-*.local` and other mDNS names,
NetworkTables, dashboards, and device web pages.

pFMS drives a VH-113 (or VH-109) field AP running
[`PRACTICE` (recommended) or `OFFSEASON` firmware](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases)
(see [Field AP firmware limitations](#field-ap-firmware-limitations)),
and provides:

- **Station configuration** — assign teams to the six field stations;
  the AP and host networking (VLANs, routing, NAT) follow automatically
- **Self-service matches** — teams join, ready up, and run official-timing
  matches with field-staff ready checks, hold-to-start, E-Stop/A-Stop, and
  match audio ([details](docs/match-system.md))
- **Speed challenges and relay races** — non-match formats for field
  events: one robot (or two racing) enabled for a window you choose, laps
  and penalties tallied from a phone, or a relay where the FMS sends each
  alliance's robots out one at a time; all ranked on a leaderboard you can
  put on the TV between runs
  ([details](docs/match-system.md#speed-challenge))
- **Scoring** — an HTTP API for goal sensors and referee tablets, a
  TV-ready scoreboard with optional live video, and post-match review
  ([details](docs/scoring.md))
- **Practice video** — on for every team by default (a team can untick
  "record while enabled" on its station page): every enable outside a match
  becomes a clip (3 s either side), with the
  balls scored and the robot's telemetry alongside; a per-day link (and zip)
  for taking home, posted to the team's mentors on Slack. Clips are kept a
  week (match videos a month), pause while matches are being run, and pause
  if the disk runs short
  ([details](docs/match-system.md#record-while-enabled-practice-runs))
- **Match video** — every match recorded from the field's video streams,
  downloadable by each drive team right after the match
  ([details](docs/match-system.md#match-video-recording))
- **Field timelapse** — a few full-resolution frames a day (optionally with
  the shop lights driven to a known level first) plus a fast timelapse of
  every stretch when robots are here, watched at `/timelapse` as one film per
  day with the robots, enables and matches laid out on a timeline under it,
  or rendered into a film on demand
  ([details](docs/match-system.md#long-term-field-timelapse))
- **Laptop ↔ robot routing** — laptops on the site network reach robots on
  their team VLANs ([details](docs/network.md))
- **Multiple robots per team, active at once** — a team can put two (or
  more) robots on the field together, each driven by its own laptop. Each
  laptop's DS link, routes, mDNS (`limelight-*.local`, `roboRIO-…`) and
  E-stop reach only the robot it drives, and it picks that robot with the
  Drive button on the team page
  ([details](docs/network.md#duplicate-team-handling))
- **Diagnostics & support** — a robot network tester for CSAs
  ([details](docs/robot-tester.md)), live logs, device discovery, robot
  telemetry, and a built-in support widget bridged to Slack
  ([details](docs/support.md))
- **Guided setup** — a `/setup` wizard that live-checks a new host and
  walks you through getting a field running (see below)

## Field AP firmware limitations

pFMS works around several limits of the Vivid-Hosting field AP firmware.
They're worth knowing before you set up a field:

- **Use `PRACTICE` firmware.** pFMS supports `OFFSEASON` too, and on
  networking alone it's the better fit: pFMS serves DHCP itself, so routing
  is simple, needs no DNAT, and supports more. But `OFFSEASON`'s firewalls
  stop most teams from uploading code to their robots. That's the bigger
  impediment, and too much friction for a practice field.
- **`PRACTICE` serves DHCP on the team VLANs itself.** That's a cost, not
  a convenience: robots get addresses pFMS didn't hand out, so the host
  has to NAT (MASQUERADE plus per-DS DNAT) to route laptop ↔ robot traffic
  through it ([details](docs/network.md#ds--rio-udp-and-dynamic-dnat)).
- **Any Wi-Fi change reconfigures the whole radio.** Adding or releasing a
  single team takes about 30 seconds and drops **every** robot's Wi-Fi.
  pFMS decides when that happens: it waits for enabled robots to be
  disabled, and it holds changes while a match is set up
  ([details](docs/match-system.md#wi-fi-changes-and-matches)).
- **The AP gives each team one subnet, `10.TE.AM.0/24`.** So two robots
  from one team sit on identical subnets on different VLANs. pFMS keeps
  them apart (see _Multiple robots per team_ above).

**Other field APs are welcome.** The VH-113/VH-109 is the only radio
supported today, but given the limits above, we'd be very happy to support
other APs. If you run a field
on different hardware, or want to help add a radio driver,
[open an issue](https://github.com/TomSawyerLabs/practice-field-management-system/issues).

## Setting Up a New Field

**Start it, then open `/setup` — the wizard walks you through the rest.**
It checks the host as you go: required packages, which NIC carries the
VLAN trunk, whether the radio answers, team VLANs, match audio (with a
test sound), casting the scoreboard, and how to keep it running. Checks
re-run every few seconds, so a step turns green the moment you fix it,
and your answers are saved — stop partway, come back, and it resumes at
the next unfinished step.

On a Linux host (network management needs Linux and root):

```bash
sudo apt install iptables iputils-arping fping dnsmasq-base conntrack tcpdump
sudo apt install alsa-utils dhcpcd5   # match audio + robot tester

bun install
bun run build
sudo node dist                        # then open http://<host>:3000/setup
```

That's a complete field — pFMS serves its own web interface, so no Caddy
or nginx is required to get started. Add a reverse proxy later for HTTPS
(casting the scoreboard needs it) and a friendly hostname.

Prefer to read rather than click? **[docs/getting-started.md](docs/getting-started.md)**
is the same ground as a linear checklist, from bare hardware to your
first match. To run pFMS permanently — systemd or Docker — see
**[docs/deployment.md](docs/deployment.md)**.

### Development

Works on any OS — no root, no radio, no VLANs:

```bash
bun install
cp .env.example .env           # DRY_RUN=1 is already set

bun run dev                    # backend (http://localhost:3000)
cd frontend && bun run dev     # frontend (http://localhost:5173), in a second terminal
```

`DRY_RUN` makes pFMS change nothing outside your machine: network
operations, radio configurations, Driver Station packets and the like are
logged instead of performed, while reads (the radio's status, scans) stay
live ([details](docs/internals.md#dry-run-mode)). Without it, starting on a
non-Linux host exits immediately with an explanation.

```bash
bun run typecheck   # Type-check both backend and frontend
bun run test        # Unit tests (scoring timeline & attribution)
bun run format      # Format all files with Prettier
bun run build       # Compile backend + build frontend
```

## Pages

| Path                | Description                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                 | Home — station configuration form (assign teams to stations)                                                                                                                                                                                                                                                                                                                                                              |
| `/<team#>[-suffix]` | Team control page — self-service match controls on top, then Robots / Radio / Network / Video tabs (`#radio` etc. in the URL)                                                                                                                                                                                                                                                                                             |
| `/overview`         | Admin station overview — status for all six stations                                                                                                                                                                                                                                                                                                                                                                      |
| `/match`            | Match control — dedicated controller page for match lifecycle and history                                                                                                                                                                                                                                                                                                                                                 |
| `/staff?role=…`     | Field-staff ready-up — a referee / scorekeeper / safety monitor marks ready before a match                                                                                                                                                                                                                                                                                                                                |
| `/admin`            | Admin page — the field E-STOP latch (and Cancel match while one runs) above five tabs: Match (field reset, freeplay, control-system policy, Teams & Controls), Wi-Fi (radio changes, Wi-Fi cards, robot scans, 6 GHz watch, firmware), Video (recording streams, retention, timelapse settings), Scoring & integrations (scoring, API keys, Slack, match audio), Access (external access); `/admin#video` etc. open a tab |
| `/network`          | Network page — discovered devices, VLAN status, network stats                                                                                                                                                                                                                                                                                                                                                             |
| `/csa`              | Field network triage — one screen for CSAs and field staff: only detected problems (radio, Driver Station links, robot links, host tables) with what to try, plus a six-station strip; tap a station for its raw numbers                                                                                                                                                                                                  |
| `/queue`            | Match queue — upcoming matches from a schedule and the fill line teams join from their page, per-match shape (1v1, 2v2, 3v3), no-shows, and "Set up next match" (Wi-Fi batch, create, join)                                                                                                                                                                                                                               |
| `/route`            | Route page — choose which robot to talk to when a team has duplicate stations                                                                                                                                                                                                                                                                                                                                             |
| `/logs`             | Logs page — live backend log stream                                                                                                                                                                                                                                                                                                                                                                                       |
| `/test`             | Robot tester — plug in a robot, diagnose network config (requires `TEST_INTERFACE`)                                                                                                                                                                                                                                                                                                                                       |
| `/scores`           | Scoreboard — full-screen TV-optimized score display for casting; ✅ (or `?checks=1`) shows each robot's setup checks between matches ([details](docs/match-system.md#setup-checks-on-the-scoreboard)); 🎥 toggles a per-browser video stream view (wide or square layout); 🪶 (or `?lite=1`) drops glow/gradients/charts for low-memory TVs; 🔇 mutes that display (admins can mute cast displays remotely)               |
| `/setup`            | Setup wizard — guided first-run checks for a new field, with live re-checking and saved progress                                                                                                                                                                                                                                                                                                                          |
| `/timelapse`        | Timelapse viewer (open to anyone) — a practice day as one film, with a scrubbable timeline of the video, matches, robots on the field and enables; see [watching it](docs/match-system.md#watching-it-and-taking-it-away)                                                                                                                                                                                                 |
| `/recordings`       | Recordings (open to anyone) — watch and download every match video and practice run still kept, and browse the field timelapse archive; a logged-in admin also gets disk usage, delete and build-a-film                                                                                                                                                                                                                   |
| `/usage`            | Usage page — per-station link session history (which teams used the field, when)                                                                                                                                                                                                                                                                                                                                          |
| `/support`          | _(redirects to `/`)_ — support is a floating widget available on every page                                                                                                                                                                                                                                                                                                                                               |
| `/api/score/schema` | Scoring API schema — machine-readable API docs for building scoring clients                                                                                                                                                                                                                                                                                                                                               |

## Documentation

The [`docs/`](docs/README.md) directory has the full documentation:

- [Getting started](docs/getting-started.md) — **new field walkthrough**:
  hardware, switch/VLAN planning, firmware, install, first match
- [Setup & deployment](docs/setup.md) — install, systemd, update script,
  reverse proxy, external access
- [Deployment](docs/deployment.md) — keeping it running: systemd vs Docker
- [Configuration reference](docs/configuration.md) — all environment
  variables
- [Match system](docs/match-system.md) — lifecycle, ready check,
  E-Stop/A-Stop, audio, history
- [Scoring](docs/scoring.md) — scoring API and match review
- [Support system](docs/support.md) — issue reports, chat, Slack, admin
  auth
- [Network architecture](docs/network.md) — VLANs, routing, DNAT,
  discovery
- [Robot network tester](docs/robot-tester.md) — the `/test` CSA tool
- [Driver Station Wi-Fi check](docs/ds-wifi-check.md) — the laptop check
  teams run from the Network tab, and where its reports land
- [Backend internals](docs/internals.md) — startup, config flow, graceful
  reload, telemetry

Recent changes are in [CHANGELOG.md](CHANGELOG.md) — start there if you're
upgrading, since the resume countdown and setup auth changes affect
existing fields. Known technical debt lives in [ISSUES.md](ISSUES.md);
in-flight task notes live in [`plans/`](plans/).

## Project Structure

- `src/` — backend (TypeScript, Node.js)
- `frontend/` — React frontend (Vite multi-page app)
- `docs/` — documentation
- `sounds/` — match audio WAV files (charge horn, buzzers, countdowns)
- `scripts/` — development and test harness scripts
- `firmware/` — cached radio firmware binaries
- `dist/`, `frontend/dist/` — build output

## License

[ISC](LICENSE) — © Cameron Tacklind. Contributions and questions welcome
via [issues](https://github.com/TomSawyerLabs/practice-field-management-system/issues).

## Resources

- [FRCture](https://frcture.readthedocs.io/en/latest/) —
  reverse-engineered documentation of FRC network protocols, including:
  - [DS → RIO protocol](https://frcture.readthedocs.io/en/latest/driverstation/ds_to_rio.html)
  - [RIO → DS protocol](https://frcture.readthedocs.io/en/latest/driverstation/rio_to_ds.html)
