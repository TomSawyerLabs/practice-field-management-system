# Operator login

**Status: waiting on the user's choice of option. Nothing is implemented.**

## Goal

Close the `ISSUES.md` entry "Operator pages have no login of their own".
`/match`, `/staff`, `/csa`, `/test` and `/overview` need no credential, so a
team's phone on guest Wi-Fi can open `/match` and run the field. The `staff`
tier in `src/wsAccess.ts` only refuses Driver Stations, which stops accidents
but not someone who means it.

The aim is that running the field takes something a team doesn't have, without
slowing down a volunteer, and without ever slowing down a stop.

## Environment

- `src/wsAccess.ts`: one table, one tier per message. `src/websocketServer.ts`
  checks it once, in `refusal()`, before acting on any message.
- `src/adminAuth.ts`: one shared passphrase, session tokens stored hashed,
  newest 20 kept. `AdminAuthGate.tsx` keeps the token in `localStorage`, and
  `useBackend` presents it again on every new socket, first thing in `onopen`.
- Admin rights belong to the socket (`adminConnections`), so a page can stay
  open across a dropped connection or a deploy.
- `src/externalAccessAuth.ts`: `/admin/auth/<token>` sets a 365-day `Secure`,
  `HttpOnly` cookie. The reverse proxy asks `/api/auth/check` about external
  visitors. This is about who sees the internal UI, not who may act.
- Reference deployment: `servers/steamboat/sites.d/pfms.caddy` in the ops repo
  (read at `edf48bd`, not changed). Private addresses, which include guest
  Wi-Fi, get the internal UI with no check.
- Never test on field hardware. Tests use the stub engine and stub radio in
  `src/wsAccess.test.ts`, and any real boot uses a fake `RADIO_URL`. Browser
  checks run headless.

## Who uses each page

| Page        | Who                                                      | Device                                              | What it can do                                                                                   |
| ----------- | -------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/match`    | The match controller: a mentor or volunteer at the field | Their phone, a tablet or a spare laptop             | Create, hold to start, resume, kick, force ready, options, Wi-Fi holds, plus every stop          |
| `/staff`    | Head referee, scorekeeper, safety monitor (`?role=`)     | Their own phone, often opened from a QR code        | Mark a role ready, with a heartbeat every 2 s. Line refs run challenge hand-offs and penalties   |
| `/csa`      | A CSA walking the field                                  | A tablet (`docs/getting-started.md`) or phone       | Mostly reading. Enable, force ready, kick, apply config                                          |
| `/test`     | A CSA at the test port                                   | A laptop or tablet                                  | Reprograms radios and updates firmware                                                           |
| `/overview` | Anyone watching the field                                | Any browser. Not known to be on a kiosk or TV today | Mainly a status grid. Its station cards also send team-tier messages and test port mode requests |

This assumes volunteers change from day to day and use their own phones on
guest Wi-Fi; correct this if it is wrong, since the recommendation leans on it. `/match` and `/staff` send a Driver Station to a phone with a QR code,
so that phone has to be able to get in within seconds. The field is served as
both `http://pfms.tsl` and `https://pfms.tomsawyerlabs.com`. Those are separate
origins, so a browser would log in once for each.

These pages stay as they are: team pages, `/scores` and Cast TVs, `/queue` and
`/admin` (already behind `AdminAuthGate`), the logs and network pages, and the
scoring API, which has its own keys.

## What a login must never get in the way of

1. **Stopping a robot.** Stop match, abort countdown, pause, station disable and
   all the e-stops stay `anyone`. This covers more than the server table:
   - The stop controls must be on screen and working before login. **Don't
     reuse `AdminAuthGate` on operator pages**: it replaces its children, so it
     would take the E-STOP off `/match`.
   - No dialog may cover them, and nothing may ask for a login after a stop is
     pressed.
   - A controller who loses their login partway through keeps Pause and Stop,
     and letting go of Hold to Start still aborts, since that sends the
     `anyone` message `matchAbortCountdown`.
2. **Teams and Driver Stations.** Nothing a team page sends moves tier.
   `src/wsAccess.test.ts` already fails if one does. A DS laptop has no login
   to give, and this must stay true for it.
