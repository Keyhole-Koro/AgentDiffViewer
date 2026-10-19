import type { ChangedFile, Hunk } from "./git.ts";
import { filesMentioned, shellMayWrite } from "./shell.ts";
import type { FileEvent, Transcripts } from "./types.ts";

export type Confidence = "sure" | "likely" | "maybe";

export interface HunkOwner {
  hunk: Hunk;
  /** The session the hunk is attributed to, or undefined when no transcript explains it. */
  owner?: string;
  confidence?: Confidence;
  /** Share of the hunk's lines found in what the owner wrote (0–1). */
  matched: number;
  /** Other sessions that touched the file after its last commit (shell commands included). */
  others: string[];
}

export interface FileAttribution {
  file: ChangedFile;
  hunks: HunkOwner[];
  /** Sessions whose shell commands mention the file after its last commit. */
  shell: string[];
}

/**
 * The part of a line that changed: "import x from '@/a/b'" → "import x from '@/c/b'" gives
 * { from: "a", to: "c" } after trimming the common prefix and suffix. Bulk rewrites (sed, perl,
 * codemods) carry exactly these fragments in their command text, not the file names.
 */
export function changedFragment(before: string, after: string): { from: string; to: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: before.slice(start, before.length - end), to: after.slice(start, after.length - end) };
}

/** Share of a substitution hunk's line pairs whose old and new fragments both appear in `text`. */
function substitutionShare(hunk: Hunk, text: string): number {
  if (hunk.added.length === 0 || hunk.added.length !== hunk.removed.length) return 0;
  let hits = 0;
  for (let i = 0; i < hunk.added.length; i++) {
    const { from, to } = changedFragment(hunk.removed[i]!, hunk.added[i]!);
    // Grow tiny fragments with neighbouring characters so "a" → "c" is not found everywhere.
    if (to.length < 3) return 0;
    if (text.includes(to) && (from.length === 0 || text.includes(from))) hits++;
  }
  return hits / hunk.added.length;
}

/** Lines worth matching: trimmed, with blank lines and lone brackets left out. */
function meaningful(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l.length >= 2 && /[\p{L}\p{N}]/u.test(l));
}

function lineSet(text: string): Set<string> {
  return new Set(meaningful(text.split("\n")));
}

/** Share of the lines (8+ characters, so trivial ones do not count) that occur inside `text`. */
function containedShare(lines: string[], text: string): number {
  const long = lines.filter((l) => l.length >= 8);
  if (long.length === 0) return 0;
  return long.filter((l) => text.includes(l)).length / long.length;
}

function score(lines: string[], set: Set<string>): number {
  if (lines.length === 0) return 0;
  let hits = 0;
  for (const l of lines) if (set.has(l)) hits++;
  return hits / lines.length;
}

/**
 * For each changed file: which sessions touched it after its last commit, and which of them
 * wrote each hunk. A hunk goes to the session whose writes contain the largest share of its
 * added lines (its removed lines when it only deletes); ties go to the latest writer.
 */
