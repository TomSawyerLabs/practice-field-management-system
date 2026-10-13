# Single-binary releases with self-update

## Goal

Publish a self-contained pFMS executable from CI (frontend, sounds, diag
script and the mdns-socket native addon all inside one file) so a field
host can run pFMS without git, bun or a build. The binary can update itself
from the admin page, and optionally on its own. The git-checkout +
`update.sh` deploy stays as the fast path for development and steamboat.

## Environment / context

- Repo `TomSawyerLabs/practice-field-management-system` is public; the only
  workflow today is `.github/workflows/mdns-socket.yml` (addon releases,
  tag `mdns-socket-v0.1.0`). No CI runs tests or typecheck.
- `scripts/package-binary.ts` (`bun run package`) already compiles
  `src/index.ts`, but puts `web/`, `sounds/`, `diag/` **beside** the
  binary and doesn't include the addon.
- Version today = `git rev-parse --short HEAD`, read at runtime in
  `src/websocketServer.ts` (`/health`, serverInfo) and baked into the
  frontend by vite (`__BUILD_VERSION__`); a mismatch makes screens reload.
  `src/deployAnnouncer.ts` posts `git log` subjects since the last deploy —
  neither works without a checkout.
- Assets are found via `__dirname/..` (`matchAudio.ts`, `setupProbe.ts`,
  `mdnsSocket.ts`) and `findAssetDir()` (`staticServer.ts`; frontend, diag).
  Sounds are played by spawning `aplay <file>`, so they need real files.
- Runtime is bun (see `plans/bun-runtime.md`); `engines.bun >=1.4.2`.

## Decisions already made (don't re-ask)

- Keep the checkout deploy (`update.sh`) working; the binary is an
  additional distribution, not a replacement. (User, 2026-10-13.)
- Self-update from the admin page, plus opt-in automatic updates. (User.)
- **Every push to master publishes a build** (release per commit, newest
  = latest; version stays the commit hash). (User, 2026-10-13.)
- **Auto-update policy is the admin's choice** — offer: off, notify only,
  daily quiet window, whenever idle. (User: "configurable. let admin pick
  their preference".)
- **Signature + checksum:** CI signs `SHA256SUMS` with an ed25519 key in a
  repo secret; the public key is compiled in. (User.)
- **Auto-revert** a self-update that doesn't come up healthy. (User.)

## Findings / gotchas

- **`--asset=<dir>` (bun 1.4)** embeds a directory; files appear in
  `Bun.embeddedFiles` and at `/$bunfs/root/<name>`, where **name is
  relative to the asset's parent** (`--asset=frontend/dist` →
  `dist/index.html`; a single file → its basename). Hence the build stages
  everything in `build/bundle/` with the repo layout and embeds that one
  directory; `binaryMain` strips `bundle/`. `existsSync`/`readdirSync`
  work on `/$bunfs` paths.
- A compiled binary can `require()` an on-disk `.node` by computed path
  (verified with the mdns-socket addon), so the addon is unpacked with the
  rest and `MDNS_SOCKET_NODE` points at it — no static require needed.
- In a compiled binary `process.argv[1]` / `Bun.main` is
  `/$bunfs/root/<name>` (`B:/~BUN/root/…` on Windows) — the wizard's unit
  writer had been using it as the entry point (fixed, `299e6bc`).
- `pfms --version` must not import the app: `src/index.ts`'s imports log
  at load ("FIRST_API_USERNAME … not set") ahead of the version, which
  broke the smoke test's first-word check. `binaryMain` answers it first.
- Compiled binaries autoload `.env` and `bunfig.toml` by default —
  disabled with `--no-compile-autoload-dotenv/-bunfig`.
- Cross-compiling linux binaries on Windows works (bun downloads the
  target runtime); the Windows binary also passes `scripts/test-binary.ts`.
  On Windows the killed binary stays locked a moment — wait for exit
  before deleting it.
- The pFMS HTTP server has no `error` handler, so a taken port crashes it —
  the e2e test uses that to simulate a build that can't start.
- **Rollback limit:** the old process has exited when the new one starts,
  so rollback logic runs _in the new binary_ (`binaryMain`, before the app
  loads). A binary that dies before reaching it can't roll itself back —
  but the pre-install `--version` smoke test proves the new binary reaches
  `binaryMain`, so only an environment-dependent crash earlier than that
  would escape.
- `.pfms-assets` pruning keeps the newest _other_ directory by mtime — after
  a revert that's the failed build's, not `pfms.prev`'s. Harmless (the
  restored binary re-unpacks on start); noted in case it matters later.
- The UI demo shows a "running an old version" banner because test builds
  override the version (`PFMS_BUILD_VERSION`) while the embedded frontend
  keeps the commit's. Real builds match.
