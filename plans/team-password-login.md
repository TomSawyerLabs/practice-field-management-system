# Team passwords and network lock

**Status: built and verified off the field (unit tests, headless browser,
real-kernel netns test). Read-only steamboat checks passed (2026-11-16). Not
merged or deployed: master has another thread's uncommitted work, and the user
said merge only once that thread is done. Then the first real test needs the
user's go-ahead.**

## Goal

Let a team set a password for itself. Laptops and browsers that logged in come
back logged in for 12 months. Optionally, a team can **lock its network**: only
its logged-in laptops can reach its robot (`10.TE.AM.x`). An unknown laptop that
browses to `http://10.TE.AM.x/...` is sent to a pFMS login page, then back to
the page it wanted. Admin can reset a team's password. A "Forgot password"
button alerts admin by Slack, push, or both (whichever is set up).

Most teams won't use any of this. A team with no password sees and gets exactly
what it does today.

## Environment / context

- Laptops are on the site's guest Wi-Fi. The site router routes `10.0.0.0/8` to
  the pFMS host, which forwards into each station's bridge `br-slotN`
  (`FORWARD -o br-slotN -j ACCEPT`, comment `pfms-fwd-in-slotN`) and
  masquerades (`src/networkManager.ts`, `updateStation`). So pFMS sees each
  laptop's real guest-network address on forwarded traffic. That is the hook
  for the lock.
- pFMS's own traffic to robots (FMS, mDNS reflector, checks) is `OUTPUT`, not
  `FORWARD`, so a `FORWARD` lock can't touch it.
- Robot → laptop traffic (DS↔RIO DNAT reverse path) enters `-i br-slotN`, so a
  lock on `-o br-slotN` only sees laptop → robot.
- Existing models to copy: `src/adminAuth.ts` (scrypt off the event loop,
  hashed tokens), `src/operatorAuth.ts` (device list, rate limit,
  `src/loginLimiter.ts`), `src/externalAccessAuth.ts` (365-day HttpOnly cookie).
- Notifications: `src/slackBridge.ts` (`postToChannel`), `src/pushService.ts`
  (web push, VAPID). Push subscriptions today are team-only
  (`src/teamPrefsStore.ts`); admin has none yet.
- `LAN_URL` (e.g. `http://pfms.tsl/`) is the address field devices use.
- Team pages have no login, and everything they send is `anyone`
  (`src/wsAccess.ts`). This feature changes that only for teams that opt in.
- Never test on field hardware: fake `RADIO_URL`, dry-run network backend,
  headless browser.

## Design (proposed)

### Password and devices — `src/teamAuth.ts`, `team-auth.json`

- One password per team number (not per robot). scrypt, like admin. Minimum 8
  characters.
- First set: anyone on the team's page (trust on first use, as admin's
  passphrase works). Changing it: a logged-in device of that team, or admin.
- A login mints a device token: random, stored hashed, with label (browser /
  OS), created, last seen. Lasts 12 months from **last use**, refreshed on every
  visit. Kept as an `HttpOnly` cookie scoped to the team (`pfms_team_1234`),
  365 days, re-set on use, so the browser's copy slides too.
- Rate limit: per address and per team, same shape as operator login.
- Admin reset: clears the password, every device, and the lock.

### Network lock — opt-in, per team

- Off by default, even with a password. A team turns it on from its page.
- Allowed sources: the current address of each logged-in device of that team,
  plus the team's own subnet (two robots of one team on two stations).
- iptables, per station holding the team:
  - `filter FORWARD -o br-slotN -m conntrack --ctstate NEW -j pfms-lock-slotN`
    inserted ahead of the accept. The chain returns for each allowed source,
    rejects everything else (`tcp-reset` for TCP, `icmp-admin-prohibited`
    otherwise) so tools fail fast instead of hanging.
  - `nat PREROUTING -d 10.TE.AM.0/24 -p tcp --dport 80 -j pfms-lockweb-slotN`:
    returns for allowed sources, otherwise `REDIRECT` to a small portal listener
    on the pFMS host. The portal answers every request with a 302 to
    `LAN_URL/login/1234?return=<original URL>`.
  - HTTPS to a robot can't be redirected; it is reset like any other port.
