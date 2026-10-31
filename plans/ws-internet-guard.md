# Keep internet visitors from running the field over `/ws`

**Status: the guard is live (pFMS `4c4b24a`) and the Caddy change is live (ops `f9bec1c`), both on 2026-10-30. The admin login limit (`26f552c`) waits for the next pFMS deploy.**

## Goal

Close the `ISSUES.md` entry "The WebSocket takes field commands from the
internet". An internet visitor with no credential must not be able to send
field commands, while a stop keeps working for anyone on site with no login.

## How an external connection differs from an on-site one

Read from Caddy's log, the journal's unit list and the ops repo on 2026-10-30,
around 5:30 PM PDT (2026-10-31 00:30Z). Read-only. The live site was not probed
from outside.

| Path                                       | Peer pFMS sees | `X-Forwarded-For` pFMS receives                            |
| ------------------------------------------ | -------------- | ---------------------------------------------------------- |
| On site, `pfms.tsl` or split DNS, to Caddy | loopback       | the client's own address, one entry, private               |
| Internet, through Cloudflare, to Caddy     | loopback       | `<whatever the client sent>, <real client>, <Cloudflare>`  |
| Internet, straight to the origin, to Caddy | loopback       | the real client, one entry. Caddy replaces what was sent   |
| Straight to `:9005`                        | the client     | Whatever it sent. Only read if the peer is a trusted proxy |

`pfms.tomsawyerlabs.com` is proxied by Cloudflare. In the log every external
`/ws` has a Cloudflare `remote_ip`, a public `client_ip` and a `Cf-Connecting-Ip`.
On-site connections have a private `remote_ip`, and no forwarded header arrives
at Caddy. Live `TRUSTED_PROXIES=127.0.0.1/8,::1/128,10.0.0.0/8`, Caddy v2.11.4.
pFMS listens on `*:9005`.

## Decisions (don't re-ask)

- **Clearing an e-stop stays open to anyone on site, and closed from the
  internet** (the user, 2026-10-30).
- **Off-site is a gate in front of the tiers, not a new tier.** `anyone` still
  means anyone on site, so the on-site access table doesn't change at all.
- **A default-deny list for outsiders.** A new message is refused from the
  internet until someone decides otherwise, like the main table.
- **On site means what Caddy means:** private ranges, link-local, or on one of
  this host's networks with global IPv6 widened to /60. If the two disagreed, Caddy
  would serve the operator page to someone whose stop pFMS then refuses.
- **No Caddy or ops change is needed.** The guard works with what is live.
- **The admin login is still open from the internet, on purpose:** it is the
  external login.

## What an external connection keeps

**Please correct this list if it's wrong.** It's `OPEN_TO_OUTSIDERS` in
`src/wsAccess.ts`. It applies to a `/ws` connection with no credential.

| Message                | Why it stays                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `adminLogin`           | This is the external login. It mints the access cookie                                               |
| `adminCheckAuth`       | `AdminAuthGate` asks on load, and an open `/admin` page presents its token again on every new socket |
| `operatorCheckAuth`    | `useBackend` presents a stored operator token on every socket, so a phone on cellular gets no error  |
| `operatorPairRedeem`   | Scanning a pairing QR on cellular. The secret is a single-use, 5-minute credential                   |
| `dsClientDismiss`      | Sent by a tab that already said so. Sets a flag on that one socket and touches nothing on the field  |
| `castReceiverRegister` | A TV may register on this socket. It's already open to everyone on `/ws/scores`                      |

Credentials let a connection through as if it were on site, then the usual
tiers apply: a valid `pfms_access` cookie, an admin login or an operator login.

Public pages need nothing else, measured by walking their imports (and now a
test does it):

- `/scores` uses `/ws/scores`, which this doesn't touch. It takes only
  `castReceiverRegister`.
