import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb, recordAgentInvocation } from '../../../desktop-db'
import { __resetFetchOriginCache } from '../../../integration-branch'
import type { ProjectContext } from '../../../project-registry'
import { createAgentConversation } from '../../agents/runtime/agent-store'
import { isolatedWorktreesRoot } from '../../delivery/runtime/isolated-worktree'
import { setRailTickets } from '../../delivery/runtime/rails-store'
import { FLOW_SYSTEM_PROMPT } from '../../missions/runtime/agent-flow-prompt'
import { isFlowHeldTicket, readStore } from '../../specs/runtime/ticket-store'
import { ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import { FlowConflictError, FlowLaunchRejectedError, FlowUnavailableError, FlowValidationError, type FlowSession } from '..'
import { createFlowService } from '../application'
import { registerFlowHttp } from '../adapters/http'
import { changeNameFromArchive, createFlowHandOffAuthority, createFlowPorts, createFlowPublication, createFlowTickets, createFlowTurnContext, createFlowWorktrees, flowConversationSummary, readDerivedChange } from '../adapters/bindings'
import { addAgentMessage } from '../../agents/runtime/agent-store'
import { defaultGitRunner } from '../../../worktree-manager'
import { createSqliteFlowEffectsStore, createSqliteFlowRepository } from '../adapters/sqlite'

const ORIGINAL_HOME = process.env.SPECRAILS_REGISTRY_HOME
let tmp: string
let repo: string
const dbs: DbInstance[] = []

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
}

