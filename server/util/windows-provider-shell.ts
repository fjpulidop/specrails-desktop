import { statSync } from 'node:fs'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { stripWindowsVerbatimPrefix } from './win-spawn'

/** Provider tools must find PortableGit's Bash even with only git/cmd on PATH. */
export function withWindowsProviderShell(binary: 'claude' | 'kimi', options: SpawnOptions): SpawnOptions {
  if (process.platform !== 'win32') return options
  const key = binary === 'claude' ? 'CLAUDE_CODE_GIT_BASH_PATH' : 'KIMI_SHELL_PATH'
  const effective = options.env ?? process.env
  if (Object.entries(effective).some(([name, value]) => name.toUpperCase() === key && value !== undefined)) return options
  const inherited = Object.entries(process.env).find(([name, value]) => name.toUpperCase() === key && value !== undefined)?.[1]
  const runtimes = stripWindowsVerbatimPrefix(effective.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? '')
  const bundled = runtimes ? [path.join(runtimes, 'git', 'bin', 'bash.exe'), path.join(runtimes, 'git', 'usr', 'bin', 'bash.exe')]
    .find(candidate => { try { return statSync(candidate).isFile() } catch { return false } }) : undefined
  const selected = inherited ?? bundled
  return selected === undefined ? options : { ...options, env: { ...effective, [key]: selected } }
}
