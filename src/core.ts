import { attribute, type FileAttribution } from "./attribute.ts";
import { readClaude } from "./claude.ts";
import { readCodex } from "./codex.ts";
import { changedFiles, commitAt, EMPTY_TREE, gitAdd, gitApplyCached, unstagedDiff, type Range } from "./git.ts";
import { recordedChanges, recordedEvents, type RecordedChange } from "./recorded.ts";
import type { Transcripts } from "./types.ts";

export interface Loaded {
  root: string;
  range: Range & { label: string };
  transcripts: Transcripts;
  attributions: FileAttribution[];
  recorded: RecordedChange[];
}

/** "2h", "30m", "3d", "today", or anything Date understands, as ms since the epoch. */
export function parseSince(text: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/.exec(text.trim());
  if (m) return now - Number(m[1]) * { m: 6e4, min: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2] as "m"];
  if (text === "today") return new Date(new Date(now).toDateString()).getTime();
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`--since: cannot read "${text}" (try 2h, 1d, today or 2026-10-19T09:00)`);
  return t;
}

/**
 * The changes to show and who made them. By default the uncommitted ones; with `base`, everything
 * since that commit; with `since`, everything since the commit that was HEAD then, made by
 * sessions active after it.
 */
export function load(root: string, opts: { days?: number; base?: string; since?: number } = {}): Loaded {
  const range: Loaded["range"] = { label: "uncommitted" };
  if (opts.since !== undefined) {
    range.cutoff = opts.since;
    range.base = commitAt(root, opts.since) ?? EMPTY_TREE;
    range.label = `since ${new Date(opts.since).toLocaleString()}`;
  }
  if (opts.base) {
    range.base = opts.base;
    range.label = `since ${opts.base}`;
  }
  const files = changedFiles(root, range);
  const transcripts: Transcripts = { sessions: new Map(), events: [], shells: [] };
  let recorded: RecordedChange[] = [];
  if (files.length) {
    const since = Math.min(Date.now() - (opts.days ?? 30) * 864e5, opts.since ?? Infinity);
    readClaude(transcripts, since);
    readCodex(transcripts, since);
    recorded = recordedChanges(root, transcripts, since, new Set(files.map((f) => f.rel)));
    transcripts.events.push(...recordedEvents(root, recorded));
  }
  return { root, range, transcripts, attributions: attribute(files, transcripts), recorded };
}

export function findSession(transcripts: Transcripts, query: string): string {
  const [agent, prefix] = query.includes(":") ? (query.split(":", 2) as [string, string]) : [undefined, query];
  const matches = [...transcripts.sessions.keys()].filter((k) => {
    const [a, id] = k.split(":") as [string, string];
    return (!agent || a === agent) && id.startsWith(prefix);
  });
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `"${query}" matches ${matches.length} sessions; use a longer prefix.` : `No session "${query}" touched these changes.`);
}

export interface AddPlan {
  /** Files the session alone changed: staged whole. */
  whole: string[];
  /** Files shared with other sessions: only the session's hunks, as a patch for the index. */
  partial: { rel: string; patch: string; hunks: number }[];
  skipped: string[];
}

/**
 * What staging the session's changes means: whole files it alone changed, and its hunks of files
 * shared with other sessions (rebuilt from the index-vs-worktree diff, so earlier staging is respected).
 */
export function planAdd({ root, transcripts, attributions }: Loaded, key: string): AddPlan {
  const plan: AddPlan = { whole: [], partial: [], skipped: [] };
  for (const a of attributions) {
    const mine = a.hunks.filter((h) => h.owner === key);
    if (!mine.length) continue;
    if (mine.length === a.hunks.length) {
      plan.whole.push(a.file.rel);
      continue;
    }
    const diff = unstagedDiff(root, a.file.rel);
    if (!diff) {
      plan.skipped.push(`${a.file.rel} (already staged)`);
      continue;
    }
    // Re-attribute the index-vs-worktree hunks with the same evidence.
    const [redo] = attribute([{ ...a.file, hunks: diff.hunks }], transcripts);
    const keep = redo!.hunks.filter((h) => h.owner === key);
    if (!keep.length) {
      plan.skipped.push(`${a.file.rel} (its hunks are already staged)`);
      continue;
    }
    const patch = [...diff.header, ...keep.flatMap((h) => [h.hunk.header, ...h.hunk.lines])].join("\n") + "\n";
    plan.partial.push({ rel: a.file.rel, patch, hunks: keep.length });
  }
  return plan;
}

export function applyAdd(root: string, plan: AddPlan): void {
  gitAdd(root, plan.whole);
  for (const p of plan.partial) gitApplyCached(root, p.patch);
}
