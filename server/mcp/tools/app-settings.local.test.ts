import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return { ...actual, apiCall: vi.fn(async () => ({ ok: true })) }
})

import { appTools } from './app-settings'
import { apiCall } from './types'
import type { McpToolContext } from './types'

describe('specrails_settings runtime_providers.* actions', () => {
  const tool = appTools()[0]
  const ctx = {} as McpToolContext
  beforeEach(() => vi.mocked(apiCall).mockClear())

  it('declares tiers: list/test read, save write', () => {
    const tier = tool.tier as (args: Record<string, unknown>) => string
    expect(tier({ action: 'runtime_providers.list' })).toBe('read')
    expect(tier({ action: 'runtime_providers.test' })).toBe('read')
    expect(tier({ action: 'runtime_providers.save' })).toBe('write')
    expect(tier({ action: 'set' })).toBe('write')
  })

  it('list → GET /runtime-providers', async () => {
    await tool.handler(ctx, { action: 'runtime_providers.list' })
    expect(apiCall).toHaveBeenCalledWith(ctx, 'GET', '/runtime-providers')
  })

  it('test → POST /runtime-providers/test with the draft (apiKeyEnv optional)', async () => {
    await tool.handler(ctx, { action: 'runtime_providers.test', baseUrl: 'http://h/v1', apiKeyEnv: 'K' })
    expect(apiCall).toHaveBeenCalledWith(ctx, 'POST', '/runtime-providers/test', { baseUrl: 'http://h/v1', apiKeyEnv: 'K' })
    await tool.handler(ctx, { action: 'runtime_providers.test', baseUrl: 'http://h/v1', apiKeyEnv: '' })
    expect(apiCall).toHaveBeenLastCalledWith(ctx, 'POST', '/runtime-providers/test', { baseUrl: 'http://h/v1' })
    await expect(tool.handler(ctx, { action: 'runtime_providers.test' })).rejects.toThrow('requires baseUrl')
  })

  it('save → PUT /runtime-providers with the full list', async () => {
    const providers = [{ id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'local', kind: 'openai-compatible', baseUrl: 'http://h/v1' }]
    await tool.handler(ctx, { action: 'runtime_providers.save', providers })
    expect(apiCall).toHaveBeenCalledWith(ctx, 'PUT', '/runtime-providers', { providers })
    await expect(tool.handler(ctx, { action: 'runtime_providers.save', providers: [] })).rejects.toThrow('non-empty providers list')
  })
})
