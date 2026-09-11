# http://pfms.tsl reload loop — LAN IPv6 clients fail the internal/external check

## Goal

Explain and fix why `http://pfms.tsl` shows the "only available from the local
network" page, says "Backend detected. Reloading...", and reloads forever on
some LAN devices. (Not a service restart loop: the backend never restarted.)

## Environment / context

- steamboat serves pFMS behind Docker Caddy. Site config is managed in the ops
  repo at `servers/steamboat/sites.d/pfms.caddy` (per-change authorization;
  deployed by ops CI on push). Backend on `localhost:9005`.
- Public-only page: `frontend/src/public.html` → `/srv/caddy/pfms/public/index.html`
  (57,258 bytes). Internal UI: `/srv/caddy/pfms/internal/index.html` (1,266 bytes).
  The sizes make the two trivially distinguishable in Caddy's JSON log.
- Caddy access log: `/var/log/caddy/pfms.log` (+ monthly `.gz`, back to
  2026-04-19). Root-only. **`ts` is when the request finished** — for a
  WebSocket that is when it closed; start = `ts - duration`.
- TSL gateway: UniFi UXG-Pro, MAC `e4:38:83:1d:41:cc` (RA/neighbor MAC
  `…:41:ce`), LAN `10.255.0.1` / `2600:1700:459:8a1f::1`. UniFi Network app
  10.6.101. Controller integration API reachable via `ops/unifi` (`.env.local`);
  the legacy `stat/event` endpoints 404 under an API key.

## Exactly how it fails (CONFIRMED 2026-09-10, reproduced from steamboat)

1. The browser resolves `pfms.tsl` → CNAME `steamboat.tsl` → **A 10.255.0.5 and
   AAAA 2600:1700:459:8a1f::1a5**. Dual-stack clients prefer IPv6 and connect
   from their own global address in the same `/64`.
2. `pfms.caddy` decides "internal" with `remote_ip private_ranges` +
   `fe80::/10`. A global IPv6 source matches neither → `@external_needs_auth`
   → Caddy asks the backend `/api/auth/check` with no cookie → 4xx →
   `handle_response` serves the **public page** for `/`.
   Reproduced on steamboat itself: `curl -4 http://pfms.tsl/` → 200, 1,266 B
   (internal UI); `curl -6 http://pfms.tsl/` → 200, 57,258 B (public page).
3. The public page's script opens `ws://pfms.tsl/ws` to detect "am I on the
   LAN yet?". `/ws` is exempt from the auth check (needed for the external
   login flow), so the upgrade succeeds (101) for everyone → the page prints
   "Backend detected. Reloading..." → `location.reload()` after 1 s → `GET /`
   → public page again (304 from cache) → repeat every ~2 s. The log shows
   exactly that alternation (`/ws` 101, `/` 304, …).

The page's assumption ("`/ws` only answers on the LAN") was true when it was
written and silently stopped being true when external access shipped:

| When                       | What                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-04-27 `bbe243d`       | Public page auto-probes `/ws` and reloads when it connects.                                                                                           |
| 2025-10-15 `8225b5f`       | "prevent infinite spin loop": adds the 1 s delay + backoff, keeps the `/ws`⇒reload assumption.                                                        |
| 2025-11-21                 | steamboat gets `…8a1f::1a5` by DHCPv6 (has held it ever since). Gateway advertises its own v6 DNS from 2025-12.                                       |
| 2026-04-17 `bd99637` / -23 | External access feature; Caddy exempts `/ws` from the auth check. **Latent bug from here**: any cookie-less external browser would loop the same way. |
| 2026-05-18 ops `1568051b`  | Caddy config moves to ops CI. Same matchers.                                                                                                          |
| 2026-08-05 03:02:20 PDT    | **TSL gateway reboots** (unattended). Ubiquiti published "UniFi Gateways 5.1.26" that day and the gateway now runs 5.1.26 → firmware auto-update.     |
| 2026-08-05 ~16:55 PDT      | First IPv6 client: sentinel's balls-counter reconnects to `pfms.tsl` over v6 (its IPv4 socket had lived since Aug 3). Only uses `/ws/scores` → fine.  |
| 2026-08-11 13:59 PDT       | First browser victim: a laptop opens `/network` → public page → 17-request loop, gives up.                                                            |
| 2026-09-10 12:46 PDT       | Cameron's laptop: 509 requests in the loop → noticed.                                                                                                 |

