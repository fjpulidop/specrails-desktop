import { describe, expect, it, vi } from 'vitest'
import {
  FlowConflictError,
  FlowNotFoundError,
  FlowTransitionError,
  FlowUnavailableError,
  FlowValidationError,
  createFlowService,
  transition,
  type FlowEffectsStore,
  type FlowPorts,
  type FlowRepository,
  type FlowSession,
  type FlowSettlementEffect,
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
    listHandedOff: () => [...rows.values()].filter((row) => row.state === 'handed_off'),
    findByDelivery: (deliveryId) => [...rows.values()].find((row) => row.deliveryId === deliveryId) ?? null,
  }
}

/** In-memory `flow_effects` honouring INSERT OR IGNORE. */
export function memoryEffects(): FlowEffectsStore & { rows: Map<string, FlowSettlementEffect> } {
  const rows = new Map<string, FlowSettlementEffect>()
  return {
    rows,
    enqueue(effects) { for (const effect of effects) if (!rows.has(effect.key)) rows.set(effect.key, { ...effect }) },
    list: (flowId) => [...rows.values()].filter((row) => row.flowId === flowId).sort((a, b) => a.seq - b.seq).map((row) => ({ ...row })),
    save(effect) { rows.set(effect.key, { ...effect }) },
    pendingFlowIds: () => [...new Set([...rows.values()].filter((row) => row.status === 'pending').map((row) => row.flowId))],
  }
}

function setup(overrides: Partial<FlowPorts> = {}) {
  const timeShift = { ms: 0 }
  const repository = memoryRepository()
  let clock = 0
  let ids = 0
  const existingSpec = { id: 12, title: 'Calmer onboarding', description: '## Acceptance criteria\n- [ ] Progress rail\n\n---\n\n## Contract Layer\n\nInputs: none', status: 'todo', nonGoals: ['No analytics'], repositoryIds: [] as string[], addenda: '' }
  const tickets = {
    createPlaceholder: vi.fn(() => 7), setFlowState: vi.fn(), deletePlaceholder: vi.fn(), markDelivered: vi.fn(), reopen: vi.fn(),
    read: vi.fn((_ticketId: number) => ({ title: 'Try a kanban board', description: 'Try a kanban board', status: 'on_review' })),
    inspectExisting: vi.fn((_ticketId: number): ReturnType<FlowPorts['tickets']['inspectExisting']> => ({ spec: existingSpec, blocker: null })),
    adoptExisting: vi.fn((_input: { ticketId: number; flowId: string; conversationId: string; startedAt: string }) => existingSpec),
    restoreExisting: vi.fn(),
    preserveOriginal: vi.fn(),
    applyAddenda: vi.fn(),
  }
  const effects = memoryEffects()
  const jira = {
    connected: vi.fn(() => true),
    enqueueCreate: vi.fn((): 'enqueued' | 'already_linked' | 'inactive' | 'failed' => 'enqueued'),
    linked: vi.fn(() => true),
    enqueueReview: vi.fn(),
    enqueueUpdate: vi.fn((): 'enqueued' | 'not_linked' | 'inactive' | 'failed' => 'enqueued'),
  }
  const publication = {
    deliveryState: vi.fn(() => ({ delivered: true }) as { delivered: boolean } | null),
    derivedChange: vi.fn(async () => ({ changeName: 'kanban-board', proposal: '## Why\nBoard', design: '## Blast radius\n- a.ts', diffstat: ' a.ts | 3 +++' })),
    conversationSummary: vi.fn(() => '---\ntranscriptTurns: 1\n---\n'),
    rewriteSpec: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
    jira,
  }
  const worktrees = {
    reserve: vi.fn(async ({ flowId, ticketId }: { flowId: string; ticketId: number }) => ({ branch: `feat/${ticketId}-idea`, worktreePath: `/wt/${flowId}/ticket-${ticketId}`, baseSha: BASE, headSha: HEAD })),
    release: vi.fn(async () => {}),
    freeze: vi.fn(async () => ({ headSha: FROZEN })),
    exists: vi.fn(() => true),
    diff: vi.fn(async () => ({ branch: 'feat/7-idea', baseSha: BASE, headSha: HEAD, files: [{ path: 'a.ts', status: 'added' as const, additions: 3, deletions: 0 }], totals: { files: 1, additions: 3, deletions: 0 } })),
  }
  let generation = 0
  const agent = {
    assertReady: vi.fn(async () => {}),
    // A resume opens a new Core session generation (a closed one never takes a turn).
    open: vi.fn(async ({ flowId, renew }: { flowId: string; renew?: boolean }) => ({ coreSessionId: renew ? `flow:${flowId}:r${++generation}` : `flow:${flowId}` })),
    close: vi.fn(async () => {}),
    launchEngine: vi.fn((_conversationId: string): { aiEngine?: string; model?: string; reasoningEffort?: string } | null => null),
  }
  const processes = { stop: vi.fn(async (_input: { flowId: string; conversationId: string }) => {}) }
  // The real launcher adopts inside delivery's transaction; the fake mirrors that commit.
  const rails = {
    launch: vi.fn(async ({ flowId, railIndex }: { flowId: string; railIndex: number }) => {
      const current = repository.get(flowId)!
      repository.save(transition(current, { type: 'handed-off', railIndex, deliveryId: 'delivery-1', headSha: current.headSha!, now: 't-adopt' }).session)
      return { loopRunIds: ['run-1'], deliveryId: 'delivery-1' }
    }),
    stoppedDelivery: vi.fn((_deliveryId: string) => ({
      railIndex: 2,
      options: { aiEngine: 'claude', model: 'sonnet' },
      findings: { reason: 'review' as const, summary: 'Two gaps remain', issues: ['Tag the tests with [spec:fx/toggles]', 'Test the Options screen'], issuesOmitted: 0, score: 58, failingChecks: [] },
    }) as ReturnType<FlowPorts['rails']['stoppedDelivery']>),
    // The real binding runs `commit` inside delivery's ledger transaction.
    returnWorktree: vi.fn((input: { deliveryId: string; worktreePath: string; detail: string; commit: () => void }) => { input.commit() }),
  }
  const usage = { costSoFar: vi.fn(() => ({ costUsd: 1.25, turns: 3, unpricedTurns: 1, tokensIn: 100, tokensOut: 50 })) }
  const notifier = { changed: vi.fn() }
  const availability = vi.fn(async () => ({ available: true, reason: 'ok', missing: [] as string[] }))
  const ports: FlowPorts = {
    repository, tickets, worktrees, agent, processes, rails, usage, notifier, effects, publication,
    clock: { now: () => new Date(Date.parse('2026-10-21T10:00:00.000Z') + 1000 * clock++ + timeShift.ms).toISOString() },
    ids: () => `flow-${++ids}`,
    availability,
    ...overrides,
  }
  const warn = vi.fn()
  return { service: createFlowService(ports, { warn }), ports, repository, tickets, worktrees, agent, processes, rails, usage, notifier, availability, warn, effects, publication, jira, timeShift }
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

  it('closes a needs-review Flow keeping its branch: nothing is released, the history says it left', async () => {
    const conversation = { postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}), postBoundary: vi.fn() }
    const { service, worktrees, agent, repository, tickets } = setup({ conversation })
    agent.open.mockRejectedValueOnce(new Error('boom'))
    worktrees.release.mockRejectedValueOnce(new Error('worktree busy'))
    await expect(service.startFlow(startInput)).rejects.toThrow('boom')
    worktrees.release.mockClear()
    // The worktree survived: the panel still reads what it holds.
    await expect(service.diffSummary('flow-1')).resolves.toMatchObject({ totals: { files: 1 } })
    const closed = await service.closeFlow('flow-1')
    expect(closed).toMatchObject({ state: 'closed', branch: 'feat/7-idea' })
    expect(repository.get('flow-1')?.state).toBe('closed')
    expect(worktrees.release).not.toHaveBeenCalled()
    expect(tickets.deletePlaceholder).not.toHaveBeenCalled()
    expect(tickets.setFlowState).toHaveBeenLastCalledWith(7, 'closed')
    expect(conversation.postBoundary).toHaveBeenLastCalledWith({ conversationId: 'conv-1', flowId: 'flow-1', event: 'left', reason: 'closed', branch: 'feat/7-idea' })
    // Idempotent: a second close changes nothing and posts nothing.
    await service.closeFlow('flow-1')
    expect(conversation.postBoundary).toHaveBeenCalledTimes(1)
  })

  it('refuses to close an open Flow (that is a discard)', async () => {
    const { service } = setup()
    await service.startFlow(startInput)
    await expect(service.closeFlow('flow-1')).rejects.toBeInstanceOf(FlowTransitionError)
  })
})

