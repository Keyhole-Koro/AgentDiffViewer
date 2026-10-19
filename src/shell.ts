/**
 * Shell commands are opaque, so they only make a session a *possible* author: the command
 * mentions the file and looks like it writes (sed -i, redirection, mv, a script, …).
 */
const WRITES =
  /\bwrite_file|apply_patch|\.replace(All)?\(|\bsed\s+-i|\bperl\s+-p?i|>>?\s*\S|\btee\b|\b(mv|cp|rm|git\s+mv|git\s+rm|touch|truncate)\b|\bpython3?\b|\bnode\b|\bbun\b|writeFile|open\([^)]*['"]w|\bpatch\b|\bgit\s+(checkout|restore|apply|stash)\b|\bnpm\s+(i|install|uninstall|version)\b|\bpnpm\b/;

export function shellMayWrite(command: string): boolean {
  return WRITES.test(command);
}

/** The changed files (absolute paths) that a write-looking command mentions. */
export function filesMentioned(command: string, files: { abs: string; rel: string }[]): string[] {
  if (!shellMayWrite(command)) return [];
  return files.filter((f) => command.includes(f.abs) || mentionsRelative(command, f.rel)).map((f) => f.abs);
}

function mentionsRelative(command: string, rel: string): boolean {
  let from = 0;
  for (;;) {
    const i = command.indexOf(rel, from);
    if (i < 0) return false;
    const before = i === 0 ? " " : command[i - 1]!;
    const after = command[i + rel.length] ?? " ";
    // Whole path only: "a/b.ts" must not match inside "x/a/b.ts" or "a/b.ts.bak"; "./a/b.ts" is fine.
    const startsPath = /[\s'"=(]/.test(before) || command.slice(i - 2, i) === "./";
    if (startsPath && /[\s'":;)|&>]/.test(after)) return true;
    from = i + 1;
  }
}