beforeEach(() => {
  __resetFetchOriginCache()
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-bindings-')))
  process.env.SPECRAILS_REGISTRY_HOME = path.join(tmp, 'home')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  // CI runners have no global git identity; the freeze commit runs through the
  // production git runner, so give the repository (and its worktrees) one.
  git(['config', 'user.name', 't'])
  git(['config', 'user.email', 't@t'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
})

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  if (ORIGINAL_HOME === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = ORIGINAL_HOME
  fs.rmSync(tmp, { recursive: true, force: true })
})

function context(): ProjectContext {
  const db = initDb(':memory:')
  const desktopDb = initDesktopDb(':memory:')
  dbs.push(db, desktopDb)
  const project = { id: 'proj-1', slug: 'flowproj', path: repo, provider: 'claude' }
  return {
    project,
    db,
    desktopDb,
    broadcast: vi.fn(),
    ticketWatcher: { notifyDesktopWrite: vi.fn() },
    getTicketSpec: (id: number) => {
      const ticket = readStore(ticketStorePathForProject(project)).tickets[String(id)]
      return ticket ? { title: ticket.title, description: ticket.description, labels: ticket.labels } : undefined
    },
  } as unknown as ProjectContext
}

describe('placeholder spec binding', () => {
  it('creates an in_progress Flow spec, relabels it and deletes only Flow specs', () => {
    const ctx = context()
    const tickets = createFlowTickets(ctx, { now: () => '2026-10-21T10:00:00.000Z' })
    const id = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Kanban', description: 'Try a kanban', startedAt: '2026-10-21T10:00:00.000Z' })
    const store = readStore(ticketStorePathForProject(ctx.project))
    const ticket = store.tickets[String(id)]
    expect(store.schema_version).toBe('1.5')
    expect(ticket).toMatchObject({
      title: 'Kanban', description: 'Try a kanban', status: 'in_progress', priority: 'medium', source: 'flow',
      metadata: { flow: { conversationId: 'conv-1', flowId: 'flow-1', worktreeId: 'flow-1', startedAt: '2026-10-21T10:00:00.000Z', state: 'active' } },
    })
    expect(isFlowHeldTicket(ticket)).toBe(true)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_created', projectId: 'proj-1' }))
    tickets.setFlowState(id, 'paused')
    expect(readStore(ticketStorePathForProject(ctx.project)).tickets[String(id)].metadata.flow?.state).toBe('paused')
    tickets.setFlowState(id, 'delivered')
    expect(isFlowHeldTicket(readStore(ticketStorePathForProject(ctx.project)).tickets[String(id)])).toBe(false)
    tickets.setFlowState(999, 'paused')
    tickets.deletePlaceholder(id)
    expect(readStore(ticketStorePathForProject(ctx.project)).tickets[String(id)]).toBeUndefined()
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_deleted', ticketId: id }))
    tickets.deletePlaceholder(id)
  })
})

describe('worktree reservation binding (real git)', () => {
  it('reserves a Flow-owned worktree, summarizes the diff, freezes HEAD and releases it', async () => {
    const ctx = context()
    const tickets = createFlowTickets(ctx)
    const ticketId = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Try a board', description: 'x', startedAt: 't' })
    const worktrees = createFlowWorktrees(ctx, { providerFor: () => 'claude' })
    const reserved = await worktrees.reserve({ flowId: 'flow-1', conversationId: 'conv-1', ticketId })
    expect(reserved.worktreePath.startsWith(path.join(isolatedWorktreesRoot('flowproj'), 'flow-1'))).toBe(true)
    expect(reserved.headSha).toBe(git(['rev-parse', 'HEAD']))
    expect(reserved.baseSha).toBe(reserved.headSha)
    expect(worktrees.exists(reserved.worktreePath)).toBe(true)

    fs.writeFileSync(path.join(reserved.worktreePath, 'README.md'), 'hello\nworld\n')
    fs.writeFileSync(path.join(reserved.worktreePath, 'board.ts'), 'export const board = 1\n')
    const diff = await worktrees.diff({ worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, branch: reserved.branch })
    expect(diff.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'board.ts', status: 'untracked', additions: null, deletions: null },
    ])
    expect(diff.totals).toEqual({ files: 2, additions: 1, deletions: 0 })

    const frozen = await worktrees.freeze({ flowId: 'flow-1', conversationId: 'conv-1', ticketId, worktreePath: reserved.worktreePath, baseSha: reserved.baseSha })
    expect(frozen.headSha).toBe(git(['rev-parse', 'HEAD'], reserved.worktreePath))
    expect(frozen.headSha).not.toBe(reserved.headSha)
    expect(git(['status', '--porcelain', '--', 'README.md', 'board.ts'], reserved.worktreePath)).toBe('')
    expect(git(['log', '-1', '--format=%s'], reserved.worktreePath)).toBe(`Flow #${ticketId}: Try a board`)

    await worktrees.release({ flowId: 'flow-1', ticketId, worktreePath: reserved.worktreePath, branch: reserved.branch })
    expect(fs.existsSync(reserved.worktreePath)).toBe(false)
    expect(git(['branch', '--list', reserved.branch])).toBe('')
    expect(worktrees.exists(reserved.worktreePath)).toBe(false)
  })

  it('refuses to remove anything outside the Flow mount root and tolerates an unrecorded mount', async () => {
    const ctx = context()
    const worktrees = createFlowWorktrees(ctx, { providerFor: () => 'claude' })
    await expect(worktrees.release({ flowId: 'flow-1', ticketId: 1, worktreePath: repo, branch: 'main' })).rejects.toThrow(/not a Flow-owned worktree/)
    await expect(worktrees.release({ flowId: 'flow-2', ticketId: 1, worktreePath: null, branch: null })).resolves.toBeUndefined()
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })
})

