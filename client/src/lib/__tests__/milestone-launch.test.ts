import { describe, it, expect, vi } from 'vitest'
import {
  MAX_TICKETS_PER_RAIL,
  chunkTickets,
  filterMilestoneTickets,
  launchMilestone,
  milestoneLabel,
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
    expect(chunkTickets([1, 2])).toEqual([[1, 2]])
    expect(chunkTickets([1, 2, 3])).toEqual([[1, 2, 3]])
    expect(chunkTickets([1, 2, 3, 4])).toEqual([[1, 2, 3], [4]])
    expect(chunkTickets([1, 2, 3, 4, 5, 6, 7])).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(chunkTickets([])).toEqual([])
  })
})

describe('launchMilestone', () => {
  const tickets = [
    { id: 1, status: 'todo', labels: ['M1'] },
    { id: 2, status: 'todo', labels: ['M1'] },
  ]

  it('creates a rail, assigns tickets and launches batch-implement', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/tickets')) return jsonRes(200, { tickets })
      if (url.endsWith('/rails')) return jsonRes(201, { rail: { railIndex: 3 } })
      if (url.includes('/rails/3/tickets')) return jsonRes(200, {})
      if (url.includes('/rails/3/launch')) return jsonRes(202, {})
      return jsonRes(404, {})
    }) as unknown as typeof fetch

    const result = await launchMilestone('proj-1', 1, fetchImpl)
    expect(result).toEqual({ ok: true, railIndices: [3], ticketCount: 2, skippedCount: 0 })
    const create = calls.find((c) => c.url.endsWith('/rails') && c.init?.method === 'POST')
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({ name: 'M1' })
    const assign = calls.find((c) => c.url.includes('/rails/3/tickets'))
    expect(JSON.parse(String(assign?.init?.body))).toMatchObject({ ticketIds: [1, 2], mode: 'batch-implement' })
    const launch = calls.find((c) => c.url.includes('/rails/3/launch'))
    expect(JSON.parse(String(launch?.init?.body))).toMatchObject({ mode: 'batch-implement' })
  })

  it('spreads a big milestone across rails of at most 3 specs each', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, status: 'todo', labels: ['M1'] }))
    const assigns: number[][] = []
    const railNames: string[] = []
    let nextRail = 4
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/tickets') && !url.includes('/rails/')) return jsonRes(200, { tickets: many })
      if (url.endsWith('/rails')) {
        railNames.push((JSON.parse(String(init?.body)) as { name: string }).name)
        return jsonRes(201, { rail: { railIndex: nextRail++ } })
      }
      if (/\/rails\/\d+\/tickets$/.test(url)) {
        assigns.push((JSON.parse(String(init?.body)) as { ticketIds: number[] }).ticketIds)
        return jsonRes(200, {})
      }
      if (/\/rails\/\d+\/launch$/.test(url)) return jsonRes(202, {})
      return jsonRes(404, {})
    }) as unknown as typeof fetch

    const result = await launchMilestone('p', 1, fetchImpl)
    expect(result).toEqual({ ok: true, railIndices: [4, 5, 6], ticketCount: 7, skippedCount: 0 })
    expect(assigns).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(railNames).toEqual(['M1 · 1', 'M1 · 2', 'M1 · 3'])
  })

  it('a mid-batch failure keeps earlier launches and reports the skipped rest', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, status: 'todo', labels: ['M1'] }))
    let railCreates = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/tickets') && !url.includes('/rails/')) return jsonRes(200, { tickets: many })
      if (url.endsWith('/rails')) {
        railCreates += 1
        if (railCreates === 2) return jsonRes(400, { error: 'rail_limit_reached' })
        return jsonRes(201, { rail: { railIndex: 0 } })
      }
      if (/\/rails\/\d+\/tickets$/.test(url)) return jsonRes(200, {})
      if (/\/rails\/\d+\/launch$/.test(url)) return jsonRes(202, {})
      return jsonRes(404, {})
    }) as unknown as typeof fetch

    const result = await launchMilestone('p', 1, fetchImpl)
    expect(result).toEqual({ ok: true, railIndices: [0], ticketCount: 3, skippedCount: 2 })
  })

  it('no launchable tickets → no-tickets', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { tickets: [] })) as unknown as typeof fetch
    expect(await launchMilestone('p', 1, fetchImpl)).toEqual({ ok: false, reason: 'no-tickets' })
  })

  it('launch guard 409 surfaces as launch-failed with the server reason', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/tickets') && !url.includes('/rails/')) return jsonRes(200, { tickets })
      if (url.endsWith('/rails')) return jsonRes(201, { rail: { railIndex: 0 } })
      if (url.includes('/rails/0/tickets')) return jsonRes(200, {})
      return jsonRes(409, { error: 'tickets_in_flight' })
    }) as unknown as typeof fetch
    const result = await launchMilestone('p', 1, fetchImpl)
    expect(result).toEqual({ ok: false, reason: 'launch-failed', detail: 'tickets_in_flight' })
  })

  it('rail creation failure surfaces as rail-create-failed', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/tickets') && !url.includes('/rails/')) return jsonRes(200, { tickets })
      return jsonRes(400, { error: 'rail_limit_reached' })
    }) as unknown as typeof fetch
    const result = await launchMilestone('p', 1, fetchImpl)
    expect(result).toEqual({ ok: false, reason: 'rail-create-failed', detail: 'rail_limit_reached' })
  })
})
