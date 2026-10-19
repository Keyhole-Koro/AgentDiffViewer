---
name: agent-diff-commit
description: Stage and commit only the changes this session made, when other Claude Code or Codex sessions (or the user) have uncommitted changes in the same working tree. Use before any git add / git commit in a shared checkout.
---

# Commit only your own changes

Several agent sessions often work in one checkout at once. `git add -A` or `git add <file>` would
then commit other sessions' half-done work along with yours. `agent-diff` knows which session
made each hunk, so stage through it instead.

## Steps

1. See what is yours:

   ```bash
   agent-diff show --self
   ```

   It prints the hunks this session made, file by file. If the command is missing, install it
   with `npm i -g agent-diff-viewer`, or fall back to staging files you are certain only you
   touched.

2. Stage exactly those changes, whole files and single hunks of shared files:

   ```bash
   agent-diff add --self --dry-run   # check the list first
   agent-diff add --self
   ```

3. Check the index, then commit as usual:

   ```bash
   git diff --cached --stat
   git commit -m "…"
   ```

## Rules

- Never `git add -A`, `git add .` or `git commit -a` in a checkout other sessions use.
- If `show --self` misses a change you know you made (for example, a file a script you ran
  generated), add that file explicitly with `git add <path>` after checking `git diff <path>`
  holds only your change.
- If a hunk you made is attributed to another session, or yours includes someone else's lines,
  stop and tell the user instead of guessing.
- Hunks marked `maybe` are guesses; look at them before committing.
