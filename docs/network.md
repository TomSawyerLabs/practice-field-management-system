# Network Architecture

The VH-113 field radio runs **`PRACTICE`** (recommended) or `OFFSEASON` AP
firmware.
The AP handles DHCP on team VLANs directly; the pFMS host adds VLAN
interfaces and MASQUERADE rules to route traffic between team subnets and
the site network so laptops can reach robots and internet.

```mermaid
graph TD
    Internet["Internet"]
    Router["Site Router"]
    Laptops@{ shape: docs, label: "Team Laptops / Phones"}

    subgraph pFMS["pFMS Host"]
        APP["pFMS App"]
        TRUNK["Trunk Interface<br/>10.0.100.5 (management)<br/>10.TE.AM.254 (per VLAN)"]
        APP -. "configures" .-> TRUNK
    end

    AP["VH-113 AP<br/>PRACTICE firmware<br/>10.0.100.2"]
    Robots@{ shape: st-rect, label: "Robots"}
    VLANs@{ shape: st-rect, label: "VLANs 10–60<br/>10.TE.AM.0/24 each"}

    Internet --- Router
    Router -. "static route<br/>10.0.0.0/8" .-> pFMS

    APP -- "HTTP REST" --> AP
    TRUNK -- "MASQUERADE" --- VLANs --- AP
    AP -- "6 GHz Wi-Fi" --- Robots

    Laptops -. "10.TE.AM.x" .-> Router
    Router -- "guest/laptop network" --- Laptops
```

## Subnets

| Subnet        | CIDR            | Managed by    | Purpose                                               |
| ------------- | --------------- | ------------- | ----------------------------------------------------- |
| Main network  | (site-specific) | Site router   | Servers, infrastructure                               |
| Guest WiFi    | (site-specific) | Site router   | Team laptops, phones                                  |
| Field control | `10.0.100.0/24` | Static        | AP management, FMS                                    |
| Team VLANs    | `10.TE.AM.0/24` | **AP (DHCP)** | Per-team isolation (e.g. team 1234 → `10.12.34.0/24`) |

## pFMS Host Network Responsibilities

1. **VLAN interfaces** — trunk port carries the team station VLANs
   (10–60) tagged; pFMS creates their sub-interfaces and bridges. Field
   control is the trunk's untagged VLAN by default, or any interface you
   name as the field-control interface (`FIELD_CONTROL_INTERFACE` /
   setup wizard), e.g. a tagged `eth0.100` that pFMS creates if it's missing
2. **VLAN IP** — assigns itself `10.TE.AM.254` (configurable via
   `VLAN_HOST_OCTET`) on each active team's VLAN as a routing anchor
3. **Inter-VLAN routing** — IP forwarding + MASQUERADE rules between team
   subnets and the site network
4. **Per-client route preferences** — `ip rule` entries steer individual
   laptop IPs to specific station VLANs (for duplicate team
   disambiguation)
5. **Radio configuration** — HTTP REST to `10.0.100.2`
6. **FMS protocol** — TCP/1750 + UDP/1160 for DS status; UDP/1121 for
   robot control packets
7. **DS↔RIO DNAT** — dynamic PREROUTING rules to route asymmetric RIO→DS
   UDP replies back to the DS laptop
8. **Syslog** — optional syslog server for radio log collection

> **OFFSEASON firmware:** the pFMS host also runs `dnsmasq` per VLAN to
> serve DHCP (gateway = `10.TE.AM.254`), since the AP does not.

## Routing: Guest WiFi ↔ Team Subnets

For laptops on the site's guest/laptop network to reach robots on team
subnets (`10.TE.AM.x`):

1. **Site router** needs a static route: `10.0.0.0/8` → the pFMS host's
   main IP (one-time config, team-agnostic)
2. **pFMS host** has direct access to team VLANs via trunk and routes
   between them and its main interface
3. **Teams** use hardcoded IPs (e.g. `10.12.34.2` for roboRIO) — no DNS
   needed

## Driver Station generations

pFMS speaks to both Driver Station generations on the same ports (TCP 1750
in, UDP 1160 in), telling them apart by the team-number handshake each one
sends when it connects:

