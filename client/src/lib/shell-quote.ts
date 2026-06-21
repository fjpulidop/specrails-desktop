/**
 * Shell-quoting helpers for path injection (drag-drop). Strict — never trust the
 * input string to be safe.
 */

/**
 * POSIX (sh, bash, zsh, fish): single-quote the path, escape any embedded `'`
 * with the canonical `'\''` sequence. Always quoting is the simplest correct
 * approach because single-quoted strings have no escape interpretation in POSIX.
 */
export function quotePosix(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * Windows cmd.exe ONLY: wrap in double quotes; escape inner double quotes by
 * doubling (`""`) and caret-escape cmd metacharacters (`%`, `^`).
 *
 * ⚠️ NOT safe for PowerShell (M3): inside a PowerShell double-quoted string,
 * `$(...)` and backtick are interpolated, so a path like `$(calc.exe).txt` would
 * execute once the line reaches the prompt. Use `quoteWindowsPowerShell` for
 * PowerShell. Retained only for callers that KNOW the target shell is cmd.exe.
 */
export function quoteWindowsCmd(path: string): string {
  const escaped = path
    .replace(/\^/g, '^^')
    .replace(/%/g, '^%')
    .replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * Windows PowerShell: single-quote the path. PowerShell single-quoted strings
 * perform NO interpolation — `$`, `$(...)`, and backtick are all literal — so
 * this is injection-safe (M3). Inner single quotes are doubled (`''`).
 */
export function quoteWindowsPowerShell(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/**
 * Resolved Windows shell family for a terminal session. The server's
 * `resolveShellFor` resolves PowerShell when available and otherwise falls back
 * to `COMSPEC`/cmd.exe; those two quote completely differently. When the server
 * exposes the resolved family per session, callers thread it through here so a
 * cmd.exe session quotes correctly (BUG-CLIENT-02).
 */
export type WindowsShellHint = 'powershell' | 'cmd'

/**
 * Pick the right quoting for the host runtime. POSIX outside Windows. On Windows
 * the quoting depends on the resolved shell: PowerShell (the default — the
 * integrated terminal resolves powershell.exe when present) interpolates inside
 * double quotes, so we single-quote (cmd-style doubles would be an injection
 * sink, M3); cmd.exe passes single quotes literally, so it needs the double-quote
 * `quoteWindowsCmd` path instead.
 *
 * `shellHint` defaults to `'powershell'` so the no-hint behaviour is byte-
 * identical to before — only an explicit `'cmd'` hint changes anything.
 */
export function quoteForHost(
  path: string,
  isWindows: boolean,
  shellHint: WindowsShellHint = 'powershell',
): string {
  if (!isWindows) return quotePosix(path)
  return shellHint === 'cmd' ? quoteWindowsCmd(path) : quoteWindowsPowerShell(path)
}

/** Join multiple paths separated by spaces, each individually quoted. */
export function quotePathList(
  paths: string[],
  isWindows: boolean,
  shellHint: WindowsShellHint = 'powershell',
): string {
  return paths.map((p) => quoteForHost(p, isWindows, shellHint)).join(' ')
}