describe('startFlow in a workspace / multi-repository project', () => {
  const members = (...list: Array<{ id: string; kind: 'git' | 'folder'; isPrimary?: boolean; available?: boolean }>) => ({
    list: () => list.map((member) => ({ name: member.id, isPrimary: false, ...member })),
  })

  it('a single-repository project is never triaged (no repository on the Flow, the spec or the worktree)', async () => {
    const { service, tickets, worktrees } = setup({ repositories: members({ id: 'primary', kind: 'git', isPrimary: true }) })
    const flow = await service.startFlow(startInput)
    expect(flow.repositoryId).toBeUndefined()
    expect(tickets.createPlaceholder.mock.calls[0]![0]).not.toHaveProperty('repositoryIds')
    expect(worktrees.reserve).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7 })
  })

  it('runs in the chosen Git member: persisted on the Flow, the placeholder spec, the worktree, the freeze and the hand-off', async () => {
    const { service, tickets, worktrees, rails, repository } = setup({
      repositories: members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'web', kind: 'git' }, { id: 'api', kind: 'git' }),
    })
    const flow = await service.startFlow({ ...startInput, repositoryId: 'api' })
    expect(flow.repositoryId).toBe('api')
    expect(repository.get(flow.id)?.repositoryId).toBe('api')
    expect(tickets.createPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ repositoryIds: ['api'] }))
    expect(worktrees.reserve).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7, repositoryId: 'api' })
    await service.handOffFlow({ flowId: flow.id, railIndex: 1 })
    expect(worktrees.freeze).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: 'api' }))
    expect(rails.launch).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: 'api' }))
    await service.diffSummary(flow.id)
    expect(worktrees.diff).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: 'api' }))
  })

  it('defaults to the only Git member of a workspace and releases there on discard', async () => {
    const { service, worktrees } = setup({ repositories: members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'app', kind: 'git' }) })
    const flow = await service.startFlow(startInput)
    expect(flow.repositoryId).toBe('app')
    await service.discardFlow(flow.id)
    expect(worktrees.release).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: 'app' }))
  })

  it('choosing the primary keeps the pre-workspace behaviour', async () => {
    const { service, worktrees } = setup({ repositories: members({ id: 'core', kind: 'git', isPrimary: true }, { id: 'docs', kind: 'git' }) })
    const flow = await service.startFlow({ ...startInput, repositoryId: 'core' })
    expect(flow.repositoryId).toBeUndefined()
    expect(worktrees.reserve).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7 })
  })

  it('refuses before any effect: several Git members without a choice, a folder, an unknown id, no Git at all', async () => {
    const cases: Array<[ReturnType<typeof members>, string | undefined, string]> = [
      [members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'web', kind: 'git' }, { id: 'api', kind: 'git' }), undefined, 'flow_repository_required'],
      [members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'web', kind: 'git' }), 'workspace', 'flow_repository_not_git'],
      [members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'web', kind: 'git' }), 'nope', 'flow_repository_unknown'],
      [members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'notes', kind: 'folder' }), undefined, 'flow_repository_not_git'],
      [members({ id: 'workspace', kind: 'folder', isPrimary: true }, { id: 'web', kind: 'git', available: false }), 'web', 'flow_repository_not_git'],
    ]
    for (const [repositories, repositoryId, code] of cases) {
      const { service, tickets, worktrees, repository } = setup({ repositories })
      const error = await service.startFlow({ ...startInput, ...(repositoryId ? { repositoryId } : {}) }).catch((caught) => caught)
      expect(error).toBeInstanceOf(FlowValidationError)
      expect(error).toMatchObject({ code })
      expect(tickets.createPlaceholder).not.toHaveBeenCalled()
      expect(worktrees.reserve).not.toHaveBeenCalled()
      expect(repository.rows.size).toBe(0)
    }
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
    // The paused session was closed in Core: resuming opens a NEW session.
    expect(resumed).toMatchObject({ state: 'active', coreSessionId: 'flow:flow-1:r1' })
    expect(agent.open).toHaveBeenLastCalledWith(expect.objectContaining({ renew: true }))
    expect(tickets.setFlowState).toHaveBeenLastCalledWith(7, 'active')
    await expect(service.resumeFlow('flow-1')).resolves.toEqual(resumed)
    expect(agent.open).toHaveBeenCalledTimes(2)
  })

  it('stops the Flow apps before closing the session on pause, discard and hand-off', async () => {
    const order: string[] = []
    const ctx = setup()
    ctx.processes.stop.mockImplementation(async () => { order.push('stop') })
    ctx.agent.close.mockImplementation(async () => { order.push('close') })
    ctx.worktrees.release.mockImplementation(async () => { order.push('release') })
    ctx.worktrees.freeze.mockImplementation(async () => { order.push('freeze'); return { headSha: FROZEN } })
    await ctx.service.startFlow(startInput)
    await ctx.service.pauseFlow('flow-1')
    expect(ctx.processes.stop).toHaveBeenLastCalledWith({ flowId: 'flow-1', conversationId: 'conv-1' })
    expect(order).toEqual(['stop', 'close'])
    await ctx.service.resumeFlow('flow-1')
    order.length = 0
    await ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    expect(order).toEqual(['stop', 'close', 'freeze'])

    const other = setup()
    other.processes.stop.mockImplementation(async () => { order.push('stop') })
    other.worktrees.release.mockImplementation(async () => { order.push('release') })
    await other.service.startFlow(startInput)
    order.length = 0
    await other.service.discardFlow('flow-1')
    expect(order).toEqual(['stop', 'release'])
  })

  it('a failing app stop never blocks pause or discard', async () => {
    const { service, processes, warn, worktrees } = setup()
    await service.startFlow(startInput)
    processes.stop.mockRejectedValue(new Error('kill failed'))
    await expect(service.pauseFlow('flow-1')).resolves.toMatchObject({ state: 'paused' })
    await expect(service.discardFlow('flow-1')).resolves.toMatchObject({ state: 'discarded' })
    expect(worktrees.release).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopProcesses failed'))
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
    expect(worktrees.freeze).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7, worktreePath: '/wt/flow-1/ticket-7', baseSha: BASE, allowedChanges: [] })
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

