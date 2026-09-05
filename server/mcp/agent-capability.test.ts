import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAgentCapabilitiesForTest,
  mintAgentCapability,
  revokeAgentCapability,
  verifyAgentCapability,
  onAgentCapabilityRevoked,
} from './agent-capability'

describe('agent MCP capabilities', () => {
  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-09T12:00:00Z'))
  })

  afterEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.useRealTimers()
  })

  it('binds conversation, project and tier server-side', () => {
    const token = mintAgentCapability({
      conversationId: 'conv-42',
      projectId: 'project-a',
      tierLevel: 2,
    })

    expect(token).toHaveLength(43)
    expect(verifyAgentCapability(token)).toMatchObject({
      conversationId: 'conv-42',
      projectId: 'project-a',
      tierLevel: 2,
    })
    expect(verifyAgentCapability('x'.repeat(43))).toBeNull()
  })

  it('expires and revokes capabilities', () => {
    const expiring = mintAgentCapability({ conversationId: 'conv-exp', tierLevel: 1, ttlMs: 1_000 })
    vi.advanceTimersByTime(1_001)
    expect(verifyAgentCapability(expiring)).toBeNull()

    const revoked = mintAgentCapability({ conversationId: 'conv-revoked', tierLevel: 3 })
    revokeAgentCapability(revoked)
    expect(verifyAgentCapability(revoked)).toBeNull()
  })

  it('rejects unsafe conversation ids before minting', () => {
    expect(() => mintAgentCapability({ conversationId: '../escape', tierLevel: 3 })).toThrow(/unsafe/)
  })

  it('rejects invalid permission levels and ambiguous duplicate headers', () => {
    expect(() => mintAgentCapability({ conversationId: 'bad-level', tierLevel: 5 as never })).toThrow('permission level')
    const token = mintAgentCapability({ conversationId: 'valid', tierLevel: 0 })
    expect(verifyAgentCapability([token, 'other'])).toBeNull()
  })

  it('notifies session owners once on revoke or expiration and supports unsubscribing', () => {
    const token = mintAgentCapability({ conversationId: 'owner', tierLevel: 0, ttlMs: 1000 })
    const close = vi.fn()
    const detached = vi.fn()
    onAgentCapabilityRevoked(token, close)
    onAgentCapabilityRevoked(token, detached)()
    vi.advanceTimersByTime(1001)
    expect(verifyAgentCapability(token)).toBeNull()
    revokeAgentCapability(token)
    expect(close).toHaveBeenCalledOnce()
    expect(detached).not.toHaveBeenCalled()
  })
})
