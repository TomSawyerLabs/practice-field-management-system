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

## Cameron's answers (2026-09-13 ~10:20)

1. Usually (a) the TV never appears in Chrome's Cast list. Sometimes (b) slow
   start, common after restarting. (c) drops eventually happen. Never (d).
2. Don't touch this computer's adapters.

## Findings, round 2 (2026-09-13 10:20–10:35)

- **Bonjour is NOT the problem.** `C:\Program Files\Bonjour\mDNSResponder.exe`
  (Bonjour 3.1.0.1, installed 2024-03-18) holds UDP 5353 per-address on
  every adapter while Chrome holds `0.0.0.0:5353`. Suspected Windows
  port-sharing starvation, but `scripts/mdns-port-share-test.py` shows a
  Chrome-style socket (0.0.0.0:5353, SO_REUSEADDR, joined group) receives
  multicast answers fine on VLAN-3 and vSwitch. Theory dropped.
- **The TV's Cast daemon goes dark while the receiver keeps running.** At
  ~09:45 the TV answered mDNS directly, 8008/8009 open, `eureka_info` served.
  At 10:20–10:33: zero answers to `_googlecast._tcp` (multicast AND unicast,
  6/6 misses from the workstation and from steamboat), 8009 closed, 8008
  accepts TCP but never answers HTTP — yet ping, adb 5555, remote 6466/6467,
  8443 and 7000 are all open, and the receiver's `/ws/scores` socket from
  09:40:17 is STILL established on steamboat (scores still on screen). The
  WiiM on the same VLAN answers every query, so multicast delivery is fine.
  So: Chrome can't list the TV because the TV's Chromecast-built-in service
  stopped responding, not because of the network or pFMS. This is (a); a TV
  restart revives it (= "works after restarting", (b)); the daemon dying
  mid-session is (c).
- Monitor running on steamboat: `/tmp/tv-cast-monitor.py` (nohup) appends a
  line to `/tmp/tv-cast-monitor.log` every time the TV's state changes
  (cast mDNS, remote mDNS, 8009, 8008 HTTP, 6466), polling every 20 s. Use it
  to time the daemon's death against TV idle/screensaver/standby timers.

## Timeline 2026-09-13 (monitor + Caddy + journal)

| Time        | Event                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09:40       | Cast started; receiver `/ws/scores` open                                                                                                                                                    |
| ~09:45      | 8009 open, TV answers discovery (Cameron's cast "finally" worked around here)                                                                                                               |
| 10:20–10:43 | Cast daemon dead: 8009 closed, 8008 HTTP dead, no discovery answers; receiver still on screen                                                                                               |
| 10:42:51    | receiver socket closed; 10:44:38 new cast (Cameron recast once the TV was findable again)                                                                                                   |
| 10:43:08    | 8009 open again (daemon recovered on its own)                                                                                                                                               |
| 11:20:01    | 8008 HTTP dead; 11:20:28 8009 closed — daemon dead again, receiver still running                                                                                                            |
| 11:24:17    | pFMS deploy restart; receiver reconnected (0 s + 34 s sessions) then **died** — with the TV's Cast daemon already dead, the TV dropped the receiver instead of the usual watchdog reconnect |
| 11:24–11:43 | Chrome cannot find the TV (daemon dead)                                                                                                                                                     |
| 11:43:06    | 8009 open again; 11:43:43 Cameron's cast succeeds ("it finally found it")                                                                                                                   |

So: the disconnect at 11:24 was triggered by the restart, but only because
the TV's Cast daemon had already died at 11:20; a healthy receiver rides
through restarts (see 09:40 → 10:42 across nothing, and the 30 s watchdog).
The daemon dies roughly hourly and revives 20–60 min later by itself.
`cast-mdns` in the monitor is always 0 — the TV evidently doesn't answer
unicast `_googlecast` queries even when healthy (multicast works); use the
8009 column as the health signal.

**Hypothesis worth testing next:** the receiver page runs the scoreboard
with its video view on a TV with limited RAM; Android may be killing the
Chromecast built-in service under memory pressure. Try casting with the
video view off (🎥 toggle on the receiver's /scores) for an afternoon and
see whether 8009 stays open.

## Lite mode (built 2026-09-13 12:07, commit b017fa3)

🪶 on the scoreboard controls or `?lite=1` turns off the freeplay glow, the
background transitions and the battery charts (static bars instead).
Per-browser, persisted. Test: recast with the receiver in lite mode and
watch `/tmp/tv-cast-monitor.log` on steamboat — if 8009 stays open for an
afternoon, the TV was OOM-killing its Cast service under the full page.

## ROOT CAUSE (2026-09-13, via adb to the TV)

Connected adb to the Warehouse TV (TCL G10 4K, 10.255.11.11:5555) and caught it:

- The Cast receiver process was killed:
  `ActivityManager: Killing 22481:com.google.android.apps.mediashell (adj 915):
Sync transaction while in frozen state`. adj 915 = the receiver had been
  pushed to **cached/background**; Android's app freezer froze it, then a sync
  binder call to the frozen process made ActivityManager kill it. When
  mediashell dies, the Cast control socket (8009) drops and the scoreboard
  disconnects until it restarts — exactly the observed "drops and goes
  undiscoverable, then comes back."
- Why it goes to background: the TV's **screensaver/sleep is on** —
  `screensaver_enabled=1`, `screen_off_timeout=600000` (10 min),
  `sleep_timeout≈1139000` (19 min). After the timeout the screensaver/ambient
  screen takes foreground, caching the receiver → frozen → killed. Matches the
  "after a while / roughly hourly" pattern far better than pure OOM.
- Memory makes it worse but isn't the trigger: 1.8 GB total RAM, ~61 MB free,
  ~390 MB into swap — a backgrounded receiver is reclaimed fast. Lite mode
  (commit b017fa3) reduces the footprint but does NOT stop the screensaver
  from backgrounding it.

### Fix (on the TV — needs Cameron's OK to change the device)

Keep the receiver foreground so it is never cached/frozen:

1. TV Settings → System/Device Preferences → **Screen saver**: set "When to
   start" / put-to-sleep to **Off / Never**. Also disable any Energy Saver
   "switch off screen after".
2. Equivalent over adb (I can run these; they change the TV's settings):
   `adb shell settings put secure screensaver_enabled 0`
   `adb shell settings put system screen_off_timeout 2147483647`
   `adb shell settings put secure sleep_timeout 2147483647`
3. Longer term: a dedicated always-on cast device or the wired HDMI kiosk
   avoids the low-RAM TV's freezer entirely.

## Open questions for Cameron

1. Is the TV showing the scoreboard right now (10:36) even though Chrome can't
   see it? (The receiver socket from 09:40 is still open, so it should be.)
2. Next time it works, note the time so the monitor log can bracket when the
   Cast service dies — and whether the TV had just been restarted.
3. Worth checking on the TV: Settings → Apps → Chromecast built-in (force
   stop / clear cache) and any "network standby" / "Cast in standby" toggle.
   A reboot revives it, but a per-service restart would confirm the daemon,
   not the TV, is what fails.
4. Yes/no on the ops Caddy change (`/cast-config.js` proxy line) — separate
   from this failure, but a real bug for fields that set their own Cast ID.

## Things not to do

- Don't change Caddy/UniFi without per-change authorization (ops repo rule).
- Don't disable IPv6 to "fix" the TV's path (memory: ipv6-stays-on).
