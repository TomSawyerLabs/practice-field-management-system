# Mid-match disables: steamboat's ARP table overflows with 4+ teams configured

## Goal

Explain and fix the 2026-09-13 11:42:17 event where 3045, 972 and 6238 (all
legacy NI Driver Stations) were "disabled" in the same second mid-match and
had to re-enable from their station pages.

## What happened (evidence)

- Journal 11:42:17: `DS disable reported: slot3`, `slot5`, `slot4` — pFMS
  latched each as a driver disable (`disabledBy: 'ds'`). 5940 (2027 DS) was
  unaffected only because the 2027 path requires an enabled→disabled
  transition.
- Kernel log, same window: `neighbour: arp_cache: neighbor table overflow!`
  in bursts at 11:41:57, 11:42:07, 11:42:17 (3,900 such lines today; the
  first at **10:42:59**; zero yesterday). dhcpcd also logged `route socket
overflowed … drained 222 messages` — noise from the same neighbor churn.
- `ip -4 neigh | wc -l` = 1016 against `gc_thresh3 = 1024` (Ubuntu defaults
  128/512/1024). By state: 605 FAILED, 371 INCOMPLETE, 30 REACHABLE. By
  device: ~246 entries on each of br-slot1/3/4/5 — i.e. one entry per
  address of each configured team /24.
- Source: `src/subnetScanner.ts` fpings `.1`–`.253` of every configured team
  subnet every 10 s (device discovery for the network page). Each sweep ARPs
  the whole /24, leaving INCOMPLETE→FAILED entries that live ~60 s
  (`gc_stale_time`). 3 teams ≈ 750 entries (fits); the 4th team configured
  at 10:42 pushed it past 1024. Six teams would be ~1,500.
- Effect of a full table: the kernel cannot create a neighbor entry for a
  new/expired destination, so packets to it are dropped until GC frees
  space — intermittent black-holing of DS↔robot traffic that pFMS routes
  (10.55.x laptops ↔ 10.TE.AM.x robots). A legacy DS that loses its robot
  drops to disabled and reports it; pFMS latched that as the driver's choice.
- 972 re-enabled at 11:42:20, then **E-Stopped themselves at 11:42:59** (the
  station page's E-Stop needs a second tap to fire), which is not
  recoverable mid-match by design. That is the "one team couldn't re-enable".
- Likely also behind some of the earlier "flaky" symptoms today (the 40%
  ping loss to 6238's robot at 11:0x was measured from steamboat, i.e.
  through this table).

## Fix

1. **Immediate (host, needs Cameron's OK):**
   `sudo sysctl -w net.ipv4.neigh.default.gc_thresh1=2048 net.ipv4.neigh.default.gc_thresh2=4096 net.ipv4.neigh.default.gc_thresh3=8192`
   (same for `net.ipv6.neigh.default.*`). Takes effect instantly, no restart.
2. **pFMS startup** sets the same thresholds next to `net.ipv4.ip_forward`
   (pFMS already owns the host's VLANs, routes and NAT), so a fresh install
   is sized for six /24 sweeps plus the guest network. Documented in
   docs/network.md.
3. **Don't latch comm-loss as a driver disable:** a legacy DS status with
   the enabled bit clear AND `robotComms` clear means "I lost the robot",
   not "the driver pressed Disable". pFMS now keeps the station enabled in
   that case (logged once), so the DS re-enables on its own when comms
   return — which is how the official FMS behaves. A disable with comms
   intact is still honored as before.

## Things not to do

- Don't disable the subnet scanner to "fix" this — the network page's
  device list depends on it. Capacity is the right fix; a slower sweep
  merely delays the overflow.