describe('Flow start on a repository with no commits (real git)', () => {
  it('answers 409 repository_has_no_commits and leaves no active Flow, spec, branch or worktree', async () => {
    const empty = path.join(tmp, 'empty-repo')
    fs.mkdirSync(empty)
    git(['init', '-q', '-b', 'main'], empty)
    const base = context()
    const ctx = { ...base, project: { ...base.project, slug: 'emptyproj', path: empty } } as unknown as ProjectContext
    const repository = createSqliteFlowRepository(ctx.db)
    const ports = createFlowPorts({
      ctx, repository, effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call: vi.fn() } as never,
      agentHost: () => ({ assertFlowSupport: vi.fn(async () => {}), closeFlowSession: vi.fn(async () => {}) }) as never,
      availability: async () => ({ available: true, reason: 'ok', missing: [] }),
      clock: { now: () => '2026-10-22T10:00:00.000Z' },
    })
    const service = createFlowService(ports, { warn: vi.fn() })
    const server = express()
    server.use(express.json())
    registerFlowHttp(server as unknown as express.Router, () => service)
    const conversation = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'proj-1' })

    const response = await request(server).post('/proj-1/flow').send({ conversationId: conversation.id, idea: 'Build a kanban board', flowId: 'flow-empty' })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'repository_has_no_commits',
      detail: 'This repository has no commits yet. Make an initial commit so Specrails can create an isolated worktree.',
    })
    expect(repository.findOpenByConversation(conversation.id)).toBeFalsy()
    expect(repository.get('flow-empty')?.state).toBe('discarded')
    expect(Object.keys(readStore(ticketStorePathForProject(ctx.project)).tickets)).toEqual([])
    expect(git(['for-each-ref', 'refs/heads'], empty)).toBe('')
    expect(fs.existsSync(path.join(isolatedWorktreesRoot('emptyproj'), 'flow-empty'))).toBe(false)
  })
})

