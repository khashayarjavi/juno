/**
 * Linux paths only (operator ruling 1 of 2026-11-08, second set; DECISIONS.md D-173, on D-172 option (b)). Claude Code
 * is governed only when it runs inside WSL2, so every path it names is a Linux path. A Windows-form path is refused,
 * fail-closed, with a reason that says so: Windows may rewrite such a name before it opens it (a trailing `.` or space
 * dropped, case ignored, D-172), and JUNO judges a path only as the Linux kernel reads it.
 *
 * Windows-form, for JUNO (D-173):
 *   - a backslash anywhere (`\\wsl.localhost\…`, `\\?\…`, `\\.\…`, `\\server\share`, `C:\x`, and `a\b`);
 *   - a drive letter and a colon at the start (`C:`, `c:/x`, `C:x`);
 *   - a leading `//` (a UNC or `//?/` path written with forward slashes; restrictive: Linux reads it as `/`).
 */
export function windowsFormReason(path: string): string | null {
  if (path.includes("\\")) return `${JSON.stringify(path)} holds a backslash`;
  if (/^[A-Za-z]:/.test(path)) return `${JSON.stringify(path)} starts with a drive letter`;
  if (path.startsWith("//")) return `${JSON.stringify(path)} starts with // (a UNC path)`;
  return null;
}

/** The denial's text for a Windows-form path: plain, and naming the ruling. */
export function windowsFormRefusal(field: string, why: string): string {
  return `${field}: ${why}, so it is a Windows-form path. JUNO governs Claude Code only inside WSL2 and accepts only Linux absolute paths (D-173)`;
}
