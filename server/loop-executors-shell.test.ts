import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
vi.mock('./bundled-openspec', () => ({ getBundledOpenspecCli: vi.fn() }))
vi.mock('./path-resolver', async original => ({ ...await original<typeof import('./path-resolver')>(), resolveBundledNodeExe: vi.fn(() => process.execPath) }))
import { getBundledOpenspecCli } from './bundled-openspec'
import { bundledLoopShellInvocation } from './loop-shell-invocation'
import { createLoopExecutors } from './loop-executors'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
describe('offline loop archive execution', () => {
  it('executes bundled OpenSpec with argv and the repository cwd, with no global CLI on PATH', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offline archive España '))
    const cli = path.join(dir, 'openspec fixture.cjs')
    writeFileSync(cli, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))')
    vi.mocked(getBundledOpenspecCli).mockReturnValue(cli)
    vi.stubEnv('SPECRAILS_IS_DESKTOP', '1')
    try {
      const result = await createLoopExecutors({ env: { PATH: '' } }).runShell({ command: 'openspec archive add-login -y', cwd: dir })
      expect(result.exitCode, result.stderr).toBe(0)
      const actual = JSON.parse(result.stdout)
      expect(actual.args).toEqual(['archive', 'add-login', '-y'])
      expect(realpathSync(actual.cwd)).toBe(realpathSync(dir))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reports a missing packaged CLI explicitly and keeps the run failed', async () => {
    vi.stubEnv('SPECRAILS_IS_DESKTOP', '1')
    vi.mocked(getBundledOpenspecCli).mockReturnValue(null)
    const result = await createLoopExecutors({ env: {} }).runShell({ command: 'openspec archive add-login -y', cwd: process.cwd() })
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('bundled OpenSpec CLI is unavailable')
  })

  it('does not reinterpret composite custom shell commands or archive flags as a built-in change', () => {
    expect(bundledLoopShellInvocation('openspec archive change -y && echo custom')).toBeNull()
    expect(bundledLoopShellInvocation('openspec archive --help -y')).toBeNull()
    vi.stubEnv('SPECRAILS_IS_DESKTOP', undefined)
    vi.mocked(getBundledOpenspecCli).mockReturnValue(null)
    expect(bundledLoopShellInvocation('openspec archive change -y')).toBeNull()
  })
})