export function attribute(files: ChangedFile[], transcripts: Transcripts): FileAttribution[] {
  const byPath = new Map<string, FileEvent[]>();
  for (const e of transcripts.events) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }

  const shellByFile = new Map<string, { sessionKey: string; at: number; command: string }[]>();
  const targets = files.map((f) => ({ abs: f.abs, rel: f.rel }));
  for (const s of transcripts.shells) {
    for (const abs of filesMentioned(s.command, targets)) {
      const list = shellByFile.get(abs) ?? [];
      list.push({ sessionKey: s.sessionKey, at: s.at, command: s.command });
      shellByFile.set(abs, list);
    }
  }

  // Write-looking shell commands, for bulk rewrites that never name the files they change.
  const writingShells = transcripts.shells.filter((s) => shellMayWrite(s.command));

  const results = files.map((file): FileAttribution => {
    const since = file.committedAt;
    const events = (byPath.get(file.abs) ?? []).filter((e) => e.at > since);
    // Per session: what it wrote and removed in this file, and when it last did.
    const writers = new Map<string, { added: Set<string>; removed: Set<string>; lastAt: number; deleted: boolean; created: boolean }>();
    for (const e of events) {
      const w = writers.get(e.sessionKey) ?? { added: new Set(), removed: new Set(), lastAt: 0, deleted: false, created: false };
      for (const l of lineSet(e.added)) w.added.add(l);
      for (const l of lineSet(e.removed)) w.removed.add(l);
      w.lastAt = Math.max(w.lastAt, e.at);
      if (e.kind === "delete") w.deleted = true;
      if (e.kind === "write") w.created = true;
      writers.set(e.sessionKey, w);
    }
    const isDeleted = file.status.startsWith("D");
    const isNew = file.status === "??" || file.status.startsWith("A");
    // Sessions the transcripts show deleting (or creating) this very file: for deleted or new
    // files that is direct evidence, even when no line matches (a move records only its diff).
    const deleters = [...writers].filter(([, w]) => w.deleted).map(([k]) => k);
    const creators = [...writers].filter(([, w]) => w.created).map(([k]) => k);
    // Shell commands that mention the file: the text they contain (a sed expression, a heredoc,
    // a script) is evidence too, though weaker than a tool call.
    const shellCalls = (shellByFile.get(file.abs) ?? []).filter((s) => s.at > since);
    const shellWriters = new Map<string, { text: string; lastAt: number }>();
    for (const c of shellCalls) {
      const w = shellWriters.get(c.sessionKey) ?? { text: "", lastAt: 0 };
      // Scripts quote and escape what they write, so match lines as substrings of the command.
      w.text += "\n" + c.command.replace(/\\n/g, "\n").replace(/\\(["'`$])/g, "$1");
      w.lastAt = Math.max(w.lastAt, c.at);
      shellWriters.set(c.sessionKey, w);
    }
    const shell = [...shellWriters.keys()].filter((k) => !writers.has(k));

    const hunks: HunkOwner[] = file.hunks.map((hunk) => {
      const added = meaningful(hunk.added);
      const removed = meaningful(hunk.removed);
      let best: { key: string; s: number; at: number } | undefined;
      for (const [key, w] of writers) {
        const s = added.length ? score(added, w.added) : score(removed, w.removed);
        if (s > 0 && (!best || s > best.s || (s === best.s && w.lastAt > best.at))) best = { key, s, at: w.lastAt };
      }
      const all = [...writers.keys(), ...shell];
      // A tool call that deleted or created this very file outranks any shell text.
      const evidence = isDeleted && deleters.length === 1 ? deleters[0] : isNew && creators.length === 1 ? creators[0] : undefined;
      if (!best && evidence) return { hunk, owner: evidence, confidence: "sure", matched: 0, others: all.filter((k) => k !== evidence) };
      if (!best) {
        // No tool call explains it: try the text of shell commands that mention the file.
        for (const [key, w] of shellWriters) {
          const s = added.length ? containedShare(added, w.text) : containedShare(removed, w.text);
          if (s > 0 && (!best || s > best.s || (s === best.s && w.lastAt > best.at))) best = { key, s, at: w.lastAt };
        }
        if (!best) {
          // A substitution across many files: a write-looking command carrying both fragments.
          for (const c of writingShells) {
            if (c.at <= since) continue;
            const s = substitutionShare(hunk, c.command);
            if (s > 0 && (!best || s > best.s || (s === best.s && c.at > best.at))) best = { key: c.sessionKey, s, at: c.at };
          }
        }
        if (best) {
          // Shell evidence is never "sure": the command may have failed or been undone.
          return { hunk, owner: best.key, confidence: best.s >= 0.5 ? "likely" : "maybe", matched: best.s, others: all.filter((k) => k !== best!.key) };
        }
      }
      if (best) {
        return { hunk, owner: best.key, confidence: best.s >= 0.5 ? "sure" : "likely", matched: best.s, others: all.filter((k) => k !== best!.key) };
      }
      // A hunk with nothing to match (whitespace, lone brackets) goes to a single writer as a
      // guess. A hunk whose lines match nobody's writes stays unattributed: the lone session that
      // touched the file did not write those lines.
      const nothingToMatch = added.length === 0 && removed.length === 0;
      const sole = !nothingToMatch ? undefined : writers.size === 1 ? [...writers.keys()][0] : shell.length === 1 && writers.size === 0 ? shell[0] : undefined;
      if (sole) return { hunk, owner: sole, confidence: "maybe", matched: 0, others: all.filter((k) => k !== sole) };
      return { hunk, matched: 0, others: all };
    });

    // A deletion without hunks (binary, or too large to diff) still belongs to whoever deleted it.
    if (hunks.length === 0) {
      const all = [...writers.keys(), ...shell];
      const evidence = isDeleted && deleters.length === 1 ? deleters[0] : isNew && creators.length === 1 ? creators[0] : undefined;
      const owner = evidence ?? (all.length === 1 ? all[0] : undefined);
      const empty: Hunk = { header: "(no textual diff)", added: [], removed: [], lines: [] };
      hunks.push(
        owner
          ? { hunk: empty, owner, confidence: evidence ? "sure" : "maybe", matched: 0, others: all.filter((k) => k !== owner) }
          : { hunk: empty, matched: 0, others: all },
      );
    }
    return { file, hunks, shell };
  });

  propagateSubstitutions(results);
  return results;
}

/**
 * A codemod rewrites the same fragment in many files. When a session is known to have made a
 * substitution (from → to) in some file, give it the same unexplained substitution elsewhere.
 */
function propagateSubstitutions(results: FileAttribution[]): void {
  const owners = new Map<string, Set<string>>();
  const pairsOf = (h: Hunk) =>
    h.added.length > 0 && h.added.length === h.removed.length
      ? h.added.map((a, i) => changedFragment(h.removed[i]!, a)).filter((f) => f.to.length >= 3).map((f) => `${f.from}\u0000${f.to}`)
      : [];
  for (const r of results) {
    for (const h of r.hunks) {
      if (!h.owner || h.confidence === "maybe") continue;
      for (const pair of pairsOf(h.hunk)) owners.set(pair, (owners.get(pair) ?? new Set()).add(h.owner));
    }
  }
  for (const r of results) {
    for (const h of r.hunks) {
      if (h.owner) continue;
      const pairs = pairsOf(h.hunk);
      if (pairs.length === 0 || pairs.length !== h.hunk.added.length) continue;
      const candidates = pairs.map((p) => owners.get(p));
      const first = candidates[0];
      if (!first || first.size !== 1) continue;
      const [owner] = first;
      if (candidates.every((c) => c?.size === 1 && c.has(owner!))) {
        h.owner = owner;
        h.confidence = "likely";
        h.others = h.others.filter((k) => k !== owner);
      }
    }
  }
}
