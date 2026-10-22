import { describe, expect, it, vi } from 'vitest'
import {
  FlowConflictError,
  FlowNotFoundError,
  FlowTransitionError,
  FlowUnavailableError,
  FlowValidationError,
  createFlowService,
  transition,
  type FlowPorts,
  type FlowRepository,
  type FlowSession,
} from '..'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const FROZEN = 'c'.repeat(40)

/** In-memory repository honouring the port contract (unique open Flow per conversation). */
function memoryRepository(): FlowRepository & { rows: Map<string, FlowSession> } {
  const rows = new Map<string, FlowSession>()
  const open = (conversationId: string) => [...rows.values()].find((row) => row.conversationId === conversationId && (row.state === 'active' || row.state === 'paused')) ?? null
  return {
    rows,
    insert(session) {
      if (rows.has(session.id) || open(session.conversationId)) throw new FlowConflictError('flow_already_open', 'open', open(session.conversationId)?.id ?? session.id)
      rows.set(session.id, { ...session })
    },
    save(session) {
      if (!rows.has(session.id)) throw new Error('missing')
      rows.set(session.id, { ...session })
    },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    findOpenByConversation: (conversationId) => open(conversationId),
    latestByConversation: (conversationId) => [...rows.values()].filter((row) => row.conversationId === conversationId).at(-1) ?? null,
    listUnsettled: () => [...rows.values()].filter((row) => row.state === 'active' || row.state === 'paused' || row.step !== null),
  }
}

function setup(overrides: Partial<FlowPorts> = {}) {
  const repository = memoryRepository()
  let clock = 0
  let ids = 0
  const tickets = { createPlaceholder: vi.fn(() => 7), setFlowState: vi.fn(), deletePlaceholder: vi.fn() }
  const worktrees = {
    reserve: vi.fn(async ({ flowId, ticketId }: { flowId: string; ticketId: number }) => ({ branch: `feat/${ticketId}-idea`, worktreePath: `/wt/${flowId}/ticket-${ticketId}`, baseSha: BASE, headSha: HEAD })),
    release: vi.fn(async () => {}),
    freeze: vi.fn(async () => ({ headSha: FROZEN })),
    exists: vi.fn(() => true),
    diff: vi.fn(async () => ({ branch: 'feat/7-idea', baseSha: BASE, headSha: HEAD, files: [{ path: 'a.ts', status: 'added' as const, additions: 3, deletions: 0 }], totals: { files: 1, additions: 3, deletions: 0 } })),
  }
  const agent = {
    assertReady: vi.fn(async () => {}),
    open: vi.fn(async ({ flowId }: { flowId: string }) => ({ coreSessionId: `flow:${flowId}` })),
    close: vi.fn(async () => {}),
  }
  // The real launcher adopts inside delivery's transaction; the fake mirrors that commit.
  const rails = {
    launch: vi.fn(async ({ flowId, railIndex }: { flowId: string; railIndex: number }) => {
      const current = repository.get(flowId)!
      repository.save(transition(current, { type: 'handed-off', railIndex, deliveryId: 'delivery-1', headSha: current.headSha!, now: 't-adopt' }).session)
      return { loopRunIds: ['run-1'], deliveryId: 'delivery-1' }
    }),
  }
  const usage = { costSoFar: vi.fn(() => ({ costUsd: 1.25, turns: 3, unpricedTurns: 1, tokensIn: 100, tokensOut: 50 })) }
  const notifier = { changed: vi.fn() }
  const availability = vi.fn(async () => ({ available: true, reason: 'ok', missing: [] as string[] }))
  const ports: FlowPorts = {
    repository, tickets, worktrees, agent, rails, usage, notifier,
    clock: { now: () => `2026-10-21T10:00:${String(clock++).padStart(2, '0')}.000Z` },
    ids: () => `flow-${++ids}`,
    availability,
    ...overrides,
  }
  const warn = vi.fn()
  return { service: createFlowService(ports, { warn }), repository, tickets, worktrees, agent, rails, usage, notifier, availability, warn }
}

const startInput = { conversationId: 'conv-1', idea: 'Try a kanban board\nwith drag and drop' }

