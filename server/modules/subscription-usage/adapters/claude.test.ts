import { describe, it, expect, vi } from 'vitest'
import { createClaudeReader } from './claude'
import { UsageError } from './errors'
const signal = new AbortController().signal
const credentials = JSON.stringify({ claudeAiOauth: { accessToken: 'private-test-token' } })
describe('read-only Claude usage adapter', () => {
  it('uses active config OAuth, preserves zero and exposes no token', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ five_hour: { utilization: 0 } })))
    const reader = createClaudeReader({ configDir: '/test-config', platform: 'linux', readFile: vi.fn().mockResolvedValue(credentials), request })
    expect(await reader.context(signal)).not.toContain('private-test-token')
    const result = await reader.read(signal); expect(result.windows[0].usedPercent).toBe(0)
    expect(JSON.stringify(result)).not.toContain('private-test-token')
    expect(request).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({ redirect: 'error' }))
  })
  it('reports signed-out and API-key-only auth without making a request', async () => {
    const request = vi.fn(), readFile = vi.fn().mockResolvedValue(null)
    const reader = createClaudeReader({ configDir: '/test', platform: 'linux', request, readFile })
    expect((await reader.read(signal)).availability).toBe('signed-out')
    readFile.mockResolvedValue('{}'); expect((await reader.read(signal)).availability).toBe('unsupported-auth'); expect(request).not.toHaveBeenCalled()
  })
  it('returns safe auth, throttle and invalid response errors', async () => {
    const request = vi.fn(), reader = createClaudeReader({ configDir: '/test', platform: 'linux', readFile: vi.fn().mockResolvedValue(credentials), request })
    request.mockResolvedValueOnce(new Response('private', { status: 401 })); await expect(reader.read(signal)).rejects.toMatchObject({ code: 'signed-out', retryable: false })
    request.mockResolvedValueOnce(new Response('private', { status: 403 })); await expect(reader.read(signal)).rejects.toMatchObject({ code: 'permission-denied' })
    request.mockResolvedValueOnce(new Response('private', { status: 429, headers: { 'retry-after': '120' } })); await expect(reader.read(signal)).rejects.toMatchObject({ code: 'rate-limited', retryMs: 120_000 })
    request.mockResolvedValueOnce(new Response('invalid')); await expect(reader.read(signal)).rejects.toMatchObject({ code: 'invalid-response' })
  })
  it('uses scoped Keychain lookup and fails safely on denied credentials', async () => {
    const keychain = vi.fn().mockResolvedValue(credentials)
    const reader = createClaudeReader({ configDir: '/test-config', platform: 'darwin', readFile: vi.fn().mockResolvedValue(null), keychain })
    await reader.context(signal); expect(keychain).toHaveBeenCalledWith(expect.stringMatching(/^Claude Code-credentials-[0-9a-f]{8}$/), signal)
    keychain.mockRejectedValueOnce(new UsageError('credentials-unreadable'))
    await expect(reader.context(signal)).rejects.toMatchObject({ code: 'credentials-unreadable' })
  })
})
