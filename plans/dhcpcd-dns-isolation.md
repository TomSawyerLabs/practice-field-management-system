# dhcpcd DNS isolation — stop field-VLAN leases from polluting host DNS

## Goal

PFMS's robot-tester dhcpcd (spawned per field VLAN by `src/robotTestMonitor.ts`)
registers DHCP-provided DNS servers into steamboat's systemd-resolved as
host-wide default-route DNS. A stale lease on eno1.99 left dead DNS server
`10.0.1.1` registered; systemd-resolved retries it, name lookups stall 7–10s,
Caddy's 3s dial timeout trips → 502s on proxied sites (noticed via
coulomb.tomsawyerlabs.com). Fix: field-VLAN DHCP must never alter host DNS,
while robot detection (team-number-from-IP) keeps working.

Success check (from reporter): `resolvectl status eno1.99` shows no DNS scope
from field leases; `journalctl -u systemd-resolved` stops accumulating
"degraded feature set ... 10.0.1.1" entries.

## Environment / context

- Host: steamboat (SSH `ssh steamboat`, passwordless sudo; production, read-only
  without approval — see `.claude/skills/steamboat/SKILL.md`).
- dhcpcd spawned in `src/robotTestMonitor.ts` `startDhcp()` with
  `--oneshot --nobackground --waitip 4 --timeout 1 --noipv4ll --reboot 0 <iface>`.
- Release: `killDhcp()` runs `dhcpcd --release <iface>`.
- `dhcpcd: [manager]` persists inside `practice-field-management-system.service`
  cgroup (dhcpcd 10 manager model) since the Jul 13 ~11:21 PDT restart.
- `/etc/dhcpcd.conf` on steamboat has per-interface sections for field VLANs
  (eno1.10/20/30, …) — ownership unclear (PFMS repo does not ship it; check the
  separate private infrastructure repo).
- Host config changes go through the ops repo, per-change authorization required.

## Decisions already made (don't re-ask)

- Reporter delegates the fix design to PFMS ("you know PFMS's requirements
  best"); host-side fixes should be _proposed via ops repo_, not applied
  directly.

## Plan / steps

1. [x] Read `robotTestMonitor.ts`, confirm PFMS spawns dhcpcd directly.
2. [x] Read-only diagnostics on steamboat (see Findings).
3. [x] Check ops repo — it does not manage `/etc/dhcpcd.conf`; ops-side
       investigation lives at `ops/plans/coulomb-502-pfms-dns-poisoning.md` and
       recommends exactly the PFMS-side fix implemented here.
4. [x] Decided fix: `--nohook resolv.conf --nohook hostname` on the dhcpcd
       spawn + `resolvectl revert <iface>` in `killDhcp()` (self-heals hosts
       polluted by pre-fix leases; `persistent` in /etc/dhcpcd.conf means the
       stale registration would otherwise survive service restarts).
5. [x] Implemented in `src/robotTestMonitor.ts`; docs updated
       (README.md "Setting Up the Test Interface", ROBOT-TESTER.md state machine
       section); typecheck passes.
6. [x] Committed as `aa5e8d4` ("Stop robot radios from slowing down name
       lookups on the field server").
       6b. [ ] **(current)** Push + deploy via `deploy` skill — BLOCKED on user
       confirmation: the branch also carries a peer session's unpushed commit
       `b73a834` (station-chart bandwidth warning line), and the deploy skill
       requires confirming before pushing unpushed commits.
7. [ ] Verify success check on steamboat after deploy:
       `resolvectl status eno1.99` shows no DNS scope, degraded-feature-set log
       entries stop, `getent hosts coulomb.tsl` fast in a loop.

## Findings / gotchas

- PFMS repo contains no dhcpcd.conf and the service file
  (`.claude/skills/update-service/practice-field-management-system.service`)
  doesn't reference one → PFMS does NOT own `/etc/dhcpcd.conf` (root-owned,
  Apr 2025; per-interface eno1.10–60 sections are stale leftovers — PFMS only
  runs dhcpcd on TEST_INTERFACE=eno1.99).
- steamboat: dhcpcd 10.1.0; NO system dhcpcd service exists — the only dhcpcd
  on the host is PFMS's (manager + proxies live in the PFMS service cgroup).
  eno1.3/.4 DNS scopes come from systemd-networkd/netplan, not dhcpcd.
- Pollution path: dhcpcd's `20-resolv.conf` hook → `resolvconf` which on
  steamboat is a symlink to `resolvectl` → per-link DNS in systemd-resolved
  with +DefaultRoute → dead 10.0.1.1 consulted for all lookups.
- `/etc/dhcpcd.conf` sets `persistent` and requests `domain_name_servers` —
  so the stale eno1.99 DNS registration survives dhcpcd exit/service restart;
  cleanup must be explicit (`resolvectl revert eno1.99`, now done in code).
- dhcpcd 10 manager model: PFMS's per-invocation flags reach the manager (the
  manager is started by PFMS's own first invocation, which carries the same
  flags; per-invocation options like --oneshot/--timeout demonstrably work
  through it already).
- eno1.99 currently has NO active lease (BPF BOOTP worker soliciting); the
  192.168.69.8/24 address is PFMS's static factory-probe IP, and the dead DNS
  is leftover from an earlier robot-radio lease.
- No default route currently installed on eno1.99; dhcpcd's ifmetric for it is
  1006 vs 100 for the real uplink default, so route hijack is not a live risk.
  Left routes alone — `routerIp` in the tester UI reads the lease's default
  route via `getInterfaceGateway()`.
- `getInterfaceGateway()` reads the default route on the test iface for the
  `routerIp` UI field — dhcpcd also installs default routes from radio leases.
  DNS is the reported problem; gateway/default-route hijack is a related risk
  worth noting but out of scope unless trivial.
- Robot detection only needs: IPv4 address on the interface (team from
  10.TE.AM.x) + on-link reachability of 10.TE.AM.1/.2 — DNS options are never
  used by PFMS itself. mDNS checks use multicast, not unicast DNS.

## Open questions for the user

1. OK to push (includes peer commit `b73a834`, station-chart bandwidth
   warning) and deploy to steamboat? Recommendation: yes — the peer commit is
   self-contained and passed hooks, and the graceful reload keeps robots
   connected. Until deployed, steamboat's DNS stays degraded (dead 10.0.1.1
   still registered on eno1.99).

## Things not to do

- Don't edit steamboat host config directly — ops repo + per-change approval.
- Don't touch systemd-resolved global config; scope the fix to PFMS's ifaces.