describe('Flow port composition', () => {
  function ports(overrides: { agentHost?: ReturnType<typeof vi.fn> | null; internal?: ReturnType<typeof vi.fn> } = {}) {
    const ctx = context()
    const repository = createSqliteFlowRepository(ctx.db)
    const host = { assertFlowSupport: vi.fn(async () => {}), closeFlowSession: vi.fn(async () => {}) }
    const call = overrides.internal ?? vi.fn(async () => ({ ok: true, status: 202, body: { loopRunIds: ['run-1'], prDeliveryId: 'd-1' } }))
    const bound = createFlowPorts({
      ctx, repository, effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call } as never,
      agentHost: () => (overrides.agentHost === null ? null : host) as never,
      availability: async () => ({ available: true, reason: 'ok', missing: [] }),
      clock: { now: () => 'now' },
    })
    return { ctx, bound, host, call }
  }

  it('checks that the mission is pinned to the project and the host supports Flow', async () => {
    const { ctx, bound, host } = ports()
    await expect(bound.agent.assertReady({ conversationId: 'missing' })).rejects.toMatchObject({ code: 'conversation_not_found' })
    const other = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'other' })
    await expect(bound.agent.assertReady({ conversationId: other.id })).rejects.toBeInstanceOf(FlowValidationError)
    const pinned = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'proj-1' })
    await expect(bound.agent.assertReady({ conversationId: pinned.id })).resolves.toBeUndefined()
    host.assertFlowSupport.mockRejectedValueOnce(new Error('no flowSessions'))
    await expect(bound.agent.assertReady({ conversationId: pinned.id })).rejects.toBeInstanceOf(FlowUnavailableError)
    await expect(bound.agent.open({ flowId: 'f', conversationId: pinned.id, worktreePath: '/wt' })).resolves.toEqual({ coreSessionId: 'flow:f' })
    await bound.agent.close({ flowId: 'f', conversationId: pinned.id, coreSessionId: 'flow:f' })
    expect(host.closeFlowSession).toHaveBeenCalledWith(pinned.id, 'flow:f', 'flow_closed')
  })

  it('reports Flow unavailable without the mission host', async () => {
    const { ctx, bound } = ports({ agentHost: null })
    const pinned = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'proj-1' })
    await expect(bound.agent.assertReady({ conversationId: pinned.id })).rejects.toBeInstanceOf(FlowUnavailableError)
    await expect(bound.agent.close({ flowId: 'f', conversationId: pinned.id, coreSessionId: 'flow:f' })).resolves.toBeUndefined()
  })

  it('launches through the rails authority with flowId, assigning a free rail', async () => {
    const { ctx, bound, call } = ports()
    const result = await bound.rails.launch({ flowId: 'flow-1', conversationId: 'conv-1', ticketId: 7, railIndex: 1, options: { loopId: 'factory:flow-spec', aiEngine: 'codex', model: 'gpt', reasoningEffort: 'high' } })
    expect(call).toHaveBeenNthCalledWith(1, 'PUT', '/projects/proj-1/rails/1/tickets', { ticketIds: [7] })
    expect(call).toHaveBeenNthCalledWith(2, 'POST', '/projects/proj-1/rails/1/launch', {
      flowId: 'flow-1', originSurface: 'agent-chat', originConversationId: 'conv-1', loopId: 'factory:flow-spec', aiEngine: 'codex', model: 'gpt', reasoning_effort: 'high',
    })
    expect(result).toEqual({ loopRunIds: ['run-1'], deliveryId: 'd-1' })
    setRailTickets(ctx.db, 2, [3, 4], 'implement', null)
    await expect(bound.rails.launch({ flowId: 'flow-1', conversationId: 'c', ticketId: 7, railIndex: 2, options: {} })).rejects.toBeInstanceOf(FlowConflictError)
  })

  it('keeps the launch authority status and code on a refusal', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: {} })
      .mockResolvedValueOnce({ ok: false, status: 409, body: { error: 'flow_worktree_mismatch', detail: 'HEAD moved' } })
    const { bound } = ports({ internal: call })
    const error = await bound.rails.launch({ flowId: 'flow-1', conversationId: 'c', ticketId: 7, railIndex: 0, options: {} }).catch((caught) => caught)
    expect(error).toBeInstanceOf(FlowLaunchRejectedError)
    expect(error).toMatchObject({ status: 409, code: 'flow_worktree_mismatch', message: 'HEAD moved' })
    // Without a choice the hand-off asks for Flow -> Spec, never the rail's default loop.
    expect(call).toHaveBeenLastCalledWith('POST', '/projects/proj-1/rails/0/launch', expect.objectContaining({ loopId: 'factory:flow-spec' }))
    const assignFails = ports({ internal: vi.fn().mockResolvedValueOnce({ ok: false, status: 500, body: null }) })
    await expect(assignFails.bound.rails.launch({ flowId: 'f', conversationId: 'c', ticketId: 7, railIndex: 0, options: {} })).rejects.toMatchObject({ status: 500, code: 'http_500' })
  })

  it('sums only billed Flow usage and broadcasts project-scoped state', () => {
    const { ctx, bound } = ports()
    const base = { conversation_id: 'conv-1', provider: 'claude', status: 'success' as const, finished_at: null }
    recordAgentInvocation(ctx.desktopDb, { ...base, id: 'a', surface: 'flow', started_at: '2026-10-21T10:01:00Z', total_cost_usd: 0.4, tokens_in: 10, tokens_out: 5 })
    recordAgentInvocation(ctx.desktopDb, { ...base, id: 'b', surface: 'flow', started_at: '2026-10-21T10:02:00Z', total_cost_usd: 0.9, total_cost_usd_estimated: true, tokens_in: 1, tokens_out: 1 })
    recordAgentInvocation(ctx.desktopDb, { ...base, id: 'c', started_at: '2026-10-21T10:03:00Z', total_cost_usd: 5 })
    recordAgentInvocation(ctx.desktopDb, { ...base, id: 'd', surface: 'flow', started_at: '2026-10-21T09:00:00Z', total_cost_usd: 7 })
    expect(bound.usage.costSoFar({ conversationId: 'conv-1', from: '2026-10-21T10:00:00Z', to: null })).toEqual({ costUsd: 0.4, turns: 2, unpricedTurns: 1, tokensIn: 11, tokensOut: 6 })
    bound.notifier.changed({ id: 'flow-1', conversationId: 'conv-1' } as FlowSession)
    expect(ctx.broadcast).toHaveBeenCalledWith({ type: 'flow.state', projectId: 'proj-1', conversationId: 'conv-1', flowId: 'flow-1', flow: { id: 'flow-1', conversationId: 'conv-1' }, timestamp: 'now' })
    expect(bound.ids()).toMatch(/\w+/)
  })
})

