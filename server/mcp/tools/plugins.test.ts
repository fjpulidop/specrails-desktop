import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return {
    ...actual,
    apiCall: vi.fn(async () => ({ ok: true })),
    projectPath: vi.fn(() => '/projects/p1'),
    originConversationDefaults: vi.fn(() => ({})),
  }
})

import { pluginsTools } from './plugins'
import { apiCall, originConversationDefaults } from './types'
import type { McpToolContext } from './types'

describe('specrails_plugins provider propagation', () => {
  const tool = pluginsTools()[0]
  const ctx = {} as McpToolContext

  beforeEach(() => {
    vi.mocked(apiCall).mockClear()
    vi.mocked(originConversationDefaults).mockReturnValue({})
  })

  it.each([
    [{ action: 'list', provider: 'kimi' }, 'GET', '/projects/p1/plugins?provider=kimi'],
    [
      { action: 'preview', name: 'serena', provider: 'kimi' },
      'GET',
      '/projects/p1/plugins/serena/preview-install?provider=kimi',
    ],
    [
      { action: 'health', name: 'serena', provider: 'kimi' },
      'GET',
      '/projects/p1/plugins/serena/health?provider=kimi',
    ],
    [
      { action: 'uninstall', name: 'serena', provider: 'kimi' },
      'DELETE',
      '/projects/p1/plugins/serena?provider=kimi',
    ],
  ])('forwards provider for %#', async (args, method, expectedPath) => {
    await tool.handler(ctx, args)
    expect(vi.mocked(apiCall)).toHaveBeenCalledWith(ctx, method, expectedPath)
  })

  it.each(['install', 'activate', 'deactivate', 'update'])(
    'forwards provider in the %s mutation body',
    async (action) => {
      await tool.handler(ctx, { action, name: 'serena', provider: 'kimi' })
      expect(vi.mocked(apiCall)).toHaveBeenCalledWith(
        ctx,
        'POST',
        `/projects/p1/plugins/serena/${action}`,
        { provider: 'kimi' },
      )
    },
  )

  it('defaults to the launching conversation provider', async () => {
    vi.mocked(originConversationDefaults).mockReturnValue({ provider: 'kimi' })
    await tool.handler(ctx, { action: 'list' })
    expect(vi.mocked(apiCall)).toHaveBeenCalledWith(
      ctx,
      'GET',
      '/projects/p1/plugins?provider=kimi',
    )
  })

  it('keeps the legacy primary-provider request when no provider is known', async () => {
    await tool.handler(ctx, { action: 'list' })
    expect(vi.mocked(apiCall)).toHaveBeenCalledWith(ctx, 'GET', '/projects/p1/plugins')
  })
})
