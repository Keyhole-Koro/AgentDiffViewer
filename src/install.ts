import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./types.ts";

/**
 * Registers the recorder as a PreToolUse + PostToolUse hook, user-wide, in
 *   Claude Code: ~/.claude/settings.json   (hooks.PreToolUse / hooks.PostToolUse)
 *   Codex:       ~/.codex/hooks.json       (same shape)
 * Other hooks are left as they are; ours are recognised by the "agent-diff-hook" marker.
 */

const MARKER = "agent-diff-hook";
const EVENTS = ["PreToolUse", "PostToolUse"] as const;
/** Tools that can write files. Read-only tools are not hooked, so they cost nothing. */
const MATCHERS: Record<Agent, string> = {
  claude: "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$",
  codex: "^(Bash|apply_patch|Edit|Write)$",
};

export function settingsFile(agent: Agent): string {
  if (agent === "claude") return join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "settings.json");
  return join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "hooks.json");
}

function onPath(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/** How the agent should start the recorder: the installed bin, else node + this checkout. */
function hookCommand(agent: Agent): string {
  if (onPath(MARKER)) return `${MARKER} --agent ${agent}`;
  const entry = join(dirname(fileURLToPath(import.meta.url)), "hook-entry.ts");
  return `"${process.execPath}" "${entry}" --agent ${agent} # ${MARKER}`;
}

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number }[];
}

type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").trim();
  return text ? (JSON.parse(text) as Settings) : {};
}

function isOurs(group: HookGroup): boolean {
  return group.hooks?.some((h) => h.command?.includes(MARKER)) ?? false;
}

function writeSettings(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak-agent-diff`);
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export function installHooks(agent: Agent): { file: string; changed: boolean } {
  const file = settingsFile(agent);
  const settings = readSettings(file);
  const command = hookCommand(agent);
  settings.hooks ??= {};
  let changed = false;
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    const ours = groups.find(isOurs);
    const want: HookGroup = { matcher: MATCHERS[agent], hooks: [{ type: "command", command, timeout: 30 }] };
    if (ours && JSON.stringify(ours) === JSON.stringify(want)) continue;
    if (ours) groups.splice(groups.indexOf(ours), 1, want);
    else groups.push(want);
    changed = true;
  }
  if (changed) writeSettings(file, settings);
  return { file, changed };
}

export function uninstallHooks(agent: Agent): { file: string; changed: boolean } {
  const file = settingsFile(agent);
  if (!existsSync(file)) return { file, changed: false };
  const settings = readSettings(file);
  let changed = false;
  for (const event of EVENTS) {
    const groups = settings.hooks?.[event];
    if (!groups) continue;
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length !== groups.length) {
      changed = true;
      if (kept.length) settings.hooks![event] = kept;
      else delete settings.hooks![event];
    }
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (changed) writeSettings(file, settings);
  return { file, changed };
}

export function agentInstalled(agent: Agent): boolean {
  return onPath(agent === "claude" ? "claude" : "codex") || existsSync(dirname(settingsFile(agent)));
}