describe('startFlow', () => {
  it('creates the spec, reserves the worktree, persists active and opens the session', async () => {
    const { service, tickets, worktrees, agent, notifier, repository } = setup()
    const flow = await service.startFlow(startInput)
    expect(flow).toMatchObject({ id: 'flow-1', state: 'active', step: null, ticketId: 7, branch: 'feat/7-idea', worktreePath: '/wt/flow-1/ticket-7', baseSha: BASE, headSha: HEAD, coreSessionId: 'flow:flow-1' })
    expect(tickets.createPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Try a kanban board', description: startInput.idea }))
    expect(worktrees.reserve).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7 })
    expect(agent.open).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', worktreePath: '/wt/flow-1/ticket-7' })
    expect(notifier.changed.mock.calls.map(([session]) => session.step)).toEqual(['start:ticket', 'start:worktree', 'start:session', null])
    expect(repository.get('flow-1')).toEqual(flow)
  })

  it('is idempotent by flowId and allows one open Flow per conversation', async () => {
    const { service, tickets } = setup()
    const first = await service.startFlow({ ...startInput, flowId: 'client-id' })
    await expect(service.startFlow({ ...startInput, flowId: 'client-id' })).resolves.toEqual(first)
    expect(tickets.createPlaceholder).toHaveBeenCalledTimes(1)
    await expect(service.startFlow(startInput)).rejects.toMatchObject({ code: 'flow_already_open', flowId: 'client-id' })
    await expect(service.startFlow({ conversationId: 'conv-2', idea: 'x', flowId: 'client-id' })).rejects.toMatchObject({ code: 'flow_id_conflict' })
  })

  it('serializes concurrent starts of one conversation', async () => {
    const { service } = setup()
    const results = await Promise.allSettled([service.startFlow(startInput), service.startFlow(startInput)])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('refuses without the Core capabilities and before any effect', async () => {
    const { service, tickets, availability } = setup()
    availability.mockResolvedValueOnce({ available: false, reason: 'Flow needs a Core that advertises flowSessions', missing: ['flowSessions'] })
    const error = await service.startFlow(startInput).catch((caught) => caught)
    expect(error).toBeInstanceOf(FlowUnavailableError)
    expect(error).toMatchObject({ code: 'feature_unavailable', missing: ['flowSessions'] })
    expect(tickets.createPlaceholder).not.toHaveBeenCalled()
  })

  it('refuses a conversation that cannot run Flow before any effect', async () => {
    const { service, tickets, agent } = setup()
    agent.assertReady.mockRejectedValueOnce(new FlowValidationError('conversation_not_pinned', 'Pin the mission'))
    await expect(service.startFlow(startInput)).rejects.toMatchObject({ code: 'conversation_not_pinned' })
    expect(tickets.createPlaceholder).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'idea', 'idea_required'],
    ['conv', 'x'.repeat(20_001), 'idea_too_long'],
  ])('validates input (%s)', async (conversationId, idea, code) => {
    const { service } = setup()
    await expect(service.startFlow({ conversationId: conversationId || ' ', idea: conversationId ? idea : '' })).rejects.toBeInstanceOf(FlowValidationError)
    await expect(service.startFlow({ conversationId: 'c', idea, ...(code === 'idea_required' ? { flowId: 'bad id!' } : {}) })).rejects.toBeInstanceOf(FlowValidationError)
  })

  it('compensates when the placeholder spec cannot be written', async () => {
    const { service, tickets, worktrees, repository } = setup()
    tickets.createPlaceholder.mockImplementationOnce(() => { throw new Error('store locked') })
    await expect(service.startFlow(startInput)).rejects.toThrow('store locked')
    expect(worktrees.release).not.toHaveBeenCalled()
    expect(tickets.deletePlaceholder).not.toHaveBeenCalled()
    expect(repository.get('flow-1')).toMatchObject({ state: 'discarded', step: null })
  })

  it('compensates when the worktree cannot be reserved', async () => {
    const { service, tickets, worktrees, repository } = setup()
    worktrees.reserve.mockRejectedValueOnce(new Error('git worktree add failed'))
    await expect(service.startFlow(startInput)).rejects.toThrow('git worktree add failed')
    expect(worktrees.release).toHaveBeenCalledWith({ flowId: 'flow-1', ticketId: 7, worktreePath: null, branch: null })
    expect(tickets.deletePlaceholder).toHaveBeenCalledWith(7)
    expect(repository.get('flow-1')?.state).toBe('discarded')
  })

  it('compensates when the agent session cannot open, and frees the conversation', async () => {
    const { service, tickets, worktrees, agent, repository } = setup()
    agent.open.mockRejectedValueOnce(new FlowUnavailableError('no driver'))
    await expect(service.startFlow(startInput)).rejects.toBeInstanceOf(FlowUnavailableError)
    expect(worktrees.release).toHaveBeenCalledWith({ flowId: 'flow-1', ticketId: 7, worktreePath: '/wt/flow-1/ticket-7', branch: 'feat/7-idea' })
    expect(tickets.deletePlaceholder).toHaveBeenCalledWith(7)
    expect(repository.findOpenByConversation('conv-1')).toBeNull()
    await expect(service.startFlow(startInput)).resolves.toMatchObject({ id: 'flow-2', state: 'active' })
  })

  it('keeps the row for review when compensation cannot remove the worktree', async () => {
    const { service, worktrees, agent, repository, warn } = setup()
    agent.open.mockRejectedValueOnce(new Error('boom'))
    worktrees.release.mockRejectedValueOnce(new Error('worktree busy'))
    await expect(service.startFlow(startInput)).rejects.toThrow('boom')
    expect(repository.get('flow-1')?.state).toBe('needs-review')
    expect(warn).toHaveBeenCalled()
  })
})