describe('settlement (arch 4.6)', () => {
  async function delivered(overrides: Partial<FlowPorts> = {}) {
    const ctx = setup(overrides)
    await ctx.service.startFlow(startInput)
    await ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    return ctx
  }
  const statuses = (ctx: ReturnType<typeof setup>) => Object.fromEntries(ctx.effects.list('flow-1').map((effect) => [effect.kind, effect.status]))

  it('runs rewrite, Jira create and Jira review in order, once', async () => {
    const ctx = await delivered()
    const order: string[] = []
    ctx.publication.rewriteSpec.mockImplementation(async () => { order.push('rewrite'); return { ok: true } })
    ctx.jira.enqueueCreate.mockImplementation(() => { order.push('create'); return 'enqueued' })
    ctx.jira.enqueueReview.mockImplementation(() => { order.push('review') })
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    expect(order).toEqual(['rewrite', 'create', 'review'])
    expect(statuses(ctx)).toEqual({ 'rewrite-spec': 'done', 'jira-create': 'done', 'jira-review': 'done' })
    expect(ctx.tickets.markDelivered).toHaveBeenCalledWith(7, { openspecChangeName: 'kanban-board' })
    expect(ctx.jira.enqueueCreate).toHaveBeenCalledWith(7, 'flow:flow-1:create')
    expect(ctx.jira.enqueueReview).toHaveBeenCalledWith(7, 'delivery-1')
    const text = ctx.publication.rewriteSpec.mock.calls[0]![0].text
    expect(text).toContain('ALREADY EXISTS')
    expect(text).toContain('## Derived proposal (proposal.md)')
    expect(text).toContain('a.ts | 3 +++')
    // Idempotent: a second delivery signal and replay change nothing.
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.replaySettlement()
    expect(order).toEqual(['rewrite', 'create', 'review'])
    expect(ctx.effects.rows.size).toBe(3)
  })

  it('posts the closing summary once the spec rewrite and the Jira create settled, never before', async () => {
    const conversation = { postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}), postDeliveredSummary: vi.fn() }
    const ctx = await delivered({ conversation })
    ctx.jira.linked.mockReturnValue(false)
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    // The review transition still waits for the issue link: the summary does not.
    expect(statuses(ctx)).toMatchObject({ 'rewrite-spec': 'done', 'jira-create': 'done', 'jira-review': 'pending' })
    expect(conversation.postDeliveredSummary).toHaveBeenCalledWith({ conversationId: 'conv-1', flowId: 'flow-1', deliveryId: 'delivery-1', ticketId: 7,
      settlement: { specRewrite: 'done', jiraCreate: 'done', jiraReview: 'pending' } })

    const waiting = await delivered({ conversation: { ...conversation, postDeliveredSummary: vi.fn() } })
    waiting.publication.rewriteSpec.mockResolvedValue({ ok: false, error: 'provider down' })
    await waiting.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await waiting.service.runSettlement('flow-1')
    expect(waiting.ports.conversation!.postDeliveredSummary).not.toHaveBeenCalled()
  })

  it('skips Jira for a project that is not connected', async () => {
    const ctx = await delivered()
    ctx.jira.connected.mockReturnValue(false)
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    expect(statuses(ctx)).toEqual({ 'rewrite-spec': 'done', 'jira-create': 'skipped', 'jira-review': 'skipped' })
    expect(ctx.jira.enqueueCreate).not.toHaveBeenCalled()
    expect(ctx.jira.enqueueReview).not.toHaveBeenCalled()
  })

  it('keeps the placeholder when the rewrite fails, then still publishes to Jira', async () => {
    const ctx = await delivered()
    ctx.publication.rewriteSpec.mockResolvedValue({ ok: false, error: 'spec-gen exited 1' })
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    // First failure: retry later, later effects wait (order is kept).
    expect(ctx.effects.list('flow-1')[0]).toMatchObject({ status: 'pending', attempts: 1, note: 'rewrite_failed', lastError: 'spec-gen exited 1' })
    expect(ctx.jira.enqueueCreate).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) { ctx.timeShift.ms += 10 * 60_000; await ctx.service.runDueSettlements() }
    expect(statuses(ctx)).toEqual({ 'rewrite-spec': 'failed', 'jira-create': 'done', 'jira-review': 'done' })
    expect(ctx.publication.rewriteSpec).toHaveBeenCalledTimes(3)
    // A failed rewrite never marks the addenda applied: the spec does not describe the work.
    expect(ctx.tickets.applyAddenda).not.toHaveBeenCalled()
    // The delivered label and change name never wait for the rewrite.
    expect(ctx.tickets.markDelivered).toHaveBeenCalledWith(7, { openspecChangeName: 'kanban-board' })
    expect(ctx.service.settlementForDelivery('delivery-1')).toEqual({ specRewrite: 'failed', jiraCreate: 'done', jiraReview: 'done' })
  })

  it('retries while Jira is down and waits for the issue link before the review transition', async () => {
    const ctx = await delivered()
    ctx.jira.enqueueCreate.mockReturnValueOnce('failed')
    ctx.jira.linked.mockReturnValue(false)
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    expect(statuses(ctx)).toEqual({ 'rewrite-spec': 'done', 'jira-create': 'pending', 'jira-review': 'pending' })
    ctx.timeShift.ms += 60_000
    await ctx.service.runDueSettlements()
    expect(statuses(ctx)['jira-create']).toBe('done')
    expect(ctx.effects.list('flow-1')[2]).toMatchObject({ status: 'pending', note: 'awaiting_issue' })
    expect(ctx.jira.enqueueReview).not.toHaveBeenCalled()
    ctx.jira.linked.mockReturnValue(true)
    ctx.timeShift.ms += 10 * 60_000
    await ctx.service.runDueSettlements()
    expect(statuses(ctx)['jira-review']).toBe('done')
    expect(ctx.jira.enqueueReview).toHaveBeenCalledTimes(1)
  })

  it('replays after a restart: a delivery that reached review while down settles, pending effects resume', async () => {
    const ctx = await delivered()
    // Restart: a fresh service over the same rows (nothing was enqueued yet).
    const restarted = createFlowService(portsOf(ctx), { warn: vi.fn() })
    await restarted.replaySettlement()
    await restarted.runSettlement('flow-1')
    expect(ctx.repository.get('flow-1')?.state).toBe('delivered')
    expect(statuses(ctx)).toEqual({ 'rewrite-spec': 'done', 'jira-create': 'done', 'jira-review': 'done' })
  })

  it('observes only Flow deliveries that reached review', async () => {
    const ctx = await delivered()
    ctx.publication.deliveryState.mockReturnValueOnce({ delivered: false })
    await expect(ctx.service.observeDelivery('delivery-1')).resolves.toBeNull()
    await expect(ctx.service.observeDelivery('unknown')).resolves.toBeNull()
    await expect(ctx.service.observeDelivery('delivery-1')).resolves.toMatchObject({ state: 'delivered' })
    // A Flow with a delivery row never settles from a bare run completion.
    await expect(ctx.service.onRailRunCompleted({ flowId: 'flow-1', runId: 'run-1' })).resolves.toBeNull()
  })
})

