import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBoardSpecColumns } from '../useBoardSpecColumns'
import type { RailState } from '../../../rails/components/RailsBoard'
import type { LocalTicket } from '../../../../types'

const ticket = (id: number, source: string, status: LocalTicket['status'] = 'todo'): LocalTicket =>
  ({ id, title: `Spec ${id}`, status, source, labels: [], created_by: source } as unknown as LocalTicket)

const columns = (tickets: LocalTicket[], rails: RailState[] = []) => renderHook(() => useBoardSpecColumns({
  tickets, isLoading: false, rails, specOrderIds: null, sortMode: 'default', sortDir: 'asc',
  handleSortChange: vi.fn(), railPrDecisions: new Map(), railPrDecisionsHydrated: true,
})).result.current

describe('useBoardSpecColumns', () => {
  it('shows a spec created through the HTTP API without a named source (legacy "hub")', () => {
    const { specTickets } = columns([ticket(1, 'hub', 'on_review'), ticket(2, 'propose-spec')])
    expect(specTickets.map((t) => t.id)).toEqual([1, 2])
  })

  it('leaves the specs on a rail to the rail', () => {
    const rail = { id: '1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' } as RailState
    const { specTickets } = columns([ticket(1, 'hub'), ticket(2, 'hub')], [rail])
    expect(specTickets.map((t) => t.id)).toEqual([2])
  })
})