describe('missions FlowTurnContext binding', () => {
  const session = (patch: Partial<FlowSession>): FlowSession => ({
    id: 'flow-1', conversationId: 'conv-1', ticketId: 7, state: 'active', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7',
    baseSha: null, headSha: null, coreSessionId: 'flow:flow-1', railIndex: null, deliveryId: null, step: null, createdAt: 't', updatedAt: 't', ...patch,
  })

  it('returns the Flow turn only for an active Flow of the pinned project', () => {
    const flows = new Map<string, FlowSession | null>([['proj-1', session({})]])
    const context = createFlowTurnContext({
      conversationProject: (id) => (id === 'unpinned' ? null : 'proj-1'),
      flowServiceFor: (projectId) => (projectId === 'proj-1' ? { getByConversation: () => flows.get('proj-1') ?? null } : null),
    })
    expect(context.forConversation('conv-1')).toEqual({
      flowId: 'flow-1', cwd: '/wt/flow-1/ticket-7', branch: 'feat/7', coreSessionId: 'flow:flow-1',
      systemPrompt: FLOW_SYSTEM_PROMPT, policy: { permissions: 'bypass', tools: { mode: 'default' } },
    })
    expect(context.forConversation('unpinned')).toBeNull()
    for (const patch of [{ state: 'paused' as const }, { step: 'handoff:freeze' as const }, { coreSessionId: null }, { state: 'handed_off' as const }]) {
      flows.set('proj-1', session(patch))
      expect(context.forConversation('conv-1')).toBeNull()
    }
    flows.set('proj-1', null)
    expect(context.forConversation('conv-1')).toBeNull()
  })

  it('offers Flow only when available, pinned and no Flow is open in the conversation', async () => {
    let available = true
    const flows = new Map<string, ReturnType<typeof session> | null>([['proj-1', null]])
    const context = createFlowTurnContext({
      conversationProject: (id) => (id === 'unpinned' ? null : 'proj-1'),
      flowServiceFor: () => ({ getByConversation: () => flows.get('proj-1') ?? null }),
      availability: async () => ({ available }),
    })
    expect(await context.offerable!('conv-1')).toBe(true)
    expect(await context.offerable!('unpinned')).toBe(false)
    flows.set('proj-1', session({ state: 'paused' }))
    expect(await context.offerable!('conv-1')).toBe(false)
    flows.set('proj-1', session({ state: 'handed_off' }))
    expect(await context.offerable!('conv-1')).toBe(true)
    available = false
    expect(await context.offerable!('conv-1')).toBe(false)
    const noGate = createFlowTurnContext({ conversationProject: () => 'proj-1', flowServiceFor: () => ({ getByConversation: () => null }) })
    expect(await noGate.offerable!('conv-1')).toBe(false)
  })
})

