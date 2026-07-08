import { describe, expect, it } from 'vitest'
import { initDb, updateProjectSettings } from './db'
import { resolveWorktreeEnvPassthrough, applyWorktreeEnvPassthrough } from './project-env'

describe('project-env worktree passthrough', () => {
  it('resolves only configured names that exist in the source env', () => {
    const db = initDb(':memory:')
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
    const db = initDb(':memory:')
    updateProjectSettings(db, { worktreeEnvPassthrough: ['NODE_AUTH_TOKEN'] })
    const base = { PATH: '/bin', NODE_AUTH_TOKEN: 'old' }

    const merged = applyWorktreeEnvPassthrough(db, base, { NODE_AUTH_TOKEN: 'fresh' })

    expect(merged).toEqual({ PATH: '/bin', NODE_AUTH_TOKEN: 'fresh' })
    expect(base.NODE_AUTH_TOKEN).toBe('old')
  })
})