- `/matches/<token>` and `/practice/<token>` open `/ws` but send nothing. They
  fetch `/api/public/*`. They import only `formatBytes` from `MatchVideoCard`.

Refused from outside with no credential, that a reader might expect to stay:

- **Everything else `anyone`:** every stop and clear, and every team-page action.
- `operatorLogin`: nothing uncredentialed from outside shows the login, and it
  would let a stranger spend the 30-a-minute overall limit and lock out
  volunteers on site.
- `adminSetPassphrase`: a stranger could otherwise claim an unclaimed field. A
  logged-in admin can still change it.
- `subscribe`: no public page uses it, and it hands out match history with share
  tokens, plus usage. See "What this doesn't fix".
- The support widget's messages: the widget shows on `/admin`, but these post to
  Slack, which shouldn't be open to anyone on the internet.
- `requestSetupProbe`, `requestRecordingsInventory`, `requestPracticeDayLink`.

## Findings

- **`trusted_proxies_strict` doesn't protect pFMS on its own.** It fixes Caddy's
  own `client_ip`, but Caddy keeps what a trusted upstream sent when it forwards.
  Reproduced with a throwaway Caddy v2.11.3 on loopback, Cloudflare's address
  stood in for by `127.0.0.1`. Sent `X-Forwarded-For: 10.255.0.50, 203.0.113.7`:

  ```
  X-Caddy-Client-Ip: 203.0.113.7
  {"xff":"10.255.0.50, 203.0.113.7, 127.0.0.1", ...}
  ```

  `getRealClientIp` read the leftmost entry, so it believed the forgery. An
  address check built on it would have looked right and been bypassed by one
  header. By the code, the `/api/auth/check` on-link branch already was: a forged
  on-link address would pass Caddy's forward auth and get the internal UI and
  `/api/*`. That was not tried on the live site, but
  `scripts/test-on-link-access.ts` now covers the case locally. Now read right to left, stopping at the first
  address that isn't a trusted proxy. Through Cloudflare that's the Cloudflare
  edge, which is public, so the verdict is right with no ops change.

- **The cost:** pFMS logs show a Cloudflare address for external visitors, not
  the visitor. Only logs and support metadata use it now. See the staged change.
- Scanners were already sending forged private addresses before the strict fix:
  Caddy's log, which goes back about 19 days, has 106 requests with a private
  `client_ip` from a public peer: 105 on scanner paths like `/wp-json/`, one on
  `/api`, none on `/ws` or `/admin`. Older traffic is gone, so this only covers
  that window.
- `cidr-matcher` matches mapped peers (`::ffff:127.0.0.1`) and returns false for
  junk, so a bad `X-Forwarded-For` entry falls through as an untrusted address
  and reads as off site. `req.socket.remoteAddress` under Bun is `::ffff:127.0.0.1`
  or `::1`.
- **An address check doesn't stop a web page.** A page on any site, open in a
  browser on site, can open `wss://pfms.tomsawyerlabs.com/ws`, and its address is
  on site. So a connection whose `Origin` doesn't match its `Host` counts as an
  outsider too, and its cookie doesn't count. `X-Forwarded-Host` is also accepted,
  for a proxy that rewrites `Host`. Tools with no `Origin` are judged on address.
- `steamboat` has no global IPv6 on any interface today, so neither Caddy's
  `onlink` nor pFMS sees an IPv6 prefix. The /60 widening matters only if it
  comes back.
- With `TRUSTED_PROXIES` unset, a proxy on the same host made everyone look like
  loopback, so on site. It now defaults to loopback.
- `journalctl -u pfms` is the wrong unit. It's
  `practice-field-management-system.service`.
- **This worktree's `node_modules` came from pnpm** (5:21 PM PDT, 2026-10-31
  00:21Z), which ignored `bun.lock`, took TypeScript 5.9.3 and failed the
  pre-commit typecheck at `NudgeSettings.tsx:108`. `bun install --frozen-lockfile`
  fixed it. Master is fine under the pinned 5.8.2. It left untracked
  `pnpm-lock.yaml` and `pnpm-workspace.yaml`, which aren't committed.