3. **A running match.** Logins never expire on a timer. A dropped Wi-Fi or a
   deploy reconnects and presents the token silently, as admin does today.
   Changing the credential logs operators out but leaves the match running.
4. **Displays.** `/scores`, Cast TVs and `/ws/scores` stay open, and viewing
   `/overview` or `/csa` needs no login. The gate is on actions, not on seeing.
5. **A new field.** pFMS ships to other fields and has a no-hardware demo. With
   no operator credential set, everything works as it does today. So do the
   scripts that send match messages (`scripts/e2e-match-harness.ts`,
   `scripts/fake-six-teams.ts`).
6. **The handoff.** A phone that scanned the DS block's QR code must get to a
   working page quickly, typing on a phone keyboard at the field.
7. **Getting locked out.** A lost credential can't stop the field for the day:
   an admin login still does everything, and admin can reset it.

## What a login won't fix

Say this plainly so the login isn't mistaken for more than it is.

- **`anyone` messages stay open.** That is every stop, so a team phone can
  still press the field E-Stop. It also covers `station`, which has no proof of
  team: `/overview`'s station cards can clear another team's Wi-Fi today.
- **Reading stays open.** Every `/ws` socket gets the field state.
- **The credential can be read off the air.** On `http://pfms.tsl` a login
  crosses Wi-Fi unencrypted, as the admin passphrase does today.
- **The internet.** See the first finding below. An operator login covers the
  `staff` messages there, but not the `anyone` ones.

## Options

### A. One shared operator code, separate from the admin passphrase (recommended)

Admin sets it on `/admin`, and it can be changed there at any time. A volunteer
types it once per browser and the device stays logged in.

- **On a page without it:** everything is visible, stops work, and a slim
  "Enter the operator code" bar takes the place of the locked actions.
- **For:** one thing to tell a new volunteer, and no admin needed on the day.
  It also works on any network and at any field. It builds directly on the
  existing token pattern, and it keeps volunteers away from Slack, API keys
  and restarts.
- **Against:** everyone shares it, so one leak means changing it for everyone,
  and a log can't say who pressed Start. A mentor who learned it last month
  keeps it until it changes.
- **Size:** medium. Backend store and tier change, a login bar on five pages,
  an `/admin` card, tests and docs.

### B. Pair each device

An admin, or a device already paired, shows a one-time QR code, and scanning it
pairs the new phone. `/admin` lists the devices with names and can revoke one.

- **For:** no secret to leak or type, one device can be cut off alone, and the
  logs can name the device. It fits the QR habit `/match` and `/staff` already
  have.
- **Against:** someone paired has to be there for every new volunteer, so the
  first morning or a dead phone means finding an admin. Clearing a browser or
  using a private tab means pairing again.
- **Size:** large. Device store, pairing flow, revocation UI, and everything A
  needs on the pages.

### C. Require the admin login for operator actions

Change `staff` to mean an admin login, and add no new credential.

- **For:** the smallest change, and nothing new to manage.
- **Against:** every referee gets Slack settings, API keys, restart and
  deleting recordings. Only 20 tokens are kept, so a busy day logs people out,
  which is exactly what a match must not suffer. Each admin login also mints a
  365-day external access token, so every volunteer phone would get the
  internal UI from home.
- **Size:** small, but the cost lands on the field's security.

### Considered and dropped: allow by network

Refusing `staff` messages from guest Wi-Fi needs no prompt at all, but
volunteers are on guest Wi-Fi with teams, so it would lock out the people it is
meant for. It would also need configuring for each field, and it leans on the
same client address the first finding below shows can be forged.

## Recommendation

**Option A.** The threat is a curious student or a mischievous team, on a field
where volunteers change daily, so the cheapest thing that keeps them out and
never gets in a volunteer's way wins. Pairing (B) can be added later as a
faster way in, without changing anything in A. It shouldn't come first, because
it makes the worst morning harder: one person at the field with no admin.

Defaults within A, decided unless the user says otherwise:

- The tier stays called `staff`. It means an operator login, or an admin login,
  once a code exists. With no code set, it behaves as it does today.
