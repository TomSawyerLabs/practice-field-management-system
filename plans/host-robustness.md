# Host robustness: dry-run sweeps and the mDNS reflector

## Goal

Fix two `ISSUES.md` entries: the subnet scanner ignoring `DRY_RUN`, and pFMS
crashing at startup when the mDNS reflector can't join multicast. An optional
feature must not take the field down.

## Decisions

- `SubnetScanner`'s `dryRun` defaults to `isDryRun()` rather than being passed
  from `index.ts`, so no caller can forget it. A dry run therefore lists no
  discovered devices. `src/dryRun.ts` and `docs/internals.md` say so.
- Reflector failures are retried on its existing 3 s timer, with no backoff:
  the attempts are cheap local syscalls, and only the first failure is logged.
- The systemd unit stays on `After=network.target`, here and in the docs. pFMS
  now copes with starting before the network, and `network-online.target` would
  hold the whole field up on an optional feature.

## Findings

Measured in an empty network namespace (`unshare -Urn` in WSL: `lo` and a dummy
NIC, so nothing reaches the field) on Bun 1.4.2, Linux:

| Case                                | What happens                                  |
| ----------------------------------- | --------------------------------------------- |
| Join, no default route              | throws `ENODEV`                               |
| Join on an address not on this host | throws `ENODEV`                               |
| Join again on the same interface    | throws `EADDRINUSE`, so count it as joined    |
| Bind conflict                       | `error` event only, the callback never runs   |
| Send with no route                  | `ENETUNREACH` in the callback, doesn't throw  |
| Second `close()`                    | throws `ERR_SOCKET_DGRAM_NOT_RUNNING`         |
| Old reflector, no route             | process exits 1 with the `ENODEV` stack       |
| Fixed reflector, no route           | stays up, hears multicast 2 s after the route |

- pFMS has no `uncaughtException` handler, so any throw from a socket callback
  ends the process.
- Beyond the reported crash, the reflector could also die on a throwing send,
  and at startup on a typo in `MDNS_EXCLUDE_REQUESTERS`. A bind failure or a
  listen interface not up yet was logged and then never retried.
- `readDnsName` in `src/mdnsReflector.ts` and `src/teamChecker.ts` followed
  compression pointers with no limit, so one crafted packet hung the event loop
  for good. `src/hostnameResolver.ts` already capped this at 8 jumps.
- A synchronous hang can't fail a test by itself: the pointer-loop tests were
  shown to hang on the old code with an outer `timeout` (exit 124).
- This worktree's `node_modules` came from pnpm, not `bun.lock`: TypeScript 5.9.3
  instead of 5.8.2, which fails typecheck in `NudgeSettings.tsx`. It left
  `pnpm-lock.yaml` and `pnpm-workspace.yaml` untracked here.
  `bun install --frozen-lockfile` fixed it.

## Things not to do

- Don't test the reflector on a real interface: `unshare -Urn` proves the same
  thing with no route to the field.

## Progress

- [x] Dry runs skip subnet sweeps
- [x] Reflector survives and retries
- [x] Pointer loops bounded
- [x] Full checks, entries removed, merged to local master
