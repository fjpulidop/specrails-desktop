import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return {
    ...actual,
    apiCall: vi.fn(async () => ({ ok: true })),
    projectPath: vi.fn(() => '/projects/p1'),
  }
})

import { analyticsTools } from './analytics'
import { apiCall } from './types'
import type { McpToolContext } from './types'

describe('specrails_analytics decision_times', () => {
  const tool = analyticsTools()[0]
  const ctx = {} as McpToolContext
  beforeEach(() => { vi.mocked(apiCall).mockClear() })

  it('reads the decision-times route with only the window filters', async () => {
    await tool.handler(ctx, { action: 'decision_times', period: '90d', surface: ['job'], ticketId: 4 })
    expect(apiCall).toHaveBeenCalledWith(ctx, 'GET', '/projects/p1/analytics/decision-times?period=90d')
    await tool.handler(ctx, { action: 'decision_times', period: 'custom', from: '2026-10-01', to: '2026-10-07' })
    expect(apiCall).toHaveBeenLastCalledWith(ctx, 'GET', '/projects/p1/analytics/decision-times?period=custom&from=2026-10-01&to=2026-10-07')
  })

  it('is a read-tier action', () => {
    expect(typeof tool.tier === 'function' ? tool.tier({ action: 'decision_times' }) : tool.tier).toBe('read')
  })
})

describe('specrails_analytics loop_economics', () => {
  const tool = analyticsTools()[0]
  const ctx = {} as McpToolContext
  beforeEach(() => { vi.mocked(apiCall).mockClear() })

  it('reads the loop-economics route with only the window filters', async () => {
    await tool.handler(ctx, { action: 'loop_economics', period: '30d', model: ['x'] })
    expect(apiCall).toHaveBeenCalledWith(ctx, 'GET', '/projects/p1/analytics/loop-economics?period=30d')
    await tool.handler(ctx, { action: 'loop_economics', period: 'custom', from: '2026-10-01', to: '2026-10-07' })
    expect(apiCall).toHaveBeenLastCalledWith(ctx, 'GET', '/projects/p1/analytics/loop-economics?period=custom&from=2026-10-01&to=2026-10-07')
  })

  it('is a read-tier action', () => {
    expect(typeof tool.tier === 'function' ? tool.tier({ action: 'loop_economics' }) : tool.tier).toBe('read')
  })
})
