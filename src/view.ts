import type { Confidence } from "./attribute.ts";
import type { Loaded } from "./core.ts";
import type { Agent } from "./types.ts";

/** What the viewer (and `--json`) shows: the changes grouped by the session that made them. */
export interface View {
  root: string;
  range: string;
  generatedAt: number;
  sessions: ViewSession[];
  /** Changes no session explains. */
  unknown: ViewFile[];
}

export interface ViewSession {
  key: string;
  agent: Agent;
  id: string;
  title: string;
  firstAt: number;
  lastAt: number;
  files: ViewFile[];
}

export interface ViewFile {
  path: string;
  status: string;
  /** How many hunks the file has in all (the session may own only some). */
  total: number;
  hunks: ViewHunk[];
  /** Sessions whose shell commands mention the file (a hint for unknown changes). */
  shell?: string[];
}

export interface ViewHunk {
  header: string;
  lines: string[];
  confidence: Confidence | null;
  truncated?: number;
}

const MAX_LINES = 400;

export function buildView(loaded: Loaded): View {
  const sessions = new Map<string, ViewSession>();
  const unknown: ViewFile[] = [];
  for (const a of loaded.attributions) {
    const groups = new Map<string, ViewHunk[]>();
    for (const h of a.hunks) {
      const k = h.owner ?? "";
      const lines = h.hunk.lines.slice(0, MAX_LINES);
      const hunk: ViewHunk = { header: h.hunk.header, lines, confidence: h.confidence ?? null };
      if (h.hunk.lines.length > MAX_LINES) hunk.truncated = h.hunk.lines.length - MAX_LINES;
      groups.set(k, [...(groups.get(k) ?? []), hunk]);
    }
    const status = a.file.status === "??" ? "A" : (a.file.status[0] ?? "M");
    for (const [k, hunks] of groups) {
      const file: ViewFile = { path: a.file.rel, status, total: a.hunks.length, hunks };
      if (!k) {
        if (a.shell.length) file.shell = a.shell;
        unknown.push(file);
        continue;
      }
      let s = sessions.get(k);
      if (!s) {
        const t = loaded.transcripts.sessions.get(k);
        const [agent, id] = k.split(":") as [Agent, string];
        s = { key: k, agent, id, title: t?.title ?? "", firstAt: t?.firstAt ?? 0, lastAt: t?.lastAt ?? 0, files: [] };
        sessions.set(k, s);
      }
      s.files.push(file);
    }
  }
  return {
    root: loaded.root,
    range: loaded.range.label,
    generatedAt: Date.now(),
    sessions: [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt),
    unknown,
  };
}
