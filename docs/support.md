# Support System

A built-in support system available as a floating widget on every page —
click the support agent icon in the status bar to open it as a floating
panel in the bottom-right corner. The widget can be closed and reopened
without losing the chat session, and persists state across page
navigations via localStorage. An unread badge appears on the icon when
admin replies arrive while the widget is closed.

## Issue Reports

Teams can submit structured issue reports with:

- Standard template fields: what they were trying to do, what steps they
  took, what they expected, and what happened
- Automatic screenshot capture of the current page content (the widget
  hides itself during capture, via html2canvas)
- Auto-included recent system logs and browser metadata (user agent,
  screen size, page URL, client IP)

Issues are stored server-side (last 200; screenshots are kept in memory
only and are not written to the persistence file) and optionally forwarded
to a Slack channel — the report posts as a formatted message with the
recent logs and screenshot attached in its thread.

## Real-Time Chat

Teams can start a live chat session that bridges to a Slack channel:

- Each chat session becomes a single Slack thread (last 100 sessions kept)
- Screenshots can be attached to chat messages with one click (📷 button)
- A chat can be started directly from an existing issue report, and issues
  can be created from chat conversations to track them formally
- An admin's Slack replies appear in real time on the web chat UI, with
  the admin's Slack display name and any custom workspace emoji resolved

## Slack Integration

Configured on the admin page (`/admin` → Slack Integration):

- Requires a Slack App with a Bot Token (`xoxb-...`) and App-Level Token
  (`xapp-...`) with `connections:write` scope
