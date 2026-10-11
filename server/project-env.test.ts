import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { spawn, spawnSync } from 'child_process'
import { initDb, updateProjectSettings } from './db'
import {
  resolveWorktreeEnvPassthrough,
  applyWorktreeEnvPassthrough,
  ensureProjectEnvFresh,
  getProjectEnvStatus,
  refreshProjectEnv,
  startProjectEnvWarmup,
  stopProjectEnvWarmup,
  worktreeEnvPassthroughWarning,
  PROJECT_ENV_FAILURE_TTL_MS,
  PROJECT_ENV_SUCCESS_TTL_MS,
} from './project-env'
import { __resetPathResolverForTest } from './path-resolver'

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('child_process')>(), spawnSync: vi.fn(), spawn: vi.fn() }))

const SECRET = 'fixture-secret-value-7f3a'
const databases: ReturnType<typeof initDb>[] = []
function project(names: string[] = []) {
  const db = initDb(':memory:')
  databases.push(db)
  updateProjectSettings(db, { worktreeEnvPassthrough: names })
  return db
}
function block(value: string) {
  return `__SRH_ENV_BEGIN__NODE_AUTH_TOKEN=${value}\n__SRH_ENV_END__`
}
function shellResult(value = 'fixture-shell-token') {
  return { pid: 1, output: [], stdout: block(value), stderr: '', status: 0, signal: null }
}
function syncTimeout() {
  return { ...shellResult(), stdout: '', status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
}
/** Async probe double: prints `stdout` and exits with `exitCode` on the next tick. */
function asyncShell(stdout: string, exitCode: number | null = 0) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { setImmediate(() => child.emit('close', null)) }
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', exitCode)
    })
    return child as never
  }
}
beforeEach(() => {
  __resetPathResolverForTest()
  vi.mocked(spawnSync).mockReset()
  vi.mocked(spawn).mockReset()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VITEST', undefined)
  vi.stubEnv('NODE_AUTH_TOKEN', undefined)
  vi.stubEnv('SHELL', '/bin/zsh')
  vi.stubEnv('SPECRAILS_LOGIN_SHELL_TIMEOUT_MS', undefined)
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
})
afterEach(() => {
  for (const db of databases.splice(0)) { stopProjectEnvWarmup(db); db.close() }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const posixOnly = it.skipIf(process.platform === 'win32')

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

  posixOnly('keeps shell-recovered values in the owning project without exposing them globally or persisting them', () => {
    vi.mocked(spawnSync).mockReturnValue(shellResult())
    const parent = project(['NODE_AUTH_TOKEN']), unrelated = project()
    const env = applyWorktreeEnvPassthrough(parent, process.env)
    expect(env.NODE_AUTH_TOKEN).toBe('fixture-shell-token')
    expect(process.env.NODE_AUTH_TOKEN).toBeUndefined()
    expect(applyWorktreeEnvPassthrough(unrelated, process.env).NODE_AUTH_TOKEN).toBeUndefined()
    expect(parent.serialize().includes(Buffer.from('fixture-shell-token'))).toBe(false)
  })

  posixOnly('retries a cold sync timeout with the larger async budget and hands the value to the next spawn', async () => {
    vi.mocked(spawnSync).mockReturnValue(syncTimeout())
    vi.mocked(spawn).mockImplementation(asyncShell(block('slow-profile-token')))
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    expect(getProjectEnvStatus(db).checking).toBe(true)
    await ensureProjectEnvFresh(db)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({ NODE_AUTH_TOKEN: 'slow-profile-token' })
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe('/bin/zsh')
    expect(process.env.NODE_AUTH_TOKEN).toBeUndefined()
  })

  posixOnly('keeps an empty lookup for 30 s, then retries it asynchronously without blocking the spawn', async () => {
    vi.mocked(spawnSync).mockReturnValue(shellResult(''))
    vi.mocked(spawn).mockImplementation(asyncShell(block('recovered-after-retry')))
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    expect(getProjectEnvStatus(db).names[0]?.status).toBe('not-defined')
    vi.mocked(Date.now).mockReturnValue(1_000 + PROJECT_ENV_FAILURE_TTL_MS - 1)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    expect(spawn).not.toHaveBeenCalled()
    vi.mocked(Date.now).mockReturnValue(1_000 + PROJECT_ENV_FAILURE_TTL_MS + 1)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    await ensureProjectEnvFresh(db)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({ NODE_AUTH_TOKEN: 'recovered-after-retry' })
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  posixOnly('keeps a success cached for 10 minutes, then refreshes it and drops it when recovery fails', () => {
    vi.mocked(spawnSync).mockReturnValueOnce(shellResult('first-token')).mockReturnValueOnce(shellResult('rotated-token')).mockReturnValue(shellResult(''))
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('first-token')
    vi.mocked(Date.now).mockReturnValue(1_000 + PROJECT_ENV_SUCCESS_TTL_MS - 1)
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('first-token')
    expect(spawnSync).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(1_000 + PROJECT_ENV_SUCCESS_TTL_MS + 1)
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('rotated-token')
    vi.mocked(Date.now).mockReturnValue(1_000 + 2 * PROJECT_ENV_SUCCESS_TTL_MS + 2)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({})
    expect(process.env.NODE_AUTH_TOKEN).toBeUndefined()
  })

  posixOnly('prefers the current inherited value over a cached shell value', () => {
    vi.mocked(spawnSync).mockReturnValue(shellResult())
    const db = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('fixture-shell-token')
    vi.stubEnv('NODE_AUTH_TOKEN', 'explicit-current-token')
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('explicit-current-token')
    expect(getProjectEnvStatus(db).names[0]).toMatchObject({ name: 'NODE_AUTH_TOKEN', status: 'inherited', shell: null })
    expect(spawnSync).toHaveBeenCalledTimes(1)
  })

  posixOnly('removing a configured name immediately drops its recovered value and status', () => {
    vi.mocked(spawnSync).mockReturnValue(shellResult())
    const db = project(['NODE_AUTH_TOKEN'])
    expect(applyWorktreeEnvPassthrough(db, process.env).NODE_AUTH_TOKEN).toBe('fixture-shell-token')
    updateProjectSettings(db, { worktreeEnvPassthrough: [] })
    expect(applyWorktreeEnvPassthrough(db, process.env).NODE_AUTH_TOKEN).toBeUndefined()
    expect(getProjectEnvStatus(db).names).toEqual([])
  })

  posixOnly('does not reuse another project connection\'s cached lookup', () => {
    vi.mocked(spawnSync).mockReturnValueOnce(shellResult('first-token')).mockReturnValue(shellResult('fresh-token'))
    const first = project(['NODE_AUTH_TOKEN']), second = project(['NODE_AUTH_TOKEN'])
    expect(resolveWorktreeEnvPassthrough(first).NODE_AUTH_TOKEN).toBe('first-token')
    expect(resolveWorktreeEnvPassthrough(second).NODE_AUTH_TOKEN).toBe('fresh-token')
    expect(resolveWorktreeEnvPassthrough(first).NODE_AUTH_TOKEN).toBe('first-token')
  })

  posixOnly('never hands one project\'s warm values to a project that does not configure the name', async () => {
    vi.mocked(spawn).mockImplementation(asyncShell(block(SECRET)))
    const owner = project(['NODE_AUTH_TOKEN']), other = project(['NPM_TOKEN'])
    vi.mocked(spawnSync).mockReturnValue({ ...shellResult(''), stdout: '__SRH_ENV_BEGIN__NPM_TOKEN=\n__SRH_ENV_END__' })
    await refreshProjectEnv(owner)
    expect(resolveWorktreeEnvPassthrough(owner).NODE_AUTH_TOKEN).toBe(SECRET)
    expect(resolveWorktreeEnvPassthrough(other)).toEqual({})
    expect(JSON.stringify(getProjectEnvStatus(other))).not.toContain(SECRET)
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
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('project-env warm cache and background refresh', () => {
  posixOnly('warms on project open so the first spawn reads the cache instead of the sync probe', async () => {
    vi.mocked(spawn).mockImplementation(asyncShell(block('warm-token'), 1))
    const db = project(['NODE_AUTH_TOKEN'])
    startProjectEnvWarmup(db)
    expect(spawn).toHaveBeenCalledTimes(1)
    await ensureProjectEnvFresh(db)
    expect(resolveWorktreeEnvPassthrough(db)).toEqual({ NODE_AUTH_TOKEN: 'warm-token' })
    expect(spawnSync).not.toHaveBeenCalled()
    // A non-zero exit after a complete block is recorded only as a diagnostic.
    expect(getProjectEnvStatus(db).names[0]).toMatchObject({ status: 'recovered', exitCode: 1, shell: '/bin/zsh' })
  })

  posixOnly('de-duplicates concurrent probes and queues one follow-up for a recheck', async () => {
    vi.mocked(spawn).mockImplementation(asyncShell(block('token')))
    const db = project(['NODE_AUTH_TOKEN'])
    const first = refreshProjectEnv(db)
    const second = refreshProjectEnv(db)
    const third = refreshProjectEnv(db)
    expect(second).toBe(third)
    await Promise.all([first, second, third])
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  posixOnly('schedules a refresh before a success expires and stops it when the project unloads', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers({ now: 1_000 })
    vi.mocked(spawn).mockImplementation(asyncShell(block('first-token')))
    const db = project(['NODE_AUTH_TOKEN'])
    startProjectEnvWarmup(db)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('first-token')
    vi.mocked(spawn).mockImplementation(asyncShell(block('rotated-token')))
    await vi.advanceTimersByTimeAsync(PROJECT_ENV_SUCCESS_TTL_MS - 60_000)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('rotated-token')
    stopProjectEnvWarmup(db)
    await vi.advanceTimersByTimeAsync(2 * PROJECT_ENV_SUCCESS_TTL_MS)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  posixOnly('keeps a still-valid recovered value when a background refresh times out', async () => {
    vi.mocked(spawn).mockImplementationOnce(asyncShell(block('first-token')))
    const db = project(['NODE_AUTH_TOKEN'])
    await refreshProjectEnv(db)
    vi.mocked(spawn).mockImplementationOnce(asyncShell('', null))
    await refreshProjectEnv(db)
    expect(resolveWorktreeEnvPassthrough(db).NODE_AUTH_TOKEN).toBe('first-token')
  })

  posixOnly('re-warms a name added while a probe is running', async () => {
    vi.mocked(spawn).mockImplementation(asyncShell('__SRH_ENV_BEGIN__NODE_AUTH_TOKEN=a\nNPM_TOKEN=b\n__SRH_ENV_END__'))
    const db = project(['NODE_AUTH_TOKEN'])
    const running = refreshProjectEnv(db)
    updateProjectSettings(db, { worktreeEnvPassthrough: ['NODE_AUTH_TOKEN', 'NPM_TOKEN'] })
    await Promise.all([running, refreshProjectEnv(db)])
    expect(getProjectEnvStatus(db).names.map(n => [n.name, n.status])).toEqual([['NODE_AUTH_TOKEN', 'recovered'], ['NPM_TOKEN', 'recovered']])
  })
})

describe('project-env status and run-log warning are value-free', () => {
  posixOnly('reports probe-timeout with shell and check time but no value', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.kill = () => { setImmediate(() => child.emit('close', null)) }
      return child as never
    })
    vi.stubEnv('SPECRAILS_LOGIN_SHELL_TIMEOUT_MS', '5')
    const db = project(['NODE_AUTH_TOKEN'])
    await refreshProjectEnv(db)
    const report = getProjectEnvStatus(db)
    expect(report.timeoutMs).toBe(5)
    expect(report.names).toEqual([{ name: 'NODE_AUTH_TOKEN', status: 'probe-timeout', shell: '/bin/zsh', checkedAt: new Date(1_000).toISOString(), exitCode: null }])
  })

  posixOnly('recheck after fixing the profile reports recovered', async () => {
    vi.mocked(spawn).mockImplementationOnce(asyncShell('profile error', 1)).mockImplementation(asyncShell(block(SECRET)))
    const db = project(['NODE_AUTH_TOKEN'])
    await refreshProjectEnv(db)
    expect(getProjectEnvStatus(db).names[0]?.status).toBe('probe-failed')
    await refreshProjectEnv(db)
    const report = getProjectEnvStatus(db)
    expect(report.names[0]?.status).toBe('recovered')
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  posixOnly('reports pending before the first check', () => {
    const db = project(['NODE_AUTH_TOKEN'])
    expect(getProjectEnvStatus(db).names).toEqual([{ name: 'NODE_AUTH_TOKEN', status: 'pending', shell: null, checkedAt: null, exitCode: null }])
  })

  posixOnly('writes one aggregated warning naming each unresolved variable and its status, never a value', async () => {
    vi.mocked(spawn).mockImplementation(asyncShell(`__SRH_ENV_BEGIN__NODE_AUTH_TOKEN=\nNPM_TOKEN=\nAWS_PROFILE=${SECRET}\n__SRH_ENV_END__`))
    const db = project(['NODE_AUTH_TOKEN'])
    await refreshProjectEnv(db)
    const env = applyWorktreeEnvPassthrough(db, process.env)
    expect(worktreeEnvPassthroughWarning(db, env)).toBe('[environment] NODE_AUTH_TOKEN not available (not-defined); configure it in the login shell or launch from a terminal')

    updateProjectSettings(db, { worktreeEnvPassthrough: ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'AWS_PROFILE'] })
    await refreshProjectEnv(db)
    const merged = applyWorktreeEnvPassthrough(db, process.env)
    const warning = worktreeEnvPassthroughWarning(db, merged)
    expect(merged.AWS_PROFILE).toBe(SECRET)
    expect(warning).toBe('[environment] NODE_AUTH_TOKEN (not-defined), NPM_TOKEN (not-defined) not available; configure them in the login shell or launch from a terminal')
    expect(warning).not.toContain(SECRET)
  })

  it('returns no warning when every configured name resolved or none are configured', () => {
    const db = project(['NODE_AUTH_TOKEN'])
    expect(worktreeEnvPassthroughWarning(db, { NODE_AUTH_TOKEN: SECRET })).toBeNull()
    expect(worktreeEnvPassthroughWarning(project(), {})).toBeNull()
  })
})
