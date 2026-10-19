#!/usr/bin/env node
import { parseArgs } from "node:util";
import { attribute, type FileAttribution, type HunkOwner } from "./attribute.ts";
import { readClaude } from "./claude.ts";
import { readCodex } from "./codex.ts";
import { changedFiles, gitAdd, gitApplyCached, repoRoot, unstagedDiff } from "./git.ts";
import type { Session, Transcripts } from "./types.ts";

const HELP = `agent-blame — which Claude Code or Codex session made each uncommitted change

  agent-blame                 Uncommitted changes grouped by the session that made them
  agent-blame --by-file       The same, one line per file
  agent-blame show <session>  The hunks a session made, as a diff
  agent-blame add <session>   Stage exactly that session's changes (whole files and single hunks)

Options
  -C <dir>         Run in another repository
  --days <n>       How far back to read transcripts (default 30; files committed earlier are
                   only matched against sessions after their last commit anyway)
  --dry-run        With add: show what would be staged
  --json           Machine-readable output

<session> is an id prefix (e.g. 0be1c91d), optionally prefixed with claude: or codex:.
Reads ~/.claude/projects and ~/.codex/sessions (or $CLAUDE_CONFIG_DIR, $CODEX_HOME).`;

const color = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (code: string) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const cyan = paint("36");

function when(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function label(s: Session | undefined, key: string): string {
  if (!s) return key;
  const agent = s.agent === "claude" ? "Claude" : "Codex ";
  const title = s.title.length > 70 ? s.title.slice(0, 69) + "…" : s.title;
  return `${bold(agent)} ${cyan(s.id.slice(0, 8))}  ${dim(`${when(s.firstAt)}–${when(s.lastAt)}`)}  ${title}`;
}

function load(root: string, days: number): { transcripts: Transcripts; attributions: FileAttribution[] } {
  const files = changedFiles(root);
  const transcripts: Transcripts = { sessions: new Map(), events: [], shells: [] };
  if (files.length) {
    const since = Date.now() - days * 864e5;
    readClaude(transcripts, since);
    readCodex(transcripts, since);
  }
  return { transcripts, attributions: attribute(files, transcripts) };
}

function findSession(transcripts: Transcripts, query: string): string {
  const [agent, prefix] = query.includes(":") ? (query.split(":", 2) as [string, string]) : [undefined, query];
  const matches = [...transcripts.sessions.keys()].filter((k) => {
    const [a, id] = k.split(":") as [string, string];
    return (!agent || a === agent) && id.startsWith(prefix);
  });
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `"${query}" matches ${matches.length} sessions; use a longer prefix.` : `No session "${query}" touched these changes.`);
}

function statusMark(status: string): string {
  const s = status === "??" ? "A" : status[0] ?? "M";
  return s === "D" ? red(s) : s === "A" ? green(s) : yellow(s);
}

function hunkCount(n: number): string {
  return `${n} hunk${n === 1 ? "" : "s"}`;
}

/** Default view: each session with the files it changed. */
function printBySession(transcripts: Transcripts, attributions: FileAttribution[]): void {
  const bySession = new Map<string, { file: FileAttribution; owned: HunkOwner[] }[]>();
  const unknown: { file: FileAttribution; owned: HunkOwner[] }[] = [];
  for (const a of attributions) {
    const groups = new Map<string, HunkOwner[]>();
    for (const h of a.hunks) {
      const k = h.owner ?? "";
      groups.set(k, [...(groups.get(k) ?? []), h]);
    }
    for (const [k, owned] of groups) (k ? (bySession.get(k) ?? bySession.set(k, []).get(k)!) : unknown).push({ file: a, owned });
  }
  const order = [...bySession.keys()].sort((a, b) => (transcripts.sessions.get(b)?.lastAt ?? 0) - (transcripts.sessions.get(a)?.lastAt ?? 0));
  for (const key of order) {
    console.log(label(transcripts.sessions.get(key), key));
    for (const { file, owned } of bySession.get(key)!) {
      const total = file.hunks.length;
      const share = owned.length === total ? "" : dim(` (${owned.length} of ${total} hunks; rest by others)`);
      const guess = owned.every((h) => h.confidence === "maybe") ? yellow(" ?") : "";
      console.log(`    ${statusMark(file.file.status)} ${file.file.rel}${guess}${share}`);
    }
    console.log("");
  }
  if (unknown.length) {
    console.log(bold("Not found in any transcript") + dim("  (edited by hand, by a tool, or by a session older than --days)"));
    for (const { file, owned } of unknown) {
      const hint = file.shell.length ? dim(`  shell commands in ${file.shell.map((k) => k.split(":")[1]!.slice(0, 8)).join(", ")} mention it`) : "";
      console.log(`    ${statusMark(file.file.status)} ${file.file.rel}${owned.length < file.hunks.length ? dim(` (${hunkCount(owned.length)})`) : ""}${hint}`);
    }
    console.log("");
  }
  if (!order.length && !unknown.length) console.log("No uncommitted changes.");
  else console.log(dim("? = only a guess (the session touched the file, but no lines matched)"));
}

