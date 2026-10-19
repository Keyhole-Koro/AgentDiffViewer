import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionKey, type Session, type Transcripts } from "./types.ts";

/**
 * Codex keeps one JSONL "rollout" per session under ~/.codex/sessions/YYYY/MM/DD/. File changes
 * arrive as FileChange items with a unified diff per absolute path (moves carry move_path);
 * shell commands as CommandExecution items. Older Codex builds logged apply_patch calls instead;
 * those are read from the patch text.
 */

export function codexRoot(): string {
  return join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "sessions");
}

function rolloutFiles(root: string, sinceMs: number): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl") && statSync(full).mtimeMs >= sinceMs) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** + and - lines of a unified diff (or of an apply_patch hunk), without their markers. */
export function diffSides(diff: string): { added: string; removed: string } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added: added.join("\n"), removed: removed.join("\n") };
}

/** Files and their changes in an apply_patch "*** Begin Patch" document. */
export function parseApplyPatch(patch: string): { path: string; kind: "add" | "update" | "delete"; moveTo?: string; body: string }[] {
  const out: { path: string; kind: "add" | "update" | "delete"; moveTo?: string; body: string }[] = [];
  let current: (typeof out)[number] | undefined;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { path: header[2]!.trim(), kind: header[1]!.toLowerCase() as "add" | "update" | "delete", body: "" };
      out.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      current.moveTo = move[1]!.trim();
      continue;
    }
    if (line.startsWith("***")) continue;
    if (current) current.body += line + "\n";
  }
  return out;
}

interface Entry {
  timestamp?: string;
  type?: string;
  payload?: Record<string, any>;
}

export function readCodex(into: Transcripts, sinceMs: number, root = codexRoot()): void {
  for (const file of rolloutFiles(root, sinceMs)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let session: Session | undefined;
    let key = "";
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      // Only these entries matter; skip parsing reasoning, outputs and token counts.
      if (!/"type":"(session_meta|item_completed|function_call|custom_tool_call)"/.test(raw.slice(0, 200)) && !raw.includes('"apply_patch"')) {
        continue;
      }
      let entry: Entry;
      try {
        entry = JSON.parse(raw) as Entry;
      } catch {
        continue;
      }
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      const p = entry.payload ?? {};
      if (entry.type === "session_meta" && p["id"]) {
        key = sessionKey("codex", p["id"]);
        session = into.sessions.get(key) ?? {
          agent: "codex",
          id: p["id"],
          title: "",
          cwd: p["cwd"],
          firstAt: Date.parse(p["timestamp"] ?? entry.timestamp ?? "") || at,
          lastAt: at,
          source: file,
        };
        into.sessions.set(key, session);
        continue;
      }
      if (!session || Number.isNaN(at)) continue;
      session.lastAt = Math.max(session.lastAt, at);

      const item = p["type"] === "item_completed" ? (p["item"] as Record<string, any> | undefined) : undefined;
      if (item?.["type"] === "UserMessage" && !session.title) {
        const t = (item["content"] as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
        if (t) session.title = t.trim().replace(/\s+/g, " ");
      }
      if (item?.["type"] === "FileChange") {
        for (const [path, change] of Object.entries(item["changes"] as Record<string, any>)) {
          if (change.type === "add") {
            into.events.push({ sessionKey: key, path, at, kind: "write", added: String(change.content ?? ""), removed: "" });
          } else if (change.type === "delete") {
            into.events.push({ sessionKey: key, path, at, kind: "delete", added: "", removed: String(change.content ?? "") });
          } else {
            const sides = diffSides(String(change.unified_diff ?? ""));
            into.events.push({ sessionKey: key, path, at, kind: "patch", ...sides });
            if (change.move_path) {
              into.events.push({ sessionKey: key, path: change.move_path, at, kind: "write", added: sides.added, removed: "" });
              into.events.push({ sessionKey: key, path, at, kind: "delete", added: "", removed: "" });
            }
          }
        }
      }
      if (item?.["type"] === "CommandExecution") {
        const cmd = item["command"];
        const command = Array.isArray(cmd) ? String(cmd.at(-1)) : String(cmd ?? "");
        if (command) into.shells.push({ sessionKey: key, at, command });
      }
      // Newer Codex drives tools from JavaScript (`exec`); the script text is evidence like a
      // shell command (it may rewrite files through the tools it calls).
      if (p["type"] === "custom_tool_call" && p["name"] === "exec" && typeof p["input"] === "string") {
        into.shells.push({ sessionKey: key, at, command: p["input"] });
      }
      // Older rollouts: apply_patch as a function/custom tool call.
      if ((p["type"] === "function_call" || p["type"] === "custom_tool_call") && p["name"] === "apply_patch") {
        const patch = String(p["input"] ?? p["arguments"] ?? "");
        for (const f of parseApplyPatch(patch)) {
          const sides = diffSides(f.body);
          if (f.kind === "add") into.events.push({ sessionKey: key, path: f.path, at, kind: "write", added: sides.added, removed: "" });
          else if (f.kind === "delete") into.events.push({ sessionKey: key, path: f.path, at, kind: "delete", added: "", removed: "" });
          else into.events.push({ sessionKey: key, path: f.path, at, kind: "patch", ...sides });
          if (f.moveTo) into.events.push({ sessionKey: key, path: f.moveTo, at, kind: "write", added: sides.added, removed: "" });
        }
      }
    }
    if (session) session.title ||= "(no prompt)";
  }
}