describe('pause, resume and discard', () => {
  it('pauses (closing the session) and resumes (reopening it), idempotently', async () => {
    const { service, agent, tickets } = setup()
    await service.startFlow(startInput)
    const paused = await service.pauseFlow('flow-1')
    expect(paused).toMatchObject({ state: 'paused', coreSessionId: null })
    expect(agent.close).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', coreSessionId: 'flow:flow-1' })
    expect(tickets.setFlowState).toHaveBeenLastCalledWith(7, 'paused')
    await expect(service.pauseFlow('flow-1')).resolves.toEqual(paused)
    expect(agent.close).toHaveBeenCalledTimes(1)
    const resumed = await service.resumeFlow('flow-1')
    expect(resumed).toMatchObject({ state: 'active', coreSessionId: 'flow:flow-1' })
    expect(tickets.setFlowState).toHaveBeenLastCalledWith(7, 'active')
    await expect(service.resumeFlow('flow-1')).resolves.toEqual(resumed)
    expect(agent.open).toHaveBeenCalledTimes(2)
  })

  it('a failing label update never blocks pause', async () => {
    const { service, tickets, warn } = setup()
    await service.startFlow(startInput)
    tickets.setFlowState.mockImplementationOnce(() => { throw new Error('store locked') })
    await expect(service.pauseFlow('flow-1')).resolves.toMatchObject({ state: 'paused' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('setTicketFlowState failed'))
  })

  it('refuses to resume when the worktree disappeared or Flow became unavailable', async () => {
    const { service, worktrees, availability } = setup()
    await service.startFlow(startInput)
    await service.pauseFlow('flow-1')
    worktrees.exists.mockReturnValueOnce(false)
    await expect(service.resumeFlow('flow-1')).rejects.toMatchObject({ code: 'flow_worktree_missing' })
    availability.mockResolvedValueOnce({ available: false, reason: 'no', missing: ['deriveChange'] })
    await expect(service.resumeFlow('flow-1')).rejects.toBeInstanceOf(FlowUnavailableError)
  })

  it('discards: closes the session, releases the worktree, deletes the spec', async () => {
    const { service, agent, worktrees, tickets } = setup()
    await service.startFlow(startInput)
    const discarded = await service.discardFlow('flow-1')
    expect(discarded.state).toBe('discarded')
    expect(agent.close).toHaveBeenCalled()
    expect(worktrees.release).toHaveBeenCalledWith({ flowId: 'flow-1', ticketId: 7, worktreePath: '/wt/flow-1/ticket-7', branch: 'feat/7-idea' })
    expect(tickets.deletePlaceholder).toHaveBeenCalledWith(7)
    await expect(service.discardFlow('flow-1')).resolves.toEqual(discarded)
    expect(worktrees.release).toHaveBeenCalledTimes(1)
  })

  it('keeps an open (paused) Flow when the worktree cannot be released', async () => {
    const { service, worktrees, repository } = setup()
    await service.startFlow(startInput)
    worktrees.release.mockRejectedValueOnce(new Error('busy'))
    await expect(service.discardFlow('flow-1')).rejects.toThrow('busy')
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', coreSessionId: null })
  })

  it('reports unknown flows', async () => {
    const { service } = setup()
    await expect(service.pauseFlow('nope')).rejects.toBeInstanceOf(FlowNotFoundError)
    expect(() => service.getFlow('nope')).toThrow(FlowNotFoundError)
  })
})

describe('handOffFlow', () => {
  it('closes the session, freezes HEAD and lets the rail adopt the worktree', async () => {
    const { service, agent, worktrees, rails, notifier } = setup()
    await service.startFlow(startInput)
    const result = await service.handOffFlow({ flowId: 'flow-1', railIndex: 2, options: { loopId: 'factory:flow-spec' } })
    expect(agent.close).toHaveBeenCalled()
    expect(worktrees.freeze).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7, worktreePath: '/wt/flow-1/ticket-7', baseSha: BASE })
    expect(rails.launch).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7, railIndex: 2, options: { loopId: 'factory:flow-spec' } })
    expect(result).toMatchObject({ loopRunIds: ['run-1'], deliveryId: 'delivery-1', flow: { state: 'handed_off', railIndex: 2, headSha: FROZEN, step: null } })
    expect(notifier.changed).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'handed_off' }))
    // Idempotent: the same rail returns the recorded hand-off; another rail conflicts.
    await expect(service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })).resolves.toMatchObject({ flow: { state: 'handed_off' }, loopRunIds: [] })
    await expect(service.handOffFlow({ flowId: 'flow-1', railIndex: 3 })).rejects.toMatchObject({ code: 'flow_already_handed_off' })
    await expect(service.discardFlow('flow-1')).rejects.toBeInstanceOf(FlowTransitionError)
  })

  it.each([
    ['freeze', (ctx: ReturnType<typeof setup>) => ctx.worktrees.freeze.mockRejectedValueOnce(new FlowConflictError('flow_freeze_failed', 'dirty'))],
    ['launch', (ctx: ReturnType<typeof setup>) => ctx.rails.launch.mockRejectedValueOnce(new Error('rail busy'))],
    ['adoption', (ctx: ReturnType<typeof setup>) => ctx.rails.launch.mockResolvedValueOnce({ loopRunIds: [], deliveryId: null })],
  ])('reverts to paused when the %s step fails', async (_step, arrange) => {
    const ctx = setup()
    await ctx.service.startFlow(startInput)
    arrange(ctx)
    await expect(ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })).rejects.toThrow()
    expect(ctx.repository.get('flow-1')).toMatchObject({ state: 'paused', step: null, railIndex: null })
    expect(ctx.worktrees.release).not.toHaveBeenCalled()
    expect(ctx.tickets.deletePlaceholder).not.toHaveBeenCalled()
  })

  it('never rolls back a transfer the launch committed', async () => {
    const ctx = setup()
    await ctx.service.startFlow(startInput)
    ctx.rails.launch.mockImplementationOnce(async ({ flowId, railIndex }) => {
      const current = ctx.repository.get(flowId)!
      ctx.repository.save(transition(current, { type: 'handed-off', railIndex, deliveryId: 'd', headSha: current.headSha!, now: 'x' }).session)
      throw new Error('response lost')
    })
    await expect(ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 1 })).rejects.toThrow('response lost')
    expect(ctx.repository.get('flow-1')?.state).toBe('handed_off')
  })

  it('validates the rail index and capability first', async () => {
    const ctx = setup()
    await ctx.service.startFlow(startInput)
    await expect(ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: -1 })).rejects.toBeInstanceOf(FlowValidationError)
    ctx.availability.mockResolvedValueOnce({ available: false, reason: 'no', missing: ['deriveChange'] })
    await expect(ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 1 })).rejects.toBeInstanceOf(FlowUnavailableError)
    expect(ctx.repository.get('flow-1')?.state).toBe('active')
  })

  it('records delivery once handed off', async () => {
    const ctx = setup()
    await ctx.service.startFlow(startInput)
    await ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    await expect(ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })).resolves.toMatchObject({ state: 'delivered' })
    expect(ctx.tickets.setFlowState).toHaveBeenLastCalledWith(7, 'delivered')
    await expect(ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })).resolves.toMatchObject({ state: 'delivered' })
  })
})

