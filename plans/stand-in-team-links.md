# 99xx stand-in team numbers linked to a real team

## Goal

Some teams give their second robot a 99xx team number (5940's spare runs as 9940) because other software can't cope with two identical `10.TE.AM.x`
subnets. pFMS's networking would be fine either way, so for these robots:

- **Change nothing on the network.** 9940 keeps its own SSID, `10.99.40.x`
  subnet, station, routes, and so on.
- **Link 9940 to its real team for the day.** On 9940's team page, pFMS asks
  which team the robot belongs to. Once linked, that day's practice videos and
  their metadata (and match recordings 9940 played in) are filed under 5940's
  practice day.
- **Auto-link** when a 99xx robot is enabled with a Wi-Fi passphrase pFMS
  already knows for exactly one real team.
- **Respect the real team's password.** If the real team has a saved robot
  passphrase, a link needs that passphrase (or the 99xx robot already uses it).

## Environment / context

- Worktree `C:\Users\camer\.t3\worktrees\practice-field-configurator\t3-8106af66-f0410adc770eefd9`,
  branch `t3/link-99xx-teams-to-real-team`, base `master` at `ca468b7`.
- "Password" = the team's saved robot Wi-Fi passphrase (`SavedTeamStore`,
  `saved-teams.json`). pFMS has no other per-team secret.
- Practice day = `practiceDayOf()` (rolls over at 04:00 local).
- "The team's database" for a day = its practice-day page
  (`/practice/<token>`, `src/practiceApi.ts` `collectDay`): matches + practice
  runs with videos and sidecars (metadata.json, telemetry.csv, scores.csv).

## Decisions already made (don't re-ask)

- Stand-in range is 9900–9999 inclusive.
- Links are per practice day, stored in `team-links.json` (`src/teamLinkStore.ts`).
  Records keep the robot's real number (runs and match history still say 9940);
  the link is applied when reading, so it is retroactive for the whole day and
  undoing it puts everything back.
- Unlinking leaves a tombstone for the day so auto-link doesn't immediately
  re-link a robot someone just unlinked.
- Auto-link only when the stand-in's saved passphrase matches saved robots of
  exactly one real team (a shared default passphrase is ambiguous → no link).
- Linking to a team with no saved passphrase is open, same trust as the rest of
  the team page. Staff (non-DS, operator-level) may link without the passphrase.

## Plan / steps

1. `src/teamLinkStore.ts` + tests: range check, link/unlink/tombstone,
   `teamFor`, `standInsFor`, persistence, `linkAuthorization` and
   `autoLinkTarget` (pure).
2. `SavedTeamStore.configsForTeam(team)`.
3. Practice: `PracticeStore` resolves teams through the link (runsFor, addRun's
   day token, opt-out), `practiceApi` collectDay/summaries, `practiceNotifier`
   skips days filed elsewhere and counts stand-in activity.
4. WS: `teamLinksState` broadcast, `linkTeam` / `unlinkTeam` messages with a
   `teamLinkResult` reply; `requestPracticeDayLink` answers the linked team's
   link.
5. index.ts: auto-link on saved-team changes.
6. Frontend: link card on a 99xx team page, linked note on the real team's
   page, video card shows both numbers' videos.
7. Docs (README / docs), typecheck, tests, commit.

## Findings / gotchas

- `requestPracticeDayLink` is open to anyone with a team number, so the
  passphrase rule protects the real team's day from strangers' robots being
  filed into it, not the videos' confidentiality.
- "Staff" for the passphrase bypass means an admin login or an operator-logged-in
  non-DS device. The plain `staff` tier isn't enough: with no operator code
  every phone on site passes it.
- A stand-in's own day token (minted before it was linked) opens the linked
  team's day, and the Slack notifier skips it, so mentors get one message.
- `practiceDayOf` moved to `src/utils.ts` (re-exported from practiceStore) so
  the video card can limit linked numbers' rows to today.

## Progress log

- [x] 1 store + tests (`src/teamLinkStore.ts`, `src/teamLinkStore.test.ts`)
- [x] 2 saved team configs (`configsForTeam`)
- [x] 3 practice resolution (store, API, notifier)
- [x] 4 websocket (`teamLinksState`, `linkTeam`, `unlinkTeam`, `teamLinkResult`)
- [x] 5 auto-link (savedTeamStore listener in index.ts)
- [x] 6 frontend (`TeamLinkCard.tsx`, video card, hooks)
- [x] 7 docs, typecheck, 1333 tests, vite build, commit
- [ ] Try it on the field: a 99xx robot linking by hand, and auto-linking on enable

## Open questions for the user

1. Is "password" the saved robot Wi-Fi passphrase? (Assumed yes: it's the only
   per-team secret pFMS has.)
2. Should matches in match history / `/match` also show "9940 (5940)"?
   Not done: only the practice day and team pages follow the link.

## Things not to do

- Don't touch radio, SSID, subnet, DHCP or routing for 99xx teams.
- Don't rewrite stored team numbers in runs or match history.