/** Rebuild the port bag of a setup() context (fresh service, same stores). */
function portsOf(ctx: ReturnType<typeof setup>): FlowPorts {
  return {
    repository: ctx.repository, tickets: ctx.tickets, worktrees: ctx.worktrees, agent: ctx.agent, processes: ctx.processes, rails: ctx.rails, usage: ctx.usage,
    notifier: ctx.notifier, effects: ctx.effects, publication: ctx.publication,
    clock: { now: () => new Date(Date.parse('2026-10-21T11:00:00.000Z') + ctx.timeShift.ms).toISOString() },
    ids: () => 'flow-x', availability: ctx.availability,
  }
}

describe('renewSession (closed Core session, provider switch)', () => {
  it('commits a new, strictly newer session generation for an active Flow only', async () => {
    const ctx = setup()
    const flow = await ctx.service.startFlow(startInput)
    const renewed = await ctx.service.renewSession(flow.id)
    expect(renewed?.coreSessionId).toMatch(/^flow:flow-1:[0-9a-z]+$/)
    expect(ctx.repository.get(flow.id)?.coreSessionId).toBe(renewed!.coreSessionId)
    const again = await ctx.service.renewSession(flow.id)
    expect(again!.coreSessionId).not.toBe(renewed!.coreSessionId)
    expect(ctx.agent.close).not.toHaveBeenCalled()
    await ctx.service.pauseFlow(flow.id)
    await expect(ctx.service.renewSession(flow.id)).resolves.toBeNull()
    await expect(ctx.service.renewSession('missing')).resolves.toBeNull()
  })
})

