# Admin "Teams & Controls" — flat sortable table

## Goal

The admin page's **Teams & Controls** card currently renders a fixed 2×3 grid of
six `StationControlCard`s, one per radio slot, in `StationNameList` order —
including slots with no team on them. That is the wrong shape:

- Slot order is meaningless to the person using the admin console.
- Empty slots take up half the card on a typical practice day.
- There is no way to answer "who has been on the field longest?" or "who has
  not driven in a while?".

Replace it with **one flat table of connected teams only**, with a sort
selector. Default sort is connection time (longest-connected first). Team
number and last-enabled are the other useful orders.

## Environment / context

- Repo: `C:\Users\camer\git\practice-field-configurator` (pFMS), branch `master`.
- Frontend: React + MUI v6 (`Grid size={{...}}`), `frontend/src/components/AdminPage.tsx`.
- Backend: Bun/TypeScript, `src/matchEngine.ts`, `src/radioManager.ts`, `src/types.ts`.
- Scripts run with `bun run` (typecheck, build, dev).

## Decisions already made (don't re-ask)

- **A "connected team" is a station whose `teamNumber` is non-null.**
  `teamNumber` is resolved by `radioManager.getTeamForStation()` from the SSID
  on the active radio config, so "has a team" == "has a configured radio slot".
  Stations without one are hidden.
- **"Connection time" = when the team took the slot**, i.e. when its SSID
  became the station's active radio config. Not the DS connect time and not
  `lastLinked` (which is "last seen linked", continuously refreshed while the
  robot is up — useless as a sort key). Stable across radio link drops, which
  is what makes it a good default order.
- **Default order is ascending** (oldest connection at the top): the field
  reads as a queue, and rows do not jump around when a new team joins.
- **"Last enabled" = `lastFmsEnable`**, the timestamp the FMS last enabled that
  station. Already tracked in `matchEngine`; just not exposed. Sorted
  descending (most recently driven first), never-enabled last.
- Slot order stays available as a non-default sort option — the column is shown
  either way and it costs nothing.
- Drop the MUI `Tooltip` on the per-station E-Stop button while rewriting;
  hover-only text is invisible on touch (global UI rule).

## Plan / steps

1. **`src/types.ts`** — add two optional fields to `StationControlState`:
   `connectedAt?: number`, `lastEnabledAt?: number`.
2. **`src/radioManager.ts`** — stamp `connectedAt` on the active config entry
   when a station's SSID is applied (immediate path and staged-commit path),
   preserving it when the same SSID is re-applied. Persist it in
   `active-config.json`. Expose `getConnectedAtForStation(station)`.
   **Guard `buildRadioStationConfig()`** so the extra field is never POSTed to
   the radio (the radio treats `/configuration` as a full replacement).
3. **`src/matchEngine.ts`** — add `setConnectedAtResolver()` alongside
   `setEnableBlocked()`; include `connectedAt` and `lastEnabledAt` in
   `getState()`'s per-station object.
4. **`src/index.ts`** — wire the resolver to `radioManager`.
5. **`frontend/src/components/AdminPage.tsx`** — rewrite
   `StationControlSection` as a table + sort selector, and reshape
   `StationControlCard` into a `<TableRow>`.
6. Run `bun run typecheck`, prettier, and the test suite; commit.

Current step: **all steps complete; verified by typecheck, build and the full
test suite.**

## Findings / gotchas

- `activeConfig` entries are handed **straight to the radio** in
  `buildRadioStationConfig()` (`src/radioManager.ts:613`). Any field added to
  those objects leaks into the `/configuration` POST body unless that function
  destructures explicitly. Comment at `src/radioManager.ts:964` records a prior
  incident where a partial `/configuration` body wiped every station config.
- `DSConnectionInfo.lastSeen` and `radioManager.lastLinked` are both
  _continuously refreshed_ while the thing is up — neither is a connect time.
  Confirmed: `setDSAddress()` overwrites `lastSeen` on every packet, and the
  radio poll loop sets `lastLinked` on every `isLinked` sample.
- `lastFmsEnable` is set by `markFmsEnabled()`, which is called from **both**
  enable paths (`enableParticipating()` for phase enables and the admin/self
  re-enable path), so it is complete — no extra plumbing needed.
- During an active match `teamNumber` is a snapshot (`getState()` only
  re-resolves when not in a match), so table rows do not shift mid-match.
  `connectedAt` is resolved live, which is fine — radio config does not change
  mid-match.
- MUI `Grid` in this repo is v6 (`size={{ xs: 12, md: 6 }}`), not `item xs={12}`.
- `bun run test` passes clean with these changes: 266 pass / 0 fail across 22
  files (~170 s — it exercises the real ffmpeg recording paths, so give it time).

## Progress log

- [x] Explored the existing section, the station state model, and where team
      numbers and timestamps come from.
- [x] Confirmed no existing connect-time timestamp exists anywhere — one has to
      be added.
- [x] Step 1 — `connectedAt` / `lastEnabledAt` on `StationControlState`.
- [x] Step 2 — radioManager stamping + persistence + radio-POST guard.
- [x] Step 3 — matchEngine resolver + state exposure.
- [x] Step 4 — index.ts wiring.
- [x] Step 5 — AdminPage table rewrite.
- [x] Step 6 — `bun run typecheck`, `bun run build`, `bun run test` (266/266),
      prettier, commit (`d7caa61`).

## Open questions for the user

None outstanding.

## Things not to do

- Do not add fields to `activeConfig` objects without auditing
  `buildRadioStationConfig()` — they go to the radio.
- Do not use `lastLinked` or `DSConnectionInfo.lastSeen` as a "connected since"
  value; they are last-seen heartbeats.
- Do not use HTML `title=` or hover-only MUI tooltips for information in this
  table — it is used on tablets at the field.