- Practice-video links are DMed to everyone whose Slack name carries the
  team number (see
  [match-system.md](match-system.md#sending-the-link-to-the-teams-mentors));
  that uses `users:read` and `chat:write`
- Uses Socket Mode for receiving messages (no public URL required)
- Test-connection button to verify configuration

The same channel also receives deploy announcements: on startup with a new
git version, the backend posts the commit subjects since the last deploy,
grouped as What's new, Fixes and Docs (see `src/deployAnnouncer.ts` — this is
why commit subjects are written as user-facing prose). Internal changes such as
plans, tests and tooling are only listed when a deploy has nothing else.

### Field snapshots on request

**Off by default.** Switched on under Slack Integration, which only allows
it once Slack is connected and a camera stream is enabled (the same streams
as match recording). Then anyone in the support channel can ask for a live
picture of the field and it is posted as a reply to their message:

- mention the bot with a word for a picture — "@pFMS snapshot", "@pFMS can
  we get a photo?" (`snapshot`, `snap`, `photo`, `picture`, `pic`) — or
- post a message that is nothing but the request: `!snapshot`, `snapshot`,
  `field snapshot`, `!photo`, optionally with "please".

Only top-level messages in that one channel count. Threads belong to the
support chat, and DMs and other channels are ignored, so every request and
every picture is in the open. There is **one snapshot every 5 minutes**
for the whole channel; asking sooner gets a threaded reply saying when to
try again, as does a camera that will not answer (which does not start the
wait). The picture is one frame off the first enabled stream, scaled to
1920 wide (`src/slackSnapshots.ts`).

It is on request rather than on a schedule on purpose: an hourly post is
two dozen pictures a day of a mostly empty shop in a channel meant for
support, and a person asking is a person choosing to take a picture that
may have people in it.

No change to the Slack app is needed. A mention of the bot in a channel it
is in arrives as an ordinary channel message (`message.channels`, already
subscribed), and the upload uses the `files:write` scope the support chat's
screenshots already need.

## Security model — read this before opening a field

pFMS assumes **everyone who can reach it on the network is trusted**. It is
designed for a field LAN, not the public internet, and it
[limits what the internet can do](#from-the-internet) for that reason. Three
specific things to know:

**Claim the field first.** The admin passphrase is
trust-on-first-use: the first person to reach `/admin` sets it, minimum 4
characters. Until then, anyone on the network can claim it — and claiming
it also mints an [external access token](setup.md#external-access). Set a
passphrase before guest teams arrive.

**Setup closes when you claim it.** `/setup` is writable by anyone while
no passphrase exists (that's how a fresh install gets configured). Once
one is set, changing setup settings requires admin. This matters because
the radio URL decides where station configurations — which contain every
team's plaintext WPA key — get sent. The wizard additionally refuses any
address that isn't a private or loopback literal.

**Set an operator code.** Until you do, anyone on the network can run the
field from `/match`, `/staff`, `/csa` and `/test`. See
[operator login](#operator-login).

**The scoring API is open until you create a key.** With no API keys
configured, `POST /api/score` and the config/mode endpoints accept
anything on the network. That's deliberate, so a sensor works out of the
box — but it means anyone can inject or reset scores. Create a key from
`/admin` for anything beyond a friendly practice field. See
[scoring.md](scoring.md#authentication).

## Operator login

Set a code on `/admin` → **Access** → **Operator Access** (at least 8
characters), and running the field takes a login. Nothing changes until you
do, so a new field and the no-hardware demo work as they always have.

- **Volunteers** type the code once per browser and stay logged in. It has no
  time limit, so a login can't land in the middle of a match. `http://pfms.tsl`
  and the HTTPS address count as separate browsers.
- **Add a device** on any logged-in page, or on `/admin`, shows a QR code that
  logs in one more device. It works once, for 5 minutes, and needs a code to
  be set first.
- **Every device is listed on `/admin`**, with who added it. Log one out and it
  loses its rights at once. Changing the code logs out the devices that typed
  the old one, not the ones paired by QR. **Remove code and logins** turns the
  whole thing off.

**Stops never need a login on site.** Stop match, abort countdown, pause,
disable and E-Stop work from any page, logged in or not, and stay on screen.
Clearing an e-stop needs no login either, so a team can clear its own from its
Driver Station. That also means anyone on the network can clear the field
E-Stop.

Too many wrong codes wait a minute: 5 from one address, or 30 overall. That
only slows a typed code, never a device already logged in.

This keeps teams out of field control. It isn't a wall against someone
determined:

- The code is shared, so if it gets out, change it.
- On plain `http://` it crosses the network unencrypted, as the admin
  passphrase does.
- Team-page actions stay open to anyone on the network, because a Driver
  Station has no login to give, and that includes changing any station's
  Wi-Fi.

## From the internet

The WebSocket has to stay reachable from outside so that the external login
works, so pFMS decides for itself who is on site. A connection is **on site**
when its address is private, link-local or on one of the host's own networks.
That's the same test the reference proxy uses to pick the internal UI, and
on-site connections are unaffected by anything below.

A connection from anywhere else can't send field commands: no stops, no clears,
no team-page actions. It can log in, and Cast TVs and the public scoreboard, match
and practice-day pages work as usual. Any credential lifts this, and the usual
rules then apply as if it were on site:

- an access cookie from an [external access](setup.md#external-access) link
- an admin login
- an operator login, from a phone that already has one, or a pairing QR. A
  typed code is refused from outside, so a stranger can't use up the limit on
  wrong codes and lock out volunteers at the field

Revoking an access link takes effect on open pages straight away.

The admin login has to stay open from the internet, so it is limited there: 5
tries a minute from one address and 30 overall, then a wait. Only visitors with
no credential count, so someone flooding it can hold up a stranger's login at
worst. Logging in at the field or with an access link is never limited, and an
open admin page keeps working.

The same goes for a page from another website open in a browser at the field. A
web page can open a WebSocket to any address, so a socket whose `Origin` doesn't
match the address it connected to is treated as outside, and a cookie doesn't
count there.

This depends on [`TRUSTED_PROXIES`](configuration.md#trusted-proxies) being
right. It only limits what a visitor can do, not what they can see: their socket
still receives the field's status. A device at the field that goes out through
the internet (a VPN, Cloudflare WARP, iCloud Private Relay or custom DNS) counts
as outside.

## Admin Authentication

The `/admin` page is secured with a shared passphrase:

- First visit prompts passphrase creation (min. 12 characters)
- Subsequent visits require login; a session token is stored in the
  browser (up to 20 active tokens; changing the passphrase invalidates
  them all)
- Required for Slack configuration and other admin operations

Admin login also issues an [external access token](setup.md#external-access)
so admins keep full UI access from outside the local network.
