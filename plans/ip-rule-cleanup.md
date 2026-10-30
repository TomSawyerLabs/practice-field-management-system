# Per-laptop ip rules piling up on steamboat

## Goal

Stop `from <laptop> to 10.TE.AM.0/24 lookup <slot table>` rules leaking, and have
pFMS remove the existing stale ones itself on startup, duplicates included,
while live rules survive a graceful restart.

## Environment

- steamboat, kernel 6.14.0-37, iproute2 6.14.0. Read-only for this work: the
  cleanup reaches it through pFMS at the next deploy.
- Rule code: `src/routePreferenceManager.ts`, `src/node-ip/linux.ts`. Tests:
  `src/routePreferenceManager.test.ts`, with a fake kernel, so no `ip` command
  runs.

## Why they leaked

Read from steamboat on 2026-10-30: 485 rules, down to priority 31927.

1. **Restore never worked.** `ip -j rule list` gives
   `{"dst":"10.1.14.0","dstlen":24}`. `listIpRules` dropped `dstlen`, so the
   `…\.0\/24$` match failed on every rule and every graceful restart came back
   with no preferences, while the kernel kept all the rules.
2. **Every pick after that added a copy.** With no preference known, auto-connect
   and the UI added the rule again. With no explicit priority the kernel gives
   it the next one down and does not treat it as a duplicate: steamboat has
   `10.55.65.16 → 10.59.40.0/24 lookup 10` 37 times.
3. **Nothing could remove them.** Clearing removed one copy of what memory knew
   about, and a team leaving only cleared what memory knew about, which after a
   restart was nothing. A full start cleared nothing it hadn't made itself, so
   rules left by a crash stayed too.
4. **Same-laptop races.** Drive sessions, the UI and auto-connect could add the
   same laptop at once, and a failed removal forgot a rule still in the kernel.

## Decisions

- **Explicit priorities.** Each rule takes the highest free number from 32765
  down, and the number is stored with the preference. Removal names it, so it
  takes exactly one rule, and the number in use is bounded by laptops on the
  field rather than falling forever. Priorities in the band are not meaningful:
  rules for different laptops never overlap and a laptop has only one.
- **A live rule** is one whose slot still has the team of the rule's subnet.
  `activeConfig` loads from disk in the RadioManager constructor, so this
  doesn't depend on the radio answering.
- **One rule per laptop:** the first live one in priority order, the one the
  kernel uses now. So `getPreference` (and through it the packet capture) places
  a laptop on the slot its traffic really goes to, including two robots of a
  team, where 10.1.14.0/24 is both lookup 10 and lookup 20.
- **Sync runs right after RadioManager is built,** before the scanner or
  WebSocket server exist, so nothing races it and no broadcast is needed. It is
  skipped without a trunk setting, which also keeps dev boxes off the Linux
  backend.
- **A start without the keep flag removes all of them.** A clean shutdown would
  have, so what's left came from a crash.
- A laptop that left while its team stays keeps its one rule until the team
  leaves. Bounded, harmless, and pFMS can't tell it's gone.

## Findings

- Replayed the real 2026-10-30 rule list through the sync against a fake kernel,
  with teams inferred from the newest rule on each slot: 485 rules became 15
  (12 laptops plus 3 system rules), and the two team 114 laptops stayed on slots
  2 and 1. The real count depends on who is on the field at deploy.
- First boot after deploy runs one `ip` per stale rule, a few seconds of startup
  once. Later boots remove almost nothing.

## Progress

- [x] Found the causes on steamboat's real output
- [x] Parse the prefix length; `priority` on add and remove
- [x] Startup sync, one-at-a-time changes, no-op for an unchanged route
- [x] Tests, docs, ISSUES.md
- [ ] Next deploy: check `ip rule list` on steamboat drops to about one rule per
      laptop on the field. The user does the deploy.

## Things not to do

- Don't match rules by subnet alone: two robots of a team share it.
- Don't add a rule without a priority.
- Don't test `ip rule` commands on steamboat or the field PC.
