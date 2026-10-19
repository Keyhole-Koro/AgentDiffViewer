# AgentDiffViewer

When several Claude Code and Codex sessions work in the same checkout, `git status` mixes their
changes. `agent-diff` reads the sessions' transcripts and tells you which session made each
uncommitted change — down to the hunk — and can stage exactly one session's work.

```text
$ agent-diff
Codex  01a14249  10/16 10:17–10/19 20:44  Move the API contracts into each feature
    M README.md (1 of 2 hunks; rest by others)
    D src/contracts/admin/api.ts
    A src/features/admin/contracts/api.ts
    …

Claude 0be1c91d  10/13 23:02–10/19 20:48  Design agent-authored trees
    M docs/improvements/README.md
    A docs/improvements/agent-authored-trees.md

Not found in any transcript  (edited by hand, by a tool, or by a session older than --days)
    M apps/web/e2e/workspaces/workspace-chat.spec.ts

$ agent-diff add 0be1c91d      # stage that session's files and hunks, nothing else
$ git commit
```

## Install

Node 22.18 or later (it runs the TypeScript sources directly).

```bash
npm i -g agent-diff-viewer   # provides the agent-diff command
```

## Commands

| Command | |
|---|---|
| `agent-diff` | Uncommitted changes grouped by session |
| `agent-diff --by-file` | One line per file with its sessions |
| `agent-diff show <session>` | The hunks a session made, as a diff |
| `agent-diff add <session>` | Stage the session's changes: whole files it alone changed, and its hunks of shared files (`--dry-run` to preview) |
| `--json` | Machine-readable output for any of the above |

`<session>` is an id prefix, optionally `claude:` or `codex:` first. `-C <dir>` runs in another
repository; `--days <n>` (default 30) limits how far back transcripts are read.

## How it decides

Transcripts live in `~/.claude/projects` (Claude Code) and `~/.codex/sessions` (Codex). For each
changed file, only sessions active after the file's last commit are considered. A hunk goes to
the session whose recorded writes contain most of its lines:

| Evidence | Confidence |
|---|---|
| Edit / Write / MultiEdit calls (Claude), FileChange diffs and apply_patch (Codex) | sure |
| A recorded delete or create of that very file (moves included) | sure |
| Text of a shell command or Codex `exec` script that mentions the file (sed, heredocs, scripts) | likely |
| The same substitution (old → new fragment) that the session made in another file — a codemod | likely |
| The only session that touched the file, for a hunk with nothing to match (whitespace) | maybe (`?`) |

Anything else stays "Not found": edits by hand, by formatters and code generators, or by sessions
older than `--days`. Nothing is sent anywhere; transcripts are read locally.

## License

MIT
