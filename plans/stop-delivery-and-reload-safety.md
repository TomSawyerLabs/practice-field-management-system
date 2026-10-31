# Stops that can't vanish, and reloads that keep them

**Status: done, on local master. Not deployed: the deploy thread owns that.**

## Goal

Six findings from a code review, none reproduced when they were handed over. Each got a test that
failed first (or a measurement saying why it doesn't reproduce) and its own commit:

1. An E-STOP pressed while the page's socket is down can vanish with no sign.
2. A reload silently lifts every e-stop.
3. A field E-Stop only pulses a robot on a slot with a deferred release.
4. The commit after a reload doesn't really wait for robots.
5. The firmware checksum is checked for shape only.
6. OFFSEASON DHCP waits on a deferred commit, and `toggleInternetAccess` isn't queued.

## Decisions (don't re-ask)

- **Item 5 was not done as written, on purpose.** `checksum` is what the radio checks after
  decrypting, not a hash of the upload: both 2.0.1 images share `77575f49…`, and hash to `1f595fdb…`
  and `bfe0e79e…` themselves. Comparing the body to it would refuse every genuine firmware. Known
  releases now pin their image hash instead; an unknown version can only be checked by the radio.
- **A DS only reports to :1160 while it's assigned a station**, so "enabled state known" can't rest
  on `TelemetryManager` alone. The robot's own UDP 1150 replies count too.
- **Those replies hold only the first commit after a start.** Feeding them into `anyRobotEnabled()`
  for good would make every commit wait for free-driving robots, which nobody asked for.
- **Team Stop persists with the e-stops.** Same hazard: `bringUpTrunk` flushed its cut too. It does
  not hold `update.sh`: it survives the reload, and a team can leave it on all day.
- **The cut survives the restart.** Startup keeps the kernel rule for restored stations, and the
  `stopCuts` map is seeded so a cut no longer wanted still lifts.
- **The capture's team→station map comes from the bridges first.** The traffic is on the bridges,
  and a deferred release leaves the team there.
- **Stops in the page go through one queue** (`frontend/src/utils/stopDelivery.ts`), confirmed by the
  field's own state: 2 s to confirm, 30 s cap, then dropped and shown until dismissed. Every stop
  message is idempotent and `anyone` tier, so a replay needs no login to have landed first.

## Findings

- All six items reproduced except item 5, which was a wrong reading (above). Item 1 reproduced in
  headless Chrome on the old page: a closed socket lost the press, a connecting one threw
  `InvalidStateError` in the click handler, a half-dead one delivered nothing and looked the same.
- A resend must keep warning. The first version fell back to the silent `sent` stage for 2 s after a
  fresh socket, so NOT CONFIRMED flickered away while nothing was confirmed.
- A hung connect never ended: nothing timed out a socket stuck in CONNECTING. Added a 5 s timeout.
- At phone width the participant row overflowed its card, leaving E-Stop One partly off screen.
- Harness traps: MUI uppercases button `innerText`, so match `textContent`. Chrome relaunches itself
  on Windows, so kill by profile directory, not the spawned pid. A background tab never acknowledges
  touch input, so `Page.bringToFront` first. A fake radio with identical status every poll isn't
  rebroadcast and can leave a page on an empty entry; a real radio's data age always changes.

## Progress log

- [x] 5: pin known images, refuse a mismatch before any write; checked against the real cached images.
- [x] 6: DHCP on the bridges' teams when a recovery commit defers; queue `toggleInternetAccess`.
- [x] 4: hold the first commit until enabled state is known.
- [x] 3: resolve the arriving copy from the bridges.
- [x] 2: persist and restore stops; `/health` reports e-stops; `update.sh` waits.
- [x] 1: stop delivery queue and page feedback.
- [x] Browser check, desktop and phone, killing and restoring a real backend.
- [x] Docs, rebase, fast-forward master.

## Not verified

No real Driver Station, robot, iptables or radio was involved: pFMS's FMS server binds 10.0.100.5,
which this PC doesn't have, so a DS going back under field control after a restart rests on unit
tests and reading the hold loop. The stop note in the pop-out match window wasn't opened in the browser.
`update.sh`'s wait logic was exercised as lifted functions against a fake `/health`, never by running it.

## Things not to do

- Don't change the scheduler: the daily 6:00 AM PDT clear neither clears e-stops nor waits on them.
- Don't compare a firmware upload's hash to its `checksum`.
- Don't make team Stops hold a deploy.
