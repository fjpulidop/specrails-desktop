import os from 'os'

/**
 * The directory that contains `.specrails/`. `SPECRAILS_REGISTRY_HOME` replaces
 * the user's home when set: tests point it at a throwaway directory, and the
 * development desktop profile points it at its own directory so it never shares
 * the installed app's databases, worktrees or tokens. Core honours the same
 * variable. Real tool homes (`~/.claude`, `~/.codex`, `~/.gemini`) are not
 * Specrails data and keep using `os.homedir()`.
 */
export function resolveSpecrailsHome(home?: string): string {
  return home ?? process.env.SPECRAILS_REGISTRY_HOME ?? os.homedir()
}
