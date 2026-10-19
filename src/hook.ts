import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Agent } from "./types.ts";

/**
 * The hook recorder. Claude Code and Codex run `agent-diff hook --agent <a>` before and after
 * every tool call that can write files, with the call described as JSON on stdin.
 *
 * Before the call it stores the current content of the files the call may touch as git blobs
 * (`git hash-object -w`); after the call it stores them again and appends one record to
 * .git/agent-diff/log.jsonl: which session changed which file from which blob to which blob.
 * Diffing those blobs later gives exactly what the call changed — shell commands included.
 *
 * It must never get in the agent's way: it prints nothing, ignores every error and exits 0.
 */

export interface HookRecord {
  v: 1;
  agent: Agent;
  session: string;
  transcript?: string;
  tool: string;
  call: string; // tool_use_id
  at: number; // ms, when the call finished
  changes: { path: string; before: string | null; after: string | null }[]; // path relative to the repo; null = file absent
  command?: string;
}

interface HookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
}

/** Tools whose writes are confined to the file they name; anything else may write anywhere. */
const SINGLE_FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

export function recordDir(root: string): string {
  // The common dir, so every worktree of a repository shares one log.
  const common = git(root, ["rev-parse", "--git-common-dir"]).trim();
  return join(isAbsolute(common) ? common : join(root, common), "agent-diff");
}

/** The repository root and its record dir in one git call (the hook runs on every tool call). */
function locate(cwd: string): { root: string; dir: string } {
  const [root, common] = git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]).trim().split("\n") as [string, string];
  return { root, dir: join(isAbsolute(common) ? common : join(cwd, common), "agent-diff") };
}

/** Paths (relative to root) of files that differ from HEAD, untracked ones included. */
function dirtyPaths(root: string): string[] {
  const out: string[] = [];
  const entries = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

/** Blob ids of the files' current contents (written to the object store), null if absent. */
function snapshot(root: string, paths: string[]): Record<string, string | null> {
  const present = paths.filter((p) => existsSync(join(root, p)));
  const ids = present.length ? git(root, ["hash-object", "-w", "--stdin-paths", "--no-filters"], present.join("\n") + "\n").trim().split("\n") : [];
  const snap: Record<string, string | null> = {};
  for (const p of paths) snap[p] = null;
  present.forEach((p, i) => (snap[p] = ids[i] ?? null));
  return snap;
}

/** The blob of `path` in HEAD, or null. */
function headBlob(root: string, path: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `HEAD:${path}`]).trim() || null;
  } catch {
    return null;
  }
}

function targetFile(input: HookInput, root: string, cwd: string): string | undefined {
  const raw = input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"];
  if (typeof raw !== "string") return undefined;
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
}

export function runHook(agent: Agent, stdin: string): void {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return;
  }
  const cwd = input.cwd ?? process.cwd();
  const event = input.hook_event_name;
  if (!input.session_id || !input.tool_name || (event !== "PreToolUse" && event !== "PostToolUse")) return;
  let root: string;
  let dir: string;
  try {
    ({ root, dir } = locate(cwd));
  } catch {
    return; // not in a git repository
  }
  const call = input.tool_use_id ?? `${input.session_id}-${input.tool_name}`;
  const pendingFile = join(dir, "pending", `${call.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const single = SINGLE_FILE_TOOLS.has(input.tool_name) ? targetFile(input, root, cwd) : undefined;

  if (event === "PreToolUse") {
    const paths = single ? [single] : dirtyPaths(root);
    mkdirSync(join(dir, "pending"), { recursive: true });
    writeFileSync(pendingFile, JSON.stringify(snapshot(root, paths)));
    return;
  }

  // PostToolUse: compare with the snapshot taken before the call.
  let before: Record<string, string | null> = {};
  try {
    before = JSON.parse(readFileSync(pendingFile, "utf8")) as Record<string, string | null>;
    rmSync(pendingFile, { force: true });
  } catch {
    // No "before" (the hook was installed mid-call): fall back to HEAD below.
  }
  const paths = single ? [single] : [...new Set([...Object.keys(before), ...dirtyPaths(root)])];
  const after = snapshot(root, paths);
  const changes: HookRecord["changes"] = [];
  for (const p of paths) {
    const b = p in before ? before[p]! : headBlob(root, p);
    const a = after[p] ?? null;
    if (b !== a) changes.push({ path: p, before: b, after: a });
  }
  if (changes.length === 0) return;

  const record: HookRecord = {
    v: 1,
    agent,
    session: input.session_id,
    transcript: input.transcript_path ?? undefined,
    tool: input.tool_name,
    call,
    at: Date.now(),
    changes,
  };
  const command = input.tool_input?.["command"];
  if (typeof command === "string") record.command = command.slice(0, 4000);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "log.jsonl"), JSON.stringify(record) + "\n");
}

export function readHookRecords(root: string, sinceMs = 0): HookRecord[] {
  let text: string;
  try {
    text = readFileSync(join(recordDir(root), "log.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: HookRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as HookRecord;
      if (r.v === 1 && r.at >= sinceMs) out.push(r);
    } catch {
      // a torn line from a crash; skip it
    }
  }
  return out;
}
