# pfms.tsl unreachable from iPhone on a different subnet — ARP failure from netmask overlap

## Goal

Figure out why an iPhone on a "slightly different internal subnet"
(10.255.15.240) does not reliably get TCP responses from `pfms.tsl`
(steamboat, 10.255.0.5). Determine the fix and propose it through the ops repo.

## Environment / context

- Host: steamboat (`ssh steamboat`, passwordless sudo; production, read-only
  without per-change approval — see `.claude/skills/steamboat/SKILL.md`).
- `pfms.tsl` → CNAME `steamboat.tsl` → single A record **10.255.0.5** (no
  round-robin; DNS is NOT the problem).
- steamboat is heavily multi-homed on eno1:
  - `eno1` = `10.255.0.5/20` (+ `10.0.100.5/24`)
  - `10.0.100.5/24` is ALSO on `eno1.4` (duplicate address — separate smell).
  - default route: `via 10.255.0.1 dev eno1 src 10.255.0.5`.
- Client: iPhone `10.255.15.240`, on a different VLAN / broadcast domain.
- Infra (field server host config + switch/AP config) is off-limits without
  explicit per-change authorization; changes go through the separate private
  infrastructure repo.

## STATUS: symptom cleared; MECHANISM UNCONFIRMED

**What is actually proven (source-independent, steamboat packet probes):**

- Before: `arping 10.255.15.240` 0/4, `ping` 100% loss, `ip neigh` INCOMPLETE —
  steamboat's broadcast ARP to the phone was unanswered. Phone was on-segment
  (its mDNS reached eno1 with its own MAC 68:ef:dc:44:8a:c9).
- After the user cut PoE to "Red Alliance Station" (Flex Mini): `arping` 4/4,
  `ping` 0% loss, `ip neigh` REACHABLE.
- => The ONLY hard fact: removing Red Alliance Station from the L2 path restored
  ARP reachability to the phone.

**What is NOT proven (do not assert):** the mechanism. The earlier
"UniFi mis-mapped the AP → provisioned the wrong port → re-provisioning fixed
it" story rests entirely on UniFi UI claims (topology map, VLAN warning) that
are UNVERIFIED — and the UniFi topology was already demonstrably WRONG once this
session, so it is an untrusted witness. We also never confirmed the phone was
associated to U7-Pro East (assumed, not checked).

**Competing hypotheses, all consistent with the evidence:**

1. L2 loop caused by Red Alliance Station cabling (loops hit broadcast/multicast
   specifically, can be one-directional/intermittent, vanish when the switch is
   removed) — arguably a BETTER fit for a one-way broadcast(ARP) drop than a
   VLAN-tag gap, which usually kills a whole VLAN both directions.
2. STP topology re-convergence unblocking a path when the switch left.
3. Wrong-port VLAN provisioning (the original story) — possible, unproven,
   UI-dependent.

**Discriminating tests (independent of the UI where possible):**

- Re-power Red Alliance Station while steamboat pings the phone in a loop
  (`ping 10.255.15.240` as neutral oracle). Breaks on rejoin => causal; stays
  fine => the "fix" may have been transient STP convergence.
- If it breaks: check UniFi EVENT LOG (more objective than the map) for MAC
  flapping (a MAC alternating between two ports = loop) and STP topology-change
  bursts at that timestamp. Flaps => loop; their absence alongside a returning
  VLAN warning => leans provisioning.
- Physically trace Red Alliance Station's cabling for a second path/loop.

## Root cause (CONFIRMED) — asymmetric L2 reachability at the Wi-Fi layer

**NOT a subnet-mask/IP problem.** The `/20` is legitimate: `10.255.0.0/20` is a
real flat L2 segment and steamboat has REACHABLE on-link neighbors across the
whole range, including the upper half (`10.255.8.60`, `.9.45`, `.11.11`,
`.11.180`, `.13.46`). The phone is genuinely on this same segment.

The real fault: **steamboat's broadcast ARP for the phone is never answered
(wired→wireless downlink broadcast is being dropped/suppressed by the AP),
while the phone's uplink to the wired side works fine.** No ARP resolution →
steamboat can't build the SYN-ACK frame → TCP handshake never completes.

Evidence (2026-07-19):

- Failing capture (`tcpdump -ni any host 10.255.15.240 and host 10.255.0.5`):
  iPhone SYNs to 10.255.0.5:80 arrive `In` on eno1; steamboat only emits
  repeated `ARP who-has 10.255.15.240 tell 10.255.0.5`, never a SYN-ACK; no ARP
  reply ever returns; iPhone rolls source ports (61716→61717→61718) and gives up.
- Phone IS on-segment: `tcpdump -eni eno1` caught the phone's own mDNS multicast
  sourced from its real MAC **68:ef:dc:44:8a:c9** (NOT the gateway MAC
  e4:38:83:1d:41:ce, NOT a reflector) → native L2 frame, same broadcast domain.
- Active probe from steamboat: `arping -I eno1 10.255.15.240` → 0/4 responses;
  `ping` → 100% loss; `ip neigh show 10.255.15.240` → `INCOMPLETE`. Even seconds
  after the phone transmitted. So steamboat→phone broadcast/ARP is the broken
  direction, not phone→steamboat.
- eno1 `/20` comes straight from DHCP (lease: `NETMASK=255.255.240.0`, server
  10.255.0.1) — steamboat is not misconfigured locally.

**Intermittency explained:** it works only while steamboat holds the phone's
neighbor entry, which it learns PASSIVELY when the phone ARPs first (phone
uplink works). Once that entry ages out (~minutes), steamboat must ACTIVELY ARP
the phone — the broken direction — and silently fails until the phone talks
first again.

## Next confirming step (needs authorization — write on production steamboat)

Add a temporary static neighbor entry and retest from the phone:
`sudo ip neigh replace 10.255.15.240 lladdr 68:ef:dc:44:8a:c9 dev eno1`
If pfms.tsl then loads reliably, it PROVES the data path is fine and only ARP
discovery (the broadcast downlink) is broken. Remove after:
`sudo ip neigh del 10.255.15.240 dev eno1`. This is a runtime kernel-table
change (local, reversible, no config/UniFi touched) — still asked for first per
the steamboat read-only rule.

## Fix direction (UniFi/Wi-Fi side — infra, per-change OK required, via ops)

The fix is at the Wi-Fi layer, not on steamboat's IP config. Investigate on the
WLAN the phone is on:

- **Proxy ARP** toggle on the WLAN (if on but AP lacks the client, ARPs go
  unanswered).
- **"Multicast and Broadcast Control" / broadcast filtering** dropping
  wired→wireless broadcast ARP.
- **Client/L2 isolation** on that SSID.
- Roaming / which AP the phone is on vs. the wired uplink.
  The large flat `/20` (up to 4094 hosts) pressures APs to suppress broadcast and
  likely aggravates this.

## Things not to do

- Don't "fix the mask" — the `/20` is correct and flat; the phone is on it.
  This was the initial (wrong) hypothesis; disproven by REACHABLE upper-half
  neighbors + the phone's native on-segment mDNS.
- Don't chase DNS: `pfms.tsl` resolves to a single stable IP (10.255.0.5).
- Don't assume routing/rp_filter: rp_filter is loose (2); inbound routing is
  fine. The failure is wired→wireless ARP/broadcast delivery.
- Don't change steamboat host config or UniFi directly — ops repo + per-change
  authorization. `ip neigh` diagnostic above also needs an explicit OK.
