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

## Finding (2026-09-10 evening): steamboat's Caddy has no legitimate IPv6 traffic

Across every Caddy site log on steamboat since 2026-04-19, **zero** connections
arrived over IPv6 from anywhere outside the LAN `/64` (link-local excluded).
Cloudflare reaches the origin via `office.tomsawyerlabs.com`, which is
**A-only** (108.65.74.188); the `steamboat - TSL` cloudflared tunnel arrives on
loopback. So IPv6 HTTP on steamboat has exactly one consumer: LAN clients that
got an AAAA — i.e. this bug. Making Caddy (or the host firewall) IPv4-only for
:80/:443 breaks nothing known and needs no addresses in config (Happy Eyeballs
falls back to v4 in ~250 ms).

Also ruled out: trusting `Host: pfms.tsl` as "internal" — the v4 port-forward
lets anyone on the internet hit steamboat with a forged Host header.

## Decisions already made (don't re-ask)

- **Do NOT disable IPv6 on steamboat** (user, 2026-09-11, after I had
  wrongly read "skip IPv6 for now" as permission for IPv4-only listeners).
  "Skip" meant: don't build full IPv6 support yet. The `default_bind`
  change that shipped was a no-op (Go binds 0.0.0.0 dual-stack) and is
  being reverted; the `tcp4/` follow-up was never pushed.
- **Stopping the AAAA for `steamboat.tsl` locally is acceptable** (user,
  2026-09-10) as the interim way to keep LAN IPv6 devices on the internal
  UI. Real IPv6 support later needs an internal test that works without a
  fixed prefix (see "Future: IPv6" below).
- **No ISP-assigned addresses in config** (user): rules out adding
  `2600:1700:459:8a1f::/64` to Caddy's matchers.
- **Trusting `Host: pfms.tsl` as internal is unsafe** — the IPv4 port-forward
  lets anyone forge it. WARP / private-DNS clients can never look local to a
  network test; the external-access cookie (QR / link) is the robust answer
  for them.
- **Public `/health` on `pfms.tomsawyerlabs.com` for uptime** (user approved).
  It maps to the backend's `/health/site`, not `/health`, because `update.sh`
  reads `/health` with `curl -f` as its live-match guard.

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
- [x] **A — public page fixed** (`65e3804`): re-fetches its own URL and reloads
      only when the answer isn't the public page (`<meta name="pfms-page">`),
      capped at 3 reloads / 5 min. Verified in a real browser against a local
      harness: external → stays and polls; flip to internal → one reload;
      fetch/navigation mismatch → stops after 3 with a message.
- [x] **D (app side) — `/health/site` + `LAN_URL`** (`bf5bf78`): probes every
      address of `LAN_URL`, 503 if any serves the public page or a non-pFMS
      page; refusals tolerated. `scripts/test-site-health.ts`: 20/20 pass.
- [x] Ops changes written, **uncommitted**, in the ops checkout:
      `servers/steamboat/global.d/03-ipv4-only.caddy` (`default_bind 0.0.0.0`),
      `/health` → `/health/site` route in `pfms.caddy`, steamboat README note,
      pFMS entry in the uptime worker. Full steamboat config assembled and
      adapted locally; worker typecheck + tests pass.
- [x] User: "do it all" (2026-09-11). Rollout in progress:
  - [x] 1. `LAN_URL=http://pfms.tsl/` appended to `/etc/pfms/environment`
       (backup `environment.bak.20260911-115310`).
  - [x] 2. pFMS master pushed (`9e6a810`), `update.sh` run 11:53 PDT, field
       idle, clean reload. `/health/site` then reported the true state:
       503 "IPv6 serves the public-only page; IPv4 serves the internal UI".
  - [x] 3. ops `2592db2` (IPv4-only Caddy, `/health` route, uptime entry)
       pushed; CI deploy in progress.
  - [x] 4. ops `2069707` refreshes the as-deployed env snapshot.
- [x] CI: steamboat deploy succeeded; `http://pfms.tsl/health` now returns
      the `/health/site` JSON. **But IPv6 still answered**: Go binds
      `0.0.0.0` dual-stack (`ss` shows `*:80`), so `default_bind 0.0.0.0` changed
      nothing. Fix staged in ops (`default_bind tcp4/0.0.0.0`, adapts to
      `tcp4/0.0.0.0:80`), **not pushed** — needs an OK.
- [x] Side effects of the ops push (fleet-wide deploy): sentinel's deploy
      rebooted it and the NVIDIA module is now rejected by Secure Boot
      (restitch down; scoring camera fine) — see ops
      `plans/sentinel-secure-boot-dkms.md`. Unrelated but found:
      `pfms.tomsawyerlabs.com` (and ~10 other steamboat names) serve **expired
      certs** since 2026-09-10 23:00 PDT, Cloudflare answers 526 — already
      diagnosed by another session in ops `plans/steamboat-expired-certs.md`
      (fix = `docker restart caddy`, awaiting OK). Until that lands the uptime
      pFMS check is red for the cert, not for `/health/site`.
- [ ] **(current)** Waiting on: push ops `tcp4/` fix; cert restart; sentinel
      DKMS removal. Then verify `curl -6 http://pfms.tsl/` refused,
      `/health/site` 200, uptime pFMS green.

## Rollout (order matters; each step needs its own OK)

1. **steamboat:** append `LAN_URL=http://pfms.tsl/` to `/etc/pfms/environment`.
   No restart; step 2's reload picks it up.
2. **pFMS:** push master, then deploy via `update.sh` (graceful reload, waits
   out a live match). After this `/health/site` on steamboat reports the true
   state: 503 "IPv6 serves the public-only page" until step 3.
3. **ops:** commit + push the staged changes. CI deploys Caddy (IPv4-only +
   `/health` route) and the uptime worker. Then `/health` should be 200 with
   "IPv4 serves the internal UI; IPv6 refuses connections".
4. **ops:** refresh `as-deployed/steamboat/pfms/environment.as-deployed` to
   include `LAN_URL` (snapshot of live state, so only after step 1).

Pushing ops before step 2 would make the new uptime check red (`/health/site` 404) — hence the order.

## Future: IPv6

To serve pFMS over IPv6 later, the internal test must recognise LAN clients
without a hardcoded prefix — e.g. the backend compares the client address with
the prefixes on its own interfaces (read at runtime), and Caddy asks the
backend via the existing `forward_auth` hop instead of `private_ranges`. Then
drop `03-ipv4-only.caddy`. `/health/site` already checks IPv6 and will say
whether it works.

## Things not to do

- Don't touch `pfms.caddy` or `/etc/pfms` on steamboat directly; Caddy is
  deployed from ops, and ops needs per-change authorization.
- Don't "fix" it by removing the `/ws` exemption; the external login flow needs it.
- Don't read a Caddy WebSocket log line's `ts` as its start time.