## What this doesn't fix

- **Reading.** Every `/ws` socket is still sent field state on connect, from
  anywhere. Logged in `ISSUES.md`. No credential is in it: API keys and access
  tokens go as summaries.
- **The admin passphrase itself:** fixed separately. See "The admin passphrase
  hash" below. An old short passphrase stays as short as it was until someone
  changes it: the limit below slows guessing it, and only that.
- **A device on site that routes out through the internet** (custom DNS, WARP,
  iCloud Private Relay, a VPN) looks external. It already gets the public page,
  which has no stop button, so this adds nothing new for a browser.
- **A field with public addresses on routed VLANs.** A device on a network this
  host isn't plugged into reads as off site. Same in the reference Caddy config.
- **DNS rebinding straight to `:9005`.** The `Origin` check compares against
  `Host`, which a rebinding page controls. Caddy refuses unknown hosts.
- A Cloudflare Tunnel into Caddy would look local, and would fool Caddy equally.
  Ops `plans/caddy-xff-perimeter-spoof.md` step 6 has since checked: nothing routes
  to Caddy that way.

## The limit on outside admin logins

The user said to build it on 2026-10-30. Only strangers count: outside the field
with no credential. They get 5 tries a minute from one address and 30 overall,
sharing `src/loginLimiter.ts` with the operator code.

The trade-off, chosen deliberately: a flood from many addresses can make a
stranger wait, so someone logging in from a new browser off site can be held
up. It can't touch anyone at the field, anyone with an access cookie (every
browser that has logged in as admin has one) or an open admin page, because none
of those count. A blocked try is refused even with the right passphrase.

## The admin passphrase hash

`src/adminAuth.ts` was one round of salted SHA-256 with a 4-character minimum.
It's scrypt now (N=2^17, r=8, p=1: 128 MiB, 270 ms on this PC, measured with the
event loop never more than about 6 ms late), with a 12-character minimum for new
passphrases.

- **Migration:** an old file keeps working. `scrypt` in the file says how the hash
  was made, and its absence means the old SHA-256. The first successful login
  replaces the hash in place and rewrites the file. Session tokens are untouched,
  so nobody is logged out, and a wrong passphrase writes nothing.
- **One way:** once a file is upgraded, a build from before this change can't
  check that passphrase. It fails closed, refusing logins, and doesn't read as
  unclaimed. Sessions already open keep working. Rolling back needs a copy of
  `admin-auth.json` from before the first login.
- **Saves are now atomic,** temp file then rename, and `0600`. Before, a torn write
  read as a field nobody had claimed. On `steamboat` the file was `root:root 0644`
  and the service runs as root in a directory it can write, so the rename works
  and the file becomes `0600`. Nothing else reads it.
- **Logins check one at a time, off the event loop,** with 8 waiting at most; a try
  past that gets the wrong-passphrase answer. On-site tries have no limit (a
  decision above), so without this a flood would cost 128 MiB per try.
- **The operator code isn't the same weakness, and wasn't changed.** It has been
  scrypt since it was built, at Node's default N=2^14, with an 8-character minimum,
  a limit on every try, and no way to try it from outside. `steamboat` has no
  `operator-auth.json` yet. Raising its cost would be a stored-format change for
  little gain.
- `AdminAuthGate` said "Invalid passphrase" a fixed second after every try, so a
  slower check would have flashed it before a good login landed. It now waits for
  the answer.

## Applied: Caddy change

The user approved this exact change on 2026-10-30. Pushed to ops as `f9bec1c`, on top of the perimeter change `e76a8f2`, and live from 8:50 PM PDT (Oct 31 03:50Z). It was staged on local ops branch
`pfms-real-client-ip`, worktree `~/.t3/worktrees/ops/pfms-real-client-ip`, from
`origin/master`, not pushed:

