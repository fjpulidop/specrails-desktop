import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'specs-unit-test-token-no-filesystem-access' }))
import { z } from 'zod'
import { initDesktopDb, type DbInstance } from '../../desktop-db'
import type { ProjectRegistry, ProjectContext } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { specsTools } from './specs'
import type { McpToolContext } from './types'
import { createAgentConversation, addAgentMessage, listAgentMessages } from '../../agent-store'

// Focused tests for the specs facade behavior fixes (plan B4/B5):
//  - `create` forwards the full generate-spec option set via the shared body
//    builder (and no longer sends the dead `provider` key)
//  - `create` throws a self-correcting error when labels/priority/status/
//    assignee are passed (generate-spec accepts none of them)
//  - `commit_draft` forwards assignee/prerequisites/metadata (one-shot insert)
//  - `contract_refine` returns the honest asymmetric-settle hint
//  - `priority` is a nullable enum (null clears — drafts only, via update)

function makeCtx(db: DbInstance): McpToolContext {
  const project = { id: 'p1', slug: 'p1', name: 'P1', path: '/tmp/p1', provider: 'claude', providers: ['claude'] } as unknown as ProjectContext['project']
  const pc = { project } as ProjectContext
  const registry = {
    desktopDb: db,
    listContexts: () => [pc],
    getContext: (id: string) => (id === 'p1' ? pc : undefined),
    getContextByPath: (p: string) => (p === '/tmp/p1' ? pc : undefined),
    removeProject: () => undefined,
  } as unknown as ProjectRegistry
  return { registry, desktopDb: db, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: 4299 }
}