describe('reconcile', () => {
  it('pauses live Flows, compensates early starts and flags missing worktrees', async () => {
    const ctx = setup()
    const base = { conversationId: 'c', ticketId: 1, branch: 'b', worktreePath: '/wt/x', baseSha: BASE, headSha: HEAD, coreSessionId: 'flow:x', railIndex: null, deliveryId: null, createdAt: 't', updatedAt: 't' }
    ctx.repository.rows.set('live', { ...base, id: 'live', conversationId: 'c1', state: 'active', step: null })
    ctx.repository.rows.set('early', { ...base, id: 'early', conversationId: 'c2', state: 'active', step: 'start:worktree', worktreePath: null, coreSessionId: null })
    ctx.repository.rows.set('gone', { ...base, id: 'gone', conversationId: 'c3', state: 'paused', step: null, worktreePath: '/wt/gone' })
    ctx.repository.rows.set('launching', { ...base, id: 'launching', conversationId: 'c4', state: 'paused', step: 'handoff:launch', railIndex: 1 })
    ctx.repository.rows.set('done', { ...base, id: 'done', conversationId: 'c5', state: 'handed_off', step: null })
    ctx.worktrees.exists.mockImplementation((path: string) => path !== '/wt/gone')
    const changed = await ctx.service.reconcile()
    expect(Object.fromEntries(changed.map((session) => [session.id, session.state]))).toEqual({ live: 'paused', early: 'discarded', gone: 'needs-review', launching: 'paused' })
    expect(ctx.worktrees.release).toHaveBeenCalledWith({ flowId: 'early', ticketId: 1, worktreePath: null, branch: 'b' })
    expect(ctx.repository.get('done')?.state).toBe('handed_off')
    // A second pass changes nothing.
    await expect(ctx.service.reconcile()).resolves.toEqual([])
  })

  it('flags a Flow whose compensation fails and keeps going', async () => {
    const ctx = setup()
    const base = { ticketId: 1, branch: 'b', worktreePath: null, baseSha: null, headSha: null, coreSessionId: null, railIndex: null, deliveryId: null, createdAt: 't', updatedAt: 't', state: 'active' as const, step: 'start:worktree' as const }
    ctx.repository.rows.set('a', { ...base, id: 'a', conversationId: 'c1' })
    ctx.repository.rows.set('b', { ...base, id: 'b', conversationId: 'c2' })
    ctx.worktrees.release.mockRejectedValueOnce(new Error('locked'))
    const changed = await ctx.service.reconcile()
    expect(changed.map((session) => [session.id, session.state])).toEqual([['a', 'needs-review'], ['b', 'discarded']])
  })
})

