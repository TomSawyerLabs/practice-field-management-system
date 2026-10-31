# Two network issues, and the unticked plan boxes

## Goal

Fix the two newest `ISSUES.md` entries, do the browser checks left unticked in four
plans, and tick the boxes whose work is already deployed. Follows the list in
`plans/stale-internet-rules.md`.

## Environment

- Branch `t3/fix-dhcp-clear-issues-tick-plans`, ends in a fast-forward of local master. No push, no deploy.
- Steamboat read-only. It was running `c08e287`, idle, with no team on any bridge.
- Browser harness, scratch and not committed: real `src/index.ts`, `DRY_RUN=1`,
  built pages through `WEB_ROOT`, data in a private temp directory, a loopback fake
  radio that counted POSTs, a preload that refused `fetch` past loopback, and
  headless Chrome 155 over CDP.

## Findings

**DHCP was real.** `configureNetwork` started dnsmasq after `updateNetworkConfig`,
which throws at the end of a pass with a failed station. A test got no servers.

**The lost clear was real.** After a clear with its commit lost, a later commit left
the bridge's address in place. The config can't show this: `active-config.json`
already lacks the team, so the kernel is the only record.

**A graceful reload also lost DHCP.** `gracefulExit` stops every dnsmasq, and with
the bridges intact no commit ran to start them. Found reading the startup path.
New leases stopped until the next station change.

**The startup check moved.** `vlansOk` only asked whether a configured team's
address existed, and it ran from the block that could race the end of startup. The
bridge comparison covers it, so it replaced it.

**A failed station gets no DHCP server.** It may have no address, or have found its
gateway taken, and serving a gateway someone else holds is worse than not serving.
It gets one on its retry.

**Wizard placeholder.** The Field-control label sat inside the empty box, so the
placeholder saying what empty means showed only on focus. The one bug the browser
checks found.

**`lastLinked`.** Logged in `ISSUES.md`, seen in a `/csa` screenshot.

## Decisions

- **The bridges outrank the config for who is up**, but only where a team is found
  there. A configured team missing from its bridge keeps `previousStations` from the
  config, so teardown behaves as before.
- **Recovery is an ordinary commit.** It waits for the radio, because a commit needs
  the firmware mode, and for robots. It pushes to the radio, which the lost commit
  would have done and which still held the team.
- **Unreadable bridges mean commit.** That matches the old check.
- **`field-timelapse.md:538` is ticked** on `1581678`, the plan commit `c7522cd` and a
  read of steamboat, since "switch it on" isn't in code.

## Progress

- [x] Claim both issues
- [x] DHCP fix, red first
- [x] Lost clear, red first
- [x] DHCP after a graceful reload, red first
- [x] Four browser checks, 9:50-10:15 PM PDT (04:50-05:15Z Oct 31) on 2026-10-30.
      Scripted, all passing on their last run: parked note, wizard and hold 28,
      recording 17, the wizard re-check 3, and for the host team the card 7 and the
      alerts 11. Early failures were harness mistakes, apart from the placeholder.
      The fake radio got every POST, and no real radio was contacted.
- [x] Real `index.ts` with `KEEP_NETWORK=true`: logged all five stations, waited for
      the radio, one POST restored five teams.
- [x] Wizard placeholder
- [x] Plan ticks, traced to `c08e287`
- [x] Full `bun test` and typecheck after the rebase, then merged

## Not verified

- No real `iptables`, bridge or dnsmasq. The recovery ran against a fake kernel, and
  the real `index.ts` run had the dry-run backend, whose bridges are always empty.
- The first time `listInterfaces()` output drives a teardown is on steamboat.
- The real radio and a real phone were not used. Chrome was desktop-sized.

## Things not to do

- Don't use a fixed filename in `$TEMP`.
- Don't type long scripts into a Bash heredoc here. Use a file.
- In Git Bash set `MSYS_NO_PATHCONV=1` before passing `/admin` to a script.
- Tab labels read as uppercase in `innerText`. Use `#video`.
