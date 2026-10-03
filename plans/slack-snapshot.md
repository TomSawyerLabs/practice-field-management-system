# A live field snapshot on request, in Slack

## Goal

Cameron (2026-10-01): let someone in Slack ask — **only in the public
support channel** — for a live picture of the field, posted there for
everyone. **Off by default**, and only switchable on when a camera is
available and Slack is configured.

## Environment / context

- `src/slackBridge.ts`: Socket Mode; the bot already receives every message
  in the configured support channel (`message.channels`) but only acts on
  threaded replies (support chat). It already uploads images there
  (`filesUploadV2`, support-chat screenshots). Scopes it has: `chat:write`,
  `files:write`, `channels:read`, `channels:history`, `users:read`,
  `emoji:read`.
- Camera: `SetupSettings.recordingStreams`; a single frame off the stream
  is ~3 s with ffmpeg (measured for the timelapse).

## Decisions already made (don't re-ask)

- **On request, not on a schedule** (my recommendation, 2026-10-02; Cameron
  asked "regularly? edit hourly? or wait for a human"): a scheduled post is
  24 photos a day of a mostly empty shop in the support channel; one
  message edited hourly cannot have its image swapped with the bot's scopes
  (it would be delete-and-repost, or a public image URL); and a person
  asking is a person choosing to take a photo with people in frame. A
  standing "latest view" can be a second step if wanted.
- **No Slack app change needed.** A mention of the bot in the channel
  arrives as an ordinary channel message, which the bot already gets, so
  `app_mention` is not subscribed.
- A 1920-wide copy, not the 12 MP frame.
- **Cameron (2026-10-02, after the first deploy):** the picture is a
  **reply to the message that asked** (`filesUploadV2` with `thread_ts`),
  not a top-level post, and there is **one snapshot every 5 minutes** for
  the whole channel (was one a minute).

## Design

- Asking: a top-level message in the support channel that either mentions
  the bot with one of `snapshot`/`photo`/`picture`/`pic`, or is nothing but
  `!snapshot` / `snapshot` / `field snapshot` / `!photo` (optionally
  "please"). Threads, DMs, other channels, edits and bots are ignored.
- `src/slackSnapshots.ts`: the rule above (pure), the capture (ffmpeg, one
  frame, scaled), and the controller (enabled?, cooldown, one at a time,
  reply in the asker's thread when it can't).
- Setting `slackSnapshots` (boolean, default off). Admin → Slack
  Integration has the switch, disabled with the reason unless Slack is
  connected and a camera stream is enabled.

## Progress log

- [x] Bridge: channel-message hook, bot id (`auth.test`), image upload,
      thread reply.
- [x] `slackSnapshots.ts` + tests (request rule, off = silent, cooldown,
      failure does not start the wait, real ffmpeg capture scaled to 1920).
- [x] Setting, wiring, admin switch, docs (`docs/support.md`).
- [ ] Not exercised against real Slack: the tests use a fake bridge. The
      mention arriving as a plain `message` event, and `filesUploadV2` with
      `thread_ts` + `initial_comment` landing in the thread with its
      caption, are from Slack's documented
      behaviour, not observed here. The admin switch is typechecked only.
- [x] Deployed to steamboat 2026-10-02 17:49 PDT (`e1f6b3f`); started
      cleanly, Slack Socket Mode connected. Ships switched off.
- [x] Reply in the requester's thread, and one every 5 minutes
      (Cameron's change after the first deploy).
- [x] Thread-reply / 5-minute change deployed 2026-10-02 22:39 PDT
      (`8be1a79`); started cleanly, Slack connected.
- [ ] Turn it on (admin page → Slack Integration) and try it in the real
      channel (needs Cameron).

## Open questions for the user

1. Should it refuse at certain times (overnight, or during matches)? Built
   without any such rule.

## Things not to do

- Don't answer in DMs or other channels — the point is that everyone sees
  who asked and what was posted.
- Don't post the full 12 MP frame.