|                          | NI FRC Driver Station (roboRIO)   | 2027 FIRST Driver Station (SystemCore)                             |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------ |
| Handshake DS → FMS       | tag `0x18`, team as 2 bytes       | tag `0x1e`: UDP reply port, flags, team as ASCII                   |
| Assignment FMS → DS      | tag `0x19` (station, status)      | tag `0x1f` (station, status, flags, team)                          |
| Control packets FMS → DS | UDP **1121** (1120 = "ask first") | the UDP port named in the handshake — a new one on every reconnect |
| Game data                | UDP tag `0x07`                    | UDP tag `0x20`, max 8 characters                                   |

Control packets to the 2027 DS must come **from** the FMS's UDP port 1160.
Sent from an ephemeral port, the DS showed "connected" but never enabled and
sent no status back; from 1160 it worked. It never sets the "enabled" bit in its
status, even while the robot runs. During a live match its TCP traffic was
only `0x1e` handshakes and `0x1d` keepalives. pFMS only counts a status as a
disable after it has seen that bit set, so it can't see a Disable pressed on
this DS. Whether the DS signals a Disable or an E-Stop some other way is
untested (`plans/field-verification-checklist.md`).

Seen between a 2027 DS and a SystemCore robot on the field: UDP 1110 in
both directions (the robot replies to the DS's source port, so NAT works
without extra forwarding), UDP 1150, and TCP 1250, 1740 and 5810.

The station-assignment reply puts the DS in FMS-controlled mode: its Enable
button disappears. pFMS only sends it for a station the field is
controlling: one joined to a match, or one held out of a match (below). Every
other DS gets **no reply**, keeps its own Enable/Disable, and retries the TCP
connection every ~8 s. Leaving a match drops the DS's connection, so it
reconnects, gets no reply and is back in local control within seconds.

