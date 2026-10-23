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
import { isFlowHeldTicket, mutateStore, readStore, type Ticket } from '../../specs/runtime/ticket-store'
import { ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import { FlowConflictError, FlowLaunchRejectedError, FlowUnavailableError, FlowValidationError, type FlowSession } from '..'
import { createFlowService } from '../application'
import { registerFlowHttp } from '../adapters/http'
import { FLOW_FAILURE_RETURN_TURN_TEXT, FLOW_RETURN_TURN_TEXT, changeNameFromArchive, railOfTicket, createFlowHandOffAuthority, deliveryFailureOf, isCrashedFlowDelivery, createFlowPorts, createFlowPublication, createFlowTickets, createFlowTurnContext, createFlowWorktrees, flowConversationSummary, readDerivedChange } from '../adapters/bindings'
import { addAgentMessage } from '../../agents/runtime/agent-store'
import { defaultGitRunner } from '../../../worktree-manager'
import { createSqliteFlowEffectsStore, createSqliteFlowRepository } from '../adapters/sqlite'
import { flowDerivationChangeId } from '../../loops/runtime/loop-executors'
import { setDetectedProvidersSupplier } from '../../../provider-selection'

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

function seedSpec(ctx: ProjectContext, patch: Partial<Ticket> = {}): number {
  let id = 0
  mutateStore(ticketStorePathForProject(ctx.project), (s) => {
    id = s.next_id++
    s.tickets[String(id)] = {
      id, title: 'Calmer onboarding', description: '## Acceptance criteria\n- [ ] Progress rail', status: 'todo', priority: 'high', labels: ['ux'],
      assignee: null, prerequisites: [], metadata: {}, comments: [{ id: 1, body: 'note', created_at: 't0', created_by: 'me' }], origin_conversation_id: null,
      is_epic: false, parent_epic_id: null, execution_order: null, short_summary: null, nonGoals: ['No analytics'],
      created_at: 't0', updated_at: 't0', created_by: 'me', source: 'manual', ...patch,
    } as Ticket
  })
  return id
}

describe('existing spec binding (Flow from an existing spec)', () => {
  const at = { now: () => '2026-10-24T10:00:00.000Z' }
  const read = (ctx: ProjectContext, id: number) => readStore(ticketStorePathForProject(ctx.project)).tickets[String(id)]!

  it('labels the spec In Flow (no placeholder), restores it on discard and never deletes it', () => {
    const ctx = context()
    const id = seedSpec(ctx)
    const tickets = createFlowTickets(ctx, at, railOfTicket(ctx.db))
    expect(tickets.inspectExisting(id)).toMatchObject({ blocker: null, spec: { id, title: 'Calmer onboarding', nonGoals: ['No analytics'] } })
    const spec = tickets.adoptExisting({ ticketId: id, flowId: 'flow-1', conversationId: 'conv-1', startedAt: 't1' })
    expect(spec).toMatchObject({ id, description: '## Acceptance criteria\n- [ ] Progress rail' })
    expect(read(ctx, id)).toMatchObject({ status: 'in_progress', source: 'manual', metadata: { flow: { flowId: 'flow-1', state: 'active', origin: 'existing', previousStatus: 'todo' } } })
    expect(isFlowHeldTicket(read(ctx, id))).toBe(true)
    // Idempotent for the same Flow; another Flow is refused.
    expect(() => tickets.adoptExisting({ ticketId: id, flowId: 'flow-1', conversationId: 'conv-1', startedAt: 't1' })).not.toThrow()
    expect(() => tickets.adoptExisting({ ticketId: id, flowId: 'flow-2', conversationId: 'conv-2', startedAt: 't1' })).toThrow(FlowConflictError)
    expect(tickets.inspectExisting(id).blocker).toMatchObject({ code: 'spec_in_flow' })
    // Discard: deletePlaceholder never touches the person's spec; restore brings back its status.
    tickets.deletePlaceholder(id)
    expect(read(ctx, id)).toBeDefined()
    tickets.restoreExisting(id, 'flow-2')
    expect(read(ctx, id).metadata.flow?.flowId).toBe('flow-1')
    tickets.restoreExisting(id, 'flow-1')
    expect(read(ctx, id)).toMatchObject({ status: 'todo', title: 'Calmer onboarding', description: '## Acceptance criteria\n- [ ] Progress rail' })
    expect(read(ctx, id).metadata.flow).toBeUndefined()
    tickets.restoreExisting(id, 'flow-1')
  })

  it('refuses closed specs and specs on a rail (running or not)', () => {
    const ctx = context()
    const tickets = createFlowTickets(ctx, at, railOfTicket(ctx.db))
    expect(tickets.inspectExisting(seedSpec(ctx, { status: 'done' })).blocker).toMatchObject({ code: 'spec_closed' })
    expect(tickets.inspectExisting(999).blocker).toMatchObject({ code: 'spec_not_found' })
    const onRail = seedSpec(ctx)
    setRailTickets(ctx.db, 1, [onRail])
    expect(tickets.inspectExisting(onRail).blocker).toMatchObject({ code: 'spec_on_rail', message: expect.stringContaining('Rail 2') })
    expect(() => tickets.adoptExisting({ ticketId: onRail, flowId: 'f', conversationId: 'c', startedAt: 't' })).toThrow(FlowConflictError)
    expect(() => tickets.adoptExisting({ ticketId: 999, flowId: 'f', conversationId: 'c', startedAt: 't' })).toThrow(FlowValidationError)
  })

  it('keeps the original content as ONE comment before the rewrite (idempotent), alongside existing comments', () => {
    const ctx = context()
    const id = seedSpec(ctx)
    const tickets = createFlowTickets(ctx, at, railOfTicket(ctx.db))
    tickets.adoptExisting({ ticketId: id, flowId: 'flow-1', conversationId: 'conv-1', startedAt: 't1' })
    tickets.preserveOriginal(id, 'flow-1')
    tickets.preserveOriginal(id, 'flow-1')
    const ticket = read(ctx, id)
    expect(ticket.comments).toHaveLength(2)
    expect(ticket.comments![1]).toMatchObject({ id: 2, created_by: 'flow' })
    expect(ticket.comments![1]!.body).toContain('## Original spec before Flow')
    expect(ticket.comments![1]!.body).toContain('- [ ] Progress rail')
    expect(ticket.comments![1]!.body).toContain('- No analytics')
    expect(ticket.metadata.flow?.originalCommentId).toBe(2)
    // Another Flow's request is ignored.
    tickets.preserveOriginal(id, 'flow-9')
    expect(read(ctx, id).comments).toHaveLength(2)
  })
})

describe('worktree reservation binding (real git)', () => {
  it('adopts the one open spec change an earlier run left under another name, and refuses several', async () => {
    const ctx = context()
    const tickets = createFlowTickets(ctx)
    const ticketId = tickets.createPlaceholder({ flowId: 'flow-oc', conversationId: 'conv-oc', title: 'Retire v1', description: 'x', startedAt: 't' })
    const worktrees = createFlowWorktrees(ctx, { providerFor: () => 'claude' })
    const reserved = await worktrees.reserve({ flowId: 'flow-oc', conversationId: 'conv-oc', ticketId })
    const change = (name: string) => {
      fs.mkdirSync(path.join(reserved.worktreePath, 'openspec', 'changes', name), { recursive: true })
      fs.writeFileSync(path.join(reserved.worktreePath, 'openspec', 'changes', name, 'proposal.md'), `# ${name}\n`)
    }
    change('retire-v1-2')
    const frozen = await worktrees.freeze({ flowId: 'flow-oc', conversationId: 'conv-oc', ticketId, worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, allowedChanges: ['retire-v1'] })
    expect(frozen.adoptedChange).toBe('retire-v1-2')
    change('unrelated-a')
    change('unrelated-b')
    await expect(worktrees.freeze({ flowId: 'flow-oc', conversationId: 'conv-oc', ticketId, worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, allowedChanges: ['retire-v1-2'] }))
      .rejects.toThrow(/open spec changes/)
    await worktrees.release({ flowId: 'flow-oc', ticketId, worktreePath: reserved.worktreePath, branch: reserved.branch })
  })

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

    const frozen = await worktrees.freeze({ flowId: 'flow-1', conversationId: 'conv-1', ticketId, worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, allowedChanges: [] })
    expect(frozen.headSha).toBe(git(['rev-parse', 'HEAD'], reserved.worktreePath))
    expect(frozen.headSha).not.toBe(reserved.headSha)
    expect(git(['status', '--porcelain', '--', 'README.md', 'board.ts'], reserved.worktreePath)).toBe('')
    expect(git(['log', '-1', '--format=%s'], reserved.worktreePath)).toBe(`Flow #${ticketId}: Try a board`)

    // Back to Flow after the hand-off: the frozen commit still counts against
    // the Flow's base (the reservation SHA), plus anything new on top.
    const afterFreeze = await worktrees.diff({ worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, branch: reserved.branch })
    expect(afterFreeze.files.map((file) => [file.path, file.status])).toEqual([['README.md', 'modified'], ['board.ts', 'added']])
    fs.writeFileSync(path.join(reserved.worktreePath, 'fx.ts'), 'export const fx = 1\n')
    fs.appendFileSync(path.join(reserved.worktreePath, 'board.ts'), 'export const more = 2\n')
    const withNew = await worktrees.diff({ worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, branch: reserved.branch })
    expect(withNew.files.map((file) => [file.path, file.status])).toEqual([['README.md', 'modified'], ['board.ts', 'added'], ['fx.ts', 'untracked']])
    expect(withNew.totals).toMatchObject({ files: 3, additions: 3 })
    // A legacy session that never recorded its base measures from the fork point, not HEAD.
    const legacy = await worktrees.diff({ worktreePath: reserved.worktreePath, baseSha: null, branch: reserved.branch })
    expect(legacy.files.map((file) => file.path)).toEqual(['README.md', 'board.ts', 'fx.ts'])

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

describe('Flow in a workspace project (real git: a plain folder holding two repositories)', () => {
  function workspace() {
    const root = path.join(tmp, 'workspace')
    fs.mkdirSync(root)
    const member = (name: string) => {
      const dir = path.join(root, name)
      fs.mkdirSync(dir)
      git(['init', '-q', '-b', 'main'], dir)
      git(['config', 'user.name', 't'], dir)
      git(['config', 'user.email', 't@t'], dir)
      fs.writeFileSync(path.join(dir, 'README.md'), `${name}\n`)
      git(['add', '.'], dir)
      git(['commit', '-q', '-m', 'init'], dir)
      return dir
    }
    const web = member('web')
    const api = member('api')
    const base = context()
    const repositories = [
      { id: 'ws', projectId: 'proj-1', name: 'workspace', path: root, isPrimary: true, kind: 'folder', integrationBranch: null, addedAt: 't' },
      { id: 'web', projectId: 'proj-1', name: 'web', path: web, isPrimary: false, kind: 'git', integrationBranch: null, addedAt: 't' },
      { id: 'api', projectId: 'proj-1', name: 'api', path: api, isPrimary: false, kind: 'git', integrationBranch: null, addedAt: 't' },
    ]
    const project = { ...base.project, slug: 'wsproj', path: root, primaryRepositoryId: 'ws', repositories }
    const ctx = { ...base, project, getTicketSpec: (id: number) => {
      const ticket = readStore(ticketStorePathForProject(project)).tickets[String(id)]
      return ticket ? { title: ticket.title, description: ticket.description, labels: ticket.labels } : undefined
    } } as unknown as ProjectContext
    const repository = createSqliteFlowRepository(ctx.db)
    const call = vi.fn(async (..._args: unknown[]) => ({ ok: true, status: 202, body: { loopRunIds: ['run-1'], prDeliveryId: 'group-1' } }))
    const ports = createFlowPorts({
      ctx, repository, effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call } as never,
      agentHost: () => ({ assertFlowSupport: vi.fn(async () => {}), closeFlowSession: vi.fn(async () => {}) }) as never,
      availability: async () => ({ available: true, reason: 'ok', missing: [] }),
      clock: { now: () => '2026-10-23T10:00:00.000Z' },
    })
    const service = createFlowService(ports, { warn: vi.fn() })
    const server = express()
    server.use(express.json())
    registerFlowHttp(server as unknown as express.Router, () => service)
    const conversation = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'proj-1' })
    return { root, web, api, ctx, ports, service, server, repository, conversation, call }
  }

  it('starts the Flow in the chosen repository: its worktree, branch, spec scope and per-repository mount root', async () => {
    const { web, api, ctx, ports, server, repository, conversation } = workspace()
    const response = await request(server).post('/proj-1/flow').send({ conversationId: conversation.id, idea: 'Rate-limit the public API', flowId: 'flow-api', repositoryId: 'api' })
    expect(response.status).toBe(201)
    const flow = response.body.flow as FlowSession
    expect(flow).toMatchObject({ state: 'active', repositoryId: 'api' })
    expect(repository.get('flow-api')?.repositoryId).toBe('api')
    expect(flow.worktreePath!.startsWith(path.join(isolatedWorktreesRoot('wsproj', 'api'), 'flow-api'))).toBe(true)
    expect(git(['rev-parse', '--show-toplevel'], flow.worktreePath!)).toBe(fs.realpathSync(flow.worktreePath!))
    expect(git(['branch', '--list', flow.branch!], api)).toContain(flow.branch!)
    expect(git(['branch', '--list', flow.branch!], web)).toBe('')
    expect(flow.baseSha).toBe(git(['rev-parse', 'HEAD'], api))
    const ticket = readStore(ticketStorePathForProject(ctx.project)).tickets[String(flow.ticketId)]
    expect(ticket.repositoryIds).toEqual(['api'])

    // Work, diff and freeze happen in that repository.
    fs.writeFileSync(path.join(flow.worktreePath!, 'limit.ts'), 'export const limit = 10\n')
    const diff = await ports.worktrees.diff({ worktreePath: flow.worktreePath!, baseSha: flow.baseSha, branch: flow.branch, repositoryId: 'api' })
    expect(diff.files.map((file) => file.path)).toEqual(['limit.ts'])
    const frozen = await ports.worktrees.freeze({ flowId: 'flow-api', conversationId: conversation.id, ticketId: flow.ticketId!, worktreePath: flow.worktreePath!, baseSha: flow.baseSha, allowedChanges: [], repositoryId: 'api' })
    expect(git(['rev-parse', flow.branch!], api)).toBe(frozen.headSha)

    // Discard releases the worktree and the branch from the same repository.
    await request(server).post('/proj-1/flow/flow-api/discard').send({})
    expect(fs.existsSync(flow.worktreePath!)).toBe(false)
    expect(git(['branch', '--list', flow.branch!], api)).toBe('')
  })

  it('refuses an untriaged Flow with several Git repositories, and a folder target, before any effect', async () => {
    const { ctx, server, repository, conversation } = workspace()
    const required = await request(server).post('/proj-1/flow').send({ conversationId: conversation.id, idea: 'Something' })
    expect(required.status).toBe(400)
    expect(required.body.error).toBe('flow_repository_required')
    const folder = await request(server).post('/proj-1/flow').send({ conversationId: conversation.id, idea: 'Something', repositoryId: 'ws' })
    expect(folder.status).toBe(400)
    expect(folder.body.error).toBe('flow_repository_not_git')
    expect(repository.findOpenByConversation(conversation.id)).toBeNull()
    expect(Object.keys(readStore(ticketStorePathForProject(ctx.project)).tickets)).toEqual([])
  })

  it('hands off as that one repository and resolves the hand-off contract with it', async () => {
    const { ports, call } = workspace()
    await ports.rails.launch({ flowId: 'flow-api', conversationId: 'c', ticketId: 1, railIndex: 0, options: {}, repositoryId: 'api' })
    expect(call).toHaveBeenLastCalledWith('POST', '/projects/proj-1/rails/0/launch', expect.objectContaining({ flowId: 'flow-api', repositoryIds: ['api'] }))
    await ports.rails.launch({ flowId: 'flow-main', conversationId: 'c', ticketId: 1, railIndex: 1, options: {} })
    expect(call.mock.calls.at(-1)![2]).not.toHaveProperty('repositoryIds')
  })

  it('reads the derived change from the Flow repository', async () => {
    const { api, ctx } = workspace()
    fs.mkdirSync(path.join(api, 'openspec/changes/rate-limit'), { recursive: true })
    fs.writeFileSync(path.join(api, 'openspec/changes/rate-limit/proposal.md'), '## Why\nLimit\n')
    const base = git(['rev-parse', 'HEAD'], api)
    git(['add', '.'], api)
    git(['commit', '-q', '-m', 'derive'], api)
    const publication = createFlowPublication(ctx)
    const derived = await publication.derivedChange({ flowId: 'f', deliveryId: null, ticketId: 1, branch: 'main', baseSha: base, repositoryId: 'api' })
    expect(derived).toMatchObject({ changeName: 'rate-limit', proposal: '## Why\nLimit\n' })
    await expect(publication.derivedChange({ flowId: 'f', deliveryId: null, ticketId: 1, branch: 'main', baseSha: base, repositoryId: 'gone' })).rejects.toThrow(/no longer registered/)
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

  it('summarizes a real-shaped Flow conversation: SQLite message times after an ISO start, briefings excluded', () => {
    const ctx = context()
    const conversation = createAgentConversation(ctx.desktopDb, { title: 'arkanoidex' } as never)
    // Shaped like run e9fe4204: the Flow started at 12:49:06.950Z; its messages
    // carry datetime('now') stamps and a run-failure briefing came afterwards.
    const rows: Array<[string, string, string, unknown[]?]> = [
      ['user', 'me gustaría añadir mas efectos de video al juego', '2026-10-22 12:48:51'],
      ['user', 'vale, estamos experimentando a meter mas efectos graficos, que le podemos meter?', '2026-10-22 12:49:34'],
      ['assistant', 'Voy a mirar qué efectos hay ya en el código.', '2026-10-22 12:49:54'],
      ['user', 'puedes incluir todas, y que desde el menu de opciones se puedan habilitar/deshabilitar?', '2026-10-22 12:55:36'],
      ['assistant', 'Sí. Añado un catálogo de 27 efectos.\nDecision: every effect is toggleable from Options', '2026-10-22 13:21:00'],
      ['system', '{"kind":"pr_decision"}', '2026-10-22 13:48:50'],
      ['user', '[Specrails run-failure briefing — automatic, not typed by the user]', '2026-10-22 13:52:16', [{ kind: 'system-briefing', id: 'e9fe4204', label: 'Run failure briefing', token: '' }]],
    ]
    for (const [role, content, at, refs] of rows) {
      const message = addAgentMessage(ctx.desktopDb, { conversationId: conversation.id, role: role as 'user', content, ...(refs ? { contextRefs: refs as never } : {}) })
      ctx.desktopDb.prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?').run(at, message.id)
    }
    const summary = flowConversationSummary(ctx.desktopDb, { conversationId: conversation.id, idea: 'Add more visual effects', from: '2026-10-22T12:49:06.950Z', to: null })
    expect(summary).toContain('transcriptTurns: 2')
    expect(summary).toContain('1. vale, estamos experimentando')
    expect(summary).toContain('   ↳ Agent: Voy a mirar qué efectos hay ya en el código.')
    expect(summary).toContain('2. puedes incluir todas')
    expect(summary).toContain('   ↳ Agent: Sí. Añado un catálogo de 27 efectos.')
    expect(summary).toContain('- every effect is toggleable from Options')
    expect(summary).not.toContain('me gustaría añadir')
    expect(summary).not.toContain('run-failure briefing')
    expect(summary).not.toContain('(none)')
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

describe('Back to Flow binding (real SQLite ownership transfer)', () => {
  it.each([
    ['settled as review_changes_requested', 'review_changes_requested', 'The reviewer requested changes'],
    // Settled before the review outcome existed: a generic failure whose evidence holds the rejected review.
    ['settled earlier as a generic implementation failure', 'settlement_interrupted', 'Core exited without a successful programmatic workflow result'],
  ] as const)('returns the adopted worktree to the Flow atomically, reopens the spec "In Flow" and leaves the worktree intact (%s)', async (_label, settledCode, settledDetail) => {
    const ctx = context()
    const worktreePath = path.join(tmp, 'worktrees', 'flow-1', 'ticket-8')
    git(['worktree', 'add', '-q', '-b', 'feat/8-effects', worktreePath])
    fs.writeFileSync(path.join(worktreePath, 'effects.ts'), 'export const effects = 27\n')
    const tickets = createFlowTickets(ctx, { now: () => '2026-10-22T13:00:00.000Z' })
    const ticketId = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Add more visual effects', description: 'effects', startedAt: '2026-10-22T12:49:06.950Z' })
    // The failed run moved the spec back to todo.
    const { mutateStore } = await import('../../specs/runtime/ticket-store')
    mutateStore(ticketStorePathForProject(ctx.project), (store) => { store.tickets[String(ticketId)]!.status = 'todo' })
    const repository = createSqliteFlowRepository(ctx.db)
    repository.insert({ id: 'flow-1', conversationId: 'conv-1', ticketId, state: 'handed_off', branch: 'feat/8-effects', worktreePath, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), coreSessionId: null, railIndex: 0, deliveryId: 'delivery-1', step: null, createdAt: '2026-10-22T12:49:06.950Z', updatedAt: '2026-10-22T13:48:50.000Z' })
    const { createPrDelivery, getPrDelivery, transitionDecision } = await import('../../delivery/runtime/rail-pr-store')
    const { createRailWorktree, getRailWorktree } = await import('../../delivery/runtime/rail-worktrees-store')
    createPrDelivery(ctx.db, { id: 'delivery-1', railIndex: 0, loopId: 'factory:flow-spec', railKey: '0-factory:flow-spec', ticketIds: [ticketId], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: 'conv-1', launchConfig: { mode: 'loop', loopId: 'factory:flow-spec', aiEngine: 'claude', model: 'sonnet', reasoning_effort: 'medium' } })
    ctx.db.prepare('UPDATE rail_pr_deliveries SET run_ids = ? WHERE id = ?').run(JSON.stringify(['run-1']), 'delivery-1')
    createRailWorktree(ctx.db, { id: 'ledger-1', railIndex: 0, ticketId, runId: 'run-1', branch: 'feat/8-effects', worktreePath, mergeState: 'needs-review' })
    transitionDecision(ctx.db, 'delivery-1', 'building', 'implementation_failed', {
      implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: settledCode, statusDetail: settledDetail, worktreeIds: ['ledger-1'],
      branches: [{ ticketId, branch: 'feat/8-effects', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'a', failureCode: settledCode, branchOwnership: 'adopted', worktreePath }],
      settleEvidence: { schemaVersion: 1, harvest: 'ok', harvestedAt: 'now', units: [{ ticketId, runId: 'run-1', sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null,
        runtime: { commands: [], checks: [], findings: [], review: { approved: false, score: 58, aspects: {}, issues: ['Tag the tests with [spec:visual-effects/toggles]'], summary: 'Blocked by missing tests' } } }] } as never,
    })
    const bound = createFlowPorts({
      ctx, repository, effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call: vi.fn() } as never,
      // No Core session host here: the Flow returns paused and the Flow bar resumes it.
      agentHost: () => null,
      availability: async () => ({ available: true, reason: 'ok', missing: [] }),
      clock: { now: () => '2026-10-22T14:00:00.000Z' },
    })
    expect(bound.rails.stoppedDelivery('delivery-1')).toMatchObject({ railIndex: 0, options: { loopId: 'factory:flow-spec', aiEngine: 'claude', model: 'sonnet', reasoningEffort: 'medium' }, findings: { reason: 'review', score: 58 } })
    const service = createFlowService(bound, { warn: vi.fn() })

    const returned = await service.returnToFlow({ deliveryId: 'delivery-1' })
    expect(returned).toMatchObject({ id: 'flow-1', state: 'paused', step: null, deliveryId: 'delivery-1', worktreePath })
    expect(returned.returnBriefing).toContain('Tag the tests with [spec:visual-effects/toggles]')
    expect(repository.get('flow-1')?.returnBriefing).toContain('Blocked by missing tests')
    expect(getRailWorktree(ctx.db, 'ledger-1')).toBeUndefined()
    expect(getPrDelivery(ctx.db, 'delivery-1')).toMatchObject({ decision: 'discarded', status_code: 'returned_to_flow' })
    expect(fs.readFileSync(path.join(worktreePath, 'effects.ts'), 'utf8')).toBe('export const effects = 27\n')
    const ticket = readStore(ticketStorePathForProject(ctx.project)).tickets[String(ticketId)]!
    expect(ticket.status).toBe('in_progress')
    expect(ticket.metadata?.flow?.state).toBe('paused')
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rail.pr_state', prDeliveryId: 'delivery-1', statusCode: 'returned_to_flow' }))
  })

  it('hands the return briefing to the next Flow turn and clears it once delivered', async () => {
    const briefingDelivered = vi.fn(async () => null)
    const session = { id: 'flow-1', state: 'active', step: null, worktreePath: '/wt', coreSessionId: 'flow:flow-1', branch: 'b', returnBriefing: '[Back from Flow → Spec] fix it' } as unknown as FlowSession
    const context = createFlowTurnContext({ conversationProject: () => 'proj-1', flowServiceFor: () => ({ getByConversation: () => session, briefingDelivered }) })
    expect(context.forConversation('conv-1')?.briefing).toBe('[Back from Flow → Spec] fix it')
    await context.briefingDelivered!('conv-1', 'flow-1')
    expect(briefingDelivered).toHaveBeenCalledWith('flow-1')
    const without = createFlowTurnContext({ conversationProject: () => 'proj-1', flowServiceFor: () => ({ getByConversation: () => ({ ...session, returnBriefing: null }) }) })
    expect(without.forConversation('conv-1')).not.toHaveProperty('briefing')
  })
})

describe('automatic return of a failed Flow → Spec run (real SQLite)', () => {
  it('classifies a crash (never a review outcome, a busy or another loop\'s delivery)', () => {
    const base = { loopId: 'factory:flow-spec', decision: 'implementation_failed', statusCode: 'settlement_interrupted', flowReview: undefined, operation: null } as const
    expect(isCrashedFlowDelivery(base as never)).toBe(true)
    expect(isCrashedFlowDelivery({ ...base, statusCode: 'review_changes_requested' } as never)).toBe(false)
    expect(isCrashedFlowDelivery({ ...base, flowReview: { reason: 'check' } } as never)).toBe(false)
    expect(isCrashedFlowDelivery({ ...base, operation: 'relaunch' } as never)).toBe(false)
    expect(isCrashedFlowDelivery({ ...base, loopId: 'factory:implement' } as never)).toBe(false)
    expect(isCrashedFlowDelivery({ ...base, decision: 'discarded', statusCode: 'returned_to_flow' } as never)).toBe(false)
    expect(deliveryFailureOf({ statusCode: 'implementation_failed', statusDetail: 'boom', units: [{ failureCode: 'settlement_interrupted' }], flowReview: undefined } as never))
      .toEqual({ stepId: null, cause: null, statusCode: 'implementation_failed', failureCode: 'settlement_interrupted', statusDetail: 'boom' })
    // After the return the delivery's own codes are gone: never reported as the crash.
    expect(deliveryFailureOf({ statusCode: 'returned_to_flow', statusDetail: 'Returned to Flow', units: [], flowReview: undefined } as never))
      .toMatchObject({ statusCode: null, statusDetail: null })
  })

  it('takes the worktree back on its own, posts the failure card and starts ONE Flow turn about it', async () => {
    const ctx = context()
    const conv = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'proj-1' })
    const worktreePath = path.join(tmp, 'worktrees', 'flow-1', 'ticket-9')
    git(['worktree', 'add', '-q', '-b', 'feat/9-board', worktreePath])
    const tickets = createFlowTickets(ctx)
    const ticketId = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: conv.id, title: 'Board', description: 'board', startedAt: 't' })
    const repository = createSqliteFlowRepository(ctx.db)
    repository.insert({ id: 'flow-1', conversationId: conv.id, ticketId, state: 'handed_off', branch: 'feat/9-board', worktreePath, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), coreSessionId: null, railIndex: 0, deliveryId: 'delivery-1', step: null, createdAt: 't', updatedAt: 't' })
    const { createPrDelivery, getPrDelivery, transitionDecision } = await import('../../delivery/runtime/rail-pr-store')
    const { createRailWorktree } = await import('../../delivery/runtime/rail-worktrees-store')
    createPrDelivery(ctx.db, { id: 'delivery-1', railIndex: 0, loopId: 'factory:flow-spec', railKey: '0-factory:flow-spec', ticketIds: [ticketId], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: conv.id, launchConfig: { mode: 'loop', loopId: 'factory:flow-spec' } })
    ctx.db.prepare('UPDATE rail_pr_deliveries SET run_ids = ? WHERE id = ?').run(JSON.stringify(['run-1']), 'delivery-1')
    createRailWorktree(ctx.db, { id: 'ledger-1', railIndex: 0, ticketId, runId: 'run-1', branch: 'feat/9-board', worktreePath, mergeState: 'needs-review' })
    transitionDecision(ctx.db, 'delivery-1', 'building', 'implementation_failed', {
      implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'implementation_failed', statusDetail: 'Programmatic workflow stopped before delivery', worktreeIds: ['ledger-1'],
      branches: [{ ticketId, branch: 'feat/9-board', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'a', failureCode: 'settlement_interrupted', branchOwnership: 'adopted', worktreePath }],
    })
    const host = { assertFlowSupport: vi.fn(async () => {}), closeFlowSession: vi.fn(async () => {}), postSystemRow: vi.fn(() => 'row-1'), startAutomaticTurn: vi.fn(async () => 'started' as const) }
    const bound = createFlowPorts({
      ctx, repository, effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call: vi.fn() } as never,
      agentHost: () => host,
      availability: async () => ({ available: true, reason: 'ok', missing: [] }),
      clock: { now: () => '2026-10-23T10:00:00.000Z' },
    })
    expect(bound.publication.deliveryState('delivery-1')).toEqual({ delivered: false, crashed: true })
    // No runtime record for this run here: only the delivery codes are known.
    await expect(bound.rails.runFailure!('delivery-1')).resolves.toBeNull()
    const service = createFlowService(bound, { warn: vi.fn() })

    const returned = await service.observeDelivery('delivery-1')
    expect(returned).toMatchObject({ id: 'flow-1', state: 'active', deliveryId: 'delivery-1' })
    expect(returned!.returnBriefing).toContain('Delivery detail: Programmatic workflow stopped before delivery')
    expect(getPrDelivery(ctx.db, 'delivery-1')).toMatchObject({ decision: 'discarded', status_code: 'returned_to_flow' })
    expect(bound.publication.deliveryState('delivery-1')).toEqual({ delivered: false, crashed: false })
    expect(host.postSystemRow).toHaveBeenCalledWith(conv.id, expect.objectContaining({
      kind: 'flow-return-briefing', reason: null,
      failure: { stepId: null, cause: null, statusCode: 'implementation_failed', failureCode: 'settlement_interrupted', statusDetail: 'Programmatic workflow stopped before delivery' },
    }), 'flow-return-briefing:delivery-1')
    expect(host.startAutomaticTurn).toHaveBeenCalledTimes(1)
    expect(host.startAutomaticTurn).toHaveBeenCalledWith(conv.id, FLOW_FAILURE_RETURN_TURN_TEXT, { turnKey: 'flow-return:delivery-1', label: 'Back to Flow' })
    expect(FLOW_FAILURE_RETURN_TURN_TEXT).not.toBe(FLOW_RETURN_TURN_TEXT)
    // A repeated observation (the return's own broadcast) changes nothing.
    await expect(service.observeDelivery('delivery-1')).resolves.toBeNull()
    expect(host.startAutomaticTurn).toHaveBeenCalledTimes(1)
  })
})

