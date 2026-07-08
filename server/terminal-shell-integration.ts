import fs from 'fs'
import path from 'path'
import os from 'os'

import type { TerminalSettings } from './terminal-settings'

export interface ShellIntegrationSpawn {
  /** Args to inject ahead of the existing arg list (or replace, depending on shell). */
  args: string[]
  /** Env vars to merge into the child env. */
  env: Record<string, string>
  /** Directory containing per-session generated artefacts (chmod 600). null when integration is disabled or shell is unsupported. */
  shimDir: string | null
  /** Path to the primary shim file actually executed by the shell. null when integration is disabled. */
  shimPath: string | null
}

export const NO_SHELL_INTEGRATION: ShellIntegrationSpawn = {
  args: [],
  env: {},
  shimDir: null,
  shimPath: null,
}

const STALE_SHIM_DIR_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the shell basename for our switch logic. We accept full paths or bare
 * basenames (e.g. "/bin/zsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe").
 */
function shellBasename(shell: string): string {
  // Use posix.basename after normalising backslashes so this works on Windows paths.
  const normalized = shell.replace(/\\/g, '/')
  return path.posix.basename(normalized).toLowerCase().replace(/\.exe$/, '')
}

/** Source of bundled shims; overridable for tests/packaging. */
export function locateBundledShim(name: string): string | null {
  const execDir = path.dirname(process.execPath)
  const candidates = [
    path.resolve(__dirname, 'shell-integration', name),
    // Desktop bundle: shims ship under binaries/shell-integration (declared in
    // tauri.conf.json resources). Windows/Linux install vs macOS .app layout.
    path.resolve(execDir, 'binaries', 'shell-integration', name),
    path.resolve(execDir, '..', 'Resources', 'binaries', 'shell-integration', name),
    // Legacy / sibling layouts (kept as existence-gated fallbacks).
    path.resolve(execDir, 'shell-integration', name),
    path.resolve(execDir, '..', 'shell-integration', name),
    path.resolve(process.cwd(), 'server', 'shell-integration', name),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  // Observability: a packaging regression that drops the shims would otherwise
  // silently disable shell integration (no marks/cwd) with no clue why. Warn
  // once per shim name so it's diagnosable from the server log.
  warnShimMissingOnce(name)
  return null
}

const _warnedShims = new Set<string>()
function warnShimMissingOnce(name: string): void {
  if (_warnedShims.has(name)) return
  _warnedShims.add(name)
  console.warn(`[terminal-shell-integration] bundled shim not found: ${name} — shell integration disabled for this shell`)
}

function specrailsHome(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

function projectsRoot(): string {
  return path.join(specrailsHome(), '.specrails', 'projects')
}

export function shimDirFor(projectSlug: string, sessionId: string): string {
  return path.join(projectsRoot(), projectSlug, 'terminals', sessionId)
}

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, { mode: 0o600 })
}

/**
 * Compose the env+args needed to spawn the given shell with our shim active.
 * When integration is disabled or the shell is unsupported, returns
 * NO_SHELL_INTEGRATION so the caller's spawn proceeds unchanged.
 */
export function composeShellIntegrationSpawn(
  shell: string,
  sessionId: string,
  projectSlug: string,
  settings: Pick<TerminalSettings, 'shellIntegrationEnabled'>,
): ShellIntegrationSpawn {
  if (!settings.shellIntegrationEnabled) return NO_SHELL_INTEGRATION
  const base = shellBasename(shell)
  const shimDir = shimDirFor(projectSlug, sessionId)

  if (base === 'zsh') {
    const bundled = locateBundledShim('zsh-shim.zsh')
    if (!bundled) return NO_SHELL_INTEGRATION
    const userZdotdirZshrc = path.join(shimDir, '.zshrc')
    const shimContent = `# Specrails auto-generated zsh entry — do not edit\nsource '${bundled.replace(/'/g, `'\\''`)}'\n`
    writeFile(userZdotdirZshrc, shimContent)
    return {
      args: [],
      // Pass the user's real ZDOTDIR (default $HOME) so the shim can still source
      // their ~/.zshenv/.zprofile/.zshrc/.zlogin — the override alone would make
      // zsh skip the login files and lose PATH/Homebrew/nvm setup.
      env: { ZDOTDIR: shimDir, SPECRAILS_REAL_ZDOTDIR: process.env.ZDOTDIR ?? '' },
      shimDir,
      shimPath: userZdotdirZshrc,
    }
  }

  if (base === 'bash') {
    const bundled = locateBundledShim('bash-shim.bash')
    if (!bundled) return NO_SHELL_INTEGRATION
    const shimPath = path.join(shimDir, 'shim.bash')
    const shimContent = `# Specrails auto-generated bash rcfile — do not edit\nsource '${bundled.replace(/'/g, `'\\''`)}'\n`
    writeFile(shimPath, shimContent)
    return {
      args: ['--rcfile', shimPath],
      env: {},
      shimDir,
      shimPath,
    }
  }

  if (base === 'fish') {
    const bundled = locateBundledShim('fish-shim.fish')
    if (!bundled) return NO_SHELL_INTEGRATION
    // Use fish's -C/--init-command, which runs AFTER the user's config.fish and
    // conf.d, so the user's real fish config is preserved. The previous approach
    // repointed XDG_CONFIG_HOME at the shim dir, which made fish resolve its
    // ENTIRE config tree (config.fish, functions, completions) from the shim dir
    // and silently dropped the user's configuration.
    return {
      args: ['-C', `source '${bundled.replace(/'/g, `'\\''`)}'`],
      env: {},
      // No per-session dir is written; shimPath (non-null) activates OSC parsing.
      shimDir: null,
      shimPath: bundled,
    }
  }

  if (base === 'powershell' || base === 'pwsh') {
    const bundled = locateBundledShim('powershell-shim.ps1')
    if (!bundled) return NO_SHELL_INTEGRATION
    const shimPath = path.join(shimDir, 'profile.ps1')
    const shimContent = `# Specrails auto-generated PowerShell profile — do not edit\n. '${bundled.replace(/'/g, "''")}'\n`
    writeFile(shimPath, shimContent)
    return {
      args: ['-NoLogo', '-NoExit', '-File', shimPath],
      env: {},
      shimDir,
      shimPath,
    }
  }

  // Unsupported shell — degrade silently.
  return NO_SHELL_INTEGRATION
}

export function cleanupSessionShim(projectSlug: string, sessionId: string): void {
  const dir = shimDirFor(projectSlug, sessionId)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

/**
 * Sweep stale shim directories on startup. A directory is "stale" when its
 * mtime is older than 24h. The volatile session registry is empty on cold
 * start, so we cannot match against live sessions; the age cap prevents us
 * from removing a directory that just spawned.
 */
export function cleanupStaleShimDirs(now: number = Date.now()): number {
  let removed = 0
  let projectsDir: string[] = []
  try {
    projectsDir = fs.readdirSync(projectsRoot())
  } catch { return 0 }
  for (const slug of projectsDir) {
    const terminalsRoot = path.join(projectsRoot(), slug, 'terminals')
    let entries: string[] = []
    try { entries = fs.readdirSync(terminalsRoot) } catch { continue }
    for (const sid of entries) {
      const dir = path.join(terminalsRoot, sid)
      try {
        const stat = fs.statSync(dir)
        if (!stat.isDirectory()) continue
        if (now - stat.mtimeMs >= STALE_SHIM_DIR_AGE_MS) {
          fs.rmSync(dir, { recursive: true, force: true })
          removed++
        }
      } catch { /* ignore */ }
    }
  }
  return removed
}