From 2026-09-15 to 2026-10-04 a DS out of a match got a status-2 "not in
match" reply instead (what Cheesy Arena sends). Every DS 26.0 takes that as
"connected, waiting" and hides Enable. It went unnoticed because the DS's
`[ ] \` enable key combo still enables with the button hidden
(`plans/csa-fms-control-status.md`). If a DS out of a match keeps streaming
status to the field (it still thinks it is under FMS control), pFMS drops its
connection again and logs it, every 15 s until the stream stops. That doesn't
always work: some DSes have kept streaming through this for over 40 minutes.

A second laptop for a robot another laptop is driving gets no reply either:
its control packets are dropped anyway, and an assignment would lock it.

When staff set "Freeplay outside matches" to **Held**, an unjoined DS is
instead assigned a slot (FMS-controlled) and held with a stream of disabled
packets whose game data reads `Admin disabled` (`AdminOff` on the 2027 DS,
which shows at most 8 characters), the same mechanism that holds a
policy-blocked control system (`Blocked`). Flipping the switch re-handshakes
every unjoined DS so it takes effect at once. Joining a match lifts the hold.

**E-stop** reaches robots out of a match too. pFMS never sets the e-stop bit
in a control packet, and it doesn't cut any traffic: it takes the DS under
field control and disables it, which is why clearing a field stop really
clears it. An unjoined DS is held like any other (game data `E-Stop`, or
`Field E-Stop` for the field E-Stop) until staff clear the e-stop (the field
E-Stop's Clear on `/match` or `/admin`, or per station on the match page). It
then goes back to local control, disabled, and the driver enables it again.

An e-stop therefore depends on the DS listening to the field:

- A DS in a match is already under field control, so it gets disabled packets
  at once.
- A DS out of a match takes the stop at its next TCP handshake. pFMS drops its
  connection, but a DS in local control usually has none open and retries about
  every 8 s (3 s on the 2027 DS), so its robot can keep running that long. The
  time hasn't been measured (`plans/field-verification-checklist.md`, check 7).
- A DS that ignores the field, or never reaches it, keeps driving its robot
  while pFMS shows it e-stopped: firewalled from pFMS, or connected to the
  robot some other way (tethered, or the robot's own Wi-Fi). Nothing on the
  network stops it. The field's pages have no warning for this yet
  (`ISSUES.md`).

**Team Stop** is the one stop that still cuts traffic, because that DS isn't
under field control and nothing else would stop it. The team's pages offer it
out of a match: **Stop robot** (a team can stop its robot even when its Driver
Station doesn't respond) and **Let it drive again**. pFMS drops every DS→robot
control packet (UDP 1110) going into that station's bridge
(`FORWARD -o br-slotN -p udp --dport 1110 -j DROP`, comment
`pfms-estop-slotN`, a name left from when e-stops used it too). A robot disables
its outputs ~100 ms after its control packets stop, whatever its DS thinks. It
drops nothing but control packets, so cameras, NetworkTables and telemetry are
untouched, and the field keeps seeing the robot. The DS just loses the robot,
drops to disabled, and the team enables from it again once they let the robot
drive. Joining a match clears a team Stop; in a match the team's console has
Disable and E-Stop instead. Startup removes any leftover cut, since no station
starts stopped.

The 2027 DS only includes
FMS support in its Windows build. Reference for the new format: Cheesy
Arena `field/driver_station_connection.go`.

## Host tuning pFMS applies

At startup pFMS enables IP forwarding and raises the kernel neighbor (ARP)
table limits (`net.ipv4.neigh.default.gc_thresh1/2/3` = 2048/4096/8192, and
the IPv6 equivalents). The device-discovery scanner sweeps every configured
team /24 every 10 s, which parks ~250 unresolved entries per slot for a
minute; Ubuntu's default ceiling of 1024 overflowed with four teams and a
full table silently drops packets to any host without an entry (2026-09-13:
three Driver Stations lost their robots mid-match). If `dmesg` shows
`neighbour: arp_cache: neighbor table overflow!`, this is what it means.
Don't fix it by slowing the scanner — that only delays the overflow; the
table size is the fix.

When a Driver Station says it's connected to FMS but the robot never
enables, the journal should show, in order: `DS at <ip>: team N (2027 DS,
control UDP P, flags 0) → assigned <slot>`, then `Match control for <slot>
now sent to <ip>:P/ds2027` **once** rather than every 3 s, then `DS attached
to FMS: <slot>`. To watch the wire:
`sudo tcpdump -i <trunk> -nn -X "host <ip> and udp"`.

Two things that look like faults and aren't: the 2027 DS reconnects its TCP
session every ~3 s while assigned (~5 s while not), advertising a fresh
control port each time — Cheesy Arena doesn't special-case it either, so it
appears to be inherent. And `dhcpcd`'s `route socket overflowed … drained N
messages` is collateral from neighbor-table churn, not a DHCP fault.

A Driver Station is not always behind its slot's NAT gateway: one team's DS
traffic has been seen arriving from an address on another subnet entirely,
with robots driving fine. Don't assume the slot gateway address when
matching a DS to a station.

## DS ↔ RIO UDP and Dynamic DNAT

The FRC Driver Station ↔ roboRIO UDP protocol uses **asymmetric ports**:
the DS sends to the RIO on port 1110 (1115 when FMS-connected), but the
RIO replies to the DS on port **1150** with an unrelated source port. This
breaks conntrack-based NAT (MASQUERADE), which expects replies on the same
port pair.

**TCP traffic (NetworkTables, AdvantageScope)** works fine through
MASQUERADE because TCP's handshake creates a proper conntrack entry.

To fix DS ↔ RIO UDP, pFMS dynamically adds PREROUTING DNAT rules when a
DS connects:

```
iptables -t nat -A PREROUTING -i eth0.slot1 -p udp -d 10.TE.AM.254 \
  -j DNAT --to-destination <ds-laptop-ip>