- A first WS handler bug: `refusal() ?? 'not available'` turned "no
  objection" (null) into a refusal — caught by the e2e test.

## Design (as built)

**Build** — `scripts/build-binary.ts [target]` (`bun run package`): stages
`frontend/dist`, `sounds`, `diag`, the target's mdns-socket addon and
`build-info.json` (commit, short version, build time, target) in
`build/bundle/`, compiles `src/binaryMain.ts` with `--asset=build/bundle`,
smoke-runs `--version` when the target is the host. Output
`release/pfms-<os>-<arch>`. `scripts/test-binary.ts` boots one from an
empty dir (dry run, fake radio) and checks UI/sounds/diag/addon/version.

**Startup** — `src/binaryMain.ts`: `--version` early exit → wait for the
predecessor (`PFMS_WAIT_FOR_PID`) → count the start against a pending
update (`src/updateRollback.ts`) → unpack the bundle to
`<exe dir>/.pfms-assets/<version>/` (tmp fallback) → `setAssetRoot()`
(`src/assetRoot.ts`, used by `findAssetDir`, sounds, addon path) → import
`src/index.ts`. Version from `src/buildInfo.ts` (bundle info, else git);
the deploy announcer falls back to GitHub's compare API.

**CI** — `.github/workflows/release.yml`: check (typecheck + tests) →
build matrix (x64 + arm64 runners: build, smoke, boot test) → release
(SHA256SUMS signed by `scripts/sign-release.ts` with secret
`PFMS_RELEASE_SIGNING_KEY`, provenance attestation, notes from
`scripts/release-notes.ts`, `build-<date>-<sha7>` marked latest, keep 20).

**Self-update** — `src/selfUpdate.ts`: newest complete `build-*` release
newer than us → verify signature (key in `src/releaseKey.ts`) → sha256 →
`--version` smoke → `<exe>`→`<exe>.prev`, download→`<exe>`, pending in
`self-update.json`. `src/restart.ts` restarts gracefully (keep-network
flag + SIGHUP; an unsupervised binary spawns its successor first).
Rollback: 4th start of a pending build, or no healthy `/health` by 120 s
→ restore `.prev` (the failed one kept as `.failed`), add to `skip`.

**Policy / manager** — `src/updateManager.ts`: `SetupSettings.autoUpdate`
(`off | notify | window | idle`; window 03:00–05:00 and idle 30 min by
default). Checks hourly unless off; installs only when the field is idle
(phase `idle`) long enough; never a skipped build; refuses during matches.

**Admin** — Software tab (`frontend/src/components/SoftwareUpdateSection.tsx`):
version, available build + notes, Check / Update (confirm), progress,
revert / error / not-a-service notices, policy editor. WS
`selfUpdateCheck` / `selfUpdateApply` gated by `setupWritesAllowed`.

## Progress log

- [x] Probe what `bun build --compile` can embed
- [x] Decisions (2026-10-13, see above)
- [x] 1. Single-file build + embedded assets + `--version` (`51fd93c`)
- [x] 2. CI release workflow + signing; key pair generated (`3af0a42`) —
     **inactive until the secret is added**
- [x] 3. Self-update core + rollback; unit tests (25) and
     `scripts/test-self-update.ts` end-to-end in WSL: 19/19 (by-hand
     update, bad signature refused, crash-loop rollback after 4 starts,
     auto-update when idle skipping the failed build)
- [x] 4. Policy + scheduler
- [x] 5. Admin Software tab (looked at in the browser against a local feed)
- [x] 6. Docs: deployment.md single-binary + updating sections, README
- [ ] Commit 3–6
- [ ] Secret added → push → first CI release → check its assets, then a
      real self-update from one CI build to the next on a throwaway Linux
      box

## Open questions for the user

1. **Add the signing secret.** Private key:
   `C:\Users\camer\.pfms-release\pfms-release-signing-key.pem`. Either run
   `gh secret set PFMS_RELEASE_SIGNING_KEY --repo TomSawyerLabs/practice-field-management-system < ~/.pfms-release/pfms-release-signing-key.pem`
   yourself, or tell me to. Then back the key up (password manager) and
   delete the file — **losing it strands every installed binary** (they
   only trust this key).
2. Steamboat stays on the checkout + `update.sh` (faster for dev and
   upgrades, as you said) — recommendation: no change there.

## Things not to do

- Don't test self-update against steamboat or the field radio; use a
  throwaway Linux box/WSL and a fake release feed.
- Don't put `[skip ci]` anywhere in a commit message on master (skips the
  whole push, including the release).
- Don't push the release workflow before the secret exists — the first run
  fails at signing.
- Don't rotate the release key casually: installed binaries can't verify
  releases signed by a new key.
