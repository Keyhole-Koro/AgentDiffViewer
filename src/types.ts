export type Agent = "claude" | "codex";

export interface Session {
  agent: Agent;
  id: string;
  /** A short description: the agent's title for the session, or its first prompt. */
  title: string;
  cwd: string | undefined;
  firstAt: number; // ms
  lastAt: number; // ms
  /** Where the transcript lives, for `agent-diff show`. */
  source: string;
}

/** One change a session made to one file, as far as its transcript tells. */
export interface FileEvent {
  sessionKey: string; // `${agent}:${id}`
  path: string; // absolute
  at: number; // ms
  kind: "edit" | "write" | "patch" | "delete";
  /** "hook": recorded by agent-diff's hook (exact); otherwise read from a transcript. */
  source?: "hook";
  /** Text the session wrote into the file (new_string, file content, + lines of a patch). */
  added: string;
  /** Text it replaced (old_string, - lines of a patch). */
  removed: string;
}

/** A shell command a session ran; matched against the changed files later. */
export interface ShellEvent {
  sessionKey: string;
  at: number;
  command: string;
}

export interface Transcripts {
  sessions: Map<string, Session>;
  events: FileEvent[];
  shells: ShellEvent[];
}

export function sessionKey(agent: Agent, id: string): string {
  return `${agent}:${id}`;
}
