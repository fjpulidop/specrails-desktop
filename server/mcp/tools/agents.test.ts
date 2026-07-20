import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return {
    ...actual,
    apiCall: vi.fn(async () => ({ ok: true })),
    projectPath: vi.fn(() => '/projects/p1'),
  }
})

import { agentsTools } from './agents'
import { apiCall } from './types'
import type { McpToolContext } from './types'

describe('specrails_agents provider propagation', () => {
  const tool = agentsTools()[0]
  const ctx = {} as McpToolContext

  beforeEach(() => {
    vi.mocked(apiCall).mockClear()
  })

  it.each([
    [{ action: 'list', provider: 'kimi' }, 'GET', '/projects/p1/profiles?provider=kimi'],
    [
      { action: 'get', name: 'kimi-default', provider: 'kimi' },
      'GET',
      '/projects/p1/profiles/kimi-default?provider=kimi',
    ],
    [
      { action: 'resolve', profileName: 'kimi-default', provider: 'kimi' },
      'GET',
      '/projects/p1/profiles/resolve?profile=kimi-default&provider=kimi',
    ],
    [
      { action: 'catalog_get', agentId: 'custom-review', provider: 'kimi' },
      'GET',
      '/projects/p1/profiles/catalog/custom-review?provider=kimi',
    ],
    [
      {
        action: 'refine_turn',
        agentId: 'custom-review',
        refineId: 'r1',
        instruction: 'tighten',
        provider: 'kimi',
      },
      'POST',
      '/projects/p1/profiles/catalog/custom-review/refine/r1/turn?provider=kimi',
    ],
  ])('forwards provider for %#', async (args, method, expectedPath) => {
    await tool.handler(ctx, args)
    expect(vi.mocked(apiCall)).toHaveBeenCalledWith(
      ctx,
      method,
      expectedPath,
      ...(method === 'POST' ? [expect.any(Object)] : []),
    )
  })

  it('keeps the legacy primary-provider URL when provider is omitted', async () => {
    await tool.handler(ctx, { action: 'catalog_list' })
    expect(vi.mocked(apiCall)).toHaveBeenCalledWith(
      ctx,
      'GET',
      '/projects/p1/profiles/catalog',
    )
  })
})