describe('Back to Flow and Relaunch (Flow → Spec requested changes)', () => {
  async function handedOff(ctx: ReturnType<typeof setup>) {
    const flow = await ctx.service.startFlow(startInput)
    await ctx.service.handOffFlow({ flowId: flow.id, railIndex: 2 })
    return flow
  }

  it('returns the worktree through delivery, reopens the spec and the session, and keeps the review for the next turn', async () => {
    const ctx = setup()
    const flow = await handedOff(ctx)
    ctx.agent.open.mockClear()
    const returned = await ctx.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(returned).toMatchObject({ id: flow.id, state: 'active', step: null, deliveryId: 'delivery-1', railIndex: null, worktreePath: '/wt/flow-1/ticket-7', coreSessionId: 'flow:flow-1:r1' })
    expect(ctx.rails.returnWorktree).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'delivery-1', worktreePath: '/wt/flow-1/ticket-7' }))
    expect(ctx.tickets.reopen).toHaveBeenCalledWith(7)
    expect(ctx.tickets.setFlowState).toHaveBeenCalledWith(7, 'active')
    // The hand-off closed `flow:flow-1`: Back to Flow opens a new session, never the closed one.
    expect(ctx.agent.open).toHaveBeenCalledWith({ flowId: flow.id, conversationId: 'conv-1', worktreePath: '/wt/flow-1/ticket-7', renew: true })
    expect(ctx.worktrees.release).not.toHaveBeenCalled()
    expect(returned.returnBriefing).toContain('the reviewer requested changes (score 58)')
    expect(returned.returnBriefing).toContain('1. Tag the tests with [spec:fx/toggles]')
    // Idempotent by delivery.
    ctx.rails.returnWorktree.mockClear()
    await expect(ctx.service.returnToFlow({ deliveryId: 'delivery-1' })).resolves.toMatchObject({ id: flow.id, state: 'active' })
    expect(ctx.rails.returnWorktree).not.toHaveBeenCalled()
  })

  it('clears the briefing once a turn delivered it, and a new hand-off drops an undelivered one', async () => {
    const ctx = setup()
    const flow = await handedOff(ctx)
    await ctx.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect((await ctx.service.briefingDelivered(flow.id))?.returnBriefing ?? null).toBeNull()
    await expect(ctx.service.briefingDelivered('missing')).resolves.toBeNull()
    const again = setup()
    const other = await handedOff(again)
    await again.service.returnToFlow({ deliveryId: 'delivery-1' })
    await again.service.handOffFlow({ flowId: other.id, railIndex: 2 })
    expect(again.repository.get(other.id)?.returnBriefing ?? null).toBeNull()
  })

  it('announces the return once: the review card, then ONE automatic Flow turn (only when active); relaunch announces nothing', async () => {
    const conversation = { postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}) }
    const ctx = setup({ conversation })
    ctx.rails.stoppedDelivery.mockImplementation(() => ({
      railIndex: 2, options: {},
      findings: { reason: 'review' as const, summary: 'Two gaps', issues: ['Tag the tests'], issuesOmitted: 0, score: 58, failingChecks: [] },
      derivation: { change: 'fx', files: 9, explained: 6, unexplainedFiles: ['src/fx/shake.ts'], unexplainedOmitted: 0 },
    }))
    const flow = await handedOff(ctx)
    const returned = await ctx.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(conversation.postReturnCard).toHaveBeenCalledWith({ conversationId: 'conv-1', flowId: flow.id, deliveryId: 'delivery-1',
      findings: expect.objectContaining({ issues: ['Tag the tests'], score: 58 }), derivation: expect.objectContaining({ files: 9, explained: 6 }) })
    expect(conversation.startReturnTurn).toHaveBeenCalledWith({ conversationId: 'conv-1', flowId: flow.id, deliveryId: 'delivery-1' })
    // The briefing names the coverage gap and the conduct of the automatic turn.
    expect(returned.returnBriefing).toContain('explains 6 of 9 changed files')
    expect(returned.returnBriefing).toContain('src/fx/shake.ts')
    expect(returned.returnBriefing).toContain('`options` block BEFORE editing')

    // A paused return (session did not open) shows the card but waits for the person.
    const paused = setup({ conversation: { postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}) } })
    await handedOff(paused)
    paused.agent.open.mockRejectedValueOnce(new Error('provider down'))
    await paused.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(paused.ports.conversation!.postReturnCard).toHaveBeenCalledTimes(1)
    expect(paused.ports.conversation!.startReturnTurn).not.toHaveBeenCalled()

    // A failing announcement never undoes the return.
    const failing = setup({ conversation: { postReturnCard: vi.fn(() => { throw new Error('db gone') }), startReturnTurn: vi.fn(async () => {}) } })
    await handedOff(failing)
    await expect(failing.service.returnToFlow({ deliveryId: 'delivery-1' })).resolves.toMatchObject({ state: 'active' })

    // Relaunch path unchanged: no card, no automatic turn.
    const relaunch = setup({ conversation: { postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}) } })
    await handedOff(relaunch)
    await relaunch.service.relaunchFlow({ deliveryId: 'delivery-1' })
    expect(relaunch.ports.conversation!.postReturnCard).not.toHaveBeenCalled()
    expect(relaunch.ports.conversation!.startReturnTurn).not.toHaveBeenCalled()
  })

  it('stays paused (ownership already returned) when the agent session cannot open', async () => {
    const ctx = setup()
    const flow = await handedOff(ctx)
    ctx.agent.open.mockRejectedValueOnce(new Error('provider down'))
    const returned = await ctx.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(returned).toMatchObject({ id: flow.id, state: 'paused', coreSessionId: null })
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining('did not open'))
  })

  it('leaves the Flow handed off when delivery refuses the return (transaction rolled back)', async () => {
    const ctx = setup()
    const flow = await handedOff(ctx)
    ctx.rails.returnWorktree.mockImplementationOnce(() => { throw new FlowConflictError('flow_return_not_allowed', 'not stopped') })
    await expect(ctx.service.returnToFlow({ deliveryId: 'delivery-1' })).rejects.toMatchObject({ code: 'flow_return_not_allowed' })
    expect(ctx.repository.get(flow.id)).toMatchObject({ state: 'handed_off', deliveryId: 'delivery-1' })
    expect(ctx.tickets.reopen).not.toHaveBeenCalled()
  })

  it('refuses an unknown delivery and a missing worktree', async () => {
    const ctx = setup()
    await expect(ctx.service.returnToFlow({ deliveryId: 'nope' })).rejects.toBeInstanceOf(FlowNotFoundError)
    const flow = await handedOff(ctx)
    ctx.worktrees.exists.mockReturnValue(false)
    await expect(ctx.service.returnToFlow({ deliveryId: 'delivery-1' })).rejects.toMatchObject({ code: 'flow_worktree_missing' })
    expect(ctx.repository.get(flow.id)?.state).toBe('handed_off')
  })

  it('relaunches Flow → Spec on the same worktree, rail and engine choices', async () => {
    const ctx = setup()
    const flow = await handedOff(ctx)
    ctx.rails.launch.mockClear()
    ctx.worktrees.freeze.mockClear()
    const relaunched = await ctx.service.relaunchFlow({ deliveryId: 'delivery-1' })
    expect(ctx.rails.returnWorktree).toHaveBeenCalledTimes(1)
    expect(ctx.worktrees.freeze).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/wt/flow-1/ticket-7' }))
    expect(ctx.rails.launch).toHaveBeenCalledWith(expect.objectContaining({ flowId: flow.id, railIndex: 2, options: { aiEngine: 'claude', model: 'sonnet' } }))
    expect(relaunched.flow).toMatchObject({ state: 'handed_off', railIndex: 2 })
    expect(relaunched.flow.returnBriefing ?? null).toBeNull()
    expect(ctx.agent.open).toHaveBeenCalledTimes(1) // only the start: a relaunch never opens a Flow turn
  })

  it('relaunches on the Flow conversation\'s CURRENT engine, keeping the loop; the previous engine only when it cannot run', async () => {
    const ctx = setup()
    await handedOff(ctx)
    ctx.rails.stoppedDelivery.mockReturnValue({ railIndex: 2, options: { loopId: 'factory:flow-spec', aiEngine: 'claude', model: 'sonnet', reasoningEffort: 'medium' }, findings: null })
    ctx.agent.launchEngine.mockReturnValue({ aiEngine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
    ctx.rails.launch.mockClear()
    await ctx.service.relaunchFlow({ deliveryId: 'delivery-1' })
    expect(ctx.agent.launchEngine).toHaveBeenCalledWith('conv-1')
    expect(ctx.rails.launch).toHaveBeenCalledWith(expect.objectContaining({ options: { loopId: 'factory:flow-spec', aiEngine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' } }))

    const other = setup()
    await handedOff(other)
    other.rails.stoppedDelivery.mockReturnValue({ railIndex: 2, options: { loopId: 'factory:flow-spec', aiEngine: 'claude', model: 'sonnet' }, findings: null })
    other.agent.launchEngine.mockReturnValue(null)
    other.rails.launch.mockClear()
    await other.service.relaunchFlow({ deliveryId: 'delivery-1' })
    expect(other.rails.launch).toHaveBeenCalledWith(expect.objectContaining({ options: { loopId: 'factory:flow-spec', aiEngine: 'claude', model: 'sonnet' } }))
  })

  it('records the change the stopped run derived and lets the next freeze keep it (relaunch and Back to Flow)', async () => {
    const ctx = setup()
    await handedOff(ctx)
    const derivation = { change: 'ticket-7-addenda-3e1942024602', files: 2, explained: 1, unexplainedFiles: ['a.ts'], unexplainedOmitted: 0 }
    ctx.rails.stoppedDelivery.mockReturnValue({ railIndex: 2, options: {}, findings: null, derivation })
    ctx.worktrees.freeze.mockClear()
    await ctx.service.relaunchFlow({ deliveryId: 'delivery-1' })
    expect(ctx.worktrees.freeze).toHaveBeenCalledWith(expect.objectContaining({ allowedChanges: ['ticket-7-addenda-3e1942024602'] }))
    expect(ctx.repository.get('flow-1')?.derivedChanges).toEqual(['ticket-7-addenda-3e1942024602'])
  })

  it('reads the derived change of a Flow returned before it was recorded, and never trusts a malformed id', async () => {
    const ctx = setup()
    const flow = await handedOff(ctx)
    ctx.rails.stoppedDelivery.mockReturnValue({ railIndex: 2, options: {}, findings: null, derivation: null })
    await ctx.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(ctx.repository.get(flow.id)?.derivedChanges).toBeUndefined()
    // Legacy: the evidence is readable now (or was recorded before this field existed).
    ctx.rails.stoppedDelivery.mockReturnValue({ railIndex: 2, options: {}, findings: null, derivation: { change: 'kanban-board', files: 1, explained: 1, unexplainedFiles: [], unexplainedOmitted: 0 } })
    ctx.worktrees.freeze.mockClear()
    await ctx.service.handOffFlow({ flowId: flow.id, railIndex: 2 })
    expect(ctx.worktrees.freeze).toHaveBeenCalledWith(expect.objectContaining({ allowedChanges: ['kanban-board'] }))

    const other = setup()
    const second = await handedOff(other)
    other.rails.stoppedDelivery.mockReturnValue({ railIndex: 2, options: {}, findings: null, derivation: { change: '../escape', files: 1, explained: 1, unexplainedFiles: [], unexplainedOmitted: 0 } })
    other.worktrees.freeze.mockClear()
    await other.service.relaunchFlow({ deliveryId: 'delivery-1' })
    expect(other.worktrees.freeze).toHaveBeenCalledWith(expect.objectContaining({ allowedChanges: [] }))
    expect(other.repository.get(second.id)?.derivedChanges).toBeUndefined()
  })
})

describe('automatic return after a Flow → Spec run fails outright', () => {
  const crash = {
    railIndex: 2, options: {}, findings: null, derivation: null,
    failure: { stepId: null, cause: null, statusCode: 'implementation_failed', failureCode: 'settlement_interrupted', statusDetail: 'Programmatic workflow stopped before delivery' },
  }

  async function crashed(overrides: Partial<FlowPorts> = {}) {
    const conversation = { postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}) }
    const ctx = setup({ conversation, ...overrides })
    const flow = await ctx.service.startFlow(startInput)
    await ctx.service.handOffFlow({ flowId: flow.id, railIndex: 2 })
    ctx.rails.stoppedDelivery.mockReturnValue(crash)
    const runFailure = vi.fn(async () => ({ stepId: 'derive', cause: 'OpenSpec 1.14.3 required; found 1.4.1' }))
    ;(ctx.rails as FlowPorts['rails']).runFailure = runFailure
    ctx.publication.deliveryState.mockReturnValue({ delivered: false, crashed: true } as { delivered: boolean })
    return { ...ctx, flow, conversation, runFailure }
  }

  it('returns the worktree, reopens the session and briefs the Flow agent with the step and the cause', async () => {
    const ctx = await crashed()
    const returned = await ctx.service.observeDelivery('delivery-1')
    expect(returned).toMatchObject({ id: ctx.flow.id, state: 'active', deliveryId: 'delivery-1' })
    expect(ctx.rails.returnWorktree).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'delivery-1', detail: expect.stringContaining('the run failed') }))
    expect(returned!.returnBriefing).toContain('failed at its "derive" step')
    expect(returned!.returnBriefing).toContain('Error: OpenSpec 1.14.3 required; found 1.4.1')
    expect(returned!.returnBriefing).toContain('Codes: implementation_failed, settlement_interrupted')
    expect(returned!.returnBriefing).toContain('tell the person exactly what to change')
    const failure = { stepId: 'derive', cause: 'OpenSpec 1.14.3 required; found 1.4.1', statusCode: 'implementation_failed', failureCode: 'settlement_interrupted', statusDetail: 'Programmatic workflow stopped before delivery' }
    expect(ctx.conversation.postReturnCard).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'delivery-1', findings: null, failure }))
    expect(ctx.conversation.startReturnTurn).toHaveBeenCalledWith({ conversationId: 'conv-1', flowId: ctx.flow.id, deliveryId: 'delivery-1', failure })
  })

  it('is idempotent across repeated observations and restarts', async () => {
    const ctx = await crashed()
    await Promise.all([ctx.service.observeDelivery('delivery-1'), ctx.service.observeDelivery('delivery-1')])
    await ctx.service.observeDelivery('delivery-1')
    await ctx.service.replaySettlement()
    expect(ctx.rails.returnWorktree).toHaveBeenCalledTimes(1)
    expect(ctx.repository.get(ctx.flow.id)?.state).toBe('active')
  })

  it('a restart returns a Flow whose run failed while the app was down', async () => {
    const ctx = await crashed()
    await expect(ctx.service.replaySettlement()).resolves.toBe(1)
    expect(ctx.repository.get(ctx.flow.id)).toMatchObject({ state: 'active', deliveryId: 'delivery-1' })
  })

  it('never fires for requested changes, a delivered run, or a Flow no longer on that delivery', async () => {
    const review = await crashed()
    review.publication.deliveryState.mockReturnValue({ delivered: false, crashed: false } as { delivered: boolean })
    await expect(review.service.observeDelivery('delivery-1')).resolves.toBeNull()
    expect(review.rails.returnWorktree).not.toHaveBeenCalled()

    // Relaunched: the Flow moved on to a new delivery; the old one is ignored.
    const relaunched = await crashed()
    relaunched.rails.launch.mockImplementationOnce(async ({ flowId, railIndex }: { flowId: string; railIndex: number }) => {
      const current = relaunched.repository.get(flowId)!
      relaunched.repository.save(transition(current, { type: 'handed-off', railIndex, deliveryId: 'delivery-2', headSha: current.headSha!, now: 't' }).session)
      return { loopRunIds: ['run-2'], deliveryId: 'delivery-2' }
    })
    await relaunched.service.relaunchFlow({ deliveryId: 'delivery-1' })
    relaunched.rails.returnWorktree.mockClear()
    await expect(relaunched.service.observeDelivery('delivery-1')).resolves.toBeNull()
    expect(relaunched.rails.returnWorktree).not.toHaveBeenCalled()

    // Discarded before the hand-off ever happened: nothing to return.
    const discarded = setup()
    const flow = await discarded.service.startFlow(startInput)
    await discarded.service.discardFlow(flow.id)
    discarded.publication.deliveryState.mockReturnValue({ delivered: false, crashed: true } as { delivered: boolean })
    await expect(discarded.service.observeDelivery('delivery-1')).resolves.toBeNull()
  })

  it('a refused automatic return only logs; the card keeps the manual Back to Flow', async () => {
    const ctx = await crashed()
    ctx.worktrees.exists.mockReturnValue(false)
    await expect(ctx.service.observeDelivery('delivery-1')).resolves.toBeNull()
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining('automatic return of delivery delivery-1 failed'))
    expect(ctx.repository.get(ctx.flow.id)?.state).toBe('handed_off')
  })

  it('briefs with the delivery codes when the runtime cannot tell the step', async () => {
    const ctx = await crashed()
    ctx.runFailure.mockRejectedValueOnce(new Error('runtime gone'))
    const returned = await ctx.service.observeDelivery('delivery-1')
    expect(returned!.returnBriefing).toContain('The Flow → Spec run failed before delivery')
    expect(returned!.returnBriefing).toContain('Delivery detail: Programmatic workflow stopped before delivery')
  })
})

