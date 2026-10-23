import { afterEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { FlowConflictError, FlowTransitionError, type FlowSession } from '..'
import { createSqliteFlowEffectsStore, createSqliteFlowRepository } from '../adapters/sqlite'
import { plannedSettlementEffects, failedAttempt } from '../domain'
import { createFlowHandOffAuthority } from '../adapters/bindings'
import { FlowHandOffNotReadyError } from '../../delivery/runtime/flow-worktree-handoff'
import { createRailWorktree, listRailWorktrees } from '../../delivery/runtime/rail-worktrees-store'

const HEAD = 'a'.repeat(40)
const databases: DbInstance[] = []
function db(): DbInstance {
  const instance = initDb(':memory:')
  databases.push(instance)
  return instance
}
afterEach(() => { for (const instance of databases.splice(0)) instance.close() })

function flow(patch: Partial<FlowSession> = {}): FlowSession {
  return {
    id: 'flow-1', conversationId: 'conv-1', ticketId: 7, state: 'active', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7',
    baseSha: 'b'.repeat(40), headSha: HEAD, coreSessionId: 'flow:flow-1', railIndex: null, deliveryId: null, step: null,
    createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z', ...patch,
  }
}

describe('SQLite Flow repository (migration 74)', () => {
  it('round-trips every field and isolates projects', () => {
    const projectA = createSqliteFlowRepository(db())
    const projectB = createSqliteFlowRepository(db())
    projectA.insert(flow())
    expect(projectA.get('flow-1')).toEqual(flow())
    expect(projectB.get('flow-1')).toBeNull()
    expect(projectB.findOpenByConversation('conv-1')).toBeNull()
    projectA.save(flow({ state: 'paused', coreSessionId: null, updatedAt: '2026-10-21T11:00:00.000Z' }))
    expect(projectA.findOpenByConversation('conv-1')).toMatchObject({ state: 'paused', coreSessionId: null })
    expect(() => projectB.save(flow())).toThrow(/does not exist/)
  })

  it('round-trips the Flow repository (migration 80); the primary stays absent', () => {
    const repository = createSqliteFlowRepository(db())
    repository.insert(flow({ repositoryId: 'api' }))
    expect(repository.get('flow-1')).toEqual(flow({ repositoryId: 'api' }))
    repository.save(flow({ id: 'flow-1', repositoryId: null, state: 'paused' }))
    expect(repository.get('flow-1')).not.toHaveProperty('repositoryId')
  })

  it('allows a single active or paused Flow per conversation (partial unique index)', () => {
    const repository = createSqliteFlowRepository(db())
    repository.insert(flow({ ticketId: null, step: 'start:ticket' }))
    const error = (() => { try { repository.insert(flow({ id: 'flow-2' })) } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(FlowConflictError)
    expect(error).toMatchObject({ code: 'flow_already_open', flowId: 'flow-1' })
    repository.save(flow({ state: 'discarded', step: null }))
    repository.insert(flow({ id: 'flow-2', createdAt: '2026-10-21T12:00:00.000Z' }))
    expect(repository.latestByConversation('conv-1')?.id).toBe('flow-2')
    expect(() => repository.insert(flow({ id: 'flow-2', conversationId: 'other' }))).toThrow(FlowConflictError)
  })

  it('lists only Flows reconciliation must inspect', () => {
    const repository = createSqliteFlowRepository(db())
    repository.insert(flow({ id: 'a', conversationId: 'c1' }))
    repository.insert(flow({ id: 'b', conversationId: 'c2', state: 'handed_off' }))
    repository.insert(flow({ id: 'c', conversationId: 'c3', state: 'paused', step: 'handoff:launch' }))
    repository.insert(flow({ id: 'd', conversationId: 'c4', state: 'discarded' }))
    expect(repository.listUnsettled().map((session) => session.id).sort()).toEqual(['a', 'c'])
  })

  it('rejects unknown states and steps at the schema level', () => {
    const instance = db()
    expect(() => instance.prepare("INSERT INTO flow_sessions (id, conversation_id, state, created_at, updated_at) VALUES ('x', 'c', 'flying', 't', 't')").run()).toThrow(/CHECK/)
    expect(() => instance.prepare("INSERT INTO flow_sessions (id, conversation_id, state, step, created_at, updated_at) VALUES ('x', 'c', 'active', 'nope', 't', 't')").run()).toThrow(/CHECK/)
  })
})

describe('Flow hand-off authority (ownership transfer inside delivery transaction)', () => {
  const launching = () => flow({ state: 'paused', step: 'handoff:launch', railIndex: 2, coreSessionId: null })

  it('resolves only a Flow waiting for its launch', () => {
    const instance = db()
    const repository = createSqliteFlowRepository(instance)
    repository.insert(flow())
    const authority = createFlowHandOffAuthority(repository)
    expect(() => authority.resolve('flow-1')).toThrow(FlowHandOffNotReadyError)
    expect(() => authority.resolve('missing')).toThrow(FlowHandOffNotReadyError)
    repository.save(launching())
    expect(authority.resolve('flow-1')).toMatchObject({ flowId: 'flow-1', ticketId: 7, conversationId: 'conv-1', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7', headSha: HEAD })
  })

  it('commits the rail ledger row and handed_off together', () => {
    const instance = db()
    const repository = createSqliteFlowRepository(instance)
    repository.insert(launching())
    const required = createFlowHandOffAuthority(repository).resolve('flow-1')
    instance.transaction(() => {
      createRailWorktree(instance, { id: 'ledger-1', railIndex: 2, ticketId: 7, runId: 'run-1', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7' })
      required.adopt({ railIndex: 2, runId: 'run-1', ledgerId: 'ledger-1', deliveryId: 'd-1', headSha: HEAD })
    })()
    expect(listRailWorktrees(instance, 2)).toHaveLength(1)
    expect(repository.get('flow-1')).toMatchObject({ state: 'handed_off', step: null, deliveryId: 'd-1', railIndex: 2 })
  })

  it('rolls back both writes when the adopted HEAD differs (no partial ownership)', () => {
    const instance = db()
    const repository = createSqliteFlowRepository(instance)
    repository.insert(launching())
    const required = createFlowHandOffAuthority(repository).resolve('flow-1')
    expect(() => instance.transaction(() => {
      createRailWorktree(instance, { id: 'ledger-1', railIndex: 2, ticketId: 7, runId: 'run-1', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7' })
      required.adopt({ railIndex: 2, runId: 'run-1', ledgerId: 'ledger-1', deliveryId: 'd-1', headSha: 'c'.repeat(40) })
    })()).toThrow(FlowTransitionError)
    expect(listRailWorktrees(instance, 2)).toEqual([])
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', step: 'handoff:launch' })
  })

  it('returns ownership to the Flow when the launch rolls back after adoption', () => {
    const instance = db()
    const repository = createSqliteFlowRepository(instance)
    repository.insert(launching())
    const changed: FlowSession[] = []
    const required = createFlowHandOffAuthority(repository, { now: () => 'now' }, (session) => changed.push(session)).resolve('flow-1')
    instance.transaction(() => {
      createRailWorktree(instance, { id: 'ledger-1', railIndex: 2, ticketId: 7, runId: 'run-1', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7' })
      required.adopt({ railIndex: 2, runId: 'run-1', ledgerId: 'ledger-1', deliveryId: 'd-1', headSha: HEAD })
    })()
    required.release('addenda claim failed')
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', step: 'handoff:launch', deliveryId: null })
    expect(changed).toHaveLength(1)
  })
})

describe('SQLite Flow settlement effects (migration 75)', () => {
  it('enqueues idempotently, saves attempts and lists pending Flows per project', () => {
    const database = db()
    const effects = createSqliteFlowEffectsStore(database)
    const planned = plannedSettlementEffects('flow-1', '2026-10-21T10:00:00.000Z')
    effects.enqueue(planned)
    effects.save(failedAttempt(planned[0]!, 'boom', '2026-10-21T10:00:01.000Z', 'rewrite_failed'))
    effects.enqueue(plannedSettlementEffects('flow-1', '2026-10-21T11:00:00.000Z'))
    const listed = effects.list('flow-1')
    expect(listed.map((effect) => effect.kind)).toEqual(['rewrite-spec', 'jira-create', 'jira-review'])
    expect(listed[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'boom', note: 'rewrite_failed', createdAt: '2026-10-21T10:00:00.000Z' })
    expect(effects.pendingFlowIds()).toEqual(['flow-1'])
    for (const effect of listed) effects.save({ ...effect, status: 'done' })
    expect(effects.pendingFlowIds()).toEqual([])
    expect(createSqliteFlowEffectsStore(db()).list('flow-1')).toEqual([])
  })

  it('finds a Flow by its delivery and lists handed-off Flows', () => {
    const repository = createSqliteFlowRepository(db())
    repository.insert(flow({ state: 'handed_off', deliveryId: 'delivery-9', coreSessionId: null }))
    expect(repository.findByDelivery('delivery-9')?.id).toBe('flow-1')
    expect(repository.findByDelivery('nope')).toBeNull()
    expect(repository.listHandedOff().map((session) => session.id)).toEqual(['flow-1'])
  })
})
