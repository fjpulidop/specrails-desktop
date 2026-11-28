import { describe, expect, it, vi } from 'vitest'

const published = vi.hoisted(() => [] as Array<{ conversationId: string; plan: unknown; source: string }>)
vi.mock('../../modules/missions/runtime/mission-plan', async (load) => ({
  ...(await load<typeof import('../../modules/missions/runtime/mission-plan')>()),
  publishMissionPlan: (conversationId: string, plan: unknown, source: string) => { published.push({ conversationId, plan, source }); return true },
}))

import { missionsTools } from './missions'
import type { McpToolContext } from './types'

const spec = missionsTools()[0]!
const ctx = (over: Partial<McpToolContext> = {}) => ({ firstPartyAgent: true, originConversationId: 'conv-1', ...over }) as unknown as McpToolContext

describe('specrails_missions plan (in-app agents)', () => {
  it('[spec:mission-plan/mcp] shows the calling mission\'s plan, read-only tier, from its capability', async () => {
    expect(spec.tier!({ action: 'plan' } as never)).toBe('read')
    const out = await spec.handler(ctx(), { action: 'plan', title: 'Login', steps: [{ content: 'Form', status: 'completed' }, { content: 'Tests', status: 'in_progress' }] }) as { content: Array<{ text: string }> }
    expect(JSON.stringify(out)).toContain('1/2 done')
    expect(published).toEqual([{ conversationId: 'conv-1', source: 'specrails', plan: { title: 'Login', steps: [{ content: 'Form', status: 'completed' }, { content: 'Tests', status: 'in_progress' }] } }])
  })

  it('refuses a client that is not a mission agent, and a plan without steps', async () => {
    await expect(spec.handler(ctx({ firstPartyAgent: false }), { action: 'plan', steps: [{ content: 'x', status: 'pending' }] })).rejects.toThrow(/in-app agent/)
    await expect(spec.handler(ctx(), { action: 'plan', steps: [] })).rejects.toThrow(/needs steps/)
  })
})
