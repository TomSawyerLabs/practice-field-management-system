# Match queue: schedule + fill line, "next match", nudges, PWA push

## Goal

Give the field a known **next match** so the day runs itself: a queue of
upcoming matches fed by an optional pre-generated schedule and by a fill
line teams join from their robot page. The match manager forms and orders
matches on a `/queue` page; the match page gets "Set up next match", which
stages the Wi-Fi batch (enables for the six robots, keeps the ones already
there, lets the rest leave), applies it, and creates the match with
alliances pre-assigned. Teams see where they are in line and get nudged
(page banner, Slack, web push) when they are on deck.

## Decisions made (2026-09-28, user)

- **One queue, two feeders, no mode switch.** Schedule entries and
  line-formed entries live in the same ordered list. The only switch is
  "teams may join the line".
- **Match shape is the match manager's call, per match, at runtime.**
  1v1, 2v2, 3v3 (and lopsided if they want): the day may start 2v2, drop
  to 1v1 for demos, go 3v3 when everything works. No-show policy and
  short-line policy are likewise knobs on the queue page, not code.
- **"Set up next match" does it all**: apply the Wi-Fi batch, wait for the
  radio, create the match with alliances assigned. Smaller buttons under it
  do one part each (stage Wi-Fi only / create match only).
- **Nudges are per team**: each team picks page banner, Slack, and/or push
  on its own page. Field default is banner only.
- **PWA + web push**: the team page installs as an app and can receive
  "you're on deck" pushes when the tab is closed.

## Model

```ts
type QueueEntry = {
  id: string;
  number: number; // display number, 1-based, renumbered on reorder
  source: 'schedule' | 'line' | 'manual';
  scheduledAt?: number; // epoch ms, schedule entries only
  red: number[];
  blue: number[]; // team numbers, 0–3 each
  status: 'queued' | 'onDeck' | 'setup' | 'playing' | 'played' | 'skipped';
  historyId?: string; // match-history record once played
  notes?: string;
};
type LineEntry = { team: number; joinedAt: number; alliance?: Alliance };
type QueueState = {
  entries: QueueEntry[];
  line: LineEntry[];
  settings: {
    lineOpen: boolean;
    defaultShape: { red: number; blue: number };
    noShowMinutes: number | null;
    allowShort: boolean;
  };
};
```

Persisted in `match-queue.json` via the same store pattern as
`matchHistoryStore`. Broadcast as `queueState`; team-facing views carry
only team numbers and positions.

## Pieces

1. **Queue store + engine** (`src/matchQueue.ts`): CRUD, reorder, form a
   match from the line (respecting the chosen shape), on-deck promotion,
   no-show timer, link to match history when the match ends.
2. **Wi-Fi batch for an entry**: for each team in the entry, the saved
   robot credentials (`savedTeamStore`) → `radioManager.configure()` enables;
   robots already on the field are `keepRobot`'d; everyone else's post-match
   release stands. Then `applyPendingChanges()`.
3. **Set up next match** (`/match`): main button = batch + apply + wait for
   radio ACTIVE + `createMatch` + `joinStationAlliance` per robot (station
   from the active config, alliance from the entry). Sub-buttons: "Stage
   Wi-Fi only", "Create match only".
4. **/queue page**: list with drag reorder, per-entry edit (teams, shape,
   time, notes), skip/remove, the line with "form next match", settings
   (line open, default shape, no-show minutes, allow short), schedule
   import (CSV) and generation (teams × matches-per-team → spaced schedule).
5. **Team page**: "Play next" / "Leave the line" on the Robots tab; a banner
   "You're up in match N (~time)" / "Nth in line"; nudge preferences
   (banner / Slack / push) saved per team.
6. **Nudges**: on-deck transition → banner (state broadcast), Slack DM or
   channel mention (`slackBridge`), web push (`web-push`, VAPID keys in
   setup config, subscriptions stored per team).
7. **PWA**: manifest + service worker (vite-plugin-pwa or hand-rolled), push
   handler in the SW, install hint on the team page.
8. **TV / scoreboard**: "Next up" line.

## Steps

1. [x] Plan (this file), explore integration points.
2. [x] Queue store, types, messages, tests.
3. [x] Team page: join/leave the line, position banner.
4. [x] /queue page (list, line, form match, settings).
5. [x] Set up next match on /match (main + sub-buttons).
6. [x] Schedule import + generation.
7. [x] Nudge preferences + Slack nudge.
8. [x] PWA + web push.
9. [x] Docs, README page table (queue, nudges, push).

## Open questions

None blocking; policies are runtime knobs per the user.
