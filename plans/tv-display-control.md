# TV / Display Control

## Goal

Let pFMS turn a field's TV on and put the scoreboard on it, by itself, on a
network we know nothing about — no Home Assistant, no cloud, no manual remote.

**Both display modes are first class** (Cameron, 2026-08-16):

1. **Cast** — pFMS casts `/scores` to a Chromecast / Google TV receiver.
2. **HDMI** — a computer wired to the TV runs a kiosk browser on `/scores`.

Neither is the "real" one. A field picks whichever suits its hardware, and pFMS
has to support both properly.

## Why this plan exists separately

This plan is the pFMS-side product design, and it is meant to stand on its own —
pFMS is a public tool and anyone should be able to act on this without access to
a particular field's infrastructure. The hardware investigation that produced
the findings below (TV identification, port behaviour in standby, keycode
testing, and the host-side kiosk build) was done against one reference field and
lives in a separate private infrastructure repo. Everything load-bearing from it
is restated here.

Related pFMS plans:
`setup-wizard.md` (where provisioning UI lives), `multi-site-adoption.md` (the
ship-to-other-fields constraint that rules out HA), `scoreboard-video-mode.md`
and `scoreboard-display-mute.md` (the page being displayed).

## Decisions already made (don't re-ask)

- **No Home Assistant dependency.** HA happens to exist at the field this was
  developed against, but cannot be assumed anywhere else — and pFMS is a public
  tool installed on networks we know nothing about. The control path ships
  inside pFMS.
- **Cast and HDMI are both first class.** Do not let one become the default and
  the other an afterthought.
- **Android TV Remote protocol (TLS, ports 6466/6467) is the control channel**,
  not ADB. ADB would require every field to unhide Developer Options and enable
  USB debugging, and leaves a broad unauthenticated control surface on the LAN.
  The remote protocol needs only a pairing step and is cert-authenticated.
- **Pairing UI goes on the admin page**, with the setup wizard linking to it.
  Pairing must be re-runnable (lost certs, factory resets, swapped TVs), so it
  cannot be wizard-only.
- **The kiosk browser gets its own unprivileged user, chosen at setup**
  (decided 2026-08-16). Explicitly **not** the daemon's user: pFMS runs as
  **root** on at least the reference deployment (it manages VLANs, radios and
  host networking), and rendering arbitrary web content as root is not
  acceptable. Equally, do not hardcode any real person's account — that is
  meaningless on someone else's install. Setup should propose a name
  (`pfms-kiosk`) and create the account if it does not exist.
- **The host kiosk build ships in pFMS too** (decided 2026-08-16), not as
  private per-site infrastructure config. A field choosing HDMI mode should get
  the whole thing from pFMS: the X server, the browser in kiosk mode, the
  dedicated user, and screen-blanking control. This is consistent with what
  pFMS already does at OS level — `networkManager`, `radioManager`, systemd vs
  docker deployment modes, firmware updates — and it is the only way HDMI mode
  is genuinely first class for someone who is not us.

## What is already in the tree

Casting is not new here — it is threaded through pFMS already:

- `SetupPage.tsx` offers both branches: **"No Chromecast? Open this on the TV
  instead"**, beside a "Casting works ✓" toggle backed by `castVerified`.
- `setupProbe.ts` → `probeScoreboard()` has a `cast` check warning that Google
  Cast needs the scoreboard over HTTPS from a real hostname.
- `ScoreboardPage.tsx` hides its controls when running as a Cast receiver.
- `websocketServer.ts` — Cast receivers load the public `/scores` page; carries
  a keepalive for "a Chromecast whose Wi-Fi died".
- `telemetryThrottle.ts` sizes its backlog for "a slow display (a Chromecast on
  TV Wi-Fi)".
- `mdnsReflector.ts` — discovery across the field VLANs.
- `SetupStepOrder` already contains a `scoreboard` step.

## Design

### One control layer, two modes

