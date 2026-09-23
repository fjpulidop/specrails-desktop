/**
 * Shared deny-set of directory segment names that hold build output, vendored
 * dependencies, or VCS metadata. These trees can contain tens of thousands of
 * constantly-rewritten files (e.g. a Rust `target/` or a Tauri `src-tauri/target`
 * with the assembled app bundle) and must never be recursively watched or walked.
 *
 * Recursively watching such a tree was the confirmed root cause of a file-descriptor
 * leak (~10k fds) that, under fd pressure, made node-pty's forkpty fail to give the
 * child shell a controlling tty — the shell then read EOF and exited instantly,
 * producing dead/hung terminals. See server/modules/code/runtime/file-summary-manager.ts (the watcher)
 * and server/modules/code/runtime/code-explorer-router.ts (the on-demand tree walk).
 *
 * Dot-directories (`.git`, `.next`, `.turbo`, `.venv`, …) are handled separately
 * by a `startsWith('.')` segment check so we don't have to enumerate every one.
 */
export const BUILD_DIRS: ReadonlySet<string> = new Set<string>([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target', // rust / java / sbt — also covers src-tauri/target
  'vendor', // go / php
])

/**
 * True when any segment of the (relative) path is a build/dep dir or a
 * dot-directory. Pass a path RELATIVE to the project root so a dot-segment in
 * the absolute prefix (e.g. a user's home dir) cannot cause a false positive.
 */
export function isInBuildDir(relPath: string): boolean {
  for (const seg of relPath.split(/[\\/]/)) {
    if (!seg || seg === '.' || seg === '..') continue
    if (seg.startsWith('.')) return true
    if (BUILD_DIRS.has(seg)) return true
  }
  return false
}
