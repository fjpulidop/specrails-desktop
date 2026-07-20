import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return {
    ...actual,
    apiCall: vi.fn(async () => ({ ok: true })),
    projectPath: vi.fn(() => '/projects/p1'),
  }
})

import { setupTools } from './setup'
import { apiCall } from './types'
import type { McpToolContext } from './types'

describe('specrails_setup install_config', () => {
  const tool = setupTools()[0]
  const ctx = {} as McpToolContext

  beforeEach(() => {
    vi.mocked(apiCall).mockClear()
  })

  it.each(['kimi', 'claude'])(
    'forwards a minimal %s config without inventing a cross-provider model alias',
    async (provider) => {
      const config = {
        provider,
        agents: { selected: [], excluded: [] },
      }

      await tool.handler(ctx, {
        action: 'install_config',
        projectId: 'p1',
        config,
      })

      expect(vi.mocked(apiCall)).toHaveBeenCalledWith(
        ctx,
        'POST',
        '/projects/p1/setup/install-config',
        { ...config, tier: 'quick' },
      )
    },
  )
})
