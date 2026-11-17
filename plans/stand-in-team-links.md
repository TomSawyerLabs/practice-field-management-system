# 99xx spare robots linked to their real team

## Goal

Some teams give their second robot a 99xx team number (5940's spare runs as 9940) because other software can't cope with two identical `10.TE.AM.x`
subnets. pFMS's networking would be fine either way, so for these robots:

- **Change nothing on the network.** 9940 keeps its own SSID, `10.99.40.x`
  subnet, station, routes, and so on.
- **Link 9940 to its real team for the day.** On 9940's team page, pFMS asks
  which team the robot belongs to. Once linked, that day's practice videos and
  their metadata (and match recordings 9940 played in) are filed under 5940's
  practice day.
- **Name it "5940 B"** on `/match`, its match history, and the public match
  summary.
- **Auto-link** when a 99xx robot is enabled with a Wi-Fi passphrase pFMS
  knows for exactly one real team.
- **Respect the real team's password** (the team password feature, branch
  `t3/team-password-login`).

## Environment / context

- Worktree `C:\Users\camer\.t3\worktrees\practice-field-configurator\t3-8106af66-f0410adc770eefd9`,
  branch `t3/link-99xx-teams-to-real-team`.
- **Stacked on `t3/team-password-login`** (unmerged, worktree
  `t3-24f41ac6-c783fd2e932164ee`, plan `plans/team-password-login.md` there).
  That branch adds `src/teamAuth.ts` and the `team` WebSocket tier: a message
  in it needs a device logged in as each team `teamsOfMessage` names that has a
  password, or an admin. Merge that branch first; this one on top.
- The robot auto-connect branch (`t3/auto-connect-robots-smoke-test-passphrase`,
  unmerged) keeps every team passphrase; auto-link reads
  `savedTeamStore.getTeams()`, so check it still sees every SSID's key after
  that merges.
- Practice day = `practiceDayOf()` in `src/utils.ts` (rolls over at 04:00).
- "The team's database" for a day = its practice-day page
  (`/practice/<token>`, `src/practiceApi.ts` `collectDay`).

## Decisions already made (don't re-ask)

- Spare range is 9900–9999 inclusive.
- "Password" means the team password from `t3/team-password-login`, not the
  Wi-Fi passphrase (the user, 2026-11-16).
- Match pages say "5940 B" (the user preferred it to "9940 (5940)"); a second
  spare that day is "5940 C", ordered by number.
- Links are per practice day, stored in `team-links.json` (`src/teamLinkStore.ts`).
  Records keep the robot's real number; the link is applied when reading, so it
  is retroactive for the whole day and undoing it puts everything back.
- Unlinking leaves a tombstone for the day so auto-link doesn't re-link it.
- Auto-link only when the spare's saved Wi-Fi passphrase matches saved robots
  of exactly one real team, and never for a team with a password.
- A 99xx number can never have a team password (the user, 2026-11-16): it
  only borrows the password of the team it joins. `TeamAuth.setPassword` and
  the `password` API refuse 99xx; the team page hides the password card.
- A linked spare's own settings need the real team's login (the user,
  2026-11-16). The `team` tier maps each team `teamsOfMessage` names through
  today's link before checking passwords; the spare's page shows the real
  team's login banner.
- `linkTeam` and `unlinkTeam` are `team` tier; `teamsOfMessage` reads `team`
  (the real team), so its login is needed when it has a password. `unlinkTeam`
  names the team it's linked to for that reason.

## Findings / gotchas

- A spare's day link request answers the linked team's token only if the page
  may act for that team (logged in, when it has a password).
- A spare's own day token (minted before it was linked) opens the linked
  team's day, and the Slack notifier skips it, so mentors get one message.
- `teamLinksState` carries earlier days' links too (`earlier`), so match
  history can name a past day's spare.
- First version guarded links with the Wi-Fi passphrase; replaced after the
  user's answer (commit on top of `60cc03a`).

## Progress log

- [x] Store, practice filing, websocket, auto-link, team page card (`60cc03a`)
- [x] Rebased onto `t3/team-password-login`; guard is the team login
- [x] "5940 B" on `/match`, its history, and the public match summary
- [x] Docs (`docs/match-system.md`), typecheck, 1380 tests, vite build
- [x] Linked spare's settings gated by the real team's login; 99xx can't have a password
- [x] Merged into local master (`5749ed5`), after team passwords and robot auto-connect; auto-link also matches each team's passphrase history
- [ ] Try it on the field: link by hand, and auto-link on enable

## Open questions for the user

- (none)

## Things not to do

- Don't touch radio, SSID, subnet, DHCP or routing for 99xx teams.
- Don't rewrite stored team numbers in runs or match history.
