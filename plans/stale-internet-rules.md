# Stale internet rules, and the heartbeat in the WebSocket gate test

## Goal

Fix two `ISSUES.md` entries, as separate commits:

- "NAT rules remain after a station is cleared": the field's rules should
  describe the teams on it. Startup removes any that are stale.
- "WebSocket gate test can catch the periodic serverInfo heartbeat".

Then list what's unticked in `plans/` that can be finished from here.

## Environment

- Branch `t3/fix-stale-nat-rules-ws-test`, ends in a fast-forward of local master.
- Steamboat is read-only. No push, no deploy.
- Real `iptables` only in a sealed namespace in WSL.

## Findings

**The leftover rules are the internet rules, not the bridge NAT.** Steamboat,
9:31 PM PDT (2026-10-31 04:31Z) on 2026-10-30, `active-config.json` is `{}`:

```
-A POSTROUTING -s 10.1.0.0/24 ! -d 10.0.0.0/8 -o eno1 -m comment --comment pfms-nat-slot1 -j MASQUERADE
-A POSTROUTING -s 10.17.0.0/24 ! -d 10.0.0.0/8 -o eno1 -m comment --comment pfms-nat-slot3 -j MASQUERADE
-A POSTROUTING -s 10.17.0.0/24 ! -d 10.0.0.0/8 -o eno1 -m comment --comment pfms-nat-slot4 -j MASQUERADE
```

These come from `setInternetAccess`, not `bridgeMasquerade`
(`pfms-nat-vlan-slotN`), and no `pfms-nat-vlan-` rule was left: `updateStation`
removes that one with the rest of a station's teardown.

**Why they stay.** The only commit path to `setInternetAccess` walked
`activeConfig` and acted on the team there now, and only if `internetAccess` was
set. A cleared station has no entry, and a station handed to a new team names the
new one, so nothing ever removed the old rule. The daily clear goes through that
commit. `flushManagedNetworkState` would remove them
on a full start, but deploys reload gracefully (`KEEP_NETWORK`), which skips the
flush, and `migrateAllBridgeNat` looks only at the bridge rules.

**What the rule does.** It lets a robot's subnet reach the internet
(`! -d 10.0.0.0/8 -o <trunk>`). Laptop-to-robot traffic uses the bridge rule, so
removing a stale internet rule can't cut a team's field comms.

**`activeConfig` isn't proof that a team left.** It changes when a change is
applied, and the commit can be deferred (robots enabled or a match active,
`shouldDefer`). A restart in that window sees a team missing from the config
while its bridge is still up. So startup keeps a rule whose team still holds its
address on that station's bridge; the commit that takes the bridge down removes it.

**`pfms-nat-` is the wrong prefix to match.** It also takes
`pfms-nat-vlan-slotN`, the rule every robot needs. Match `pfms-nat-slot`.

**A failed station skipped everyone's internet rules.** `configureNetwork` throws
if any station failed, after doing the others, and the rules ran in its `.then`.

**Shared `$TEMP` files collide.** `$TEMP/m.txt` was overwritten by another thread
between writing and `git commit -F`, so a commit took that thread's message. Use
a private directory for commit messages and scripts.

**Heartbeat.** `send` in `src/wsAccess.test.ts` returned everything that arrived
while it waited, so a test expecting no replies failed if the 10 s heartbeat
(`src/websocketServer.ts`) came in during that wait. `wsAccess.test.ts` is the only
test that runs `setupWebSocket`, and the stand-in server has no other timer: the
5 s and 60 s ones need `setup` and `matchHistoryStore`.

## Decisions

- **The commit is where a rule goes.** It's the moment the bridges change, so it
  syncs the rules with the config: add what's wanted first, then remove the rest.
  Each station has its own comment, so two robots on one team don't share a rule.
- **Toggles still touch one rule.** Syncing everything there would remove the rule
  of a team whose release is waiting on a deferred commit.
- **`internetAccess` undefined means off**, as everywhere else in pFMS (`!!`). A
  stale rule that happens to fit a returning team with it off goes at the next commit.
- **Startup goes through the commit queue**, so it can't interleave with a commit.

## Progress

- [x] Claim both issues
- [x] Fix the internet rules, with tests against a fake kernel. 17 tests in
      `src/internetRules.test.ts`, 10 of which fail on the old commit logic.
- [x] Real `iptables` in a sealed namespace: all six checks pass
- [x] Fix the heartbeat test
- [x] Docs
- [ ] Merge, list unticked plans

## Lab

WSL has no `iptables` and no route to the apt mirrors, so the lab used steamboat's
`xtables-nft-multi` 1.8.11, its libraries and its `ld.so`, run from a copy under
`unshare -n` with only a dummy `eno1`. It drove the real `RadioManager` on the real
Linux backend. `--argv0 iptables` picks the applet: a further `iptables` argument
is refused as `Bad argument`. Every commit creates all six bridges, so a lab
shouldn't add `br-slotN` itself.

## Things not to do

- Don't test `iptables` on steamboat or the field PC.
- Don't flush `pfms-nat-`.
- Don't use a fixed filename in `$TEMP`.
