# Team passwords and network lock

**Status: building.**

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
  half the guest DHCP lease (read from the rule's packet counters every
  minute).
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
- Team page warning while locked: "A laptop at 192.168.x.y is trying to reach
  your robot but isn't logged in", from the DS handshake and reject counters.
- `/login/1234`: password box, "Forgot password", and the return URL.
- `/admin` teams table: password set? lock on? devices; **Reset password**.

### Forgot password

- Button on the login page and the team card. One alert per team per 10 min.
- Sent to Slack (support channel) and to every admin push device, whichever are
  set up. Text: team, time, requesting address, link to `/admin`.
- New: `/admin` can subscribe its device to push (admin push devices list).
  If neither channel is set up, the button says to find a field admin in person.

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
  binding ends after **half the lease time** with no traffic from it. Reason: a
  client renews at half its lease, so an address seen in use at time T can't be
  handed to another device before T + lease/2. The lease time is a setting
  (default 24 h, UniFi's default), so the default idle limit is 12 h.

## Open questions for the user

- (none)

## Progress

- [x] Survey network, auth and notification code
- [x] Draft this plan
- [x] User answers open questions (2026-11-16)
- [ ] `teamAuth.ts` + tests
- [ ] Login page, team card, `/admin` reset
- [ ] Forgot password: Slack + admin push
- [ ] Network lock: chains, portal listener, binding, expiry + tests (fake
      backend)
- [ ] Docs (`docs/network.md`, `docs/internals.md`, README)
- [ ] Headless browser check against a stub engine

## Things not to do

- Don't gate any stop, or anything a Driver Station needs to stop a robot.
- Don't change the default for teams without a password.
- Don't test against the real radio or steamboat's firewall.