describe('read models', () => {
  it('exposes the conversation Flow, the diff and the real cost window', async () => {
    const ctx = setup()
    expect(ctx.service.getByConversation('conv-1')).toBeNull()
    const flow = await ctx.service.startFlow(startInput)
    expect(ctx.service.getByConversation('conv-1')?.id).toBe(flow.id)
    await expect(ctx.service.diffSummary(flow.id)).resolves.toMatchObject({ totals: { files: 1, additions: 3 } })
    expect(ctx.service.costSoFar(flow.id)).toEqual({ flowId: flow.id, costUsd: 1.25, turns: 3, unpricedTurns: 1, tokensIn: 100, tokensOut: 50 })
    expect(ctx.usage.costSoFar).toHaveBeenCalledWith({ conversationId: 'conv-1', from: flow.createdAt, to: null })
    const discarded = await ctx.service.discardFlow(flow.id)
    ctx.service.costSoFar(flow.id)
    expect(ctx.usage.costSoFar).toHaveBeenLastCalledWith({ conversationId: 'conv-1', from: flow.createdAt, to: discarded.updatedAt })
    await expect(ctx.service.diffSummary(flow.id)).resolves.toMatchObject({ files: [] })
    expect(ctx.service.getByConversation('conv-1')?.state).toBe('discarded')
    await expect(ctx.service.availability()).resolves.toMatchObject({ available: true })
  })
})