```

This catches all UDP packets from the robot destined for the gateway IP on
the station's VLAN interface and rewrites the destination to the DS
laptop's guest WiFi IP. The rule is scoped to the gateway IP to avoid
catching multicast/broadcast traffic.

### Drive sessions belong to the robot, not the slot

Which laptop drives which robot is a _drive session_
(`src/driveSessions.ts`). It is keyed by the robot's SSID and the laptop's
IP, never by slot. The slot a robot is on is looked up from the radio config
only when a rule is built on that slot's bridge.

- **Starting.** A laptop announces its team number in every DS handshake and
  UDP status. When that team has exactly one robot on the field, the laptop
  drives it. With two robots of one team, the laptop picks one with the Drive
  button on its team page (or `/route`). A laptop whose session lapsed (DS
  quiet for 20 s) gets the robot it last drove back when it speaks again,
  unless another laptop has taken that robot meanwhile or it pressed Stop.
- **Select is not Drive.** Picking a robot on the team page routes that
  device (its traffic to the team subnet, and its `.local` lookups) to the
  robot, without making it the robot's Driver Station. That's for laptops
  and phones that aren't a DS. A device that drives a robot is routed to
  that robot instead, and Disconnect turns Select's routing off until a
  robot is picked again.
- **Kernel state is derived.** From the sessions and the current radio
  config, pFMS works out which DNAT rules, duplicate-DS blocks and route
  preferences should exist, and one serialised sync adds or removes the
  difference. It runs on every change and every 5 seconds, so a burst of
  handshakes cannot create duplicate rules, a failed iptables call is
  retried, and anything that drifts heals.
- **A slot changing hands needs no special case.** The previous robot is no
  longer on any slot, so its session ends and its rules go; the new robot
  has no session, so its team's laptop takes it. The previous team's laptop
  can keep handshaking from the guest Wi-Fi without effect. When this was
  keyed by slot, that laptop kept the slot, the new team's only laptop was
  refused as a "duplicate DS", and joining a match handed control to the old
  laptop (2026-09-27, slots 1 and 4).
- **A robot moving slots keeps its laptop**, and its rules follow it.
- **"Multiple DSes"** means a second laptop for the same robot. A FORWARD drop
  on UDP 1110 stops its Driver Station's control packets, and its game data
  says so. Everything else that laptop does on the robot's network, such as
  deploying code, cameras and NetworkTables, keeps working. A TCP flap doesn't
  lift this, or the second DS would reach the robot in every gap. It ends when the first laptop goes quiet or stops driving, the
  robot leaves the field, or the second laptop goes quiet for 20 s, stops
  from the Drive button, drives another robot, or is switched to another
  team.
- **Persistent** across DS TCP reconnects (the DS flaps every ~6 s when no
  match is running). A session ends when its laptop has said nothing for
  20 s, when its robot leaves the field, or when the laptop's DS is switched
  to another team.
- **Cleaned up** on hard restart via the `pfms-` comment prefix (same as
  all other rules).
- **Preserved** across graceful restarts (SIGHUP / `systemctl reload`): DNAT
  rules found in the kernel become sessions again when the robot on their
  slot is still of that team, so robots stay connected. Anything else found
  there (rules for robots that left, duplicate copies, leftover blocks) is
  removed.

**Is the laptop's DS reaching its robot?** The packet capture sees every leg
of a legacy NI DS's link (the laptop's control packets as they arrive, the
robot's replies to the gateway, and those replies forwarded to the laptop),
and pFMS logs one line per drive session saying which:
`Robot link up for <ip> on <slot> after Ns: DS → <robot ip>` when it works.
When it doesn't, after a 10 s grace, it logs
`Robot link down for <ip> on <slot>: …`, ending in one of:

- _the DS sends the robot nothing_: the DS on the laptop is stuck, not the
  field;
- _the DS sends to X, but pFMS isn't forwarding that to the robot's network_:
  pFMS is at fault;
- _the DS sends to X and pFMS forwards it, but no robot answers_: the robot is
  off, still coming up, or not at X. This is normal for up to about a minute
  after a robot is added: the DS needs no restart;
- _the robot answers from X, but its replies aren't reaching the laptop_: the
  drive session's DNAT isn't working, so pFMS is at fault;
- _the DS sends to X, but it has no drive session_: nothing forwards the
  robot's replies to the laptop. The DS may not have reached pFMS, or the
  team has two robots and nobody pressed Drive. `… started its drive session