describe('Flow closing summary binding', () => {
  it('posts ONE flow-delivered row with the PR, the archived change and the Jira key', async () => {
    const ctx = context()
    const tickets = createFlowTickets(ctx)
    const ticketId = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Board', description: 'board', startedAt: 't' })
    tickets.markDelivered(ticketId, { openspecChangeName: 'kanban-board' })
    const { createPrDelivery } = await import('../../delivery/runtime/rail-pr-store')
    createPrDelivery(ctx.db, { id: 'delivery-1', railIndex: 0, loopId: 'factory:flow-spec', railKey: '0-factory:flow-spec', ticketIds: [ticketId], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: 'conv-1', launchConfig: { mode: 'loop' } })
    ctx.db.prepare('UPDATE rail_pr_deliveries SET pr_url = ?, pr_number = ? WHERE id = ?').run('https://github.com/o/r/pull/42', 42, 'delivery-1')
    const host = { assertFlowSupport: vi.fn(async () => {}), closeFlowSession: vi.fn(async () => {}), postSystemRow: vi.fn(() => 'row-1') }
    const bound = createFlowPorts({
      ctx, repository: createSqliteFlowRepository(ctx.db), effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call: vi.fn() } as never,
      agentHost: () => host, availability: async () => ({ available: true, reason: 'ok', missing: [] }), clock: { now: () => 'now' },
    })
    bound.conversation!.postDeliveredSummary!({ conversationId: 'conv-1', flowId: 'flow-1', deliveryId: 'delivery-1', ticketId, settlement: { specRewrite: 'done', jiraCreate: 'skipped', jiraReview: 'skipped' } })
    expect(host.postSystemRow).toHaveBeenCalledWith('conv-1', {
      kind: 'flow-delivered', flowId: 'flow-1', deliveryId: 'delivery-1', ticketId,
      prUrl: 'https://github.com/o/r/pull/42', prNumber: 42, changeName: 'kanban-board', changeArchived: true,
      specRewrite: 'done', jiraCreate: 'skipped', jiraKey: null, at: 'now',
    }, 'flow-delivered:flow-1')
  })
})

