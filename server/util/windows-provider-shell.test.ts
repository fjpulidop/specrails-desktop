import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withWindowsProviderShell } from './windows-provider-shell'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
describe('bundled Windows provider Bash', () => {
  it.each([['claude', 'CLAUDE_CODE_GIT_BASH_PATH'], ['kimi', 'KIMI_SHELL_PATH']] as const)('grants the existing PortableGit Bash to %s without changing caller environments', (provider, key) => {
    const root = mkdtempSync(path.join(tmpdir(), 'bundled Bash España '))
    const bash = path.join(root, 'git', 'bin', 'bash.exe')
    mkdirSync(path.dirname(bash), { recursive: true }); writeFileSync(bash, 'fixture')
    vi.stubEnv(key, undefined)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const env = { SPECRAILS_BUNDLED_RUNTIMES_PATH: root, PATH: 'git/cmd' }
    try {
      expect(withWindowsProviderShell(provider, { env })).toEqual({ env: { ...env, [key]: bash } })
      expect(env).not.toHaveProperty(key)
      expect(process.env[key]).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('preserves an explicit user path regardless of Windows key casing', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const options = { env: { claude_code_git_bash_path: 'D:\\My Git\\bash.exe' } }
    expect(withWindowsProviderShell('claude', options)).toBe(options)
  })

  it('retains a configured user Bash when the caller narrows its child env', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('KIMI_SHELL_PATH', 'D:\\Git\\bash.exe')
    expect(withWindowsProviderShell('kimi', { env: { PATH: 'minimal' } })).toEqual({ env: { PATH: 'minimal', KIMI_SHELL_PATH: 'D:\\Git\\bash.exe' } })
  })

  it('leaves POSIX and missing bundles unchanged', () => {
    vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', undefined)
    vi.stubEnv('SPECRAILS_BUNDLED_RUNTIMES_PATH', undefined)
    const options = { env: { PATH: 'fixture' } }
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(withWindowsProviderShell('claude', options)).toBe(options)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(withWindowsProviderShell('claude', options)).toBe(options)
  })
})
