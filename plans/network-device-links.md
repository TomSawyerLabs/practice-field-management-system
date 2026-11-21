# Network page: links to team devices

## Goal

On the Network page (`/network`), each device found on a team subnet gets a
direct way in: a named link to its web page, links to its robot-code camera
streams, and a copy-to-clipboard SSH hint. Requested by the user 2026-11-15
(idj item `01M7GHG5WDGTJ9QHE1HFTG9583`, then review comments in the T3 thread).

## Environment / context

- Probes live in `src/subnetScanner.ts`, run on steamboat as root, with curl
  pinned to the station bridge (`--interface br-slotN`), like `fping -I` and
  `src/interfaceFetch.ts`. A team on two stations has its subnet on two bridges.
- Steamboat curl is 8.12.1: `--max-filesize` aborts a transfer of unknown size
  mid-way (behaviour since 8.4), which is what keeps a probe of a camera stream short.
- Browser links go from the viewer's browser, not from pFMS: they work only from a
  network routed to `10.0.0.0/8` (guest Wi-Fi via the site router's static route).
- Rendered frontend: `frontend/src/components/NetworkPage.tsx`, the table under
  "Discovered Devices".

## Decisions already made (don't re-ask)

- Port 80 web link: shipped `64949cd`, deployed 3:41 PM PST (23:41Z) 2026-11-15.
- Label each web link by what the device is (page title), not "Web". (user: "do it")
- PhotonVision on 5800, linked only when 5800 serves HTML, so a Limelight's 5800
  (its MJPEG stream) is never pulled every minute. (user: "good idea")
- Robot-code camera streams 1181–1190, connect-only probe. (user: "sure")
- SSH: a small icon when 22 is open; click copies `ssh 10.TE.AM.x`. (user)
- 443 isn't probed (same page as 80 on a roboRIO, self-signed cert).
- mDNS lookup log: yes, "on a short log rotation" (user, 2026-11-16). 2 MB + one
  `.1` copy, repeats within 30 s folded into a count.
- Camera stream view: yes (user, 2026-11-16). Built as a pFMS relay (works on
  https, one copy over the robot's Wi-Fi), gated on the radio's QoS BW Limit
  being reported off.
- Stills for limited robots: yes (user, 2026-11-16, "a 0.25Hz poll of the
  picture"). Built `d6796db`: with QoS on or unread, Watch shows a still every 4 s.
- Main display camera: "something the scorekeeper/admin/host/manager can turn
  on and off on the fly" (user, 2026-11-20). Built as a `staff`-tier toggle.
- NT readout: yes to all three (user, 2026-11-16): robot code running ("good
  idea"), connected dashboards ("sure"), FMSInfo the robot received ("sure").

## Survey: Team 2854, 3:4x PM PST 2026-11-15 (TCP connect, then page titles)

- `.1` radio: 80 → 302 to `/configuration`.
- `.2` roboRIO: 22, 80, 443, 1250, 1735, 1740, 5810. Port 80 is "HTML Device
  Configuration", `Server: Embedthis-http` (443 the same).
- `.201`, `.202` Limelights: 22, 80, 5800–5807. Port 80 and 5801 both "Limelight"
  (Apache). 5800 is the stream.
- `.4`: none of the ports tried.
- No CameraServer stream (1181+) was running; that probe is untested on hardware.

## Plan / steps

1. [x] Scanner: `services` per host (web with port + label, camera ports, ssh),
       concurrency-limited curl (24), probes beside the sweeps, tests with a fake
       runner modelled on 2854's devices (`src/deviceServices.test.ts`).
2. [x] Network page: `HostServiceChips.tsx`. Labelled web chips, camera chips,
       an SSH chip that copies `ssh <ip>` and says "Copied" inline (no tooltips;
       falls back to `execCommand('copy')` on plain-http pages).
3. [x] Docs (`docs/network.md` Device Discovery), typecheck, 1326 tests, commit.
4. [x] mDNS lookup log + Network page "Name lookups (.local)" card (`d4a7724`).
5. [x] Inline camera view: relay `src/cameraRelay.ts`, `GET /api/camera`,
       "Watch" chip (`1a53254`). Checked with real curl against a fake MJPEG
       server on this PC (19 frames in 0.6 s, stops after the viewer leaves).
       5b. [x] Stills every 4 s when the live stream is off (`d6796db`).
       5c. [x] NT readout: addon `InterfaceTcp` (`5052de5`), reader + Network page
       "Robot code" lines (`64e8ccf`). Checked in WSL against real ntcore 2026.2.2
       with a dashboard connected (114 ms). Not checked on a robot.
6. [x] Deployed `c3d0436` 1:03 PM PST (21:03Z) 2026-11-20, with mdns-socket
       0.3.0 released first. Not yet seen: Watch through Caddy, stills, NT line.
       After deploy, check Caddy streams the multipart reply without buffering
       (open Watch on the https site), and that the NT lines appear.
7. [ ] Next team day: check chips, a CameraServer stream through Watch, the
       lookup log while a team uses an app that finds devices by name, and ask
       2854 which camera app they use.
8. [x] Main display camera (`8d5041b`): staff toggle under Watch, banner with
       "Take it down", overlay on on-site `/scores`. Not deployed, not seen in a
       browser (no camera to scan off a team day).
9. [x] Caster: user answered "both" (2026-11-20). TVs = step 8. Livestream:
       `/camera-feed` (scores bundle) shows whatever is on the main display,
       full page, transparent when nothing is up, for an OBS Browser Source;
       "Copy livestream link" on the Network page. A path, not a `/scores`
       query, because the http→https redirect drops queries. On site only
       (the relay's rule). Main display and feed retry a failed live stream
       every 5 s. Not deployed, not seen in a browser or OBS.

## NT readout design

- NT4 is a WebSocket at `ws://10.TE.AM.2:5810/nt/<name>`, subprotocol
  `v4.1.networktables.first.wpi.edu` (fall back to `networktables.first.wpi.edu`).
  Text frames are JSON (`subscribe`, `announce`), binary frames msgpack
  `[topicId, timestamp, type, value]`. Subscribe only to `$clients` and the
  `/FMSInfo/` prefix, so the traffic is a few hundred bytes.
- **Must be pinned to the station bridge** (a team on two stations has 10.TE.AM.2
  on two bridges). Bun's sockets can't `SO_BINDTODEVICE`; curl `telnet://` mangles
  0xFF bytes; curl's ws CLI can't send. Chosen: add a pinned TCP socket
  (`InterfaceTcp`) to the existing Rust addon `native/mdns-socket` (repo is public,
  so its CI release build is free), and a small WebSocket + msgpack client in TS.
  Rejected: a python3 helper (steamboat has 3.13, but a system-python dependency).
- Addon release needs a version bump + `mdns-socket-v<version>` tag push before
  the deploy that uses it.
- Server answering = robot code running. `$clients` = dashboards by name and
  address. `/FMSInfo/*` = match number, alliance, station as the robot sees them.

## Ideas proposed, not started (need the user's go)

- **Camera streams for casting / the main display / an inline view.** From the
  user: when the team's radio bandwidth limit is off, offer its streams to a caster,
  a temporary view on the main display, or an inline view in the browser. pFMS
  already knows the limit (`qosEnabled`, `evaluateQosLimit` in `src/teamChecker.ts`).
  Catches: an inline `<img src=http://10.x…>` is blocked as mixed content on the
  https site (works on `http://pfms.tsl`); every extra viewer is another copy of the
  stream over the robot's Wi-Fi link unless pFMS relays one copy.
- **Reading the non-web ports** (user asked what we could show):
  - 5810 / 1735 NetworkTables (NT4 / NT3): a read-only subscribe could show that robot
    code runs, which dashboards are connected (`$clients`), and the FMSInfo the robot
    sees (match, alliance, station). That last one checks pFMS → DS → robot end to end.
  - 1250 Phoenix diagnostics (CTRE): an HTTP API behind Tuner X. It could list CAN
    devices and their firmware. The endpoints differ between Phoenix 5 and 6 and are
    unverified.
  - 1740 is the DS ↔ roboRIO TCP link; don't touch it, it could disturb the team's DS.

## Findings / gotchas

- **onlineSince reset every sweep** (fixed in `d64f6a9`, its own commit). Each
  scan marked every host down and then back up, so the down→up check restarted
  `onlineSince` every 10 s, for team devices and guests alike. It also made every
  host look "just came back", so the service probe re-ran on every sweep.
- The lefthook typecheck checks staged test files against the worktree's other
  files, so a split commit needs the whole worktree set to the staged state
  (back up the feature files first, restore after).
- No visual check in a browser: dry-run discovers no devices. Check on a team day.

- The probe can't use `fetch()` (no interface binding) and a full GET of a stream
  port would make the robot encode video. Connect-only uses curl `telnet://` with
  stdin closed; a refused port exits 7, an open one times out (28) with
  `time_connect` > 0.

## The incident that started this (2854, ~1:20 PM PST 2026-11-15)

2854's usual camera app couldn't find their cameras (probably by mDNS); they
connected once given the IPs. Looked into it at 11:20 PM PST (07:20Z, Nov 16):

- **No record of the queries survives.** The reflector keeps only in-memory
  counters (reset by the 3:41 PM deploy) and logs nothing per query.
- The driving laptop 10.55.18.177 was placed on slot1 from 1:08 PM ("Drive
  started"), so its queries would have been forwarded. A second laptop,
  10.55.216.169, showed up as a DS at 1:29 PM (blocked as a duplicate).
- ~~Likely cause: the app ran on a device pFMS hadn't placed.~~ **Ruled out**:
  the user says it was the DS laptop, which was placed on slot1 from 1:08 PM.
  (An unplaced device's queries are still dropped silently, so that remains a
  gap for phones and second laptops.)
- **Cause unknown.** The path worked on 1700's robot on 2026-10 (tested with a
  Node script from this PC, not a Windows resolver or a real app). Untested:
  whether Windows (or the app) accepts the reflector's unicast answer to a QM
  query sent from port 5353, and how the app discovers cameras at all.
- Laptop mDNS does reach steamboat on VLAN 3 (`eno1.3`): tcpdump saw queries
  from Wi-Fi clients directly. Most VLAN-3 mDNS comes from 10.55.0.1, the site
  router's own mDNS proxy, which pFMS can never place.
- Unverified alternatives: the app discovers by broadcast (never crosses the
  router), or the forwarded multicast query doesn't reach a device behind the
  robot radio (robot-tester.md notes multicast to a robot is unreliable).

## Progress log

- [x] Port 80 Web link shipped and deployed (`64949cd`).
- [x] Port survey of 2854's devices.
- [x] Steps 1–3 (2026-11-15 evening PST), `d64f6a9` fix + feature commit.
- [x] Steps 4–5 (2026-11-16 early AM PST).
- [x] Stills (`d6796db`) and NT readout (`5052de5`, `64e8ccf`), 2026-11-16.
- [ ] Steps 6–9.

## Open questions for the user

1. ~~Caster~~: answered "both"; TVs = main display, livestream = `/camera-feed`.
2. ~~NT readout~~: answered yes, in progress.
3. ~~mDNS evidence~~: answered yes, built (`d4a7724`).

- WSL test rig for the addon: `unshare -rn` gives CAP*NET_RAW for
  SO_BINDTODEVICE on `lo` without sudo; pyntcore via `uv` in `~/ntvenv`. The
  ntcore server writes `networktables.json` into its cwd (delete it). A Python
  ntcore \_client* never connected inside the namespace; a Bun WebSocket did.
- NT4 meta topics (`$clients`) have type `msgpack`: the value is a msgpack
  bin holding packed msgpack, decoded twice.

## Things not to do

- Don't GET stream ports (5800 on a Limelight, 1181+): connect-only or HTML-gated.
- Don't connect to 1740.
- Don't test against field hardware without a team's robot being there and read-only
  probes only (see memory "never test on field hardware").
