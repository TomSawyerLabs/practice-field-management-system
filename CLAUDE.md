# pFMS — Project Notes

## Commit subjects are user-facing

On every deploy, the backend posts the commit subjects since the last deploy to
the pfms-support Slack channel (`src/deployAnnouncer.ts`). Write every commit
subject as a short line of prose for that audience — mentors and teams, not
just developers. Lead with the user-visible effect ("Auto-clear finished
matches back to idle after 2 minutes"), not the mechanism. Implementation
detail belongs in the commit body, which is not posted.

The announcement groups commits, in this order: **What's new** (changes a
pFMS user will notice), **Fixes**, **Docs**. Internal changes — plans, tests,
formatting, tooling — are left out unless a deploy contains nothing else.

Tag every commit with a `Changelog:` trailer so it lands in the right group.
Put it in the final paragraph, next to `Co-Authored-By`, or git won't read it
as a trailer:

```
Changelog: feature     # or: fix, docs, internal
Co-Authored-By: ...
```

Untagged commits are guessed: plan/test/tooling-only files → internal,
docs-only → docs, a subject saying "no longer", "actually", "fix"… → fix,
anything else → feature. The guess can't tell that a code change is only a
refactor or new tests, so tag those `internal`.

## Tooling

- Use `bun run` for all package scripts (typecheck, build, dev).
- The pre-commit hook (lefthook) runs typecheck and prettier `--check` on the
  worktree copies of staged files.
  - Line endings are handled: `.gitattributes` forces LF on checkout
    (`* text=auto eol=lf`), so git operations on Windows (checkout-index,
    stash, etc.) no longer materialize CRLF that prettier rejects. If prettier
    ever fails purely on line endings again, something bypassed
    `.gitattributes` — normalize with `bunx prettier --write`, don't fight it
    per-commit.
  - Partially-staged files are still checked against worktree content (not the
    staged blob). When committing from a shared working tree with unrelated
    changes in the same file, sync the worktree file to the staged content for
    the commit (`git checkout-index -f -- <file>` after backing up), then
    restore the unrelated changes.