describe('Flow mode boundaries (history lines)', () => {
  const conversationPort = () => ({ postReturnCard: vi.fn(), startReturnTurn: vi.fn(async () => {}), postBoundary: vi.fn() })

  it('enters on start, leaves on hand-off, enters again on Back to Flow and leaves on discard', async () => {
    const conversation = conversationPort()
    const ctx = setup({ conversation })
    const flow = await ctx.service.startFlow(startInput)
    expect(conversation.postBoundary).toHaveBeenLastCalledWith({ conversationId: 'conv-1', flowId: flow.id, event: 'entered', reason: 'started', branch: 'feat/7-idea' })
    await ctx.service.handOffFlow({ flowId: flow.id, railIndex: 2 })
    expect(conversation.postBoundary).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'left', reason: 'handed_off' }))
    // The idempotent repeat of the same hand-off posts nothing new.
    await ctx.service.handOffFlow({ flowId: flow.id, railIndex: 2 })
    expect(conversation.postBoundary).toHaveBeenCalledTimes(2)
    await ctx.service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(conversation.postBoundary).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'entered', reason: 'returned' }))
    expect(ctx.service.listOpen().map((open) => open.id)).toEqual([flow.id])
    await ctx.service.discardFlow(flow.id)
    expect(ctx.service.listOpen()).toEqual([])
    expect(conversation.postBoundary).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'left', reason: 'discarded' }))
    expect(conversation.postBoundary).toHaveBeenCalledTimes(4)
  })

  it('a failed start or hand-off posts no boundary, and a throwing port never fails the transition', async () => {
    const conversation = conversationPort()
    const ctx = setup({ conversation })
    ctx.worktrees.reserve.mockRejectedValueOnce(new Error('no worktree'))
    await expect(ctx.service.startFlow(startInput)).rejects.toThrow('no worktree')
    expect(conversation.postBoundary).not.toHaveBeenCalled()

    const throwing = setup({ conversation: { ...conversationPort(), postBoundary: vi.fn(() => { throw new Error('db locked') }) } })
    await expect(throwing.service.startFlow(startInput)).resolves.toMatchObject({ state: 'active' })
  })
})

