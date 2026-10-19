import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Hunk {
  /** The "@@ … @@" header line, as git printed it. */
  header: string;
  added: string[];
  removed: string[];
  /** The hunk's lines as they appear in the patch (with +/- markers), for staging. */
  lines: string[];
}

export interface ChangedFile {
  rel: string;
  abs: string;
  /** Porcelain status: M, A, D, R, ?? … (index and worktree letters squeezed). */
  status: string;
  /** The patch header lines ("diff --git …" up to the first hunk), for staging. */
  patchHeader: string[];
  hunks: Hunk[];
  /** When the file was last committed (ms), or 0 if never. */
  committedAt: number;
}

function git(cwd: string, args: string[], maxBuffer = 256 * 1024 * 1024): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** Splits `git diff -U0` output into per-file headers and hunks. */
export function parseDiff(text: string): Map<string, { header: string[]; hunks: Hunk[] }> {
  const files = new Map<string, { header: string[]; hunks: Hunk[] }>();
  let current: { header: string[]; hunks: Hunk[] } | undefined;
  let hunk: Hunk | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // "diff --git a/<old> b/<new>": key by the new path.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { header: [line], hunks: [] };
      files.set(m ? m[2]! : line, current);
      hunk = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      hunk = { header: line, added: [], removed: [], lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      current.header.push(line);
      continue;
    }
    if (line.startsWith("+")) hunk.added.push(line.slice(1));
    else if (line.startsWith("-")) hunk.removed.push(line.slice(1));
    else if (!line.startsWith("\\")) continue;
    hunk.lines.push(line);
  }
  return files;
}

const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

function untrackedHunk(abs: string): Hunk[] {
  try {
    if (statSync(abs).size > MAX_UNTRACKED_BYTES) return [];
    const text = readFileSync(abs, "utf8");
    if (text.includes("\u0000")) return []; // binary
    const added = text.split("\n");
    if (added.at(-1) === "") added.pop();
    return [{ header: "(new file)", added, removed: [], lines: added.map((l) => "+" + l) }];
  } catch {
    return [];
  }
}

/** Every uncommitted change in the working tree (staged or not, and untracked files), vs HEAD. */
export function changedFiles(root: string): ChangedFile[] {
  const entries = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the next entry is the original path
    files.push({ rel, abs: join(root, rel), status: xy === "??" ? "??" : xy.replace(/ /g, "").slice(0, 2), patchHeader: [], hunks: [], committedAt: 0 });
  }
  if (files.length === 0) return files;

  let hasHead = true;
  try {
    git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }
  const tracked = files.filter((f) => f.status !== "??");
  if (hasHead && tracked.length) {
    const diff = parseDiff(git(root, ["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "-M", "--", ...tracked.map((f) => f.rel)]));
    for (const f of tracked) {
      const d = diff.get(f.rel);
      if (d) {
        f.patchHeader = d.header;
        f.hunks = d.hunks;
      }
    }
  }
  for (const f of files) {
    if (f.status === "??" || (!hasHead && f.hunks.length === 0)) f.hunks = untrackedHunk(f.abs);
  }
  if (hasHead && tracked.length) {
    // One walk of history instead of a `git log -1` per file: the first commit listing a path
    // is its last commit.
    const pending = new Set(tracked.map((f) => f.rel));
    const committed = new Map<string, number>();
    let at = 0;
    for (const line of git(root, ["log", "--format=%x00%ct", "--name-only", "--no-renames", "--", ...pending]).split("\n")) {
      if (line.startsWith("\u0000")) at = Number(line.slice(1)) * 1000;
      else if (line && pending.has(line) && !committed.has(line)) committed.set(line, at);
      if (committed.size === pending.size) break;
    }
    for (const f of tracked) f.committedAt = committed.get(f.rel) ?? 0;
  }
  return files;
}

/** Index-vs-worktree hunks for one file, used when staging part of it. */
export function unstagedDiff(root: string, rel: string): { header: string[]; hunks: Hunk[] } | undefined {
  return parseDiff(git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--", rel])).get(rel);
}

export function gitAdd(root: string, rels: string[]): void {
  if (rels.length) git(root, ["add", "-A", "--", ...rels]);
}

/** Stages a patch made of some hunks of `git diff -U0`. */
export function gitApplyCached(root: string, patch: string): void {
  execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], { cwd: root, input: patch, stdio: ["pipe", "pipe", "pipe"] });
}