Why Aug 5 is the trigger: from the first log line (2026-04-19) to 2026-08-06
**no client ever reached steamboat over global IPv6 on any site**; the only v6
hits were link-local (`fe80::…`, exempt → internal UI). Steamboat's journal
shows a ~75 s upstream outage 03:02:17–03:03:33 PDT (all cloudflared tunnels,
Slack socket, Docker DNS) with no carrier loss on eno1, UniFi records steamboat
as "connected at 03:03:22", and the gateway's `uptime` puts its boot at
03:02:20. After that reboot the gateway's DNS answers AAAA for DHCPv6-leased
client hostnames (`steamboat.tsl` → `::1a5`, `sentinel.tsl` → `::3b3`). Whether
that is a 5.1.26 behaviour change or just a repopulated lease table after the
reboot is not proven (no event log access), but the before/after is.

Not the cause (ruled out): frontend/backend version-mismatch reload (both
`267b652`); backend restarts (up since 2026-07-24; `NRestarts=16` is lifetime
graceful reloads); the `/opt` → `/srv/caddy` symlinks (intact); the ops UniFi
DNS sync (no changes applied in the window; `pfms.tsl` has been
`CNAME steamboat.tsl` since May; the AAAA is not a policy — the only policies
are 34 CNAMEs + 1 forward). The Aug 16 investigation
(`plans/pfms-tsl-iphone-subnet-reachability.md`) checked only the A record.

## Why ops' uptime checks never noticed

1. **There is no pFMS check.** `cloudflare/workers/uptime/src/config.ts` monitors
   `practice-field-scheduler.tomsawyerlabs.com`, `homeassistant…`,
   `steamboat.tomsawyerlabs.com` etc., but neither `pfms.tomsawyerlabs.com` nor
   `pfms.tsl`, and pFMS is not in `deploySites` either.
2. **A check would have been green anyway.** The worker runs on Cloudflare, so
   it is always "external": it would get the public page, which is a 200, and
   `validate()` in `checks.ts` looks only at the status code. Same false-green
   class as `plans/tuzfal-false-green.md`.
3. **The failure is only observable from inside the LAN, over IPv6, without a
   cookie.** Nothing monitors from inside; the only in-house probe is
   `update.sh`'s `curl localhost:9005/health`, which bypasses Caddy entirely.

What would catch it: a steamboat-side `/health` that self-probes
`http://pfms.tsl/` over `-4` and `-6` and returns 5xx when the two differ (fits
the health-cache pattern already used for sentinel/tuzfal), exposed to the
worker like the others. Alternative: the external check sends a valid
external-access cookie and expects the internal `index.html`.

## Fix options

A. **App (this repo): make the public page's probe honest.** Replace "`/ws`
opened ⇒ reload" with "`fetch('/', {cache:'no-store'})` returned something
other than this public page ⇒ reload" (e.g. mark the public page with a
`<meta name="pfms-page" content="public">`), with a retry cap. Fixes every
misclassified or genuinely external client, needs no infra approval, and
would have made the Aug 11 laptop show a static page instead of a loop.
B. **Caddy (ops, per-change OK): add steamboat's own `/64`
(`2600:1700:459:8a1f::/64`) to both internal matchers.** Correct today,
fragile: AT&T-delegated prefix, changes without notice.
C. **DNS (ops/infra, per-change OK): stop publishing the AAAA for
`steamboat.tsl`.** Either steamboat stops taking a DHCPv6 lease (SLAAC only;
UniFi may still learn the address via ND) or UniFi is told not to publish
IPv6 client records (setting not yet located). The ops sync deliberately
emits `pfms.tsl` as a CNAME, so an "A-only pfms.tsl" would need a schema
change there.
D. **Monitoring (ops): the dual-stack self-check above.**

Recommendation: A + D now; then B or C so LAN IPv6 clients get the internal UI
instead of the public page at all. Workaround meanwhile: open an
external-access link (`/admin/auth/<token>`) once on the device — the cookie
makes Caddy serve the internal UI — or turn off IPv6 on that device.

## Progress log

- [x] Mechanism reproduced from steamboat (`curl -4` vs `curl -6`).
- [x] Onset dated to the 2026-08-05 03:02 PDT gateway reboot (firmware 5.1.26,
      published that day); first victims identified from Caddy logs.
- [x] Monitoring gap explained (no pFMS check; external checks see a 200).
- [ ] **(current)** User to choose: A (+D) now, then B or C.

## Things not to do

- Don't touch `pfms.caddy` or `/etc/pfms` on steamboat directly; Caddy is
  deployed from ops, and ops needs per-change authorization.
- Don't "fix" it by removing the `/ws` exemption; the external login flow needs it.
- Don't read a Caddy WebSocket log line's `ts` as its start time.
