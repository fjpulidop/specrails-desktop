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

describe('Enterprise OAuth spend', () => {
  const payload = { five_hour: null, seven_day: null, extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 2078, currency: 'USD' } }
  function fixture(plan?: string) {
    const auth = JSON.stringify({ claudeAiOauth: { accessToken: 'private-enterprise-token', subscriptionType: plan } })
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)))
    const reader = createClaudeReader({ configDir: '/test', platform: 'linux', readFile: vi.fn().mockResolvedValue(auth), request, now: () => Date.parse('2026-10-03T05:56:00Z') })
    return { reader, request }
  }
  it('accepts money-only Enterprise without administrator credentials or additional requests', async () => {
    const f = fixture('enterprise'), result = await f.reader.read(signal)
    expect(result).toMatchObject({ availability: 'available', windows: [], plan: 'enterprise', source: 'oauth', spend: { usedAmount: 20.78, limitAmount: 1000 } })
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('private-enterprise-token')
  })
  it('resolves missing plan metadata with the same OAuth session profile', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(new Response(JSON.stringify(payload))).mockResolvedValueOnce(new Response(JSON.stringify({ organization: { organization_type: 'claude_enterprise' } })))
    expect(await f.reader.read(signal)).toMatchObject({ plan: 'enterprise', spend: { limitAmount: 1000 } })
    expect(f.request).toHaveBeenNthCalledWith(2, 'https://api.anthropic.com/api/oauth/profile', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer private-enterprise-token' }), redirect: 'error' }))
  })
  it('does not classify an unknown or Team profile as Enterprise', async () => {
    for (const organization_type of [undefined, 'claude_team']) {
      const f = fixture()
      f.request.mockResolvedValueOnce(new Response(JSON.stringify(payload))).mockResolvedValueOnce(new Response(JSON.stringify({ organization: { organization_type } })))
      await expect(f.reader.read(signal)).rejects.toMatchObject({ code: 'usage-unavailable' })
    }
  })
  it('keeps conventional subscriptions and Enterprise windows even with extra spending', async () => {
    for (const plan of ['pro', 'max', 'team', 'enterprise']) {
      const f = fixture(plan)
      f.request.mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, five_hour: { utilization: 12 } })))
      expect(await f.reader.read(signal)).toMatchObject({ plan, spend: null, windows: [expect.objectContaining({ usedPercent: 12 })] })
      expect(f.request).toHaveBeenCalledTimes(1)
    }
    const f = fixture('team')
    await expect(f.reader.read(signal)).rejects.toMatchObject({ code: 'usage-unavailable' })
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('keeps profile authorization and throttle failures bounded and free of response bodies', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(new Response(JSON.stringify(payload))).mockResolvedValueOnce(new Response('private profile body', { status: 403 }))
    await expect(f.reader.read(signal)).rejects.toMatchObject({ code: 'permission-denied' })
  })
})
