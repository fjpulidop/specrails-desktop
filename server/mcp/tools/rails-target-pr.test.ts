import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { McpToolContext } from './types'

// Focused pass-through test for the explicit-target launch parameter
// (deliver-rail-into-existing-pr): the MCP facade must forward
// `targetPrNumber` verbatim in the POST body — the router owns validation.
const { mockApiCall } = vi.hoisted(() => ({ mockApiCall: vi.fn() }))
vi.mock('./types', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  apiCall: mockApiCall,
  projectPath: () => '/projects/p1',
}))

import { railsTools } from './rails'

describe('specrails_rails launch — targetPrNumber pass-through', () => {
  const ctx = {
    apiOrigin: 'http://127.0.0.1:0',
    masterToken: 't',
    activeProjectId: 'p1',
    originConversationId: null,
  } as unknown as McpToolContext

  beforeEach(() => {
    mockApiCall.mockReset().mockResolvedValue({ loopRunIds: ['r1'], railIndex: 0 })
  })

  const spec = railsTools()[0]

  it('declares targetPrNumber on the input schema', () => {
    expect(spec.inputSchema).toHaveProperty('targetPrNumber')
  })

  it('forwards targetPrNumber in the launch POST body', async () => {
    await spec.handler(ctx, { action: 'launch', railIndex: 0, targetPrNumber: 151 })
    expect(mockApiCall).toHaveBeenCalledWith(
      ctx, 'POST', expect.stringMatching(/\/rails\/0\/launch$/),
      expect.objectContaining({ targetPrNumber: 151 }),
    )
  })

  it('omits targetPrNumber from the body when not provided', async () => {
    await spec.handler(ctx, { action: 'launch', railIndex: 0 })
    const body = mockApiCall.mock.calls[0][3] as Record<string, unknown>
    expect('targetPrNumber' in body).toBe(false)
  })
  it('forwards explicit repository scope for launch and a grouped child review packet', async () => {
    await spec.handler(ctx, { action: 'launch', railIndex: 0, repositoryIds: ['app', 'api'] })
    expect(mockApiCall).toHaveBeenLastCalledWith(ctx, 'POST', expect.stringMatching(/\/rails\/0\/launch$/), expect.objectContaining({ repositoryIds: ['app', 'api'] }))
    await spec.handler(ctx, { action: 'review_packet', prDeliveryId: 'parent', repositoryId: 'api' })
    expect(mockApiCall).toHaveBeenLastCalledWith(ctx, 'GET', expect.stringMatching(/\/pr-deliveries\/parent\/packet\?repositoryId=api$/))
  })
})