after Ns` follows if it gets one.

A later `Robot link back … after Ns` shows when it recovered (a DS restart,
say). The 2027 DS isn't judged: its robot answers on the DS's own port, which
the capture doesn't watch.

**Short dropouts** (0.5–10 s) are too quick for those checks, but they are
what drops NetworkTables and dashboards. The same capture pairs each control
packet with the robot's reply by sequence number
(`src/robotDropouts.ts`), and logs one `Dropout on <slot> (<team>): …` line
per dropout:

- `the robot answered none of N control packets for Xs`: the DS kept
  sending and the robot went quiet. The line ends in
  `— brownout, battery down to V` when a reply within 2 s before or 3 s after
  had the brownout bit or a battery under 7 V. A brownout that deep cuts the
  robot's network (team 114, 2026-10-29: ~1 s each, down to 6.6 V).
- `the Driver Station sent its robot nothing for Xs (laptop side)`: the
  laptop or its Wi-Fi went quiet.

Only control packets pFMS actually forwarded count towards the robot's
silence, so a team Stop's cut isn't mistaken for one. The team's page
shows a warning with the last 15 minutes' dropouts, what they mean and what
to try, plus a brownout count for the visit. `/csa` lists the robot too.
Like the link checks, this needs a legacy DS routed through pFMS.

**Robots e-stopped in the roboRIO.** An e-stop from a Driver Station (its
button, or the Space bar, even when the DS isn't the focused window) latches
in the roboRIO until it reboots. Nothing in pFMS clears that. The capture
reads it from two bits (`src/robotEStopWatch.ts`): the robot's status byte
says it is latched, and the e-stop bit in the control packets that reached
the robot says who sent it. Each packet is traced to its laptop by source
port, because forwarding rewrites the address but not the port, and the VLAN
of the forwarded copy says which robot it really reached. The journal then
says one of:

- `DS <ip> sent an e-stop to <slot> (<robot>): …`, with whether that laptop
  drives this robot or another one;
- `Robot e-stopped on <slot> (<robot>), N ms after it enabled: …`, with the
  sender and every laptop sending to it at the time. `no DS on the field
