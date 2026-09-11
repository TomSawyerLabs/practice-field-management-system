# http://pfms.tsl stuck in a reload loop — LAN IPv6 clients are treated as external

## Goal

Explain and fix why `http://pfms.tsl` reloads itself every ~2 seconds on some
LAN devices instead of showing the pFMS UI.

## Environment / context

- steamboat serves pFMS behind Docker Caddy. The site config is managed in the
  ops repo at `servers/steamboat/sites.d/pfms.caddy` (per-change authorization
  required; deployed by ops CI on push).
- The public-only page is `frontend/src/public.html`, deployed by `update.sh` to
  `/srv/caddy/pfms/public/index.html` (57,258 bytes; the internal `index.html`
  is 1,266 bytes, which makes the two easy to tell apart in Caddy's log).
- Caddy access log: `/var/log/caddy/pfms.log` on steamboat (root-only; JSON).

## Root cause (CONFIRMED 2026-09-10 from the Caddy access log)

Three things combine:

1. **`pfms.tsl` is now dual-stack.** The gateway (10.255.0.1) answers
   `pfms.tsl` → CNAME `steamboat.tsl` → A `10.255.0.5` **and AAAA
   `2600:1700:459:8a1f::1a5`** (steamboat's global IPv6 address on eno1). The
   Aug 16 investigation (`plans/pfms-tsl-iphone-subnet-reachability.md`)
   recorded a single A record, so either the AAAA is newer or only A was
   checked back then. Dual-stack clients prefer IPv6.
2. **Caddy classifies those clients as external.** `pfms.caddy`'s `@external` and
   `@external_needs_auth` matchers use `not remote_ip private_ranges` +
   `not remote_ip fe80::/10`. A LAN client connecting from its global address
   in steamboat's own `/64` (`2600:1700:459:8a1f::/64`) matches neither, so
   without an access cookie it gets the public-only page for `/`.
3. **The public page reloads whenever `/ws` connects, and `/ws` always
   connects.** `public.html` probes `/ws` and, on open, shows "Backend
   detected. Reloading..." and reloads (added in `8225b5f`, 2025-10-15, to
   auto-recover once a device came back onto the LAN). `pfms.caddy` exempts
   `/ws` from the auth check for the login flow, so for any external-classified
   browser the probe always succeeds → reload → public page again → forever.

Evidence (steamboat, log window 2026-08-03 → 2026-09-11):

- Every `GET /` on host `pfms.tsl` (262) came from a single client,
  `2600:1700:459:8a1f:c8c4:564d:96e2:5a5b`, a Windows Chrome browser in steamboat's own /64.
  257 on 2026-09-10 and more again at 2026-09-11 00:44Z.
- Its requests alternate `/ws` (101) and `/` (304, or 200 with 57,258 bytes =
  the public page) every 1–2 seconds.

Not the cause (ruled out the same day):

- Frontend/backend version mismatch auto-reload (`useBackend.ts`
  `handleServerInfo`): the served UI and the backend are both `267b652`.
- Backend crash loop: the service has been up continuously since
  2026-07-24 14:24 PDT (`NRestarts=16` is the lifetime count of graceful
  reloads).
- The `/opt` → `/srv/caddy` symlinks: intact, same content.

Likely also affected: any real browser reaching `pfms.tomsawyerlabs.com` from
outside without a cookie would loop the same way (not verified — the external
hits in the log are mostly bots that don't run JS).

## Fix options

A. **App (pFMS repo): stop the public page's probe from trusting `/ws`.** It
should reload only when reloading would actually serve something different,
e.g. `fetch('/', { cache: 'no-store' })` and reload only if the response is
not the public page, with a cap on attempts. Stops the loop for every
misclassified or external client, regardless of the Caddy/DNS side.
B. **Caddy (ops, needs per-change OK): treat the site's own IPv6 prefix as
internal**, adding `2600:1700:459:8a1f::/64` alongside `private_ranges` in
both matchers. Fragile: the prefix is delegated by AT&T and can change.
C. **DNS/UniFi (ops, needs per-change OK): stop publishing the AAAA for the
`.tsl` names**, so LAN clients use 10.255.0.5. Needs finding what creates
the record.

Recommendation: A regardless (the page should never loop), plus B or C so LAN
IPv6 clients get the internal UI instead of the "only available from the local
network" page.

Immediate workaround for an affected device: an external-access link
(`/admin/auth/<token>`) sets the cookie that makes Caddy serve the internal UI;
or disable IPv6 on that device.

## Progress log

- [x] Root cause confirmed from the Caddy access log, DNS and steamboat's
      addresses (read-only).
- [ ] **(current)** User to choose fix A / B / C.

## Things not to do

- Don't touch `pfms.caddy` on steamboat directly; it is deployed from ops.
- Don't "fix" it by removing the `/ws` exemption; the external login flow needs
  it.
