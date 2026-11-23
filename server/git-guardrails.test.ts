import { describe, it, expect } from 'vitest'
import { assertGitAllowed, isForcePush, pushesToBranch, GitGuardrailError } from './git-guardrails'

describe('isForcePush', () => {
  it('detects force flags', () => {
    expect(isForcePush(['push', '--force', 'origin', 'b'])).toBe(true)
    expect(isForcePush(['push', '-f', 'origin', 'b'])).toBe(true)
    expect(isForcePush(['push', '--force-with-lease', 'origin', 'b'])).toBe(true)
    expect(isForcePush(['push', '--force-with-lease=b:sha', 'origin', 'b'])).toBe(true)
  })
  it('is false for a normal push', () => {
    expect(isForcePush(['push', '-u', 'origin', 'b'])).toBe(false)
  })
})

describe('pushesToBranch', () => {
  it('detects implicit + explicit refspecs targeting the branch', () => {
    expect(pushesToBranch(['push', 'origin', 'main'], 'main')).toBe(true)
    expect(pushesToBranch(['push', 'origin', 'HEAD:main'], 'main')).toBe(true)
    expect(pushesToBranch(['push', 'origin', 'sr/p/ticket-1:main'], 'main')).toBe(true)
    expect(pushesToBranch(['push', 'origin', 'refs/heads/main'], 'main')).toBe(true)
  })
  it('is false when pushing a different branch', () => {
    expect(pushesToBranch(['push', '-u', 'origin', 'sr/p/ticket-1'], 'main')).toBe(false)
  })
})

describe('assertGitAllowed', () => {
  it('allows a normal ticket-branch push', () => {
    expect(() => assertGitAllowed('git', ['push', '-u', 'origin', 'sr/p/ticket-1'], { protectedBranch: 'main' })).not.toThrow()
  })
  it('refuses a force-push', () => {
    expect(() => assertGitAllowed('git', ['push', '--force', 'origin', 'sr/p/ticket-1'])).toThrow(GitGuardrailError)
  })
  it('refuses a direct push to the integration branch', () => {
    expect(() => assertGitAllowed('git', ['push', 'origin', 'main'], { protectedBranch: 'main' })).toThrow(/integration branch/)
  })
  it('ignores non-push git commands and non-git commands', () => {
    expect(() => assertGitAllowed('git', ['merge', '--no-ff', 'b'], { protectedBranch: 'main' })).not.toThrow()
    expect(() => assertGitAllowed('gh', ['pr', 'create'], { protectedBranch: 'main' })).not.toThrow()
  })
})

describe('run-scoped git rules (agent policy hook)', () => {
  it('detects +refspec, --mirror and combined short force flags', async () => {
    const { isForcePush } = await import('./git-guardrails')
    expect(isForcePush(['push', 'origin', '+HEAD:b'])).toBe(true)
    expect(isForcePush(['push', '--mirror', 'backup'])).toBe(true)
    expect(isForcePush(['push', '-uf', 'origin', 'b'])).toBe(true)
    expect(isForcePush(['push', '-o', '+x', 'origin', 'b'])).toBe(false)
  })

  it('resolves implicit push destinations to the current branch', async () => {
    const { pushDestinations } = await import('./git-guardrails')
    expect(pushDestinations(['push'], 'feat')).toEqual(['feat'])
    expect(pushDestinations(['push', 'origin', 'HEAD'], 'main')).toEqual(['main'])
    expect(pushDestinations(['push', 'origin', 'a:refs/heads/b'], 'x')).toEqual(['b'])
  })

  it('detects remote deletes, hard resets and branch deletes', async () => {
    const { pushDeletesRemoteBranch, isHardReset, branchDeleteTargets } = await import('./git-guardrails')
    expect(pushDeletesRemoteBranch(['push', 'origin', ':old'])).toBe(true)
    expect(pushDeletesRemoteBranch(['push', '--delete', 'origin', 'old'])).toBe(true)
    expect(pushDeletesRemoteBranch(['push', 'origin', 'new'])).toBe(false)
    expect(isHardReset(['reset', '--hard', 'HEAD'])).toBe(true)
    expect(isHardReset(['reset', 'HEAD'])).toBe(false)
    expect(branchDeleteTargets(['branch', '-D', 'a', 'b'])).toEqual(['a', 'b'])
    expect(branchDeleteTargets(['branch', '-df', 'a'])).toEqual(['a'])
    expect(branchDeleteTargets(['branch', '--list'])).toEqual([])
  })

  it('still lets the app push a verified commit to the run branch', () => {
    expect(() => assertGitAllowed('git', ['push', 'origin', `${'a'.repeat(40)}:refs/heads/sr/p/ticket-1`], { protectedBranch: 'main' })).not.toThrow()
    expect(() => assertGitAllowed('git', ['push', 'origin', '+HEAD:sr/p/ticket-1'], { protectedBranch: 'main' })).toThrow(GitGuardrailError)
  })
})