network sent it` means a DS is reaching the robot another way, tethered or on
  its own Wi-Fi;
- `Robot e-stop gone on <slot> … the robot rebooted`.

The team's page and `/csa` say to power cycle the robot, and who sent it.
Presses of pFMS's own stop and clear buttons log who pressed them
(`Field E-Stop pressed by <ip> (<hostname>)`). SystemCore robots aren't
covered until their packets are decoded.

A SystemCore robot (2027 DS) answers from UDP 1110 to the DS's own port, in
an unpublished layout. The capture recognizes it by that and keeps its
traffic raw in `systemcore-captures/systemcore-YYYY-MM-DD.pcap` (50 MB a
day, 300 MB total) until it can be decoded, instead of misreading it as NI
packets (`plans/systemcore-robot-capture.md`). Until then, dropouts, link
checks and battery readings cover NI robots only.

The match engine still records a Driver Station per station; the drive
sessions keep it in step, so a station shows the laptop of the robot on it
now.

## Duplicate Team Handling

When the same team is assigned to multiple stations (e.g., two robots from
team 1234):

- **DS address resolution** uses the kernel ARP/neighbor table
  (`ip neigh`) to identify which VLAN (station) a packet came from,
  instead of relying on team number alone. For unique team numbers (the
  common case), the lookup is a direct map check with no subprocess
  overhead.
- **Route page** (`/route`) lets laptops choose which station's robot they
  connect to. Selecting a station adds an
  `ip rule from <laptop-ip> to 10.TE.AM.0/24 lookup <vlan-table>` kernel rule
  directing that laptop's traffic through the chosen station's VLAN. Each
  laptop has one rule, numbered downward from priority 32765. Preferences are
  cleared when station configs change, to prevent stale rules pointing at
  removed routing tables, and startup removes any rule left over from before
  (see [Graceful Reload](internals.md#graceful-reload)).

## Device Discovery

The backend periodically scans each configured team's subnet using
`fping`, pinging `.1–.253` every 10 seconds. Discovered devices (IPs that
have responded at least once) are tracked with up/down status and
first/last-seen timestamps, and broadcast to frontend clients. Results
appear in the **Discovered Devices** section on the Network page and are
cleared when station config is cleared.

Each sweep is pinned to the station's bridge (`fping -I br-slotN`), and so is
the HTTP in the team checks (`curl --interface br-slotN`). A team on two
stations has the same subnet on two bridges, and the routing table would send
everything to one robot, so pinning is what lets each station report its own
robot. The unicast mDNS query that identifies a SystemCore is pinned too (by
the `mdns-socket` addon), so one team can run a roboRIO and a SystemCore side
by side.

Guest laptops are found from conntrack, which can't say which bridge a flow
used. For a team on one station, a laptop talking to its subnet is listed there
and auto-connected. For a team on two stations, a laptop is listed only on the
robot it chose (team page or `/route`) and is never auto-connected: until it
chooses, it stays on whichever route the kernel picks.

### Guest Host Names

Guest-network hosts (DS laptops, phones) are shown by device name wherever
they appear — Discovered Devices, DS chips, "Multiple DSes Detected"
warnings — with the IP shown alongside and used as the fallback when no
name is known. Since the site router owns guest DHCP (no lease file to
read), the backend asks each host directly, in parallel:

- an mDNS reverse PTR query (unicast to UDP 5353 — answered by
  Windows 10+, macOS, iOS, Linux),
- a NetBIOS node-status query (UDP 137 — answered by Windows DS laptops),
- and a reverse-DNS lookup through the system resolver (works when the
  site router registers DHCP client names).

Names are cached (`src/hostnameResolver.ts`) and pushed to clients as a
`hostnames` broadcast.

## mDNS Reflector

With `MDNS_REFLECTOR=true` (requires `VLAN_INTERFACE`), the backend
bridges `.local` queries between the main network and team VLANs so
laptops can resolve `roboRIO-TEAM-FRC.local`, `radio.local`,
`limelight.local` and the like across the routed boundary.
`MDNS_EXCLUDE_REQUESTERS` and `MDNS_LISTEN_INTERFACES` tune which
requesters and interfaces participate.

It is a per-laptop bridge, not a flood:

- **A query is forwarded only to the VLAN of the station that laptop is
  placed on** — its route preference. That preference comes from pressing
  "Drive this robot", from the Driver Station's FMS handshake, or from the
  subnet scanner noticing (in conntrack, every 10 s) that the laptop is
  talking to a team subnet. A laptop that can't be placed gets nothing
  forwarded until it connects to something in its `10.TE.AM.x` range.
- **An answer is sent unicast back to the laptop(s) that asked**, matched
  by name against the questions forwarded in the last few seconds. Nothing
  is multicast onto the laptop networks, and unsolicited announcements are
  dropped. This is what lets several robots share a name: every radio is
  `radio.local`, and a flooded answer from one team used to land in every
  laptop's cache.
- **Each station has its own socket, pinned to its bridge**
  (`SO_BINDTODEVICE`, from the native addon in `native/mdns-socket`). A
  query leaves by the laptop's station's bridge only, and an answer is
  known to come from that station's robot. That keeps two robots of one
  team apart: their bridges share the gateway address, and an IPv4
  multicast interface can't be picked by address when two interfaces hold
  it. Forwarded queries ask for multicast answers (QU bit cleared), since a
  unicast answer to the gateway address would be caught by the drive
  session's DNAT. Without the addon (not Linux, or the prebuilt binary
  missing), pFMS logs an error and robot networks get no mDNS.
- **The bridges' MASQUERADE skips steamboat's own packets**
  (`-m addrtype ! --src-type LOCAL`). Masquerading them did nothing useful,
  and conntrack then dropped a pinned socket's query (EPERM) when the same
  flow had already gone out the other bridge of a two-robot team.

The reflector is optional, so it never takes pFMS down with it. A port it
can't bind or a multicast group it can't join (a host with no default route
yet, an interface whose address isn't up) is logged once and retried every
few seconds, so `.local` names start working once the network is up, with
no restart. A bad `MDNS_EXCLUDE_REQUESTERS` entry is logged and skipped.

## Physical Field Ports

With `FIELD_PORTS` configured (e.g. `201:Port A,202:Port B`), teams can
request a physical Ethernet port from their team control page. The port's
VLAN sub-interface is added as a second member of the station's bridge, so
a laptop plugged into that switch port is on the same L2 segment as the
radio VLAN and can reach the robot directly.
