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

describe('specrails_settings get — sub-agents (read-only)', () => {
  it('reports the app-wide setting and, with projectId, the project setting', async () => {
    const { initDesktopDb, setDesktopSetting } = await import('../../desktop-db')
    const desktopDb = initDesktopDb(':memory:')
    setDesktopSetting(desktopDb, 'agent_allow_subagents', 'true')
    setDesktopSetting(desktopDb, 'agent_subagent_runtime', JSON.stringify({ provider: 'claude', model: 'sonnet', effort: null }))
    const tool = appTools()[0]
    const ctx = { desktopDb } as unknown as McpToolContext
    vi.mocked(apiCall).mockResolvedValueOnce({ allowSubagents: false, subagentRuntime: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' } })
    const result = await tool.handler(ctx, { action: 'get', projectId: 'p 1' }) as Record<string, unknown>
    expect(result).toMatchObject({
      allowSubagentsWithoutProject: true, projectAllowSubagents: false,
      subagentRuntimeWithoutProject: { provider: 'claude', model: 'sonnet', effort: null },
      projectSubagentRuntime: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
    })
    expect(apiCall).toHaveBeenLastCalledWith(ctx, 'GET', '/projects/p%201/settings')
    expect(await tool.handler(ctx, { action: 'get' })).not.toHaveProperty('projectAllowSubagents')
    // Not writable: `set` has no such field.
    await expect(tool.handler(ctx, { action: 'set', allowSubagents: true })).rejects.toThrow('set requires at least one field')
    await expect(tool.handler(ctx, { action: 'set', subagentRuntime: null })).rejects.toThrow('set requires at least one field')
  })
})

