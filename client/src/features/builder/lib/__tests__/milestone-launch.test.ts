import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MAX_TICKETS_PER_RAIL,
  LEGACY_SEQUENTIAL_PLANS_KEY,
  MILESTONE_LAUNCH_MODE_KEY,
  chunkTickets,
  filterMilestoneTickets,
  launchMilestone,
  resumeChain,
  cancelChain,
  milestoneLabel,
  readMilestoneLaunchMode,
  saveMilestoneLaunchMode,
  dropLegacySequentialPlans,
  MILESTONE_AUTO_ADVANCE_KEY,
  readMilestoneAutoAdvance,
  saveMilestoneAutoAdvance,
  setChainAutoAdvance,
} from '../milestone-launch'

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('milestoneLabel / filterMilestoneTickets / chunkTickets', () => {
  it('labels milestones M<n>', () => {
    expect(milestoneLabel(1)).toBe('M1')
    expect(milestoneLabel(12)).toBe('M12')
  })

  it('filters todo tickets carrying the milestone label', () => {
    const tickets = [
      { id: 1, status: 'todo', labels: ['M1'] },
      { id: 2, status: 'done', labels: ['M1'] },
      { id: 3, status: 'todo', labels: ['M2'] },
      { id: 4, status: 'todo', labels: ['M1', 'backend'] },
    ]
    expect(filterMilestoneTickets(tickets, 1)).toEqual([1, 4])
    expect(filterMilestoneTickets(tickets, 2)).toEqual([3])
  })

  it('chunks tickets into groups of at most MAX_TICKETS_PER_RAIL', () => {
    expect(MAX_TICKETS_PER_RAIL).toBe(3)
    expect(chunkTickets([1, 2, 3, 4, 5, 6, 7])).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(chunkTickets([])).toEqual([])
  })
})

describe('launch mode + legacy plan cleanup (localStorage)', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to sequential and persists an explicit choice', () => {
    expect(readMilestoneLaunchMode()).toBe('sequential')
    saveMilestoneLaunchMode('parallel')
    expect(localStorage.getItem(MILESTONE_LAUNCH_MODE_KEY)).toBe('parallel')
    expect(readMilestoneLaunchMode()).toBe('parallel')
  })

  it('drops the retired sequencer plans once', () => {
    localStorage.setItem(LEGACY_SEQUENTIAL_PLANS_KEY, '[{"projectId":"p"}]')
    expect(dropLegacySequentialPlans()).toBe(true)
    expect(localStorage.getItem(LEGACY_SEQUENTIAL_PLANS_KEY)).toBeNull()
    expect(dropLegacySequentialPlans()).toBe(false)
  })
})

describe('launchMilestone (server-owned chain)', () => {
  it('POSTs the mode to the milestone launch route and returns the launched/pending plan', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonRes(202, {
        chainId: 'chain-1',
        launched: [{ chunk: 1, railIndex: 3, ticketIds: [1, 2, 3], runIds: ['run-1'], deliveryId: 'd-3' }],
        pending: [[4, 5, 6], [7, 8]],
      })
    }) as unknown as typeof fetch

    const result = await launchMilestone('proj-1', 1, 'sequential', fetchImpl)
    expect(result).toEqual({
      ok: true, chainId: 'chain-1', ticketCount: 3, skippedCount: 5,
      launched: [{ chunk: 1, railIndex: 3, ticketIds: [1, 2, 3], runIds: ['run-1'], deliveryId: 'd-3' }],
      pending: [[4, 5, 6], [7, 8]],
    })
    expect(calls[0].url).toBe('/api/projects/proj-1/blueprint/milestones/1/launch')
    expect(calls[0].init?.method).toBe('POST')
    // Auto-advance rides the body from the stored preference (default OFF = checkpoints).
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ mode: 'sequential', autoAdvance: false })
  })

  it('maps the typed refusals (chain_active / no_tickets / not found / unavailable / guard)', async () => {
    const cases: Array<[number, unknown, string]> = [
      [409, { error: 'chain_active', chainId: 'c1' }, 'chain_active'],
      [400, { error: 'no_tickets', detail: 'none' }, 'no_tickets'],
      [404, { error: 'milestone_not_found' }, 'milestone_not_found'],
      [503, { error: 'milestone_chain_unavailable' }, 'unavailable'],
      [409, { error: 'tickets_in_flight' }, 'launch_rejected'],
      [500, 'not json', 'launch_rejected'],
    ]
    for (const [status, body, reason] of cases) {
      const fetchImpl = vi.fn(async () => (typeof body === 'string'
        ? ({ ok: false, status, json: async () => { throw new Error('bad json') } } as unknown as Response)
        : jsonRes(status, body))) as unknown as typeof fetch
      const result = await launchMilestone('p', 1, 'parallel', fetchImpl)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe(reason)
        if (reason === 'chain_active') expect(result.chainId).toBe('c1')
        if (reason === 'no_tickets') expect(result.detail).toBe('none')
      }
    }
  })

  it('a network failure is reported, never thrown', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const result = await launchMilestone('p', 1, 'sequential', fetchImpl)
    expect(result).toMatchObject({ ok: false, reason: 'network', detail: 'offline' })
  })

  it('tolerates a malformed 202 body', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(202, { launched: 'x', pending: [1, [2]] })) as unknown as typeof fetch
    const result = await launchMilestone('p', 1, 'sequential', fetchImpl)
    expect(result).toEqual({ ok: true, chainId: null, launched: [], pending: [[2]], ticketCount: 0, skippedCount: 1 })
  })
})

