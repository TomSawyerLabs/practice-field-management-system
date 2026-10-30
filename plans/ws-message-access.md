# WebSocket message access

## Goal

Close two `ISSUES.md` entries: "Admin-page actions the WebSocket accepts from
anyone" and "DS-client operator guard is IP-based and UI-only" (both gaps:
no backend enforcement, and multi-interface laptops slipping through). Every
client → server message type gets an explicit decision, enforced by the
server, without breaking team pages or Driver Station laptops.

## Environment

- `src/wsAccess.ts`: the access table and the DS match (pure, tested).
- `src/websocketServer.ts`: one gate at the top of `ws.on('message')`, and the
  per-connection `dsClientState` push.
- `frontend/src/components/DsClientGuard.tsx`: reads the server's verdict.
- Never test on field hardware. `src/wsAccess.test.ts` uses a stub engine and
  a stub radio, so nothing leaves the process.

## Decisions (don't re-ask)

- **There is no staff login.** `/match`, `/staff`, `/csa`, `/test` and
  `/overview` have no credential, so "staff" can only mean "not a Driver
  Station". Adding a staff credential is a product change and out of scope.
- **Four tiers.** `anyone`; `staff` (refused from a DS, an admin login
  overrides); `admin` (admin login once a passphrase exists, open before that,
  like `setupWritesAllowed`); `adminOnly` (always a login, the existing strict
  checks). Existing checks keep their behaviour; only their wording unified.
- **One table, default deny.** A type missing from the table is refused, so a
  new message fails loudly in development instead of being open by accident.
- **`portBridge` stays open.** The issue listed it as admin, but the team
  page's port selector sends it. Gating it would have broken teams.
- **A stop is never refused.** `adminStopMatch`, `matchAbortCountdown`,
  `stationPauseMatch`, `adminStationDisable` and all the e-stop messages stay
  `anyone`. A false DS match must not block a stop, and e-stop behaviour is
  being reconsidered by the user, so the e-stop _clears_ are untouched too.
- **IP match is hard, hostname match is soft.** Same IP cannot be dismissed.
  Same hostname can ("This isn't a Driver Station"), because teams do share
  names like DRIVERSTATION. The server refuses `staff` messages from a
  hostname match until dismissed, per socket.
- **Test-port and radio tools are `staff`.** `docs/robot-tester.md` calls
  `/test` a CSA tool, and they reprogram live radios.
- **`/csa`, `/test`, `/overview` get a banner, not a block.** They are useful
  read-only on a DS, and a hostname match needs somewhere to be dismissed.

## Findings

- `useBackend` opens `/ws/scores` only on exactly `/scores`, so the cast
  leaderboard page registers over `/ws`: `castReceiverRegister` must stay open
  there.
- `clearMatchHistory` and `refreshAudioDevices` used to fail silently without
  admin; the gate now answers with an error.
- `matchEngine` broadcasts at least every ~2 s while a DS is talking, so the
  push of `dsClientState` needs no timer of its own: with no DS there is
  nothing to report.
- NetBIOS answers in capitals and mDNS as typed, so hostnames compare
  case-insensitively.

## Progress

- [x] Classify every message type (`MESSAGE_ACCESS`)
- [x] Backend gate and per-connection DS verdict
- [x] Frontend reads the verdict; soft block, banner
- [x] Tests: table covers the dispatcher, team page sends nothing gated, real
      socket behaviour per tier
- [x] Docs, `ISSUES.md`

- `scripts/test-setup-auth.ts` passed against a real boot (2026-10-30, `DRY_RUN`,
  dead `RADIO_URL`). The UI was not looked at in a browser; the logic is covered
  by `src/wsAccess.test.ts` and `scripts/fake-backend-ds-guard.ts` shows it.

## Things not to do

- Don't run `scripts/test-setup-auth.ts` assuming `RADIO_URL` holds: it writes
  `radioUrl: http://10.0.100.7` while the field is unclaimed, which is on the
  field subnet. That run only polled it and timed out, but use a build without
  field reachability if `10.0.100.7` ever becomes a real device.

- Don't gate anything the team page sends. `src/wsAccess.test.ts` walks the
  frontend's imports from `roots/control.tsx` and fails if it does.
- Don't touch e-stop behaviour or `pfms-estop-*` here.