```diff
         reverse_proxy @external_needs_auth localhost:9005 {
             method GET
             rewrite /api/auth/check
             header_up Cookie {http.request.header.Cookie}
+            header_up X-Forwarded-For {client_ip}
...
-        reverse_proxy /ws localhost:9005
-        reverse_proxy /api/* localhost:9005
+        reverse_proxy /ws localhost:9005 {
+            header_up X-Forwarded-For {client_ip}
+        }
+        reverse_proxy /api/* localhost:9005 {
+            header_up X-Forwarded-For {client_ip}
+        }
```

Why it helps:

- The per-address limit counts real visitors instead of Cloudflare edges.
- pFMS logs show the visitor.
- It closes the forged on-link path on the pFMS running now, before this deploy,
  because the only address left in the header is the real one.

It works with either pFMS version, in either order. It fits the ops perimeter
hardening design, which keeps `{client_ip}` placeholders. Checked: `caddy adapt`
passes with the `onlink` blocks removed (the local Caddy doesn't have that
plugin), and all three proxies set the header. The header's effect was seen on the
loopback Caddy: `{"xff":"203.0.113.7"}`. Pushing to ops starts Server Deploys, which
reloads Caddy on `steamboat`.

Seen live, read-only: all 6 pFMS proxies that matter carry the header (3 for each of
the two site blocks), strict mode is on, Caddy reloaded in place, `pfms.tsl` and a
WebSocket upgrade through Caddy answer, and the journal shows a real visitor address
(`99.47.71.x`) where a Cloudflare edge would have shown. Server Deploys and Perimeter
Check both passed. No forged request was sent to the live site.

**The trade-off that came with it:** pFMS's verdict on who is on site now rests on
Caddy's `client_ip`, so on `trusted_proxies_strict`. Without this change, pFMS's
right-to-left read would have held even if strict mode were lost. Ops' static check
and 6-hourly Perimeter Check exist to catch that.

## How it was verified

All on this PC, with a stub engine and radio. No `RADIO_URL`, nothing headed, and
the live site wasn't touched.

- `bun run typecheck`, and `bun test` after rebasing on master: 1067 pass, 0 fail.
- Real sockets in `src/wsAccess.test.ts`: every message outside the list refused
  from outside, by table, with and without a forged address.
- Three deliberate breaks, each failing the tests and then restored: reading the
  leftmost address, no `Origin` check, E-Stop on the outsider list.
- The guard behind a real Caddy v2.11.3 on loopback, live server settings, a
  throwaway script: 10 of 10. Cloudflare-style path: visitor, forged address, forged
  with `Cf-Connecting-Ip` and `X-Real-IP`, and a made-up cookie refused, a real
  cookie stopped. Direct path: field page and tool stopped, another site's
  page refused.

## Progress

- [x] Claim the issue
- [x] Establish what pFMS sees, read-only
- [x] Read the forwarded address right to left, default trust to loopback
- [x] The guard, its list and the `Origin` check
- [x] Tests with a real socket
- [x] Docs and `ISSUES.md`
- [x] Limit on outside admin logins
- [x] Caddy change approved, applied and verified
- [x] Guard deployed by the deploy thread (`4c4b24a`)
- [ ] Admin login limit deployed: the deploy thread's call

## Open questions for the user

1. The list of what an external connection keeps stands as built unless the user
   wants the support widget on `/admin` opened to strangers. Recommendation: no.

## Things not to do

- Don't read the leftmost `X-Forwarded-For` entry for anything that decides
  access.
- Don't use `Cf-Connecting-Ip` to decide access: anyone reaching the origin
  directly can send it.
- Don't add a login in front of a stop on site.
- Don't test on the live site or the real radio. Don't touch Caddy or ops without
  a per-change yes.
- Don't test `/api/auth/check` forgeries against production to prove the finding.
