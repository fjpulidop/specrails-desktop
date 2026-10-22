import { afterEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { FlowConflictError, FlowTransitionError, type FlowSession } from '..'
import { createSqliteFlowRepository } from '../adapters/sqlite'
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

describe('SQLite Flow repository (migration 72)', () => {
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