- One code for all five pages. CSAs and referees get no separate roles.
- The Driver Station guard stays: an operator login doesn't override it, and an
  admin login still does.
- The code is at least 8 characters, stored with a slow salted hash and limited
  to a few wrong attempts a minute per address, because `/ws` is reachable by
  strangers. A short PIN is not safe here.
- An operator login mints no external access token.
- Operator tokens get their own store, so they can't push admin tokens out.
- The queue buttons on `/match`'s Next up card (`queueSetupNext`, `queueSkip`,
  `queueReplaceTeam`, `queueForm`) move from `admin` to `staff`. They are `admin`
  today, so a controller without the admin login is refused.
- The e-stop clears stay with `issues/stop-cut`. Once that lands, the clears
  fit `staff` naturally.

## Plan if A is chosen

1. Credential store with its own file, token list and rate limit, plus
   `operatorLogin` and `operatorCheckAuth` messages, added to `logRedact`.
2. `staff` tier checks it in `refusal()`, and the queue buttons move tier.
3. `useBackend` presents the token first in `onopen`, like admin.
4. A login bar on the five pages, with stops outside it. `/staff` sends no
   heartbeat until unlocked.
5. An `/admin` card to set, change and clear the code, and a mention in setup.
6. Tests: every stop still works from a locked socket, a locked socket can't
   send `staff` messages, no code means no change, tokens survive a reconnect,
   and wrong attempts get limited.
7. Headless browser check with a fake `RADIO_URL`: E-STOP visible and working
   on a locked `/match`.
8. Docs: `docs/internals.md`, `docs/match-system.md`, `docs/support.md`,
   `docs/getting-started.md`.

## Findings

- **The reference deployment passes `/ws` to internet visitors with no check.**
  `pfms.caddy` exempts `/ws` so that external login works, and
  `docs/setup.md` says to keep it that way. The backend has no address or
  `Origin` check on it, and `refusal()` looks only at login and DS match. So by
  reading the config and code, a stranger could send every `anyone` and `staff`
  message, including `matchCreate` and `adminGlobalEStop`. **This was not tried
  against the live site.** `docs/support.md` says pFMS isn't designed for the
  public internet. Logged in `ISSUES.md`, since it needs fixing whichever option
  wins.
- **The address can be forged until an ops change is applied.** Any fix for the
  above that trusts the client's address depends on
  `plans/caddy-xff-perimeter-spoof.md` in the ops repo (fix staged, not
  applied). Changing that is the user's call, per change.
- **`/match` already hides E-STOP in one case.** `DsClientBlock` returns before
  `FieldEStopControl` renders (`MatchControlPage.tsx:469`), so a false hostname
  match takes E-STOP off screen until dismissed. Logged in `ISSUES.md`.
- **`/staff` and `/csa` have no stop controls at all**, including the Safety
  Monitor's page. Logged in `ISSUES.md`. Not caused by this work, but "stops
  stay visible" only means something on pages that have them.
- `adminLogin` has no rate limit, the passphrase hash is one round of SHA-256,
  and the minimum is 4 characters. Fine for a trusted LAN, not for `/ws` as
  exposed. Logged in `ISSUES.md`.
- `POST /api/firmware/upload` and `/download` take no credential and send
  `Access-Control-Allow-Origin: *`. Logged in `ISSUES.md`. A login on `/test`
  doesn't cover them.

## Progress

- [x] Read the access table, admin login, proxy config, pages and docs
- [x] Write this plan and log the side findings
- [ ] User picks an option
- [ ] Implement

## Open questions for the user

1. Which option: A, B or C? Recommendation: A.

## Things not to do

- Don't wrap an operator page in `AdminAuthGate`, or anything else that replaces
  the page: it takes the stop controls away.
- Don't gate anything a team page sends.
- Don't expire a token on a timer, or add a confirm-your-login step to a stop.
- Don't touch Caddy, steamboat or the ops repo for this. Don't test against the
  live site or the real radio.
- Don't change e-stop behaviour, or the clears, here. `issues/stop-cut` owns them.
