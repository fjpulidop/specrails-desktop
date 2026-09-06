import { getBundledOpenspecCli } from './bundled-openspec'
import { resolveBundledNodeExe } from './path-resolver'

/** Resolve the exact built-in archive operation without requiring a global CLI. */
export function bundledLoopShellInvocation(command: string): { binary: string; args: string[] } | null {
  const match = /^openspec archive ([A-Za-z0-9][A-Za-z0-9._-]*) -y$/.exec(command)
  if (!match) return null
  const cli = getBundledOpenspecCli()
  if (!cli) {
    if (process.env.SPECRAILS_IS_DESKTOP === '1') throw new Error('The bundled OpenSpec CLI is unavailable; repair the desktop installation before archiving.')
    return null
  }
  const binary = resolveBundledNodeExe() ?? (!(process as NodeJS.Process & { pkg?: unknown }).pkg ? process.execPath : null)
  if (!binary) throw new Error('The bundled Node runtime is unavailable; the archive was not started.')
  return { binary, args: [cli, 'archive', match[1], '-y'] }
}
