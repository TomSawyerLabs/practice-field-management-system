# Draft: Chief Delphi post introducing pFMS

> Suggested category: **Technical → Control System** (or General Forum).
> Tags: `fms`, `practice-field`, `open-source`.
> Fill in or delete everything in `[brackets]` before posting.

---

**Title:** pFMS: an open-source FMS for _shared_ practice fields (self-serve matches, free drive the rest of the time)

---

Hi CD!

For the last [year and a half] we've been building and running **pFMS** (the
Practice Field Management System) at [Tom Sawyer Labs' practice field in
LOCATION]. [N] teams have used it. It's open source (ISC), and we think it's
ready for other fields to try:

**https://github.com/TomSawyerLabs/practice-field-management-system**

### The problem it solves

[Cheesy Arena](https://github.com/Team254/cheesy-arena) (and
[Cheesy Arena Lite](https://github.com/Team254/cheesy-arena-lite)),
[Freezy Arena](https://github.com/Freezy-Arena/freezy-arena) and FIRST's
[Offseason FMS](https://frc-events.firstinspires.org/OffSeasonEvent) are
great at running an _event_: a schedule, a scorekeeper, every Driver Station
under field control.
[Freezy Ultralite](https://github.com/Freezy-Arena/freezy-arena-ultralite)
goes the other way: it sets up the radio and switch and leaves the drivers in
control, but doesn't run matches. A shared
practice field is different. On a typical [Saturday] we'll have several teams
coming and going all day. Most of the time each one just wants to drive its
own robot, with its own Driver Station, without fighting over Wi-Fi. Every so
often a few of them want to run a real match against each other, with nobody
volunteering to sit in a scorekeeper's chair.

pFMS is built for that:

- **Bring your robot exactly as it's set up at home. Everything just works.**
  No radio reprogramming and no kiosk. Type in the SSID and WPA key your robot
  already uses (once; pFMS remembers it) and the field AP serves that network.
  Laptops stay on the site's ordinary Wi-Fi, with internet, and everything
  they do at home works unchanged: Driver Station by team number, code
  deploys, `roboRIO-TEAM-FRC.local`, `limelight-*.local` and other mDNS
  names, NetworkTables, dashboards, and device web pages.
- **Free drive by default.** A team picks a station from its phone or laptop,
  the field AP is reconfigured for it, and its DS keeps its own
  Enable/Disable. The FMS only takes over a station when the team **joins a
  match**. Leave the match and you're back in free drive within seconds.
- **Self-service matches.** Teams join Red or Blue from their station page and
  ready up. Field staff (ref / scorekeeper / safety) ready up from their
  phones. Hold-to-start, official timing (2026 REBUILT), field audio, and
  E-Stop/A-Stop. 1v1, 2v2 and 3v3 all work, with a queue for busy days.
  When the field is full, a team can get in line. A robot that's been off
  the Wi-Fi for 5 minutes gives up its slot to the team waiting.
- **E-stop works outside matches too.** Robots in free drive can still be
  stopped from any staff page, and the robot stops within a second. The
  field takes the DS under control, the same way a real field does. A DS in
  free drive may not be talking to the field at that moment, so until it
  takes the stop, the host briefly holds back that DS's control packets.
  Nothing else is touched: cameras, NetworkTables and telemetry keep
  flowing. An e-stop survives a pFMS restart, and it can't be cleared while
  a Driver Station is still telling the robot to drive.
- **Multiple robots per team, all active at once.** Bring your comp bot and
  your practice bot and drive both together, each from its own laptop, even
  a roboRIO and a SystemCore side by side. Each
  laptop's DS link, routing, `.local` names (Limelights, roboRIO) and E-stop
  reach only the robot it drives. One tap on the team page picks which robot
  that is.

### Hardware (deliberately boring)

- A **Vivid-Hosting VH-113 or VH-109** field AP running the
  [`PRACTICE` (recommended) or `OFFSEASON` firmware](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases)
- **Any 802.1Q-capable managed switch.** The Linux host does the routing, so
  you don't need a Cisco L3 switch
- **A Linux box** with a NIC that can carry a VLAN trunk (NUC, small server, or
  Pi 4/5)
- One static route on your site router (`10.0.0.0/8` → the pFMS host)

pFMS ships as **one program file** for Linux (x64 or arm64). It carries its
web interface, and it updates itself from the admin page, rolling back on
its own if a new version doesn't start. Download it, start it, open `/setup`,
and a wizard checks each step as you go: packages,
trunk NIC, radio reachable, team VLANs, test sound, scoreboard cast. If you'd
rather read than click, there's also a
[linear getting-started guide](https://github.com/TomSawyerLabs/practice-field-management-system/blob/master/docs/getting-started.md).
`DRY_RUN=1` runs the whole UI on any OS without a radio if you just want to
poke at it.

### Things that grew out of running it every week

- **Practice video for every team.** Every enable outside a match becomes a
  clip, with a little time either side, the balls scored and the robot's
  telemetry. Teams get a per-day link (and a zip) to take home. Matches are
  recorded too, and the drive team can download the video right after the
  match.
- **TV scoreboard** to cast to the field TV, with optional live video and an
  **HTTP scoring API** for goal sensors and ref tablets.
- **`/csa`: field network triage.** One screen that lists only the problems it
  has detected (radio, DS links, robot links) and what to try. There's also a
  plug-in **robot network tester** for CSAs, and a watch for competing 6 GHz
  APs.
- **Robot health on the team page.** It warns when your robot briefly loses
  its connection and says when a brownout caused it. If your robot is
  e-stopped until power cycled, it says so, and says which Driver Station
  sent the e-stop.
- **Volunteer-friendly access.** Lock the operator pages with a code.
  Volunteers type it once, or a logged-in phone shows a QR code to bring in
  another. Stop buttons never need a login.
- **Speed challenges and relay races** for outreach days and field events,
  with a leaderboard on the TV.
- **Field timelapse.** Each practice day becomes one film, with a timeline
  of robots, enables and matches underneath.
- A support widget on every page that's bridged to Slack, so teams can ask
  for help without hunting down a mentor.
- **Ready for 2027: SystemCore and the new FIRST Driver Station** work
  alongside the roboRIO and NI DS, with the same battery voltage, link
  quality, enabled/mode and e-stop warnings. (We learned a few protocol
  surprises the hard way and are happy to share notes with anyone writing
  their own FMS.)

[SCREENSHOTS: team page · /scores on the TV · /csa · a /timelapse frame]

### Limitations

- **It's for practice fields, not events.** There's no event schedule,
  alliance selection or playoffs. For a full offseason event,
  [Cheesy Arena](https://github.com/Team254/cheesy-arena) and
  [Freezy Arena](https://github.com/Freezy-Arena/freezy-arena) are still the
  right tools. pFMS is for the rest of the year.
- **Linux host only**, and it needs root to manage the networking. (The UI
  runs anywhere in dry-run mode.)
- **Only the VH-113/VH-109 field radio for now**, with the six stations on
  VLANs 10–60. That radio's firmware is the biggest source of friction:
  - Every Wi-Fi change reconfigures the whole radio. That means about 30 s
    with **every** robot's Wi-Fi down, even when only one team is joining
    or leaving. pFMS waits until no robot is enabled and no match is set
    up, but on a busy day you'll still notice it.
  - Neither firmware image is a clean fit. `OFFSEASON` is actually the
    better match for pFMS: pFMS hands out the robots' addresses itself, so
    routing is simple and does more. But its firewalls stop most teams from
    uploading code, and that's the bigger problem. So we recommend
    `PRACTICE`. Its own DHCP means pFMS has to NAT laptop ↔ robot traffic
    to make it behave like an ordinary network.

  We'd be very happy to support other field APs (see below).

### What we'd love from you

- **Other shared or multi-team fields**: give it a try. We'd like to make it
  easy for a second field to adopt it (per-field branding and layout config
  are on the roadmap), and real feedback from another site is the fastest
  way there.
- **Other field radios**: if you'd like pFMS to drive an AP other than a
  VH-109/VH-113, tell us which one. We'd love to add it.
- **Bug reports, ideas, and PRs** are welcome on
  [GitHub issues](https://github.com/TomSawyerLabs/practice-field-management-system/issues).
- Questions about the network setup, VLANs, or the DS protocol: ask away here.

Thanks to the [Cheesy Arena](https://github.com/Team254/cheesy-arena) folks
and the
[FRCture](https://frcture.readthedocs.io/) docs. Both made this a lot easier.

[Name] · [Team / Tom Sawyer Labs]