function printByFile(transcripts: Transcripts, attributions: FileAttribution[]): void {
  const width = Math.min(60, Math.max(...attributions.map((a) => a.file.rel.length)));
  for (const a of attributions) {
    const owners = [...new Set(a.hunks.map((h) => h.owner ?? "?"))].map((k) => {
      if (k === "?") return red("unknown");
      const s = transcripts.sessions.get(k);
      return `${s?.agent === "codex" ? "Codex" : "Claude"} ${cyan(k.split(":")[1]!.slice(0, 8))}`;
    });
    console.log(`${statusMark(a.file.status)} ${a.file.rel.padEnd(width)}  ${owners.join(", ")}`);
  }
}

function show(transcripts: Transcripts, attributions: FileAttribution[], key: string): void {
  console.log(label(transcripts.sessions.get(key), key) + "\n");
  for (const a of attributions) {
    const owned = a.hunks.filter((h) => h.owner === key);
    if (!owned.length) continue;
    console.log(bold(`${a.file.rel}`) + dim(`  ${owned.length} of ${hunkCount(a.hunks.length)}`));
    for (const h of owned) {
      console.log(cyan(h.hunk.header) + (h.confidence === "maybe" ? yellow("  (guess)") : ""));
      for (const l of h.hunk.lines.slice(0, 200)) console.log(l.startsWith("+") ? green(l) : l.startsWith("-") ? red(l) : l);
      if (h.hunk.lines.length > 200) console.log(dim(`… ${h.hunk.lines.length - 200} more lines`));
    }
    console.log("");
  }
}

/**
 * Stages the session's changes: whole files it alone changed, and its hunks of files shared
 * with other sessions (rebuilt from the index-vs-worktree diff, so earlier staging is respected).
 */
function add(root: string, transcripts: Transcripts, attributions: FileAttribution[], key: string, dryRun: boolean): void {
  const whole: string[] = [];
  const partial: { rel: string; patch: string; hunks: number }[] = [];
  const skipped: string[] = [];
  for (const a of attributions) {
    const mine = a.hunks.filter((h) => h.owner === key);
    if (!mine.length) continue;
    if (mine.length === a.hunks.length) {
      whole.push(a.file.rel);
      continue;
    }
    const diff = unstagedDiff(root, a.file.rel);
    if (!diff) {
      skipped.push(`${a.file.rel} (already staged)`);
      continue;
    }
    // Re-attribute the index-vs-worktree hunks with the same transcripts.
    const [redo] = attribute([{ ...a.file, hunks: diff.hunks }], transcripts);
    const keep = redo!.hunks.filter((h) => h.owner === key);
    if (!keep.length) {
      skipped.push(`${a.file.rel} (its hunks are already staged)`);
      continue;
    }
    const patch = [...diff.header, ...keep.flatMap((h) => [h.hunk.header, ...h.hunk.lines])].join("\n") + "\n";
    partial.push({ rel: a.file.rel, patch, hunks: keep.length });
  }

  for (const rel of whole) console.log(`${green("+")} ${rel}`);
  for (const p of partial) console.log(`${green("+")} ${p.rel} ${dim(`(${hunkCount(p.hunks)} of its changes)`)}`);
  for (const s of skipped) console.log(`${dim("-")} ${s}`);
  if (dryRun) {
    console.log(dim("\n(dry run: nothing staged)"));
    return;
  }
  gitAdd(root, whole);
  for (const p of partial) gitApplyCached(root, p.patch);
  console.log(dim(`\nStaged. Check with: git diff --cached --stat`));
}

function main(): void {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      C: { type: "string", short: "C" },
      days: { type: "string" },
      "by-file": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (o.help) {
    console.log(HELP);
    return;
  }
  const root = repoRoot(o.C ?? process.cwd());
  const days = o.days ? Number(o.days) : 30;
  const { transcripts, attributions } = load(root, days);
  const [command, arg] = positionals;

  if (o.json) {
    const sessions = Object.fromEntries([...transcripts.sessions].filter(([k]) => attributions.some((a) => a.hunks.some((h) => h.owner === k || h.others.includes(k)))));
    console.log(
      JSON.stringify(
        {
          root,
          files: attributions.map((a) => ({
            path: a.file.rel,
            status: a.file.status,
            hunks: a.hunks.map((h) => ({ header: h.hunk.header, owner: h.owner ?? null, confidence: h.confidence ?? null, matched: h.matched, others: h.others })),
            shell: a.shell,
          })),
          sessions,
        },
        null,
        2,
      ),
    );
    return;
  }

  switch (command) {
    case undefined:
    case "status":
      if (o["by-file"]) printByFile(transcripts, attributions);
      else printBySession(transcripts, attributions);
      return;
    case "show":
      if (!arg) throw new Error("Usage: agent-blame show <session>");
      show(transcripts, attributions, findSession(transcripts, arg));
      return;
    case "add":
      if (!arg) throw new Error("Usage: agent-blame add <session>");
      add(root, transcripts, attributions, findSession(transcripts, arg), !!o["dry-run"]);
      return;
    default:
      throw new Error(`Unknown command "${command}". Run agent-blame --help.`);
  }
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
