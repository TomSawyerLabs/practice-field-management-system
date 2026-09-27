# /csa — one-screen field-network triage page for field staff

## Goal

A single page at `/csa` that a CSA (Control System Advisor) or other field
staff can keep open on a tablet or phone and glance at to find and fix
field-network problems fast. All-green shows almost nothing; only detected
problems bubble up, each with what to do about it. No scrolling on a tablet;
a phone may scroll.

Requested 2026-09-27. Build and commit, **do not deploy** (user's call).

## Environment / context

- Repo `C:\Users\camer\git\practice-field-configurator` (pFMS). Frontend is a
  Vite multi-page app: one `frontend/<page>.html` + `frontend/src/roots/<page>.tsx`
  per page, wired in `frontend/vite.config.ts` (dev route rewrite + build
  input). Production static serving (`src/staticServer.ts`) already maps any
  clean URL to `<name>.html`, so `/csa` needs no backend routing change.
- Pages are wrapped by `WrapAll` (`frontend/src/roots/wrap.tsx`): status bar
  on top, support chat widget, theme, error boundary.
- Real field failure modes to surface (from `plans/`):
  - DS laptops dropping off site Wi-Fi mid-match, DS falls "stale"
    (`blue-ds-dropout-2026-09-27.md`).
  - Team readied with no DS attached; DS held a stale handshake after a slot
    move (`ready-requires-ds-link.md`).
  - Old team's laptop keeps a slot's drive session after Apply (commit
    `7324ae8` plan).
  - ARP neighbour-table overflow black-holing robots (2026-09-13,
    `NeighborTableGauge` in `NetworkPage.tsx`).
  - Radio reconfig pending/held/failed; second DS blocked on a station.
  - TSL gateway / AP unreachable (`field-l2-reachability-arp` memory).

## Decisions already made (don't re-ask)

- New page, not a mode of `/network` or `/overview`: those are inventories;
  this one is an exception list.
- Reuse existing websocket state only; no new backend detectors in this
  first cut unless a check is impossible without one.
- Commit, don't deploy.

## Plan / steps

1. [x] Survey state surface + existing pages (Explore agent, findings below).
2. [x] Issue model: `frontend/src/utils/fieldIssues.ts`, pure
       `detectFieldIssues(inputs) → FieldIssue[]` (severity, station, team,
       title, detail, fix, actions), tests in `fieldIssues.test.ts`.
3. [x] `frontend/src/components/CsaPage.tsx`, `roots/csa.tsx`, `csa.html`,
       vite dev rewrite and build input. Home page quick link "CSA".
4. [x] README pages table + `docs/getting-started.md` optional pages.
5. [x] Typecheck, prettier, full `bun test` (419 pass). Frontend eslint is
       broken repo-wide (missing `typescript-eslint` package), not run.
6. [x] Visual check in dev (dry-run backend + vite) at 1024×768 and 390×844
       with Playwright (headless Chrome's minimum window width distorts a
       390 px `--screenshot`; use Playwright's viewport). Six robots down
       fit on one tablet screen thanks to grouping.
7. [x] Committed as `5942156` (`Changelog: feature`). **Not deployed** — the
       user asked for commit only.

## Findings / gotchas

- **Radio-unreachable entries never reached the frontend.** When the AP poll
  fails, `radioManager` sends `{ timestamp, radioUpdate: undefined }`; JSON
  drops the key and the client's `isStatusEntry` demanded it, so the entry
  fell to "Unknown message" and `useLatest()` kept the last good status.
  Fixed in `useBackend.ts` (a timestamp with no `type` is a status entry;
  every typed message is matched earlier). `StationChart`/`SystemInfo`
  already guard `radioUpdate`.
- `driveSessionState` is not sent on connect; it arrives with the 5 s sweep.
  The "linked robot, nobody driving" note stays quiet while it is null.
- Telemetry is "latest wins" across three sources; the passive robot capture
  hard-codes `radioPing`/`rioPing` true and sets `robotComms` from the robot
  code flag. Wording of the no-robot-comms issue holds for both sources.
- Nothing observes the TSL gateway / uplink / site router; `siteHealth` is
  HTTP-only. A DS-side Wi-Fi outage (2026-09-27) shows up as several DSes
  going quiet at once, which the page reports per station.
- No websocket message exists to force a DS re-handshake, unblock a
  duplicate DS, or clear a drive session; the page can only explain those.
- Websocket actions (kick, release, apply, admin enable) are not
  auth-gated server-side; `/csa` is ungated like `/match` and `/staff`.
  Field-changing buttons are two-tap (armed for 5 s).
- Same-kind station issues fold into one card (`groupIssues`): six
  never-linked robots (AP reboot, start of day) would otherwise need six
  cards and a scroll. Group key = kind + severity + fix text, so "never
  linked" and "dropped off" stay separate.
- The dry-run backend's fake radio reports demo SSIDs that never match the
  active config, which is what surfaced the missing "radio out of sync"
  check (now `radio-out-of-sync-<slot>`, quiet while the AP is
  CONFIGURING/BOOTING).
- Frontend `bunx eslint` fails to load `frontend/eslint.config.js`
  (`typescript-eslint` not installed) — pre-existing; lefthook only runs
  typecheck + prettier.

## Progress log

- [x] 2026-09-27 plan created; survey done.
- [x] Detector + tests, page, wiring, docs, isStatusEntry fix; all checks pass.
- [x] Visual check at tablet and phone sizes; grouping + out-of-sync check added
      from what the screenshots showed. 24 detector tests pass.
- [x] Committed `5942156` on master, not pushed, not deployed.

## Open questions for the user

(none yet)

## Things not to do

- Don't deploy (`bun run deploy` / steamboat) — explicitly not asked for.
- Don't add a `package-lock.json`; Bun only.
