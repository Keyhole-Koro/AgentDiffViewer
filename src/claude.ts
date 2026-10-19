import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sessionKey, type Session, type Transcripts } from "./types.ts";

/**
 * Claude Code keeps one JSONL transcript per session under ~/.claude/projects/<dir>/, where
 * <dir> is the session's working directory with "/" turned into "-". File changes appear as
 * Edit / MultiEdit / Write / NotebookEdit tool calls; Bash calls are recorded as shell commands.
 */

export function claudeRoot(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ? join(process.env["CLAUDE_CONFIG_DIR"], "projects") : join(homedir(), ".claude", "projects");
}

/** Transcript files modified after `sinceMs`, including subagent transcripts in session folders. */
function transcriptFiles(root: string, sinceMs: number): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && statSync(full).mtimeMs >= sinceMs) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

interface Line {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: { content?: unknown };
}

interface ToolUse {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

function firstPrompt(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((c) => c?.type === "text")?.text : undefined;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  // Skip slash-command wrappers, caveats and other harness text.
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[Request interrupted")) return undefined;
  return trimmed.replace(/\s+/g, " ");
}

export function readClaude(into: Transcripts, sinceMs: number, root = claudeRoot()): void {
  for (const file of transcriptFiles(root, sinceMs)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let session: Session | undefined;
    let title: string | undefined;
    let prompt: string | undefined;
    for (const raw of text.split("\n")) {
      // Only tool calls, titles and user prompts matter; most of a transcript is tool output and
      // attachments, so skip parsing those (session times come from the lines that are parsed).
      if (!raw || !(raw.includes('"tool_use"') || raw.includes('"ai-title"') || raw.includes('"type":"user"'))) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.type === "ai-title" && line.aiTitle) title = line.aiTitle;
      if (!line.sessionId || !line.timestamp) continue;
      const at = Date.parse(line.timestamp);
      const key = sessionKey("claude", line.sessionId);
      session ??= into.sessions.get(key) ?? {
        agent: "claude",
        id: line.sessionId,
        title: "",
        cwd: line.cwd,
        firstAt: at,
        lastAt: at,
        source: file,
      };
      session.firstAt = Math.min(session.firstAt, at);
      session.lastAt = Math.max(session.lastAt, at);
      into.sessions.set(key, session);

      if (line.type === "user" && !line.isMeta && !line.isSidechain && !prompt) prompt = firstPrompt(line.message?.content);
      if (line.type !== "assistant" || !Array.isArray(line.message?.content)) continue;

      for (const block of line.message.content as ToolUse[]) {
        if (block?.type !== "tool_use") continue;
        const input = block.input ?? {};
        const pathOf = (p: unknown) => (typeof p === "string" ? (isAbsolute(p) ? p : resolve(line.cwd ?? "/", p)) : undefined);
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        switch (block.name) {
          case "Edit": {
            const path = pathOf(input["file_path"]);
            if (path) into.events.push({ sessionKey: key, path, at, kind: "edit", added: str(input["new_string"]), removed: str(input["old_string"]) });
            break;
          }
          case "MultiEdit": {
            const path = pathOf(input["file_path"]);
            const edits = Array.isArray(input["edits"]) ? (input["edits"] as Record<string, unknown>[]) : [];
            if (path) {
              into.events.push({
                sessionKey: key,
                path,
                at,
                kind: "edit",
                added: edits.map((e) => str(e["new_string"])).join("\n"),
                removed: edits.map((e) => str(e["old_string"])).join("\n"),
              });
            }
            break;
          }
          case "Write": {
            const path = pathOf(input["file_path"]);
            if (path) into.events.push({ sessionKey: key, path, at, kind: "write", added: str(input["content"]), removed: "" });
            break;
          }
          case "NotebookEdit": {
            const path = pathOf(input["notebook_path"]);
            if (path) into.events.push({ sessionKey: key, path, at, kind: "edit", added: str(input["new_source"]), removed: "" });
            break;
          }
          case "Bash": {
            const command = str(input["command"]);
            if (command) into.shells.push({ sessionKey: key, at, command });
            break;
          }
        }
      }
    }
    if (session) session.title = session.title || title || prompt || "(no prompt)";
  }
}
