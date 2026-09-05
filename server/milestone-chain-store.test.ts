import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  createChain,
  getChain,
  listActiveChains,
  listChains,
  listChainsTouchingDelivery,
  updateChain,
  toChainSnapshot,
  parseChunks,
  parseLaunched,
  parseRunIds,
  pauseChainsForDiscardedHead,
  isActiveChainStatus,
} from './milestone-chain-store'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const NOW = Date.parse('2026-09-04T12:00:00.000Z')

function seed(n = 1, over: Partial<Parameters<typeof createChain>[1]> = {}) {
  return createChain(db, { id: `c${n}-${Math.random().toString(36).slice(2, 6)}`, milestoneN: n, milestoneId: `m${n}`, mode: 'sequential', chunks: [[1, 2, 3], [4, 5, 6], [7, 8]], integrationBranch: 'main', nowMs: NOW, ...over })
}

describe('milestone-chain-store', () => {
  it('creates a running row with the plan and ISO timestamps', () => {
    const row = seed()
    expect(row).toMatchObject({ milestone_n: 1, milestone_id: 'm1', mode: 'sequential', status: 'running', next_chunk: 0, head_branch: null, integration_branch: 'main' })
    expect(parseChunks(row)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8]])
    expect(parseLaunched(row)).toEqual([])
    expect(parseRunIds(row)).toEqual([])
    expect(row.created_at).toBe('2026-09-04T12:00:00.000Z')
  })

  it('enforces ONE non-terminal chain per milestone', () => {
    seed(1)
    expect(() => seed(1)).toThrow()
    // A terminal row does not block a new one.
    const c2 = seed(2)
    expect(updateChain(db, c2.id, 'running', { status: 'cancelled' })).toBe(true)
    expect(() => seed(2)).not.toThrow()
  })

  it('updateChain is compare-and-set on status', () => {
    const row = seed()
    expect(updateChain(db, row.id, 'paused', { headBranch: 'x' })).toBe(false)
    expect(updateChain(db, row.id, ['paused', 'running'], { headBranch: 'feat/1', currentRunIds: ['r1'], launched: [{ chunk: 1, railIndex: 3, ticketIds: [1, 2, 3], runIds: ['r1'], deliveryId: 'd1' }], nextChunk: 1 }, NOW + 1000)).toBe(true)
    const fresh = getChain(db, row.id)!
    expect(fresh.head_branch).toBe('feat/1')
    expect(parseRunIds(fresh)).toEqual(['r1'])
    expect(parseLaunched(fresh)[0]).toMatchObject({ chunk: 1, railIndex: 3, deliveryId: 'd1' })
    expect(fresh.updated_at).toBe('2026-09-04T12:00:01.000Z')
    expect(fresh.next_chunk).toBe(1)
  })

  it('lists active vs all (newest first) and finds chains touching a delivery', () => {
    const a = seed(1, { nowMs: NOW })
    const b = seed(2, { nowMs: NOW + 5000 })
    updateChain(db, a.id, 'running', { launched: [{ chunk: 1, railIndex: 1, ticketIds: [1], runIds: [], deliveryId: 'd-a' }] })
    updateChain(db, b.id, 'running', { status: 'completed', launched: [{ chunk: 1, railIndex: 2, ticketIds: [4], runIds: [], deliveryId: 'd-b' }] })
    expect(listActiveChains(db).map((r) => r.id)).toEqual([a.id])
    expect(listChains(db).map((r) => r.id)).toEqual([b.id, a.id])
    expect(listChainsTouchingDelivery(db, 'd-a').map((r) => r.id)).toEqual([a.id])
    expect(listChainsTouchingDelivery(db, 'd-b').map((r) => r.id)).toEqual([b.id])
    expect(listChainsTouchingDelivery(db, 'nope')).toEqual([])
  })

  it('snapshot projection carries total chunks and launched entries', () => {
    const row = seed()
    updateChain(db, row.id, 'running', { status: 'waiting', nextChunk: 1, currentRailIndex: 4, headBranch: 'feat/1', launched: [{ chunk: 1, railIndex: 4, ticketIds: [1, 2, 3], runIds: ['r'], deliveryId: 'd' }] })
    expect(toChainSnapshot(getChain(db, row.id)!)).toMatchObject({ milestoneN: 1, mode: 'sequential', status: 'waiting', nextChunk: 1, totalChunks: 3, currentRailIndex: 4, headBranch: 'feat/1', pauseReason: null })
  })

  it('malformed JSON columns degrade to empty arrays', () => {
    const row = seed()
    db.prepare(`UPDATE milestone_launch_chains SET chunks = 'x', launched = '{', current_run_ids = '1' WHERE id = ?`).run(row.id)
    const bad = getChain(db, row.id)!
    expect(parseChunks(bad)).toEqual([])
    expect(parseLaunched(bad)).toEqual([])
    expect(parseRunIds(bad)).toEqual([])
  })

  it('pauseChainsForDiscardedHead rewinds the head to the previous chunk and pauses', () => {
    const row = seed()
    updateChain(db, row.id, 'running', {
      status: 'waiting', headBranch: 'feat/2', nextChunk: 2,
      launched: [
        { chunk: 1, railIndex: 1, ticketIds: [1, 2, 3], runIds: [], deliveryId: 'd1' },
        { chunk: 2, railIndex: 2, ticketIds: [4, 5, 6], runIds: [], deliveryId: 'd2' },
      ],
    })
    const paused = pauseChainsForDiscardedHead(db, 'd2', (id) => (id === 'd1' ? 'feat/1' : null), NOW)
    expect(paused).toHaveLength(1)
    expect(paused[0]).toMatchObject({ status: 'paused', pause_reason: 'head_discarded', head_branch: 'feat/1' })
    // Discarding the FIRST chunk rewinds to null (= the integration branch).
    const again = pauseChainsForDiscardedHead(db, 'd1', () => null, NOW)
    expect(again[0].head_branch).toBeNull()
    // Unknown delivery / terminal chain → nothing.
    expect(pauseChainsForDiscardedHead(db, 'zzz', () => null)).toEqual([])
    updateChain(db, row.id, 'paused', { status: 'cancelled' })
    expect(pauseChainsForDiscardedHead(db, 'd2', () => null)).toEqual([])
  })

  it('auto_advance defaults on, is patchable, and awaiting_approval counts as active (D9)', () => {
    const row = seed(1)
    expect(row.auto_advance).toBe(1)
    expect(toChainSnapshot(row).autoAdvance).toBe(true)
    expect(updateChain(db, row.id, 'running', { autoAdvance: false, status: 'awaiting_approval', headBranch: 'feat/1' })).toBe(true)
    const fresh = getChain(db, row.id)!
    expect(fresh.auto_advance).toBe(0)
    expect(fresh.status).toBe('awaiting_approval')
    expect(toChainSnapshot(fresh)).toMatchObject({ autoAdvance: false, status: 'awaiting_approval' })
    expect(listActiveChains(db).map((r) => r.id)).toEqual([row.id])
    // Still ONE non-terminal chain per milestone while at a checkpoint.
    expect(() => seed(1)).toThrow()
    expect(isActiveChainStatus('awaiting_approval')).toBe(true)
    // A chain created with the preference off stores 0.
    const off = createChain(db, { id: 'c-off', milestoneN: 7, milestoneId: 'm7', mode: 'sequential', chunks: [[1]], integrationBranch: null, autoAdvance: false })
    expect(off.auto_advance).toBe(0)
  })

  it('retry_chunk is null by default and patchable (Resume retries the failed chunk)', () => {
    const row = seed(1)
    expect(row.retry_chunk).toBeNull()
    expect(updateChain(db, row.id, 'running', { status: 'paused', retryChunk: 0 })).toBe(true)
    expect(getChain(db, row.id)!.retry_chunk).toBe(0)
    expect(updateChain(db, row.id, 'paused', { status: 'running', retryChunk: null })).toBe(true)
    expect(getChain(db, row.id)!.retry_chunk).toBeNull()
  })

  it('isActiveChainStatus', () => {
    expect(['running', 'waiting', 'paused'].every(isActiveChainStatus)).toBe(true)
    expect(['completed', 'cancelled', 'x'].some(isActiveChainStatus)).toBe(false)
  })
})
