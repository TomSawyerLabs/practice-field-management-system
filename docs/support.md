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

## Security model — read this before opening a field

pFMS assumes **everyone who can reach it on the network is trusted**. It is
designed for a field LAN, not the public internet. Three specific things
to know:

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

**The scoring API is open until you create a key.** With no API keys
configured, `POST /api/score` and the config/mode endpoints accept
anything on the network. That's deliberate, so a sensor works out of the
box — but it means anyone can inject or reset scores. Create a key from
`/admin` for anything beyond a friendly practice field. See
[scoring.md](scoring.md#authentication).

## Admin Authentication

The `/admin` page is secured with a shared passphrase:

- First visit prompts passphrase creation (min. 4 characters)
- Subsequent visits require login; a session token is stored in the
  browser (up to 20 active tokens; changing the passphrase invalidates
  them all)
- Required for Slack configuration and other admin operations

Admin login also issues an [external access token](setup.md#external-access)
so admins keep full UI access from outside the local network.
