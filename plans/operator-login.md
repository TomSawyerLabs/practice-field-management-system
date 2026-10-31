# Operator login

**Status: built and verified, not deployed. Set a code on `/admin` → Access to turn it on.**

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
- **The internet.** See the first finding below. Fixed separately:
  `plans/ws-internet-guard.md`.

## Decisions (don't re-ask)

- **Both the shared code and device pairing, not one or the other** (the user,
  2026-10-30). They end in the same place: a remembered device with its own
  token, in one list on `/admin`.
- **The code is the one on/off switch.** No code means no logins and no devices,
  and pairing needs a code first. Letting paired devices hold a field locked on
  their own meant that logging out the last one silently unlocked it.
- **The admin login is not reused for operators.** It would give referees Slack,
  API keys and restart, and its 20-token cap and 365-day external access tokens
  don't fit volunteer phones.
- **No allow-by-network.** Volunteers are on guest Wi-Fi alongside teams, and it
  leans on a client address that can be forged.
- One code for all five pages, with no separate roles for CSAs or referees.
- An operator login doesn't override the Driver Station guard; an admin login
  still does.
- The code is at least 8 characters, hashed with scrypt off the event loop, and
  limited to 5 wrong tries a minute per address and 30 overall. Attempts count
  before the slow hash, so a burst can't all get through at once.
- Changing the code logs out devices that typed it, not paired ones.
- A device logging itself out is removed from the list.
- An operator login mints no external access token, and has its own store.
- Queue buttons on `/match` (`queueSetupNext`, `queueSkip`, `queueReplaceTeam`,
  `queueForm`) get a new `operator` tier rather than `staff`. `staff` would have
  opened them to anyone on a field with no code, where they were `admin`.
- The e-stop clears stay `anyone`, including the field E-Stop's. `d7761ad` put them
  back while this was being built: a team may clear its own e-stop from its
  Driver Station, which has no login to give. So the Clear buttons aren't held
  back on a locked page.

## What was built

- `src/operatorAuth.ts`: the code, devices, pairing and rate limit.
- `src/wsAccess.ts`, `src/websocketServer.ts`: the gate and the messages. The
  operator list goes only to admin sockets.
- `frontend/src/components/OperatorAccess.tsx`: `OperatorBar` on the five pages,
  `OperatorOnly` around what needs a login, and the `/admin` card.
- A pairing QR is the current page plus `#pair=<secret>`, so no new page or
  Caddy change is needed, the phone lands where it was going, and the secret
  never reaches a server log.

## Findings

- **The reference deployment passes `/ws` to internet visitors with no check.**
  `pfms.caddy` exempts `/ws` so that external login works, and
  `docs/setup.md` says to keep it that way. The backend has no address or
  `Origin` check on it, and `refusal()` looks only at login and DS match. So by
  reading the config and code, a stranger could send every `anyone` and `staff`
  message, including `matchCreate` and `adminGlobalEStop`. **This was not tried
  against the live site.** `docs/support.md` says pFMS isn't designed for the
  public internet. Fixed by `plans/ws-internet-guard.md`.
- **The address could be forged.** `plans/caddy-xff-perimeter-spoof.md` in the
  ops repo fixed Caddy's own view, and `plans/ws-internet-guard.md` fixed pFMS's,
  which that change didn't reach.
- **`/match` already hides E-STOP in one case.** `DsClientBlock` returns before
  `FieldEStopControl` renders (`MatchControlPage.tsx:469`), so a false hostname
  match takes E-STOP off screen until dismissed. Logged in `ISSUES.md`.
- **`/staff` and `/csa` have no stop controls at all**, including the Safety
  Monitor's page. Logged in `ISSUES.md`. Not caused by this work, but "stops
  stay visible" only means something on pages that have them.
- `adminLogin` had no rate limit, the passphrase hash is one round of SHA-256,
  and the minimum is 4 characters. Fine for a trusted LAN, not for `/ws` as
  exposed. Tries from outside are limited since `plans/ws-internet-guard.md`, and
  the weak passphrase is logged in `ISSUES.md`.
- `POST /api/firmware/upload` and `/download` take no credential and send
  `Access-Control-Allow-Origin: *`. Logged in `ISSUES.md`. A login on `/test`
  doesn't cover them.

## Progress

- [x] Read the access table, admin login, proxy config, pages and docs
- [x] Write this plan and log the side findings
- [x] User chose: both the code and pairing (2026-10-30)
- [x] Backend, frontend, `/admin` card, docs
- [x] Tests: `src/operatorAuth.test.ts`, and a real socket in `src/wsAccess.test.ts`
- [x] Headless Chrome against the built pages, with a stub engine and radio
- [ ] Deployed. Waiting on the user's one big push, then setting a code

## Things not to do

- Don't wrap an operator page in `AdminAuthGate`, or anything else that replaces
  the page: it takes the stop controls away.
- Don't gate anything a team page sends.
- Don't expire a token on a timer, or add a confirm-your-login step to a stop.
- Don't touch Caddy, steamboat or the ops repo for this. Don't test against the
  live site or the real radio.
- Don't change e-stop behaviour here. `issues/stop-cut` owns it.
- Don't show the pairing QR in a dialog: on `/match` it would cover the E-STOP.
