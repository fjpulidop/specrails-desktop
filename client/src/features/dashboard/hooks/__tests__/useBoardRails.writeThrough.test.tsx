import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useBoardRails } from '../useBoardRails'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

const puts = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
  .map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))])

beforeEach(() => {
  localStorage.clear()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
})

describe('useBoardRails: the person\'s moves are written to the server', () => {
  it('writes a changed idle rail through PUT /rails/:i/tickets with its latest specs', async () => {
    const { result } = renderHook(() => useBoardRails('p1'))
    act(() => result.current.updateRails((prev) => prev.map((r) => (r.id === 'rail-2' ? { ...r, ticketIds: [4, 5] } : r))))
    await waitFor(() => expect(puts()).toEqual([['/api/projects/p1/rails/1/tickets', { ticketIds: [4, 5] }]]))
  })

  it('writes the source rail too when a spec moves between rails', async () => {
    localStorage.setItem('specrails-desktop:rails:p1', JSON.stringify([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [3], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
    ]))
    const { result } = renderHook(() => useBoardRails('p1'))
    act(() => result.current.updateRails((prev) => prev.map((r) => (r.id === 'rail-1' ? { ...r, ticketIds: [] } : { ...r, ticketIds: [3] }))))
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()).toEqual(expect.arrayContaining([
      ['/api/projects/p1/rails/0/tickets', { ticketIds: [] }],
      ['/api/projects/p1/rails/1/tickets', { ticketIds: [3] }],
    ]))
  })

  it('does not write what the server reported, a running rail, or an unchanged assignment', async () => {
    localStorage.setItem('specrails-desktop:rails:p1', JSON.stringify([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [3], mode: 'implement', status: 'running', activeJobId: 'j' },
    ]))
    const { result } = renderHook(() => useBoardRails('p1'))
    act(() => result.current.syncRails((prev) => prev.map((r) => ({ ...r, ticketIds: [3, 4] }))))
    act(() => result.current.updateRails((prev) => prev.map((r) => ({ ...r, ticketIds: [3, 4, 5] }))))
    act(() => result.current.updateRails((prev) => prev.map((r) => ({ ...r, label: 'Renamed' }))))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(puts()).toEqual([])
  })

  it('reports a pending write until the server answers', async () => {
    let answer: (value: unknown) => void = () => {}
    global.fetch = vi.fn().mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const { result } = renderHook(() => useBoardRails('p1'))
    act(() => result.current.updateRails((prev) => prev.map((r) => (r.id === 'rail-1' ? { ...r, ticketIds: [1] } : r))))
    await waitFor(() => expect(result.current.isTicketWritePending(0)).toBe(true))
    await act(async () => { answer({ ok: true, json: () => Promise.resolve({}) }) })
    await waitFor(() => expect(result.current.isTicketWritePending(0)).toBe(false))
  })
})
