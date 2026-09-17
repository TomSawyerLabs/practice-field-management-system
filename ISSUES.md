# Known Issues & Technical Debt

## `setupWebSocket` parameter sprawl

The `setupWebSocket()` function in `src/websocketServer.ts` now has **21 positional parameters**. The call site in `src/index.ts` is nearly impossible to read — you have to count commas to understand which argument maps to which parameter. Adjacent optional callbacks of compatible types make it easy to accidentally swap arguments.

**Fix:** Refactor to accept an options object:

```ts
interface SetupWebSocketOptions {
  radioManager: RadioManager;
  matchEngine: MatchEngine;
  port: number;
  trustedProxyMatcher?: CIDRMatcher;
  // ...
}
```

Every new feature that adds another callback makes this worse. This is the single highest-impact refactor for maintainability of the WebSocket server wiring.

## `teamSubnet` duplication across files

The `teamSubnet()` function (converting a team number to `"10.TE.AM"` subnet prefix) is exported from `src/teamChecker.ts` but has private copies in:

- `src/robotTestMonitor.ts:693` — `teamSubnetStr()`, identical logic
- `src/subnetScanner.ts:312` — `SubnetScanner.teamSubnet()`, identical logic
- `src/routePreferenceManager.ts:16` — `teamSubnet()`, slight variant (appends `.0/24`)

**Fix:** Consolidate all to use the export from `teamChecker.ts`. The route preference variant could call the shared one and append the CIDR suffix.

## Global hook redundancy in StationStatus

`StationStatus` renders 6 times (once per station). Each instance subscribes to several global hooks (`useLastLinked`, `usePortBridgeState`, `useLatest`, `useMatchState`, `useNetworkStats`, `useSubnetScan`, `useMdnsActivity`, etc.). Any update to these global states causes all 6 instances to re-render and diff their entire subtree, even if only one station's data changed.

This is the established pattern throughout the codebase and isn't a bottleneck at 6 stations with infrequent updates. But if performance ever becomes a concern, the proper fix would be a React context with per-station selectors — a broader refactor, not a one-off fix.

## Per-station firmware/radio configure progress not surfaced in UI

When a firmware update or radio reconfiguration runs through station test port mode, the `StationTestManager` receives per-station progress callbacks from the `RobotTestMonitor`. These are currently no-ops — the inline test port mode UI only shows settling banners (derived from `StationTestState.testState.reconfiguredAt`), not step-by-step progress (e.g., "Uploading firmware... 30%").

To add detailed progress UI to the inline view, we'd need:

1. A per-station progress message type (e.g., `StationFirmwareUpdateProgress`) or embed progress in `StationTestState`
2. Corresponding frontend hooks and UI components
3. Care to avoid conflating with the global test monitor's progress handlers

## DS-client operator guard is IP-based and UI-only

The guard that blocks `/match` and `/staff` on Driver Station devices
(`frontend/src/components/DsClientGuard.tsx`) compares the browser's IP to
connected DS IPs. Two accepted gaps (user decision 2026-07-24: fine for now):

- **Multi-interface laptops slip through** — a machine wired to the field for
  the DS but browsing over guest Wi-Fi has different IPs per interface and
  won't match. Hardening path: join on device hostname via `hostnameResolver`
  (same hostname on both interfaces), soft-block on hostname match to tolerate
  hostname collisions.
- **No backend enforcement** — the websocket still honors operator/staff
  messages from DS-identified clients; only the UI is blocked. Hardening path:
  compute a per-connection DS flag server-side and reject operator/staff
  commands from flagged connections.

## Remaining silent-skip paths in RadioManager

Two members of the 2026-07-24 incident's "silent skip" family were fixed
(reconcile-on-reconnect in `reconcileAfterConnect()`, and commit-queue
poisoning where one rejected commit made every later commit re-reject without
executing — both covered by `scripts/test-radio-reconcile.ts`). Two remain,
neither surfaced to the user:

- `configure()` early-returns with only a console log when `this.configuring`
  is set — a user's config request during a ~30s radio reconfigure is
  silently dropped instead of queued or rejected with a visible error.
- `commitConfiguration()` silently defers when `shouldDefer()` is true
  (match active or any robot enabled), and `TelemetryManager.enabledStations`
  entries are never aged out — a DS that was enabled and then unplugged
  (never sending a disabled packet) leaves a stale `true` entry that defers
  all commits until some other DS event clears it.

- `NetworkManager` only records `previousStations` after a fully successful
  pass, so any teardown error repeats on every retry until the service
  restarts. (`Address not found` is tolerated; other errors aren't.)

Diagnosis oracle: `curl -s http://10.0.100.2/status` from the field server.
`stationStatuses.<station> = null` means the station is not configured on the
radio, whatever `active-config.json` says — that file is written even when the
radio push fails.

## Silent paths in match control

- `sendDSPacket` returns silently when a joined station has no live DS
  endpoint, so a match can run with a robot that never receives an enable.
  Nothing warns at countdown or auto start; the only signal is the advisory
  DS chip before Ready.
- A match that ends because every station left (`abandoned`) is never
  written to match history: no station is still joined when postMatch is
  entered, so the history store finds no teams and skips it.

## SystemCore gaps

- Passive robot telemetry (`robotPacketCapture.ts`) only captures robot
  packets from UDP source port 1150. A SystemCore robot replies from 1110, so
  passive battery telemetry is probably missing for SystemCore robots.
  Unverified on hardware.
- Route preference (`routePreferenceManager.ts`) always runs an IPv4
  `ip rule add`. A browser on an IPv6 address logs `Invalid source address`
  and gets no route preference (and no mDNS reflection).

## Setup and packaging

- No "restart pFMS" action: settings read at startup only tell you to
  restart.
- The network backend is built when `networkManager.ts` loads; it should be
  created lazily.
- The Linux standalone-binary targets compile but have never been run, and
  the binary has no self-update path (`update.sh` doesn't apply to it).