describe('wave checkpoints (autoAdvance)', () => {
  beforeEach(() => localStorage.clear())

  it('the stored preference defaults OFF and persists', () => {
    expect(readMilestoneAutoAdvance()).toBe(false)
    saveMilestoneAutoAdvance(true)
    expect(localStorage.getItem(MILESTONE_AUTO_ADVANCE_KEY)).toBe('true')
    expect(readMilestoneAutoAdvance()).toBe(true)
    saveMilestoneAutoAdvance(false)
    expect(readMilestoneAutoAdvance()).toBe(false)
  })

  it('launchMilestone sends an explicit autoAdvance option, else the stored preference', async () => {
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return jsonRes(202, { chainId: 'c', launched: [], pending: [] }) }) as unknown as typeof fetch
    await launchMilestone('p', 1, 'sequential', { autoAdvance: true, fetchImpl })
    saveMilestoneAutoAdvance(true)
    await launchMilestone('p', 1, 'sequential', { fetchImpl })
    await launchMilestone('p', 1, 'parallel', { autoAdvance: false, fetchImpl })
    expect(bodies).toEqual([{ mode: 'sequential', autoAdvance: true }, { mode: 'sequential', autoAdvance: true }, { mode: 'parallel', autoAdvance: false }])
  })

  it('setChainAutoAdvance PATCHes the chain and parses the snapshot; errors relay', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonRes(202, { chain: { id: 'c1', milestoneN: 1, mode: 'sequential', status: 'running', pauseReason: null, autoAdvance: true, nextChunk: 2, totalChunks: 3, currentRailIndex: 4, headBranch: 'feat/1', launched: [], updatedAt: 'x' } })
    }) as unknown as typeof fetch
    const r = await setChainAutoAdvance('proj-1', 'c1', true, fetchImpl)
    expect(calls[0].url).toBe('/api/projects/proj-1/blueprint/chains/c1')
    expect(calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ autoAdvance: true })
    expect(r).toEqual({ ok: true, chain: expect.objectContaining({ id: 'c1', autoAdvance: true, status: 'running' }) })
    const failing = vi.fn(async () => jsonRes(409, { error: 'chain_terminal', detail: 'chain is cancelled' })) as unknown as typeof fetch
    expect(await setChainAutoAdvance('proj-1', 'c1', false, failing)).toEqual({ ok: false, error: 'chain_terminal', detail: 'chain is cancelled' })
    const network = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await setChainAutoAdvance('proj-1', 'c1', false, network)).toEqual({ ok: false, error: 'network', detail: 'offline' })
  })
})

describe('resumeChain / cancelChain', () => {
  it('POST the control routes and parse the returned chain', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return jsonRes(202, { chain: { id: 'c1', milestoneN: 1, mode: 'sequential', status: 'running', pauseReason: null, nextChunk: 2, totalChunks: 3, currentRailIndex: 4, headBranch: 'feat/1', launched: [], updatedAt: 'x' } })
    }) as unknown as typeof fetch
    const resumed = await resumeChain('p', 'c1', fetchImpl)
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.chain).toMatchObject({ id: 'c1', status: 'running', nextChunk: 2 })
    const cancelled = await cancelChain('p', 'c1', fetchImpl)
    expect(cancelled.ok).toBe(true)
    expect(urls).toEqual(['/api/projects/p/blueprint/chains/c1/resume', '/api/projects/p/blueprint/chains/c1/cancel'])
  })

  it('relays the server error + detail and reports network failures', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(409, { error: 'head_missing', detail: 'branch gone' })) as unknown as typeof fetch
    expect(await resumeChain('p', 'c1', fetchImpl)).toEqual({ ok: false, error: 'head_missing', detail: 'branch gone' })
    const boom = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await cancelChain('p', 'c1', boom)).toMatchObject({ ok: false, error: 'network' })
  })
})
