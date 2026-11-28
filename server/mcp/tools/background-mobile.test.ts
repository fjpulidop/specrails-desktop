import { describe, expect, it, vi } from 'vitest'

const startMobileTest = vi.fn(async () => ({ ok: true as const, runId: 'run-9' }))
vi.mock('../../modules/tapflow', () => ({
  startMobileTest: (...args: unknown[]) => startMobileTest(...(args as [])),
  mobileTestRunView: (_c: unknown, runId: string) => (runId === 'run-9' ? { runId, state: 'launched', summary: 'iOS on iPhone 17 Pro', devices: [] } : null),
  mobileOfferEnv: { tapflowReady: async () => true },
}))

import { backgroundTool } from './background'
import type { McpToolContext } from './types'

const flow = { id: 'flow-1', state: 'active', step: null as unknown, worktreePath: '/intent/w' }
const projectCtx = { project: { id: 'p1' }, flow: { getByConversation: (id: string) => (id === 'conv-1' ? flow : null) } }
const ctx = (over: Partial<McpToolContext> = {}) => ({
  registry: { getContext: (id: string) => (id === 'p1' ? projectCtx : undefined) },
  sessionState: { activeProjectId: 'p1' }, firstPartyAgent: true, originConversationId: 'conv-1', agentTierLevel: 0, ...over,
}) as unknown as McpToolContext

describe('specrails_background mobile_test (in-app agents)', () => {
  const spec = backgroundTool()

  it('[spec:mobile-device-testing/agent-runs-the-app] builds the mission\'s Intent on a device, admitted inside its own active Intent at any level', async () => {
    expect(spec.tier!({ action: 'mobile_test' } as never)).toBe('write')
    expect(spec.tierException!(ctx(), { action: 'mobile_test', platforms: ['ios'] })).toBe(true)
    // A checkout run is not covered by the Intent grant: the ladder applies.
    expect(spec.tierException!(ctx(), { action: 'mobile_test', target: 'checkout', platforms: ['ios'] })).toBe(false)
    const out = await spec.handler(ctx(), { action: 'mobile_test', platforms: ['ios'] }) as Record<string, unknown>
    expect(out).toMatchObject({ ok: true, runId: 'run-9', loopRunId: 'run-9' })
    expect(startMobileTest).toHaveBeenCalledWith(projectCtx, { target: { kind: 'mission' }, platforms: ['ios'], devices: {}, conversationId: 'conv-1' }, expect.anything())
    expect(await spec.handler(ctx(), { action: 'mobile_status', runId: 'run-9' })).toMatchObject({ state: 'launched', summary: 'iOS on iPhone 17 Pro' })
  })

  it('is for in-app agents, and outside an active Intent the exception does not apply', async () => {
    await expect(spec.handler(ctx({ firstPartyAgent: false }), { action: 'mobile_test', platforms: ['ios'] })).rejects.toThrow(/in-app agent/)
    flow.state = 'paused'
    expect(spec.tierException!(ctx(), { action: 'mobile_test', platforms: ['ios'] })).toBe(false)
    flow.state = 'active'
  })
})
