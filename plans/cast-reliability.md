# Casting the scoreboard to the Warehouse TV is unreliable

## Goal

Cameron reports (2026-09-13) that casting `/scores` from Chrome on his
workstation to the shop's Android TV "still seems unreliable". Pin down which
part fails (discovery, session start, session survival) and fix what is ours.

## Environment / context

- TV: "Warehouse TV", TCL Android TV, **wired**, `10.255.11.11` (vSwitch VLAN
  10.255.0.0/20), Cast build 3.72.446070, uptime ~106 days. Cast receiver
  app "TSL pFMS Scores" (app id `260A23F5`) was running during the check.
- Sender: Chrome on Cameron's Windows box, which is multi-homed on Hyper-V
  vEthernet adapters: VLAN-3 `10.55.193.64/16`, vSwitch `10.255.0.77/20`,
  VLAN-FMS `10.0.100.204`, VLAN-99, VLAN-5, WSL, Tailscale. Default route
  via Wi-Fi 172.16.17.1.
- Sender page: `https://pfms.tomsawyerlabs.com/scores` (`frontend/scores.html`,
  Cast SDK, `receiverApplicationId` from `/cast-config.js` with fallback
  `260A23F5`). Receiver loads the same URL; it reaches steamboat over **IPv6**
  (`2600:1700:459:8a1f:…`), so it is judged on-link and gets the internal UI.
- Logs: Caddy `/var/log/caddy/pfms.log` (JSON, root; `ts` = request end,
  WebSocket start = ts − duration). Backend journal logs "Public scores
  client connected" only (no disconnect line, no receiver name).
- steamboat has no avahi; probe mDNS with
  `scripts/mdns-probe.py`: `python scripts/mdns-probe.py <iface-ip>…`, or
  `ssh steamboat python3 - < scripts/mdns-probe.py <ip>…`.

## Findings (2026-09-13 morning)

- **Discovery works from everywhere that matters.** `_googlecast._tcp`
  queries answered on VLAN-3 (via the UniFi mDNS repeater at 10.55.0.1) and on
  the vSwitch VLAN (directly from the TV), from both the workstation and
  steamboat. Not on VLAN-FMS or VLAN-5. The repeater's cached answer can be
  stale (showed `rs=` empty while the TV itself reported the app running).
- **TV reachable:** TCP 8008 and 8009 open from the workstation (source
  10.255.0.77, direct L2). `eureka_info` served.
- **`/cast-config.js` 404s on the internal site** (every sender and receiver
  load). `pfms.caddy` proxies only `/ws`, `/api/*`, `/ws/scores`, `/health`,
  `/admin/auth/*` to the backend; everything else is the static build, which
  has no such file. External clients (through the auth-check branch) got 200
  on 2026-09-12 17:58 — so only LAN users hit it. Harmless today because the
  fallback IDs are the right ones for this field, but it breaks
  `CAST_RECEIVER_APP_ID` for any other field. Fix staged in the ops repo
  (`servers/steamboat/sites.d/pfms.caddy`, working copy only, not committed):
  `reverse_proxy /cast-config.js localhost:9005` next to `/api/*`. **Needs
  Cameron's explicit go-ahead** (ops CI deploys on push).
- **Timeline (Caddy log, 2026-09-12/13):** each cast attempt shows the sender
  page loading, then the receiver loading `/scores` **50–100 s later**
  (17:58:58 → 17:59:51; 19:39:47 → 19:40:56; 09:38:39 → 09:40:17). Cameron also
  tried from an Android phone (10.55.229.206) at 09:35. The delay is between
  clicking Cast and the TV launching the receiver — Chrome-side discovery /
  session start, not pFMS.
- **Receiver sessions end on their own:** receiver `/ws/scores` sockets closed
  at 18:18:13 (after 1101 s, reconnected within 1 s — watchdog works), 18:52:30
  (after 2057 s, **no reconnect** — cast session gone), 21:02:18 (after 4880 s).
  Nothing in the backend restarted at those times (deploys were 19:20–19:39).
  Cause unknown: TV closing the app, TV standby, or Chrome sender tearing the
  session down when its tab/PC sleeps.
- Deploys restart the backend; the receiver's 30 s watchdog reconnects. Not a
  problem unless deploys land mid-match.

- **The TV's path to pFMS is direct, not via Cloudflare.** LAN DNS resolves
  `pfms.tomsawyerlabs.com` to steamboat (10.255.0.5 / `…8a1f::1a5`); the
  receiver's requests carry no `Cf-Connecting-Ip`/`X-Forwarded-For` and
  `remote_ip` is the TV's own global IPv6. So Cloudflare's WebSocket limits
  are not in play. The TV's IPv6 source address rotated between 09-12 and
  09-13 (privacy addresses) — not expected to cut an 18-minute-old socket,
  but worth remembering if drops line up with address rotation.

## Open questions for Cameron

1. Which of these is the "unreliable" you see? (a) the TV never appears in
   Chrome's Cast list, (b) it appears but takes a minute+ to start, (c) it
   starts but the TV drops the scoreboard later, (d) Chrome says "available
   for specific video sites" / greyed out.
2. Does Chrome show the TV when the PC is on only one network (e.g. disable
   the vEthernet adapters except vSwitch)? Multi-homed Windows boxes are a
   known Cast discovery pain point.
3. OK to push the Caddy `/cast-config.js` proxy change?

## Things not to do

- Don't change Caddy/UniFi without per-change authorization (ops repo rule).
- Don't disable IPv6 to "fix" the TV's path (memory: ipv6-stays-on).