describe('Flow freeze after Back to Flow keeps the Flow\'s own derived change (real git + SQLite)', () => {
  const LEGACY = 'ticket-8-addenda-3e1942024602'

  async function returnedFlow(options: { evidenceChange: string | null }) {
    const ctx = context()
    const tickets = createFlowTickets(ctx)
    const ticketId = tickets.createPlaceholder({ flowId: 'flow-1', conversationId: 'conv-1', title: 'Arkanoid power-ups', description: 'x', startedAt: 't' })
    const worktrees = createFlowWorktrees(ctx, { providerFor: () => 'claude' })
    const reserved = await worktrees.reserve({ flowId: 'flow-1', conversationId: 'conv-1', ticketId })
    // What the stopped Flow -> Spec run left: code plus its derived change, unarchived.
    fs.writeFileSync(path.join(reserved.worktreePath, 'powerups.ts'), 'export const powerups = 3\n')
    fs.mkdirSync(path.join(reserved.worktreePath, 'openspec', 'changes', LEGACY), { recursive: true })
    fs.writeFileSync(path.join(reserved.worktreePath, 'openspec', 'changes', LEGACY, 'proposal.md'), '## Why\nPower-ups\n')
    git(['add', '-A'], reserved.worktreePath)
    git(['commit', '-q', '-m', 'run commit'], reserved.worktreePath)
    const repository = createSqliteFlowRepository(ctx.db)
    // Returned before derived changes were recorded: the session carries no list.
    repository.insert({ id: 'flow-1', conversationId: 'conv-1', ticketId, state: 'paused', branch: reserved.branch, worktreePath: reserved.worktreePath, baseSha: reserved.baseSha, headSha: reserved.headSha, coreSessionId: null, railIndex: null, deliveryId: 'delivery-1', step: null, createdAt: 't', updatedAt: 't' })
    const { createPrDelivery, transitionDecision } = await import('../../delivery/runtime/rail-pr-store')
    createPrDelivery(ctx.db, { id: 'delivery-1', railIndex: 0, loopId: 'factory:flow-spec', railKey: '0-factory:flow-spec', ticketIds: [ticketId], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: 'conv-1', launchConfig: { mode: 'loop', loopId: 'factory:flow-spec' } })
    transitionDecision(ctx.db, 'delivery-1', 'building', 'implementation_failed', {
      implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'review_changes_requested', statusDetail: 'changes requested', worktreeIds: [], branches: [],
      settleEvidence: { schemaVersion: 1, harvest: 'ok', harvestedAt: 'now', units: [{ ticketId, runId: 'run-1', sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null,
        runtime: { commands: [], checks: [], findings: [], review: null,
          ...(options.evidenceChange ? { derivation: { change: options.evidenceChange, files: 1, explained: 1, unexplainedFiles: [], unexplainedOmitted: 0, confidence: 'high', requirementsAdded: 1, requirementsModified: 0, tasks: 1, transcriptTurnsUsed: 1 } } : {}) } }] } as never,
    })
    const authority = createFlowHandOffAuthority(repository)
    const resolved: Array<{ changeId?: string | null; worktreePath: string; baseSha?: string | null }> = []
    const internalApi = {
      call: vi.fn(async (method: string) => {
        if (method === 'PUT') return { ok: true, status: 200, body: {} }
        // The rails launch route: resolve the Flow contract and adopt it.
        const flow = authority.resolve('flow-1')
        resolved.push(flow)
        flow.adopt({ railIndex: 0, runId: 'run-2', ledgerId: 'ledger-2', deliveryId: 'delivery-2', headSha: flow.headSha })
        return { ok: true, status: 202, body: { loopRunIds: ['run-2'], prDeliveryId: 'delivery-2' } }
      }),
    }
    const bound = createFlowPorts({
      ctx, repository, effects: createSqliteFlowEffectsStore(ctx.db), internalApi: internalApi as never, agentHost: () => null,
      availability: async () => ({ available: true, reason: 'ok', missing: [] }),
    })
    return { ctx, repository, reserved, resolved, service: createFlowService(bound, { warn: vi.fn() }) }
  }

  it('freezes with the legacy derived change active and seeds the next run with that same change', async () => {
    const { repository, reserved, resolved, service } = await returnedFlow({ evidenceChange: LEGACY })
    fs.appendFileSync(path.join(reserved.worktreePath, 'powerups.ts'), 'export const fixed = true\n')
    const handed = await service.handOffFlow({ flowId: 'flow-1', railIndex: 0 })
    expect(handed.flow).toMatchObject({ state: 'handed_off', deliveryId: 'delivery-2', derivedChanges: [LEGACY] })
    expect(repository.get('flow-1')?.derivedChanges).toEqual([LEGACY])
    expect(git(['status', '--porcelain', '--', 'powerups.ts'], reserved.worktreePath)).toBe('')
    expect(resolved[0]?.changeId).toBe(LEGACY)
    // The run re-derives the existing change in place instead of a title-based new one.
    expect(flowDerivationChangeId(reserved.worktreePath, { baseSha: reserved.baseSha, changeId: resolved[0]!.changeId }, 'Arkanoid power-ups')).toBe(LEGACY)
  })

  it('still blocks an unrelated new active change', async () => {
    const { repository, reserved, service } = await returnedFlow({ evidenceChange: LEGACY })
    fs.mkdirSync(path.join(reserved.worktreePath, 'openspec', 'changes', 'rogue-change'), { recursive: true })
    fs.writeFileSync(path.join(reserved.worktreePath, 'openspec', 'changes', 'rogue-change', 'proposal.md'), '# rogue\n')
    const error = await service.handOffFlow({ flowId: 'flow-1', railIndex: 0 }).catch((caught: unknown) => caught as FlowConflictError)
    expect(error).toBeInstanceOf(FlowConflictError)
    // Two open changes are ambiguous: the agent must keep one.
    expect((error as FlowConflictError).message).toContain('rogue-change')
    expect((error as FlowConflictError).message).toMatch(/keep one/)
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', step: null })
  })

  it('without recorded evidence the one leftover change is adopted as the Flow\'s, and a first derivation is named after the spec', async () => {
    const { repository, reserved, service } = await returnedFlow({ evidenceChange: null })
    await service.handOffFlow({ flowId: 'flow-1', railIndex: 0 }).catch((caught: unknown) => {
      expect(String((caught as Error)?.message)).not.toMatch(/open spec change|new active changes/)
    })
    expect(repository.get('flow-1')?.derivedChanges).toContain(LEGACY)
    expect(flowDerivationChangeId(reserved.worktreePath, { baseSha: reserved.baseSha, changeId: null }, 'Arkanoid power-ups')).toBe('arkanoid-power-ups')
  })
})

describe('Flow launch engine binding', () => {
  afterEach(() => setDetectedProvidersSupplier(null))

  it('is the conversation\'s current provider/model/effort when this machine can run it, else null', () => {
    const ctx = context()
    const codex = createAgentConversation(ctx.desktopDb, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium', pinnedProjectId: 'proj-1' })
    const plain = createAgentConversation(ctx.desktopDb, { provider: 'claude', pinnedProjectId: 'proj-1' })
    const ports = createFlowPorts({
      ctx, repository: createSqliteFlowRepository(ctx.db), effects: createSqliteFlowEffectsStore(ctx.db), internalApi: { call: vi.fn() } as never,
      agentHost: () => null, availability: async () => ({ available: true, reason: 'ok', missing: [] }),
    })
    setDetectedProvidersSupplier(() => ['claude', 'codex'])
    expect(ports.agent.launchEngine!(codex.id)).toEqual({ aiEngine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
    expect(ports.agent.launchEngine!(plain.id)).toEqual({ aiEngine: 'claude' })
    expect(ports.agent.launchEngine!('missing')).toBeNull()
    setDetectedProvidersSupplier(() => ['claude'])
    expect(ports.agent.launchEngine!(codex.id)).toBeNull()
  })
})