**Powering the TV on is orthogonal to display mode.** The remote protocol wakes
the panel identically either way; only what follows differs — open a Cast
session, or select an HDMI input. Build **one `TvControl`** with a mode on top,
not two parallel implementations.

### Library

`androidtv-remote` (npm, louis49) — standalone Node implementation of the
PairingSession + RemoteManager protocols over TLS. HA uses it but it has no HA
dependency. Runs under bun. LAN-only.

- Pairing emits a `secret` event; reply with `sendCode(code)`.
- **`getCertificate()` returns a client cert to persist** — pair once per field,
  reconnect unattended forever after.
- `sendKey(KeyCode, Direction)`, `sendAppLink(url)`, plus `powered` / `volume` /
  `current_app` events.

### Persistence

Follow `apiKeyStore.ts` / `externalAccessStore.ts`: a JSON store with an
env-overridable path and a listener list for pushing state to the UI. A
`tvPairingStore.ts` mirrors those.

**The cert is a secret — it does not belong in `setup-config.json`**, which
holds wizard answers.

### Admin UI

`AdminPage.tsx` is a stack of `*Section` components. Add a `DisplaySection`
beside `AudioDeviceSection`, which is a near-exact precedent: pick a piece of AV
hardware, save it, verify it works. "Match Audio" and "Match Display" read well
together. Admin is already behind `AdminAuthGate`, which is where a durable
control credential belongs.

The wizard's `scoreboard` step links to it and records a `tvPaired` flag beside
`castVerified` — matching the existing pattern where the wizard records operator
confirmation while real config lives elsewhere.

## HDMI mode: what the host build needs

Measured on a reference field server (Ubuntu 25.04, Intel graphics). This is the
part that now ships with pFMS rather than living in private site config.

- **A minimal X server pulls in no desktop.** `xserver-xorg-core`,
  `x11-xserver-utils`, `x11-utils` resolve to ~25 packages with no desktop
  environment, no display manager, and — importantly — no `xserver-xorg-legacy`.
  None of them start anything on install.
- **Run X rootless via logind.** If the host has a seat that owns the GPU, a
  systemd unit with `PAMName=login` and a `TTYPath` gets DRM master without any
  setuid wrapper. Do not install `xserver-xorg-legacy` to "fix" permissions.
- **No window manager is needed** — the browser in kiosk mode on a bare root
  window is enough.
- **`--password-store=basic` is not optional.** With no keyring on a headless
  box the browser can hang at startup waiting on a Secret Service that does not
  exist. Also `--noerrdialogs`, `--disable-session-crashed-bubble`,
  `--no-first-run`, `--disable-component-update`.
- **Screen blanking has two independent layers**: the kernel console blanker
  (default 60 s on many installs) and X's own DPMS. Both must be handled, and
  the console one can be changed at runtime with `setterm --blank`, no reboot.
  Note `setterm` takes minutes while the sysfs parameter reports seconds.
- **Chromium packaging is distro-dependent and can be hostile.** On Ubuntu
  25.04 there is no chromium deb at all — the archive package is a snap shim,
  and snap auto-refresh will restart the kiosk on its own schedule. Whatever
  pFMS ships must let a field pick a real deb.
- **A display reporting `connected` with a valid EDID does NOT mean it is on.**
  The EDID EEPROM stays powered in standby. Do not use connector state as a
  proxy for "the TV is showing something" — that is exactly what the TV control
  layer above is for.

## Findings / gotchas

- **Input switching cannot be done with keycodes on the test TV.** Both
  `KEYCODE_TV_INPUT_HDMI_1` (243) and `KEYCODE_TV_INPUT` (178) had no effect on
  a TCL G10. Only an ADB intent to
  `content://android.media.tv/passthrough/<inputId>` worked.
- **But the TV resumes its last input on wake** — switch to HDMI 1, sleep, wake,
  and the same activity comes back. So **input selection is one-time
  provisioning, not a per-wake step**, and "turn the TV on" is the only
  recurring operation. This is what makes the no-ADB path viable.