- Binding an address: whenever a logged-in device of the team loads any pFMS
  page or opens the socket, its current address is allowed (and any older one
  of that device is dropped). A returning laptop browsing to its robot hits the
  portal, the cookie logs it in silently, and it bounces straight back — one
  redirect, no typing.
- A binding ends when: another device logs in from that address, the device is
  logged out or reset, or no traffic from that address has hit its rule for
  the guest DHCP lease (read from the rule's packet counters every minute).
- Chain layout (custom chains, so order is fixed and a rebuild is one flush):
  `pfms-lock-<team>`: reply packets of robot-initiated flows return
  (`--ctdir REPLY`), the team's own subnet returns, each bound address returns
  (its counter is the traffic clock), TCP gets `tcp-reset`, the rest
  `icmp-admin-prohibited`. The jump sees every packet, not just new ones, so
  unbinding an address cuts its open flows (a DS's UDP stream never looks
  new to conntrack, so NEW-only counters would miss it too).
- Teardown follows the team: a commit, a team leaving, admin reset, or lock off
  removes its chains. Graceful reload keeps them (rules carry the `pfms-`
  comment prefix, like everything else).

### Pages

- Team page: a **Team password** card (set / change / log out this device /
  logged-in devices list with "log out" each), and the lock switch, with a
  plain warning that a Driver Station laptop that isn't logged in can't reach
  the robot, matches included.
- _Not built (follow-up):_ a team page warning while locked, "A laptop at
  192.168.x.y is trying to reach your robot but isn't logged in", from the DS
  handshake. The page already says a DS laptop must be logged in.
- `/login/1234`: password box, "Forgot password", and the return URL.
- `/admin` teams table: password set? lock on? devices; **Reset password**.

### Forgot password: ask an admin to let this device in

- "Forgot password?" on the login form opens "Who's asking? (optional)" and
  **Ask an admin to let me in** (`POST /api/team-auth/<team>/request`). The
  request is in memory (`src/teamAccessRequests.ts`), 30 min, at most 5
  waiting per team. Its secret is an HttpOnly cookie `pfms_teamreq_<team>`,
  so only the asking browser can collect the login.
- `/admin` → Team Logins shows it at the top, **Let in** / **Deny**
  (`teamAuthDecide`, admin tier). The waiting page polls its status every 3 s;
  the GET that sees the approval mints a device for that browser once
  (`TeamAuth.grantDevice`), sets the login cookie and lets its address through.
  Then the team changes the password from its page if it wants.
- Admins are told by Slack (support channel) and every admin push device, at
  most once per team per 10 min. `/admin` can subscribe its device to push.
  If neither channel is set up, the page says to find a field admin.
- **Here now** (user, 2026-11-16): the card lists teams at the field first
  (pending request, any use of their login in the last 3 h, or on a station),
  then "Other teams with a password (N)" collapsed, with a team-number search.

## What it won't do

- An address can be borrowed: a stranger who gets a logged-in laptop's old
  DHCP lease, or forges its address on guest Wi-Fi, gets through until the
  binding ends. This is a lock for honest mistakes and casual snooping, not a
  security boundary against a determined attacker on the same Wi-Fi.
- Over `http://pfms.tsl` the password crosses Wi-Fi unencrypted, like the admin
  passphrase does.
- Non-browser traffic (DS app, code deploys, SSH) can't be redirected. A laptop
  whose address changed has to open the team page or any robot web page once.

## Decisions already made (don't re-ask)

- **A password gates the team's own settings** (the user, 2026-11-16): Wi-Fi
  changes, internet, ports, saved robots, push and nudge settings, practice
  recording, the lock and the password itself need a device logged in as that
  team, or admin. Stops, queue, ready, joining a match and viewing stay open.
- **An address binding follows the guest network's DHCP lease** (the user,
  2026-11-16: visits run 8 h, sometimes to 2 AM, so 4 h is too short). A
  binding ends after **the full lease** with no traffic from it (the user,
  2026-11-16: "why half? make it until the end?"). Half was the strict bound (a
  client renews at half its lease, so its lease may end lease/2 after it was
  last seen); the full lease accepts that small window, which is within the
  "address can be borrowed" limit the user already accepted. Setting default
  24 h (UniFi's default).
- **Forgot password = a request an admin approves**, not a reset (the user,
  2026-11-16). Reset stays for when a team wants everything wiped.
- **The address-based limit is accepted** (the user, 2026-11-16: hardening it
  would take a lot). So is a DS laptop needing a login when locked.
- **Merge only when master's other thread is done** (the user, 2026-11-16).

## Open questions for the user

- (none)

## Findings / gotchas

- **Custom chains, replaced whole with `iptables-restore --noflush`.** The
  backend had no chain support and `-I` ordering of per-address rules would
  have been fragile. Declaring `:chain - [0:0]` in a `--noflush` restore
  empties and refills it in one commit, so traffic never sees it half written.
  Counters restart on each rewrite, so the poller treats a rewrite as zero.
- **Every packet goes through the chain, not just NEW.** A DS's UDP stream to
  1110 is never NEW again once it's flowing, so NEW-only counters would let a
  binding expire under an active Driver Station, and unbinding wouldn't cut it.
  `--ctdir REPLY` lets replies to robot-started flows through.
- **The lock can't act until the bridges are known** (`TeamLock.activate()`).
  At startup `teamsOnBridges()` is empty; reconciling then would tear down the
  locks a graceful reload kept. It activates on the first commit, or after
  `recoverLostCommit` on a reload.
- **The portal's redirect must be `no-store`**, or a browser caches
  `http://10.TE.AM.2/` → login and keeps going there after logging in.
- **A login page that auto-redirects can loop** if the laptop is logged in but
  can't be let through (address only seen over IPv6, say). A 15 s
  sessionStorage guard stops after one bounce and says why.
- **Real-kernel test** (`scripts/test-team-lock-netns.sh`, WSL Ubuntu 24.04,
  iptables 1.8.10 nf_tables): 16/16 pass, including the REDIRECT → portal
  → 302, tcp-reset, admin-prohibited ping, robot-started flows, moving a
  binding, counters, and cleanup. Steamboat's iptables flavour (legacy vs
  nft) is unchecked: the script must never run on
  the field server itself.
  Check `iptables --version` on steamboat (read-only) before deploying.
