import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

/** git at the current time (unlike git(), which commits in the past). */
function gitNow(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
}

function run(...args: string[]): string {
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
  const json = JSON.parse(run("--json")) as { files: { path: string; hunks: { owner: string | null }[] }[] };
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
    const json = JSON.parse(run("--json")) as { files: { hunks: { owner: string; confidence: string }[] }[] };
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
    gitNow("commit", "-q", "--allow-empty", "-m", "touch");
    writeFileSync(join(repo, "shared.ts"), "const later = 1;\n");
    gitNow("commit", "-q", "-am", "commit the session's work");
    writeFileSync(join(repo, "shared.ts"), "const later = 1;\nconst byHand = 2;\n");
    assert.deepEqual(owners()["shared.ts"], [null]);
  });
});

describe("add", () => {
  it("stages only the session's hunk of a shared file", () => {
    writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "const fromClaude = true;", "", "", "", "", "", "", "", "", "const z = 26;", "const fromCodex = true;", ""].join("\n"));
    claudeSession("claude-one", [claudeTool("Edit", { file_path: join(repo, "shared.ts"), old_string: "const a = 1;", new_string: "const a = 1;\nconst fromClaude = true;" })]);
    codexSession("codex-one", { [join(repo, "shared.ts")]: { type: "update", unified_diff: "@@ -10 +10,2 @@\n const z = 26;\n+const fromCodex = true;\n" } });

    run("add", "claude-one");
    const staged = git("diff", "--cached");
    assert.match(staged, /\+const fromClaude = true;/);
    assert.doesNotMatch(staged, /fromCodex/);
    assert.match(git("diff"), /\+const fromCodex = true;/);
  });

  it("stages whole files the session alone changed, including new ones", () => {
    writeFileSync(join(repo, "new.md"), "# Notes\nwritten by claude\n");
    claudeSession("writer", [claudeTool("Write", { file_path: join(repo, "new.md"), content: "# Notes\nwritten by claude\n" })]);
    run("add", "writer");
    assert.equal(git("diff", "--cached", "--name-only").trim(), "new.md");
  });

  it("refuses an ambiguous or unknown session", () => {
    assert.throws(() => run("add", "nobody"), /No session/);
  });
});

const HOOK = join(import.meta.dirname, "..", "src", "hook-entry.ts");

function hook(agent: string, input: object): void {
  execFileSync(process.execPath, [HOOK, "--agent", agent], { cwd: repo, input: JSON.stringify({ cwd: repo, ...input }) });
}

/** Runs `change` between a PreToolUse and a PostToolUse hook call, as an agent would. */
function hooked(session: string, tool: string, toolInput: object, change: () => void, agent = "claude"): void {
  const call = { session_id: session, tool_name: tool, tool_use_id: `${session}-${Math.random()}`, tool_input: toolInput };
  hook(agent, { ...call, hook_event_name: "PreToolUse" });
  change();
  hook(agent, { ...call, hook_event_name: "PostToolUse" });
}

describe("hook records", () => {
  it("attribute shell edits exactly, without any transcript", () => {
    hooked("shell-session", "Bash", { command: "./codegen" }, () =>
      writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "", "", "", "", "", "", "", "", "const z = 27;", ""].join("\n")),
    );
    const json = JSON.parse(run("--json")) as { files: { hunks: { owner: string; confidence: string }[] }[] };
    assert.equal(json.files[0]!.hunks[0]!.owner, "claude:shell-session");
    assert.equal(json.files[0]!.hunks[0]!.confidence, "recorded");
  });

  it("separate two sessions' edits to the same file", () => {
    const lines = ["const a = 1;", "", "", "", "", "", "", "", "", "const z = 26;", ""];
    hooked("first", "Edit", { file_path: join(repo, "shared.ts") }, () => {
      lines[0] = "const a = 2;";
      writeFileSync(join(repo, "shared.ts"), lines.join("\n"));
    });
    hooked("second", "apply_patch", {}, () => {
      lines[9] = "const z = 2;";
      writeFileSync(join(repo, "shared.ts"), lines.join("\n"));
    }, "codex");
    assert.deepEqual(owners()["shared.ts"], ["claude:first", "codex:second"]);
  });
});

describe("ranges", () => {
  it("--base includes changes committed since that commit", () => {
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "later.md"), "committed later\n");
    claudeSession("committer", [claudeTool("Write", { file_path: join(repo, "later.md"), content: "committed later\n" })]);
    gitNow("add", ".");
    gitNow("commit", "-q", "-m", "later");
    assert.deepEqual(owners(), {});
    const json = JSON.parse(run("--json", "--base", base)) as { files: { path: string; hunks: { owner: string }[] }[] };
    assert.deepEqual(json.files.map((f) => [f.path, f.hunks[0]!.owner]), [["later.md", "claude:committer"]]);
  });

  it("--since leaves out sessions older than the time", () => {
    writeFileSync(join(repo, "new.md"), "x\n");
    claudeSession("writer", [claudeTool("Write", { file_path: join(repo, "new.md"), content: "x\n" })]);
    const recent = JSON.parse(run("--json", "--since", "1h")) as { files: { hunks: { owner: string }[] }[] };
    assert.equal(recent.files[0]!.hunks[0]!.owner, "claude:writer");
    const future = JSON.parse(run("--json", "--since", new Date(Date.now() + 36e5).toISOString())) as { files: { hunks: { owner: string | null }[] }[] };
    assert.equal(future.files[0]!.hunks[0]!.owner, null);
  });
});

describe("view", () => {
  it("serves the changes to the page, only with the token", async () => {
    writeFileSync(join(repo, "new.md"), "x\n");
    claudeSession("writer", [claudeTool("Write", { file_path: join(repo, "new.md"), content: "x\n" })]);
    const child = spawn(process.execPath, [CLI, "view", "--port", "0"], { cwd: repo, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" } });
    try {
      const url = await new Promise<string>((resolve) => child.stdout.on("data", (d: Buffer) => /http:\S+/.test(String(d)) && resolve(/http:\S+/.exec(String(d))![0])));
      const { origin, hash } = new URL(url);
      assert.equal((await fetch(`${origin}/api/view`)).status, 403);
      const res = await fetch(`${origin}/api/view`, { headers: { "x-token": hash.slice(3) } });
      const view = (await res.json()) as { sessions: { key: string; files: { path: string }[] }[] };
      assert.deepEqual(view.sessions.map((s) => [s.key, s.files.map((f) => f.path)]), [["claude:writer", ["new.md"]]]);
      assert.match(await (await fetch(`${origin}/`)).text(), /<title>Agent Diff<\/title>/);
    } finally {
      child.kill();
    }
  });
});

describe("--self", () => {
  it("stages the changes of the session running the command", () => {
    writeFileSync(join(repo, "mine.md"), "mine\n");
    writeFileSync(join(repo, "theirs.md"), "theirs\n");
    claudeSession("me", [claudeTool("Write", { file_path: join(repo, "mine.md"), content: "mine\n" })]);
    codexSession("them", { [join(repo, "theirs.md")]: { type: "add", content: "theirs\n" } });
    execFileSync(process.execPath, [CLI, "add", "--self"], { cwd: repo, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", CLAUDE_CODE_SESSION_ID: "me" } });
    assert.equal(git("diff", "--cached", "--name-only").trim(), "mine.md");
  });
});