- **UNTESTED and important: does `sendAppLink()` accept the `content://`
  passthrough URI?** If yes, the remote protocol can switch inputs too and ADB
  is unnecessary even for provisioning. Cannot be tested without pairing first.
  **Do not assume it works.**
- **Casting may not be able to wake a TV.** On the TCL G10, port 8008 (Cast
  discovery) stays open in standby but **8009 (the Cast control socket) is
  closed** — so a sender cannot open a session, and casting will not power the
  TV on. A cast-mode field hits "casting doesn't turn the TV on" with no error
  and no obvious fix. `probeScoreboard()` already catches the analogous
  HTTPS/secure-origin trap and is the right home for a networked-standby check
  with "here's the setting to flip" guidance.
- **HDMI-CEC is not available** when the source connects over DisplayPort — DP
  carries no CEC. Do not plan around `cec-utils`.
- **Wake-on-LAN is the wrong tool.** These TVs stay fully on the network in
  standby; WoL solves a problem they do not have.
- **pFMS does NOT arbitrate between the modes** (decided 2026-08-16). Cast and
  wired are presented as two separate options an operator picks between, not a
  handoff pFMS manages. Nothing tries to reclaim the screen after a cast.
- **Cast is the harder option to adopt**, and that shapes which is the default
  path for a new field: it needs additional DNS setup and Google app
  registration, so it does not scale to other fields as easily as plugging in a
  cable. Wired should be the low-friction route.
- **Wired displays must register like cast displays do.** The per-display
  registry (`castReceiverRegister` → `castReceiverList`, with per-display
  **name**, **mute** and **swap orientation** controls) rides the **public
  WebSocket**, not the Cast protocol — it is already transport-agnostic. But
  registration is gated on `window.__isCastReceiver`
  (`ScoreboardPage.tsx:260`), so a wired kiosk currently would not appear in
  the list or get any of those controls. Widening that gate is small and is
  most of what "first class" actually means here. The `cast*` naming is then
  misleading and worth revisiting.

- **The two modes fight over one panel.** Observed in practice on a shared shop
  TV: a persistent HDMI display gets knocked off screen whenever someone casts
  to the same TV, and something has to put it back. An unconditional auto-heal
  loop is the wrong answer — it yanks the screen back mid-score, fighting a
  deliberate cast.

## Open questions

1. ~~Can one TV run both modes, with explicit handoff — or is it one mode per
   display, chosen at setup?~~ **Answered 2026-08-16:** pFMS does not
   arbitrate between the modes (see Findings).
2. Does `sendAppLink()` accept the passthrough `content://` URI? Needs a pairing
   against a real TV to answer.
3. Should pFMS detect and warn about the Cast-in-standby limitation, or attempt
   to fix it? Detection is clearly right; changing a TV setting for the operator
   probably is not.

## Things not to do

- Don't make this depend on Home Assistant. It ships to fields that have none.
- Don't reach for ADB as the shipping control path — Developer Options on every
  field's TV is a bad ask and a bad security posture.
- Don't put the pairing certificate in `setup-config.json`.
- Don't build an auto-heal loop that re-asserts the display unconditionally; it
  will fight a deliberate cast mid-match. Gate on "nothing has cast for N
  minutes" if it is ever wanted.
- Don't chase Roku ECP (`:8060`) for Google TV hardware, and don't trust the
  DLNA `Windows Media Player` / `Microsoft Corporation` strings a TV advertises.

## Progress log

- [x] Establish that both cast and HDMI are intended first-class modes
- [x] Confirm casting is already threaded through the codebase
- [x] Pick the control channel (remote protocol over ADB) and the library
- [x] Decide where pairing UI and cert persistence live
- [x] Test input switching — keycodes fail, intent works, wake resumes last input
- [x] Answer open question 1 (one mode per display, or arbitration?) — no arbitration
- [ ] Pair against a real TV and test `sendAppLink()` with the passthrough URI
- [ ] Add a networked-standby check to `probeScoreboard()`
- [ ] Build `tvPairingStore.ts` + `DisplaySection`