describe('settlement publication bindings', () => {
  function commitDerived(): { base: string; head: string } {
    const base = git(['rev-parse', 'HEAD'])
    fs.mkdirSync(path.join(repo, 'openspec/changes/archive/2026-10-21-kanban-board/specs/board'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'openspec/changes/archive/2026-10-21-kanban-board/proposal.md'), '## Why\nA board\n')
    fs.writeFileSync(path.join(repo, 'openspec/changes/archive/2026-10-21-kanban-board/design.md'), '## Blast radius\n- src/board.ts\n')
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, 'src/board.ts'), 'export const board = 1\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'flow'])
    return { base, head: git(['rev-parse', 'HEAD']) }
  }

  it('reads the archived derived change, its name and a diffstat from the delivered commit', async () => {
    const { base, head } = commitDerived()
    const derived = await readDerivedChange(defaultGitRunner, repo, { ref: head, baseSha: base, changeName: null })
    expect(derived).toMatchObject({ changeName: 'kanban-board', proposal: '## Why\nA board\n', design: '## Blast radius\n- src/board.ts\n' })
    expect(derived.diffstat).toContain('src/board.ts')
    expect(changeNameFromArchive('2026-10-21-x-y')).toBe('x-y')
    // Nothing derived on the branch: null texts (the settlement retries, then keeps the placeholder).
    await expect(readDerivedChange(defaultGitRunner, repo, { ref: head, baseSha: head, changeName: null })).resolves.toMatchObject({ proposal: null, design: null })
  })

  it('labels the spec delivered, records the change name and moves it to review once', () => {
    const ctx = context()
    const tickets = createFlowTickets(ctx, { now: () => '2026-10-21T10:00:00.000Z' })
    const id = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Kanban', description: 'Try a kanban', startedAt: '2026-10-21T10:00:00.000Z' })
    tickets.markDelivered(id, { openspecChangeName: 'kanban-board' })
    const ticket = readStore(ticketStorePathForProject(ctx.project)).tickets[String(id)]!
    expect(ticket).toMatchObject({ status: 'on_review', metadata: { openspecChangeName: 'kanban-board', flow: { state: 'delivered' } } })
    expect(isFlowHeldTicket(ticket)).toBe(false)
    const calls = vi.mocked(ctx.broadcast).mock.calls.length
    tickets.markDelivered(id, { openspecChangeName: null })
    expect(vi.mocked(ctx.broadcast).mock.calls.length).toBe(calls)
    expect(tickets.read(id)).toMatchObject({ title: 'Kanban', status: 'on_review' })
    expect(tickets.read(999)).toBeNull()
  })

  it('rewrites in place with the Contract Layer awaited, and maps Jira through the sync manager', async () => {
    const ctx = context()
    const jira = { isActive: vi.fn(() => true), enqueuePromote: vi.fn(() => 'enqueued'), onRailReview: vi.fn() }
    ;(ctx as unknown as { jiraSyncManager: unknown }).jiraSyncManager = jira
    const generate = vi.fn(async () => ({ ok: true as const, requestId: 'r', ticket: {} as never, kind: 'rewritten' as const, spec: {} as never }))
    const publication = createFlowPublication(ctx, { generate })
    await expect(publication.rewriteSpec({ ticketId: 3, text: 'derived' })).resolves.toEqual({ ok: true })
    expect(generate.mock.calls[0]![1]).toMatchObject({ ticketId: 3, text: 'derived', surface: 'flow', provider: 'claude', contractRefine: { await: true } })
    expect(publication.deliveryState('unknown')).toBeNull()
    expect(publication.jira.connected()).toBe(true)
    expect(publication.jira.enqueueCreate(3, 'flow:f:create')).toBe('enqueued')
    expect(jira.enqueuePromote).toHaveBeenCalledWith(3, 'flow:f:create')
    expect(publication.jira.linked(3)).toBe(false)
    publication.jira.enqueueReview(3, 'delivery-1')
    expect(jira.onRailReview).toHaveBeenCalledWith([3], 'delivery-1')
  })

  it('summarizes the Flow conversation for the hand-off (user messages and decisions)', () => {
    const ctx = context()
    const conversation = createAgentConversation(ctx.desktopDb, { title: 'm' } as never)
    addAgentMessage(ctx.desktopDb, { conversationId: conversation.id, role: 'user', content: 'Build a board' })
    addAgentMessage(ctx.desktopDb, { conversationId: conversation.id, role: 'assistant', content: 'ok\nDecision: three columns' })
    const summary = flowConversationSummary(ctx.desktopDb, { conversationId: conversation.id, idea: 'Kanban', from: '1970-01-01', to: null })
    expect(summary).toContain('transcriptTurns: 1')
    expect(summary).toContain('- three columns')
    const repository = createSqliteFlowRepository(ctx.db)
    repository.insert({ id: 'flow-1', conversationId: conversation.id, ticketId: 7, state: 'paused', branch: 'b', worktreePath: '/wt', baseSha: null, headSha: 'a'.repeat(40), coreSessionId: null, railIndex: 1, deliveryId: null, step: 'handoff:launch', createdAt: 't', updatedAt: 't' })
    const authority = createFlowHandOffAuthority(repository, { now: () => 't' }, undefined, () => summary)
    expect(authority.resolve('flow-1').summary).toBe(summary)
    const failing = createFlowHandOffAuthority(repository, { now: () => 't' }, undefined, () => { throw new Error('db') })
    expect(failing.resolve('flow-1').summary).toBe('')
  })
})
