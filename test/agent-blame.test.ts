import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const PAST = "2026-01-01T00:00:00Z";
const NOW = new Date().toISOString();

let home: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

function blame(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" } });
}

function claudeSession(id: string, lines: object[]): void {
  const dir = join(home, ".claude", "projects", "-repo");
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd: repo, timestamp: NOW };
  const rows = [{ ...base, type: "user", message: { content: `prompt of ${id}` } }, ...lines.map((l) => ({ ...base, ...l }))];
  writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function claudeTool(name: string, input: object): object {
  return { type: "assistant", message: { content: [{ type: "tool_use", name, input }] } };
}

function codexSession(id: string, changes: Record<string, object>): void {
  const dir = join(home, ".codex", "sessions", "2026", "10", "19");
  mkdirSync(dir, { recursive: true });
  const rows = [
    { timestamp: NOW, type: "session_meta", payload: { id, cwd: repo, timestamp: NOW } },
    { timestamp: NOW, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: `prompt of ${id}` }] } } },
    { timestamp: NOW, type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes } } },
  ];
  writeFileSync(join(dir, `rollout-${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function owners(): Record<string, (string | null)[]> {
  const json = JSON.parse(blame("--json")) as { files: { path: string; hunks: { owner: string | null }[] }[] };
  return Object.fromEntries(json.files.map((f) => [f.path, f.hunks.map((h) => h.owner)]));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ab-home-"));
  repo = mkdtempSync(join(tmpdir(), "ab-repo-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "", "", "", "", "", "", "", "", "const z = 26;", ""].join("\n"));
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

describe("attribution", () => {
  it("splits one file between a Claude session and a Codex session, hunk by hunk", () => {
    writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "const fromClaude = true;", "", "", "", "", "", "", "", "", "const z = 26;", "const fromCodex = true;", ""].join("\n"));
    claudeSession("claude-one", [claudeTool("Edit", { file_path: join(repo, "shared.ts"), old_string: "const a = 1;", new_string: "const a = 1;\nconst fromClaude = true;" })]);
    codexSession("codex-one", { [join(repo, "shared.ts")]: { type: "update", unified_diff: "@@ -10 +10,2 @@\n const z = 26;\n+const fromCodex = true;\n" } });
    assert.deepEqual(owners()["shared.ts"], ["claude:claude-one", "codex:codex-one"]);
  });

  it("gives a new file to the session that wrote it", () => {
    writeFileSync(join(repo, "new.md"), "# Notes\nwritten by claude\n");
    claudeSession("writer", [claudeTool("Write", { file_path: join(repo, "new.md"), content: "# Notes\nwritten by claude\n" })]);
    assert.deepEqual(owners()["new.md"], ["claude:writer"]);
  });

  it("uses the text of a shell command that mentions the file, but never as sure", () => {
    writeFileSync(join(repo, "shared.ts"), ["const a = 100;", "", "", "", "", "", "", "", "", "const z = 26;", ""].join("\n"));
    claudeSession("sheller", [claudeTool("Bash", { command: "sed -i 's/const a = 1;/const a = 100;/' shared.ts" })]);
    const json = JSON.parse(blame("--json")) as { files: { hunks: { owner: string; confidence: string }[] }[] };
    assert.equal(json.files[0]!.hunks[0]!.owner, "claude:sheller");
    assert.notEqual(json.files[0]!.hunks[0]!.confidence, "sure");
  });

  it("gives a codemod's substitution in an untouched file to the session that made it elsewhere", () => {
    writeFileSync(join(repo, "a.ts"), 'import { x } from "@/old/place";\n');
    writeFileSync(join(repo, "b.ts"), 'import { y } from "@/old/place";\n');
    git("add", ".");
    git("commit", "-q", "-m", "two files");
    writeFileSync(join(repo, "a.ts"), 'import { x } from "@/new/home";\n');
    writeFileSync(join(repo, "b.ts"), 'import { y } from "@/new/home";\n');
    // The session's patch only shows a.ts; b.ts was rewritten by a script nobody logged per file.
    codexSession("codemod", {
      [join(repo, "a.ts")]: { type: "update", unified_diff: '@@ -1 +1 @@\n-import { x } from "@/old/place";\n+import { x } from "@/new/home";\n' },
    });
    const o = owners();
    assert.deepEqual(o["a.ts"], ["codex:codemod"]);
    assert.deepEqual(o["b.ts"], ["codex:codemod"]);
  });

  it("leaves changes no transcript explains unattributed", () => {
    writeFileSync(join(repo, "shared.ts"), "edited by hand\n");
    assert.deepEqual(owners()["shared.ts"], [null]);
  });

  it("ignores sessions that touched the file before its last commit", () => {
    claudeSession("old", [claudeTool("Edit", { file_path: join(repo, "shared.ts"), old_string: "x", new_string: "const later = 1;" })]);
    // Commit again *after* the session (no fixed date), then change the file by hand.
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "touch"], { cwd: repo });
    writeFileSync(join(repo, "shared.ts"), "const later = 1;\n");
    execFileSync("git", ["commit", "-q", "-am", "commit the session's work"], { cwd: repo });
    writeFileSync(join(repo, "shared.ts"), "const later = 1;\nconst byHand = 2;\n");
    assert.deepEqual(owners()["shared.ts"], [null]);
  });
});

describe("add", () => {
  it("stages only the session's hunk of a shared file", () => {
    writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "const fromClaude = true;", "", "", "", "", "", "", "", "", "const z = 26;", "const fromCodex = true;", ""].join("\n"));
    claudeSession("claude-one", [claudeTool("Edit", { file_path: join(repo, "shared.ts"), old_string: "const a = 1;", new_string: "const a = 1;\nconst fromClaude = true;" })]);
    codexSession("codex-one", { [join(repo, "shared.ts")]: { type: "update", unified_diff: "@@ -10 +10,2 @@\n const z = 26;\n+const fromCodex = true;\n" } });

    blame("add", "claude-one");
    const staged = git("diff", "--cached");
    assert.match(staged, /\+const fromClaude = true;/);
    assert.doesNotMatch(staged, /fromCodex/);
    assert.match(git("diff"), /\+const fromCodex = true;/);
  });

  it("stages whole files the session alone changed, including new ones", () => {
    writeFileSync(join(repo, "new.md"), "# Notes\nwritten by claude\n");
    claudeSession("writer", [claudeTool("Write", { file_path: join(repo, "new.md"), content: "# Notes\nwritten by claude\n" })]);
    blame("add", "writer");
    assert.equal(git("diff", "--cached", "--name-only").trim(), "new.md");
  });

  it("refuses an ambiguous or unknown session", () => {
    assert.throws(() => blame("add", "nobody"), /No session/);
  });
});
