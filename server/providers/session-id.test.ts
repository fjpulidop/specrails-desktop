import { describe, expect, it } from 'vitest'
import { isSafeProviderSessionId, safeProviderSessionId, UnsafeProviderSessionIdError, MAX_PROVIDER_SESSION_ID_LENGTH } from './session-id'
import { claudeAdapter } from './claude-adapter'
import { codexAdapter } from './codex-adapter'
import { geminiAdapter } from './gemini-adapter'

describe('provider session id validation', () => {
  it('accepts real ids and rejects argv-injection shapes', () => {
    expect(isSafeProviderSessionId('4e55f762-4f66-4181-a295-02506c289f66')).toBe(true)
    expect(isSafeProviderSessionId('019a2b3c-thread')).toBe(true)
    for (const bad of ['', '-p', '--dangerously-skip-permissions', 'a\nb', 'a\u0000', 'a\u001b[2J', ' padded', 'x'.repeat(MAX_PROVIDER_SESSION_ID_LENGTH + 1), 42, null]) {
      expect(isSafeProviderSessionId(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(() => safeProviderSessionId('--x', 'claude')).toThrow(UnsafeProviderSessionIdError)
  })

  it('every adapter refuses to resume an unsafe id', () => {
    const opts = { prompt: 'hi', model: 'm', sessionId: '--settings=/tmp/evil.json' }
    expect(() => claudeAdapter.buildArgs('chat-resume', opts as never)).toThrow(UnsafeProviderSessionIdError)
    expect(() => claudeAdapter.buildArgs('chat-stream', opts as never)).toThrow(UnsafeProviderSessionIdError)
    expect(() => codexAdapter.buildArgs('chat-resume', opts as never)).toThrow(UnsafeProviderSessionIdError)
    expect(() => geminiAdapter.buildArgs('chat-resume', opts as never)).toThrow(UnsafeProviderSessionIdError)
    expect(claudeAdapter.buildArgs('chat-resume', { ...opts, sessionId: 'abc-123' } as never)).toContain('abc-123')
  })
})