- Frontend `eslint` is broken repo-wide (`typescript-eslint` not installed),
  pre-existing and not in the commit hooks.

## Deploy checks

1. Done 2026-11-16 (read-only): steamboat has `iptables v1.8.11 (nf_tables)`,
   the same flavour as the WSL test; `-P INPUT ACCEPT`; port 8180 free.
2. Done: `/etc/pfms/environment` has `LAN_URL=http://pfms.tsl/` and
   `VLAN_INTERFACE=eno1`, so the lock is available and the portal sends
   laptops to the right place.
3. First real use: a test team on a station, lock on, one laptop logged in and
   one not. Needs the user's go-ahead (real field hardware).

## Progress

- [x] Survey network, auth and notification code
- [x] Draft this plan
- [x] User answers open questions (2026-11-16)
- [x] `teamAuth.ts` + tests
- [x] Login page, team card, `/admin` reset
- [x] Forgot password: Slack + admin push
- [x] Network lock: chains, portal listener, binding, expiry + tests (fake
      backend)
- [x] Real-kernel netns test of the lock (`scripts/test-team-lock-netns.sh`)
- [x] Docs (`docs/network.md`, `docs/internals.md`, `docs/support.md`,
      `docs/configuration.md`, README)
- [x] Headless browser check (sandboxed backend, fake radio): set password,
      banner, wrong password, forgot, login + return, open-redirect refused,
      `/admin` card
- [x] Full lease instead of half (user, 2026-11-16)
- [x] Ask-an-admin requests with Let in / Deny, and "Here now" on `/admin`
      (unit tests, headless browser: ask → admin lets in → page carries on to
      `/1234#network`)
- [x] Read-only steamboat checks (deploy checks 1–2)
- [ ] Merge into master, once master's other thread is done (its uncommitted
      timeline-chart work was in the main checkout on 2026-11-16)
- [ ] Deploy (other thread owns deploys: `plans/deploy-log.md`)
- [ ] First real lock test (needs the user's go-ahead)
- [ ] Follow-up: "unlogged DS is trying to reach your robot" warning

## Things not to do

- Don't gate any stop, or anything a Driver Station needs to stop a robot.
- Don't change the default for teams without a password.
- Don't test against the real radio or steamboat's firewall.
