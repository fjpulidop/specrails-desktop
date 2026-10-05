import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { initDb, updateProjectSettings } from './db'
import { resolveWorktreeEnvPassthrough, applyWorktreeEnvPassthrough } from './project-env'
import { __resetPathResolverForTest } from './path-resolver'

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('child_process')>(), spawnSync: vi.fn() }))

const databases: ReturnType<typeof initDb>[] = []
function project(names: string[] = []) {
  const db = initDb(':memory:')
  databases.push(db)
  updateProjectSettings(db, { worktreeEnvPassthrough: names })
  return db
}
function shellResult(value = 'fixture-shell-token') {
  return { pid: 1, output: [], stdout: `__SRH_ENV_BEGIN__NODE_AUTH_TOKEN=${value}\n__SRH_ENV_END__`, stderr: '', status: 0, signal: null }
}
beforeEach(() => {
  __resetPathResolverForTest()
  vi.mocked(spawnSync).mockReset()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VITEST', undefined)
  vi.stubEnv('NODE_AUTH_TOKEN', undefined)
  vi.stubEnv('SHELL', '/bin/zsh')
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
})
afterEach(() => {
  databases.splice(0).forEach(db => db.close())
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('project-env worktree passthrough', () => {
  it('resolves only configured names that exist in the source env', () => {
    const db = project()
    updateProjectSettings(db, { worktreeEnvPassthrough: ['NODE_AUTH_TOKEN', 'AWS_PROFILE', 'MISSING_VAR'] })

    const env = resolveWorktreeEnvPassthrough(db, {
      NODE_AUTH_TOKEN: 'npm-secret',
      AWS_PROFILE: 'dev-profile',
      OTHER_SECRET: 'must-not-pass',
    })

    expect(env).toEqual({
      NODE_AUTH_TOKEN: 'npm-secret',
      AWS_PROFILE: 'dev-profile',
    })
  })

  it('merges passthrough values over the caller env without mutating it', () => {
    const db = project()
    updateProjectSettings(db, { worktreeEnvPassthrough: ['NODE_AUTH_TOKEN'] })
    const base = { PATH: '/bin', NODE_AUTH_TOKEN: 'old' }

    const merged = applyWorktreeEnvPassthrough(db, base, { NODE_AUTH_TOKEN: 'fresh' })

    expect(merged).toEqual({ PATH: '/bin', NODE_AUTH_TOKEN: 'fresh' })
    expect(base.NODE_AUTH_TOKEN).toBe('old')
  })

  it('keeps shell-recovered values in the owning project without exposing them globally or persisting them', () => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValue(shellResult())
    const parent = project(['NODE_AUTH_TOKEN']), unrelated = project()
    const env = applyWorktreeEnvPassthrough(parent, process.env)
    expect(env.NODE_AUTH_TOKEN).toBe('fixture-shell-token')
    expect(process.env.NODE_AUTH_TOKEN).toBeUndefined()
    expect(applyWorktreeEnvPassthrough(unrelated, process.env).NODE_AUTH_TOKEN).toBeUndefined()
    expect(parent.serialize().includes(Buffer.from('fixture-shell-token'))).toBe(false)
  })

  it.each(['timeout', 'empty'])('retries a %s lookup after expiry without repeatedly probing during the cooldown', failure => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValueOnce(failure === 'timeout'
      ? { ...shellResult(), stdout: '', status: null, error: new Error('fixture timeout') }
      : shellResult('')).mockReturnValue(shellResult('recovered-after-retry'))
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    vi.mocked(Date.now).mockReturnValue(15_000)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    expect(spawnSync).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(31_001)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({ NODE_AUTH_TOKEN: 'recovered-after-retry' })
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('refreshes shell values after expiry and discards expired values if recovery fails', () => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValueOnce(shellResult('first-token')).mockReturnValueOnce(shellResult('rotated-token')).mockReturnValue(shellResult(''))
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('first-token')
    vi.mocked(Date.now).mockReturnValue(31_001)
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('rotated-token')
    vi.mocked(Date.now).mockReturnValue(61_002)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    expect(process.env.NODE_AUTH_TOKEN).toBeUndefined()
  })

  it('prefers the current inherited value over a cached shell value', () => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValue(shellResult())
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('fixture-shell-token')
    vi.stubEnv('NODE_AUTH_TOKEN', 'explicit-current-token')
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('explicit-current-token')
    expect(spawnSync).toHaveBeenCalledTimes(1)
  })

  it('removing a configured name immediately drops its recovered value', () => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValue(shellResult())
    const db = project(['NODE_AUTH_TOKEN'])
    expect(applyWorktreeEnvPassthrough(db, process.env).NODE_AUTH_TOKEN).toBe('fixture-shell-token')
    updateProjectSettings(db, { worktreeEnvPassthrough: [] })
    expect(applyWorktreeEnvPassthrough(db, process.env).NODE_AUTH_TOKEN).toBeUndefined()
  })

  it('does not reuse another project connection\'s cached lookup', () => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValueOnce(shellResult('first-token')).mockReturnValue(shellResult('fresh-token'))
    const first = project(['NODE_AUTH_TOKEN']), second = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(first).NODE_AUTH_TOKEN).toBe('first-token')
    expect(resolveWorktreeEnvPassthrough(second).NODE_AUTH_TOKEN).toBe('fresh-token')
  })

  it.each(['HOME', 'SHELL', 'ZDOTDIR'])('invalidates shell results when %s changes', key => {
    if (process.platform === 'win32') return
    vi.mocked(spawnSync).mockReturnValueOnce(shellResult('first-token')).mockReturnValue(shellResult('new-shell-token'))
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('first-token')
    vi.stubEnv(key, '/fixture/new-shell-context')
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('new-shell-token')
  })

  it('never probes the real login shell for an explicitly supplied source environment', () => {
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db, {})).toEqual({})
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
