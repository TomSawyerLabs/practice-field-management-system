# Chief Delphi: survey of FMS software + pFMS introduction post

## Goal

1. Survey Chief Delphi for other FMS / practice-field software and the
   threads where people struggle to run one, so pFMS can be positioned
   honestly against what already exists.
2. Draft a post introducing pFMS to the FIRST community.

The draft itself is in
[`chiefdelphi-intro-post-draft.md`](chiefdelphi-intro-post-draft.md).
Nothing has been posted; posting is the user's call.

## Environment / context

- Repo is public: `github.com/TomSawyerLabs/practice-field-management-system`
  (ISC licence).
- First commit 2025-03-25; ~830 commits as of 2026-10-12.
- Best forum category is probably **Technical → Control System** or
  **General Forum**, tagged `fms`. The `fms` tag page
  (`chiefdelphi.com/tag/fms`) is where the comparable threads live.

## Findings: what already exists (as of 2026-10-12)

| Project                                                        | What it is                                                                                                                                                        | Relevance to pFMS                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cheesy Arena** (Team 254, Go)                                | Full event FMS: scheduling, scoring, audience display, PLC, switch + AP config. The default answer on CD.                                                         | Built for events with a scorekeeper. DSes are under FMS control whenever connected. Wants a Cisco L3 switch it can configure; Linksys/OpenMesh support dropped Feb 2025. |
| **Cheesy Arena Lite**                                          | Slimmed CA for practice/offseason; people run it on a Pi 5 with VH-109→VH-113 practice firmware and a TL-SG108E. Talk of merging back into CA.                    | Closest existing comparison for a practice field. Still match-centric.                                                                                                   |
| **Freezy Arena** (Corey Applegate, fork of CA)                 | Moved to its own GitHub org Feb 2026. Adds e-stop/a-stop on scoring pages, hub-light ESP32 API, week-0 branches.                                                  | Event-focused.                                                                                                                                                           |
| **Freezy Ultralite** (Python, Windows)                         | Configures VH-113 (practice firmware only) and Cisco 3500–9300 switches, WPA keys, a schedule and a match timer. **Does not control DSes.** "Under construction". | The only other tool aimed at "keep drivers in control". No routing, matches or video.                                                                                    |
| **Rootbeer PLC** (FRC 2481)                                    | ~$7k Automation Direct PLC replacing CA's ~$17k Allen-Bradley PLC.                                                                                                | Hardware for CA. Not competition for pFMS.                                                                                                                               |
| **Offseason FMS** (FIRST, ex-FMS Lite)                         | Official.                                                                                                                                                         | Windows, event-oriented. Its timers drift.                                                                                                                               |
| Older/dead: OpenFMS, O!FMS, Team 537 fms, Java-FRC-FMS         | Proofs of concept from 2013–2018.                                                                                                                                 | Historical.                                                                                                                                                              |
| Team 9611 (2024)                                               | Wanted to write its own multi-robot FMS and asked about the protocol. Pointed at CA's `driver_station_connection.go` and FRCture.                                 | Shows demand; pFMS's 2027 DS notes could help people like this.                                                                                                          |
| Rebuilt Match Timer, DS practice mode, OBS FMS-synced overlays | Timing-only tools.                                                                                                                                                | Show how many teams settle for "enable on three".                                                                                                                        |

### Recurring pain points on CD (pFMS answers several of these)

- **Switch hell.** People buy an HP 1920 or TL-SG108E and then learn that CA
  needs L3 routing on a Cisco 3560 "S" variant (`/t/fms-help/507156`).
  pFMS does the routing on the Linux host, so any 802.1Q switch works.
- **Radio confusion.** It's unclear whether to run PRACTICE or OFFSEASON AP
  firmware, the VH-109→VH-113 conversion is a puzzle, and Linksys/OpenMesh
  support was dropped. pFMS needs PRACTICE: OFFSEASON's firewalls are too
  restrictive. (PRACTICE's own DHCP is a cost, not the reason. pFMS has to
  reverse-NAT around it.)
- **Safety under FMS control.** Ryan_Blue points out that under full FMS
  control a DS can't be disabled locally, so "your software is solely
  responsible" (`/t/information-about-the-fms-protocol/470616`). pFMS only
  takes control of stations that joined a match, and its e-stop also works
  outside matches by dropping UDP 1110.
- **Shared fields have no software story.** Shared fields exist (Piedmont,
  Oakland, Richmond, East Palo Alto, Iowa: `/t/.../519911`), but no thread
  describes self-service software for one. That gap is exactly where pFMS
  sits.
- **6 GHz congestion / packet loss** at a field with 12–20 neighbouring
  networks (`/t/.../507791`). pFMS has a 6 GHz competing-AP watch.
- **Match-start process debate** (`/t/a-new-match-start-process/507748`):
  dual confirmation and staff ready-ups. pFMS already has field-staff ready
  checks and hold-to-start, a useful talking point.

## Decisions already made (don't re-ask)

- **PRACTICE firmware is required, not just recommended** (user,
  2026-10-12). OFFSEASON firmware has excessive firewalls. Don't say the
  reason is that PRACTICE does DHCP: its DHCP is a headache that pFMS works
  around with reverse NAT. The repo docs still say otherwise, which is
  logged in `ISSUES.md`.
- **Link every FMS the post names** (user, 2026-10-12).

## Progress log

- [x] Searched CD (tag `fms`, Cheesy Arena/Lite, Freezy, practice-field
      threads) and fetched the key threads.
- [x] Drafted the post (`plans/chiefdelphi-intro-post-draft.md`).
- [ ] User fills the placeholders (location, team count, screenshots) and
      reviews the tone.
- [ ] User posts it (or asks for revisions).

## Open questions for the user

1. **Placeholders**: the field's location, how many teams have used it, and
   whether to name Tom Sawyer Labs. The usage page has the team count.
2. **Screenshots**: which ones? I'd suggest the team page, `/scores` on the
   TV, `/csa`, and a `/timelapse` frame.
3. **Tone toward Cheesy Arena**: the draft frames pFMS as complementary
   (practice days vs event days). Keep it that way?
4. **Call to action**: ask for other shared fields to try it, ask for
   contributors, or both? The draft asks for both.

## Things not to do

- Don't post to Chief Delphi on the user's behalf. It's outward-facing and
  permanent.
- Don't overclaim hardware support. Docs say VH-113/VH-109 only, Linux host
  only, and the station↔VLAN map is fixed at 10–60.