describe('specrails_specs facade', () => {
  let db: DbInstance
  let ctx: McpToolContext
  let fetchMock: ReturnType<typeof vi.fn>
  const spec = specsTools()[0]

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    ctx = makeCtx(db)
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, requestId: 'req-1' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function lastBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.at(-1) as [string, { body?: string }]
    return JSON.parse(call[1].body ?? '{}') as Record<string, unknown>
  }

  it('returns a compact paginated list instead of full spec descriptions', async () => {
    const tickets = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      title: `Spec ${index + 1}`,
      description: 'x'.repeat(10_000),
      status: 'todo',
      priority: 'medium',
      labels: ['area:test'],
      updated_at: '2026-09-02T00:00:00Z',
    }))
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tickets, revision: 3, total: 55 }),
    })

    const result = await spec.handler(ctx, { action: 'list', projectId: 'p1' }) as {
      tickets: Array<Record<string, unknown>>
      nextOffset: number | null
    }
    expect(result.tickets).toHaveLength(50)
    expect(result.tickets[0]).not.toHaveProperty('description')
    expect(result.nextOffset).toBe(50)
    expect(JSON.stringify(result).length).toBeLessThan(15_000)
  })

  it('create forwards contextScope/attachmentIds/pendingSpecId/createLocal and drops the dead provider key', async () => {
    await spec.handler(ctx, {
      action: 'create',
      projectId: 'p1',
      title: 'T',
      description: 'D',
      contextScope: { full: true },
      attachmentIds: ['a1'],
      pendingSpecId: 'pend-1',
      createLocal: true,
      model: 'sonnet',
      aiEngine: 'claude',
      contractRefine: true,
    })
    const body = lastBody()
    expect(body.idea).toBe('T\n\nD')
    expect(body.contextScope).toEqual({ full: true })
    expect(body.attachmentIds).toEqual(['a1'])
    expect(body.pendingSpecId).toBe('pend-1')
    expect(body.createLocal).toBe(true)
    expect(body.model).toBe('sonnet')
    expect(body.aiEngine).toBe('claude')
    expect(body.contractRefine).toBe(true)
    expect('provider' in body).toBe(false)
  })

  it('generate forwards the same option set as create (shared body builder)', async () => {
    await spec.handler(ctx, {
      action: 'generate',
      projectId: 'p1',
      idea: 'the idea',
      contextScope: { specrails: true },
      attachmentIds: ['a2'],
      pendingSpecId: 'pend-2',
      createLocal: false,
    })
    const body = lastBody()
    expect(body.idea).toBe('the idea')
    expect(body.contextScope).toEqual({ specrails: true })
    expect(body.attachmentIds).toEqual(['a2'])
    expect(body.pendingSpecId).toBe('pend-2')
    expect(body.createLocal).toBe(false)
  })

  it.each(['labels', 'priority', 'status', 'assignee'] as const)(
    'create throws a self-correcting error when %s is passed',
    async (field) => {
      const values: Record<string, unknown> = {
        labels: ['x'],
        priority: 'high',
        status: 'todo',
        assignee: 'me',
      }
      await expect(
        spec.handler(ctx, { action: 'create', projectId: 'p1', title: 'T', [field]: values[field] }),
      ).rejects.toThrow(
        'create generates the spec with AI and cannot set labels/priority directly — use commit_draft (you control everything) or update after generation.',
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('commit_draft forwards assignee/prerequisites/metadata (one-shot insert)', async () => {
    await spec.handler(ctx, {
      action: 'commit_draft',
      projectId: 'p1',
      title: 'Full spec',
      description: 'Body',
      acceptanceCriteria: ['ac1'],
      priority: 'high',
      labels: ['l1'],
      shortSummary: 'One line',
      assignee: 'sr-developer',
      prerequisites: [1, 2],
      metadata: { area: 'server' },
    })
    const body = lastBody()
    expect(body.assignee).toBe('sr-developer')
    expect(body.prerequisites).toEqual([1, 2])
    expect(body.metadata).toEqual({ area: 'server' })
    expect(body.shortSummary).toBe('One line')
  })

  it('contract_refine returns the asymmetric-settle hint (not the generic watch hint)', async () => {
    const r = (await spec.handler(ctx, { action: 'contract_refine', projectId: 'p1', id: 3 })) as { hint: string }
    expect(r.hint).toContain('explore.contract_refine_failed')
    expect(r.hint).toContain('ticket_updated')
  })

  it('the generic watch hint no longer promises contract-refine settles via watch', async () => {
    const r = (await spec.handler(ctx, { action: 'generate', projectId: 'p1', idea: 'x' })) as { hint: string }
    expect(r.hint).not.toContain('contract_refine')
  })

  // ── Contract Layer defaults (super specs by default) ─────────────────────

  it('create defaults contractRefine to TRUE when unset', async () => {
    await spec.handler(ctx, { action: 'create', projectId: 'p1', title: 'T' })
    expect(lastBody().contractRefine).toBe(true)
  })

  it('generate honours an explicit contractRefine:false opt-out', async () => {
    await spec.handler(ctx, { action: 'generate', projectId: 'p1', idea: 'x', contractRefine: false })
    expect(lastBody().contractRefine).toBe(false)
  })

  it('agent-authored commit_draft (no conversationId/draftTicketId) defaults contractRefine to TRUE', async () => {
    await spec.handler(ctx, { action: 'commit_draft', projectId: 'p1', title: 'Refined spec' })
    expect(lastBody().contractRefine).toBe(true)
  })

  it('agent-authored commit_draft honours contractRefine:false (user declined the enrichment)', async () => {
    await spec.handler(ctx, {
      action: 'commit_draft', projectId: 'p1', title: 'No layer please', contractRefine: false,
    })
    expect(lastBody().contractRefine).toBe(false)
  })

  it('Explore-origin commit_draft (conversationId) does NOT default contractRefine — scope governs', async () => {
    await spec.handler(ctx, {
      action: 'commit_draft', projectId: 'p1', title: 'From Explore', conversationId: 'conv-1',
    })
    expect('contractRefine' in lastBody()).toBe(false)
  })

  it('draft-flip commit_draft (draftTicketId) does NOT default contractRefine either', async () => {
    await spec.handler(ctx, {
      action: 'commit_draft', projectId: 'p1', title: 'Flip', draftTicketId: 7,
    })
    expect('contractRefine' in lastBody()).toBe(false)
  })

  it('priority schema is a nullable enum (null clears — drafts only)', () => {
    const priority = spec.inputSchema.priority as z.ZodTypeAny
    expect(priority.safeParse(null).success).toBe(true)
    expect(priority.safeParse('high').success).toBe(true)
    expect(priority.safeParse('urgent').success).toBe(false)
  })

  it('update forwards a null priority to the PATCH route', async () => {
    await spec.handler(ctx, { action: 'update', projectId: 'p1', id: 5, priority: null })
    const body = lastBody()
    expect(body.priority).toBeNull()
  })
})

// ─── The framing gate on commit_draft (critical-spec-framing) ─────────────────
// A spec the IN-APP agent authored may not be persisted until the conversation
// holds a problem frame the user has answered. External MCP clients are exempt:
// they cannot render the card and hold no conversation here.

describe('specrails_specs commit_draft — framing gate', () => {
  let db: DbInstance
  let baseCtx: McpToolContext
  let fetchMock: ReturnType<typeof vi.fn>
  let conversationId: string
  const spec = specsTools()[0]

  const frame = {
    restated: { reading: 'Group the Settings sections', touches: ['client/src/pages/SettingsPage.tsx'] },
    alternative: { reading: 'Make one setting findable from anywhere', touches: ['client/src/components/CommandPalette.tsx'] },
    discriminator: 'Are you scanning the page, or did you arrive by accident?',
    assumptions: [],
    unknowns: [],
  }
  const fenced = '```problem-frame\n' + JSON.stringify(frame) + '\n```'

  const commitArgs = {
    action: 'commit_draft',
    projectId: 'p1',
    title: 'Group the Settings sections',
    description: 'D',
    acceptanceCriteria: ['C'],
  }

  function firstParty(): McpToolContext {
    return { ...baseCtx, firstPartyAgent: true, originConversationId: conversationId }
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    baseCtx = makeCtx(db)
    conversationId = createAgentConversation(db, {}).id
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 42 }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    db.close()
  })

  function answeredFrame() {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced })
    addAgentMessage(db, { conversationId, role: 'user', content: 'yes, the first one' })
  }

  it('refuses a first-party commit with no frame, and writes nothing', async () => {
    await expect(spec.handler(firstParty(), { ...commitArgs })).rejects.toThrow(/problem-frame/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(listAgentMessages(db, conversationId)).toHaveLength(0)
  })

  it('refuses while the frame is still unanswered', async () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced })
    await expect(spec.handler(firstParty(), { ...commitArgs })).rejects.toThrow(/has not answered/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('proceeds once the frame is answered, keeping the Contract Layer default', async () => {
    answeredFrame()
    const result = await spec.handler(firstParty(), { ...commitArgs })
    expect(result).toEqual({ id: 42 })
    const call = fetchMock.mock.calls.at(-1) as [string, { body?: string }]
    const body = JSON.parse(call[1].body ?? '{}') as Record<string, unknown>
    expect(body.title).toBe('Group the Settings sections')
    expect(body.contractRefine).toBe(true)
  })

  it('spends the frame: a second spec in the same conversation is refused', async () => {
    answeredFrame()
    await spec.handler(firstParty(), { ...commitArgs })
    fetchMock.mockClear()
    await expect(spec.handler(firstParty(), { ...commitArgs, title: 'Second' })).rejects.toThrow(/already spent/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a fresh frame after the commit re-arms the path', async () => {
    answeredFrame()
    await spec.handler(firstParty(), { ...commitArgs })
    answeredFrame()
    await expect(spec.handler(firstParty(), { ...commitArgs, title: 'Second' })).resolves.toEqual({ id: 42 })
  })

  it('a user waiver lets several specs through untouched', async () => {
    addAgentMessage(db, { conversationId, role: 'user', content: '#noframe just do it' })
    await expect(spec.handler(firstParty(), { ...commitArgs })).resolves.toEqual({ id: 42 })
    await expect(spec.handler(firstParty(), { ...commitArgs, title: 'Second' })).resolves.toEqual({ id: 42 })
  })

  it('a failed write does not spend the frame', async () => {
    answeredFrame()
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, text: async () => 'boom' }))
    await expect(spec.handler(firstParty(), { ...commitArgs })).rejects.toThrow()
    // Still satisfied: nothing was consumed by the attempt.
    await expect(spec.handler(firstParty(), { ...commitArgs })).resolves.toEqual({ id: 42 })
  })

  it('an EXTERNAL MCP client is unaffected — no frame required, no marker written', async () => {
    await expect(spec.handler(baseCtx, { ...commitArgs })).resolves.toEqual({ id: 42 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(listAgentMessages(db, conversationId)).toHaveLength(0)
  })

  it('a first-party call without a conversation is not gated (nothing to read)', async () => {
    const noConversation = { ...baseCtx, firstPartyAgent: true, originConversationId: null }
    await expect(spec.handler(noConversation, { ...commitArgs })).resolves.toEqual({ id: 42 })
  })

  it('an Explore-origin flip is gated too, and keeps its own contractRefine default', async () => {
    answeredFrame()
    await spec.handler(firstParty(), { ...commitArgs, conversationId: 'explore-conv-1', priority: 'medium' })
    const call = fetchMock.mock.calls.at(-1) as [string, { body?: string }]
    const body = JSON.parse(call[1].body ?? '{}') as Record<string, unknown>
    expect(body.conversationId).toBe('explore-conv-1')
    expect(body.contractRefine).toBeUndefined()
  })
})
