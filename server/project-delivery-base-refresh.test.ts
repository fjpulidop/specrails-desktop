import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refreshDeliveryOnBase, resolverRoute } from './project-delivery-base-refresh'
import { initDb, type DbInstance } from './db'
import { createPrDelivery } from './modules/delivery/runtime/rail-pr-store'
import type { ProjectContext } from './project-registry'

describe('base refresh resolver route', () => {
  it('runs the conflict resolver on the delivery run\'s own provider and model', () => {
    expect(resolverRoute({ provider: 'claude', model: 'haiku' })).toEqual({ provider: 'claude', model: 'haiku' })
  })
  it('falls back to the provider default for an unknown model and to the machine default for an unknown provider', () => {
    expect(resolverRoute({ provider: 'claude', model: 'per-role' }).provider).toBe('claude')
    expect(resolverRoute({ provider: 'claude', model: 'per-role' }).model).not.toBe('per-role')
    expect(resolverRoute({ provider: 'agent-runtime', model: 'per-role' }).model).not.toBe('per-role')
  })
})

describe('base refresh progress', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => db.close())

  it('says it refused (with the reason) on the WS, so the chain and the delivery surfaces stop saying it is updating', async () => {
    const sent: unknown[] = []
    const ctx = { db, project: { id: 'p1', path: '/repo' }, broadcast: (msg: unknown) => sent.push(msg) } as unknown as ProjectContext
    const row = createPrDelivery(db, { railIndex: 0, railKey: '0-implement', loopId: 'factory:implement', loopName: 'Implement', ticketIds: [4], baseBranch: 'main', originSurface: 'dashboard' })
    const outcome = await refreshDeliveryOnBase(ctx, row.id)
    expect(outcome.status).toBe(409)
    expect(sent).toEqual([{ type: 'delivery.base_refresh', projectId: 'p1', deliveryId: row.id, phase: 'refused', reason: 'refresh_not_applicable' }])
  })

  it('stays silent for a delivery that does not exist', async () => {
    const sent: unknown[] = []
    const ctx = { db, project: { id: 'p1', path: '/repo' }, broadcast: (msg: unknown) => sent.push(msg) } as unknown as ProjectContext
    expect((await refreshDeliveryOnBase(ctx, 'nope')).status).toBe(404)
    expect(sent).toEqual([])
  })
})