describe('Flow from an existing spec', () => {
  const fromSpec = { conversationId: 'conv-1', ticketId: 12 }

  it('labels the existing spec instead of creating a placeholder, and seeds the first turn with it', async () => {
    const { service, tickets, worktrees, repository } = setup()
    const flow = await service.startFlow(fromSpec)
    expect(tickets.createPlaceholder).not.toHaveBeenCalled()
    expect(tickets.adoptExisting).toHaveBeenCalledWith({ ticketId: 12, flowId: 'flow-1', conversationId: 'conv-1', startedAt: expect.any(String) })
    expect(worktrees.reserve).toHaveBeenCalledWith({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 12 })
    expect(flow).toMatchObject({ state: 'active', ticketId: 12, specOrigin: 'existing' })
    // The spec (with its acceptance criteria / Contract Layer and non-goals) rides the next Flow turn once.
    expect(flow.returnBriefing).toContain('[Flow started from spec #12')
    expect(flow.returnBriefing).toContain('## Spec #12: Calmer onboarding')
    expect(flow.returnBriefing).toContain('## Contract Layer')
    expect(flow.returnBriefing).toContain('- No analytics')
    await service.briefingDelivered('flow-1')
    expect(repository.get('flow-1')?.returnBriefing ?? null).toBeNull()
  })

  it('refuses a spec that is not free to work on before writing anything', async () => {
    const { service, tickets, repository } = setup()
    tickets.inspectExisting.mockReturnValueOnce({ spec: null, blocker: { code: 'spec_running', message: 'Spec #12 is running on Rail 2' } })
    await expect(service.startFlow(fromSpec)).rejects.toMatchObject({ code: 'spec_running' })
    tickets.inspectExisting.mockReturnValueOnce({ spec: null, blocker: { code: 'spec_not_found', message: 'gone' } })
    await expect(service.startFlow(fromSpec)).rejects.toBeInstanceOf(FlowValidationError)
    await expect(service.startFlow({ conversationId: 'conv-1', ticketId: -3 })).rejects.toMatchObject({ code: 'invalid_ticket_id' })
    expect(repository.rows.size).toBe(0)
    expect(tickets.adoptExisting).not.toHaveBeenCalled()
  })

  it('runs in the one repository the spec targets', async () => {
    const repositories = { list: () => [{ id: 'web', name: 'web', isPrimary: true, kind: 'git' as const }, { id: 'api', name: 'api', isPrimary: false, kind: 'git' as const }] }
    const ctx = setup({ repositories })
    ctx.tickets.inspectExisting.mockReturnValueOnce({ spec: { id: 12, title: 'T', description: 'D', status: 'todo', nonGoals: [], repositoryIds: ['api'], addenda: '' }, blocker: null })
    const flow = await ctx.service.startFlow(fromSpec)
    expect(flow.repositoryId).toBe('api')
  })

  it('discard restores the spec (never deletes it) and a failed start compensates the same way', async () => {
    const { service, tickets, worktrees, agent } = setup()
    await service.startFlow(fromSpec)
    await service.discardFlow('flow-1')
    expect(tickets.deletePlaceholder).not.toHaveBeenCalled()
    expect(tickets.restoreExisting).toHaveBeenCalledWith(12, 'flow-1')
    expect(worktrees.release).toHaveBeenCalled()

    const failing = setup()
    failing.agent.open.mockRejectedValueOnce(new Error('boom'))
    await expect(failing.service.startFlow(fromSpec)).rejects.toThrow('boom')
    expect(failing.tickets.restoreExisting).toHaveBeenCalledWith(12, 'flow-1')
    expect(failing.tickets.deletePlaceholder).not.toHaveBeenCalled()
    expect(failing.repository.get('flow-1')?.state).toBe('discarded')
    void agent
  })

  it('settlement keeps the original as a comment, then rewrites the spec entirely from what was built', async () => {
    const ctx = setup()
    const order: string[] = []
    ctx.tickets.read.mockReturnValue({ title: 'Calmer onboarding', description: 'ORIGINAL BODY', status: 'on_review' })
    ctx.tickets.preserveOriginal.mockImplementation(() => { order.push('preserve') })
    ctx.publication.rewriteSpec.mockImplementation(async () => { order.push('rewrite'); return { ok: true } })
    await ctx.service.startFlow(fromSpec)
    await ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    ctx.jira.linked.mockReturnValue(false)
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    expect(order).toEqual(['preserve', 'rewrite'])
    expect(ctx.tickets.preserveOriginal).toHaveBeenCalledWith(12, 'flow-1')
    // The rewritten spec covers the addenda the Flow was shown: applied, once.
    expect(ctx.tickets.applyAddenda).toHaveBeenCalledTimes(1)
    expect(ctx.tickets.applyAddenda).toHaveBeenCalledWith(12, 'flow-1', 'delivery-1')
    const text = ctx.publication.rewriteSpec.mock.calls[0]![0].text
    expect(text).toContain('Rewrite the spec ENTIRELY from what was built')
    expect(text).toContain('ORIGINAL BODY')
    // Unlinked spec: today's create-at-settlement.
    expect(ctx.jira.enqueueCreate).toHaveBeenCalledWith(12, 'flow:flow-1:create')
    expect(ctx.jira.enqueueUpdate).not.toHaveBeenCalled()
  })

  it('a spec already linked to Jira updates THAT issue (idempotent key), never creates a duplicate, then moves it to review', async () => {
    const ctx = setup()
    await ctx.service.startFlow(fromSpec)
    await ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    ctx.jira.linked.mockReturnValue(true)
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    expect(ctx.jira.enqueueUpdate).toHaveBeenCalledWith(12, 'flow:flow-1:update')
    expect(ctx.jira.enqueueCreate).not.toHaveBeenCalled()
    expect(ctx.jira.enqueueReview).toHaveBeenCalledWith(12, 'delivery-1')
    const create = ctx.effects.list('flow-1').find((effect) => effect.kind === 'jira-create')!
    expect(create).toMatchObject({ status: 'done', note: 'updated' })
    // Replays never enqueue another update.
    await ctx.service.replaySettlement()
    expect(ctx.jira.enqueueUpdate).toHaveBeenCalledTimes(1)
  })

  it('retries a Jira update that could not be enqueued, and falls back to create when the link went away', async () => {
    const ctx = setup()
    await ctx.service.startFlow(fromSpec)
    await ctx.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    ctx.jira.enqueueUpdate.mockReturnValueOnce('failed')
    await ctx.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await ctx.service.runSettlement('flow-1')
    expect(ctx.effects.list('flow-1').find((effect) => effect.kind === 'jira-create')).toMatchObject({ status: 'pending', note: 'enqueue_failed' })

    const gone = setup()
    await gone.service.startFlow(fromSpec)
    await gone.service.handOffFlow({ flowId: 'flow-1', railIndex: 2 })
    gone.jira.enqueueUpdate.mockReturnValueOnce('not_linked')
    await gone.service.onFlowDelivered({ flowId: 'flow-1', deliveryId: 'delivery-1' })
    await gone.service.runSettlement('flow-1')
    expect(gone.jira.enqueueCreate).toHaveBeenCalledWith(12, 'flow:flow-1:create')
  })
})
