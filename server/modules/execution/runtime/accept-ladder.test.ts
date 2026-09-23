import { describe, it, expect, vi } from 'vitest'
import { resolveAcceptCapability } from './accept-ladder'

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const fail = (code = 1, stderr = 'nope') => ({ code, stdout: '', stderr })

function execFor(map: { remote?: unknown; ghAuth?: unknown }) {
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'remote') {
      if (map.remote instanceof Error) throw map.remote
      return (map.remote ?? ok('origin\n')) as never
    }
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token') {
      if (map.ghAuth instanceof Error) throw map.ghAuth
      return (map.ghAuth ?? ok('gho_token')) as never
    }
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`)
  })
  return { run }
}

describe('resolveAcceptCapability', () => {
  it('resolves to a PR when a remote and an authenticated gh exist', async () => {
    const capability = await resolveAcceptCapability({ repoDir: '/repo', exec: execFor({}) })
    expect(capability).toEqual({
      target: 'create-pr', hasRemote: true, ghAuthenticated: true,
      irreversible: false, reasonCode: 'pr-capable',
    })
  })

  it('falls back to local integration with no remote — and never probes gh', async () => {
    const exec = execFor({ remote: ok('') })
    const capability = await resolveAcceptCapability({ repoDir: '/repo', exec })
    expect(capability).toMatchObject({
      target: 'merge-local', hasRemote: false, ghAuthenticated: false,
      irreversible: true, reasonCode: 'no-remote',
    })
    expect(exec.run).toHaveBeenCalledTimes(1)
  })

  it('falls back to local integration when gh is not signed in', async () => {
    const capability = await resolveAcceptCapability({ repoDir: '/repo', exec: execFor({ ghAuth: fail() }) })
    expect(capability).toMatchObject({
      target: 'merge-local', hasRemote: true, ghAuthenticated: false, reasonCode: 'gh-unauthenticated',
    })
  })

  it('treats a git failure as no remote (fail closed, never claims a PR path)', async () => {
    const capability = await resolveAcceptCapability({ repoDir: '/repo', exec: execFor({ remote: fail(128, 'not a repo') }) })
    expect(capability.target).toBe('merge-local')
    expect(capability.irreversible).toBe(true)
  })

  it('reports probe-failed when a probe throws outright', async () => {
    const capability = await resolveAcceptCapability({
      repoDir: '/repo', exec: execFor({ remote: new Error('ENOENT git') }),
    })
    expect(capability).toMatchObject({ target: 'merge-local', reasonCode: 'probe-failed', irreversible: true })
  })

  it('reports probe-failed when gh itself is missing', async () => {
    const capability = await resolveAcceptCapability({
      repoDir: '/repo', exec: execFor({ ghAuth: new Error('ENOENT gh') }),
    })
    expect(capability).toMatchObject({ target: 'merge-local', hasRemote: true, reasonCode: 'probe-failed' })
  })

  it('ignores whitespace-only remote output', async () => {
    const capability = await resolveAcceptCapability({ repoDir: '/repo', exec: execFor({ remote: ok('   \n  ') }) })
    expect(capability.hasRemote).toBe(false)
  })

  it('runs both probes in the delivery repo dir', async () => {
    const exec = execFor({})
    await resolveAcceptCapability({ repoDir: '/some/repo', exec })
    for (const call of exec.run.mock.calls) expect(call[2]).toBe('/some/repo')
  })

  it('marks irreversible exactly when the target is merge-local', async () => {
    for (const map of [{}, { remote: ok('') }, { ghAuth: fail() }]) {
      const capability = await resolveAcceptCapability({ repoDir: '/repo', exec: execFor(map) })
      expect(capability.irreversible).toBe(capability.target === 'merge-local')
    }
  })
})
