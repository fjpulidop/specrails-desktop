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
