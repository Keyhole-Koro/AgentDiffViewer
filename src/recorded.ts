import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readHookRecords, type HookRecord } from "./hook.ts";
import { sessionKey, type FileEvent, type Transcripts } from "./types.ts";

/** One change from a hook record, with its diff: what exactly the tool call did to the file. */
export interface RecordedChange {
  sessionKey: string;
  record: HookRecord;
  path: string; // relative to the repo
  before: string | null;
  after: string | null;
  /** `git diff` between the two blobs, with 3 lines of context (header lines removed). */
  diff: string[];
  added: string[];
  removed: string[];
}

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** Diff two blobs (null = absent). Lines start with " ", "+", "-" or "@@". */
export function blobDiff(root: string, before: string | null, after: string | null, context = 3): string[] {
  try {
    // The empty blob stands in for a missing side so creations and deletions diff normally.
    const text = git(root, ["diff", "--no-color", `-U${context}`, before ?? EMPTY_BLOB, after ?? EMPTY_BLOB]);
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.startsWith("@@"));
    return start < 0 ? [] : lines.slice(start).filter((l) => l !== "");
  } catch {
    return []; // a blob was pruned by git gc
  }
}

/**
 * Hook records since `sinceMs`, as diffs, limited to `paths` (relative) when given. Sessions that
 * only appear in hook records (their transcript is older than --days) are added to `into`.
 */
export function recordedChanges(root: string, into: Transcripts, sinceMs: number, paths?: Set<string>): RecordedChange[] {
  const out: RecordedChange[] = [];
  const cache = new Map<string, string[]>();
  for (const record of readHookRecords(root, sinceMs)) {
    const key = sessionKey(record.agent, record.session);
    const s = into.sessions.get(key);
    if (s) {
      s.firstAt = Math.min(s.firstAt, record.at);
      s.lastAt = Math.max(s.lastAt, record.at);
    } else {
      into.sessions.set(key, {
        agent: record.agent,
        id: record.session,
        title: "(transcript not read)",
        cwd: root,
        firstAt: record.at,
        lastAt: record.at,
        source: record.transcript ?? "",
      });
    }
    for (const c of record.changes) {
      if (paths && !paths.has(c.path)) continue;
      const pair = `${c.before}:${c.after}`;
      let diff = cache.get(pair);
      if (!diff) {
        diff = blobDiff(root, c.before, c.after);
        cache.set(pair, diff);
      }
      out.push({
        sessionKey: key,
        record,
        path: c.path,
        before: c.before,
        after: c.after,
        diff,
        added: diff.filter((l) => l.startsWith("+")).map((l) => l.slice(1)),
        removed: diff.filter((l) => l.startsWith("-")).map((l) => l.slice(1)),
      });
    }
  }
  return out;
}

/** The same changes as attribution events (exact evidence). */
export function recordedEvents(root: string, changes: RecordedChange[]): FileEvent[] {
  return changes.map((c) => ({
    sessionKey: c.sessionKey,
    path: join(root, c.path),
    at: c.record.at,
    kind: c.before === null ? "write" : c.after === null ? "delete" : "patch",
    added: c.added.join("\n"),
    removed: c.removed.join("\n"),
    source: "hook" as const,
  }));
}
