import { afterEach, describe, expect, it, vi } from 'vitest'
import { anyTriage, readyTriage, recalculateSpecTriage, recommendedLoopForTickets } from '../spec-triage'

const ready = { status: 'ready', size: 'S', recommendedLoop: 'factory:implement', inputsHash: 'h', computedAt: 't' }

describe('spec-triage', () => {
  afterEach(() => { vi.mocked(fetch).mockReset() })

  it('reads ready records tolerantly', () => {
    expect(readyTriage({ metadata: { triage: ready } })).toEqual(ready)
    expect(readyTriage({ metadata: { triage: { ...ready, size: 'XXL' } } })).toBeNull()
    expect(readyTriage({ metadata: {} })).toBeNull()
    expect(anyTriage({ metadata: { triage: { status: 'failed', error: 'x' } } })).toMatchObject({ status: 'failed' })
    expect(anyTriage({ metadata: { triage: { status: 'weird' } } })).toBeNull()
  })

  it('recommends the first ready triage in rail order', () => {
    expect(recommendedLoopForTickets([undefined, { metadata: { triage: { status: 'unavailable' } } }, { metadata: { triage: ready } }])).toBe('factory:implement')
    expect(recommendedLoopForTickets([])).toBeNull()
  })

  it('posts the recalculation and surfaces errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ triage: ready }) } as Response)
    await expect(recalculateSpecTriage(7, '/api/projects/p1')).resolves.toEqual(ready)
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/projects/p1/tickets/7/triage', { method: 'POST' })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'triage_not_applicable' }) } as Response)
    await expect(recalculateSpecTriage(7, '/api/projects/p1')).rejects.toThrow('triage_not_applicable')
  })
})
