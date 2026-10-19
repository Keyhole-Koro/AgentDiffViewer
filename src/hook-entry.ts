#!/usr/bin/env node
// Lean entry point for the agents' hooks: loads only the recorder, never prints, always exits 0.
import { runHook } from "./hook.ts";

const i = process.argv.indexOf("--agent");
const agent = process.argv[i + 1] === "codex" ? "codex" : "claude";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
try {
  runHook(agent, stdin);
} catch {
  // never block or fail a tool call
}
