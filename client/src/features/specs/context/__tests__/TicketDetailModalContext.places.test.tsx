import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, type Location } from 'react-router-dom'
import { useEffect, useReducer } from 'react'

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  desktop: { projects: [{ id: 'a', name: 'Alpha' }], activeProjectId: 'a' as string | null, setActiveProjectId: () => {} },
  tickets: { list: [] as Array<{ id: number; title: string }>, isLoading: false, error: null as string | null },
}))

vi.mock('sonner', () => ({ toast: Object.assign((...args: unknown[]) => h.toast(...args), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => h.desktop }))
vi.mock('../../hooks/useTickets', () => ({
  useTickets: () => ({
    tickets: h.tickets.list,
    isLoading: h.tickets.isLoading,
    error: h.tickets.error,
    updateTicket: vi.fn(),
    deleteTicket: vi.fn(),
  }),
}))
vi.mock('../../components/TicketDetailModal', () => ({
  TicketDetailModal: ({ ticket, onClose, onOpenTicket }: { ticket: { id: number }; onClose: () => void; onOpenTicket: (id: number) => void }) => (
    <div data-testid="spec-modal" data-id={ticket.id}>
      <button onClick={onClose}>close-spec</button>
      <button onClick={() => onOpenTicket(ticket.id + 1)}>next-spec</button>
    </div>
  ),
}))
vi.mock('../../../../components/SplitViewShell', () => ({ SplitViewShell: () => <div data-testid="split-shell" /> }))

import { PlaceHistoryProvider, usePlaceHistory, type PlaceHistoryValue } from '../../../../hooks/usePlaceHistory'
import { TicketDetailModalProvider, useTicketDetailModal } from '../TicketDetailModalContext'

let places: PlaceHistoryValue | null = null
let loc: Location
let api: ReturnType<typeof useTicketDetailModal>

function Probe({ claim = false }: { claim?: boolean }) {
  places = usePlaceHistory()
  loc = useLocation()
  api = useTicketDetailModal()
  const { claimSpecHost } = api
  useEffect(() => (claim ? claimSpecHost() : undefined), [claim, claimSpecHost])
  return null
}

function Harness({ claim }: { claim?: boolean }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => { tickRef.fn = tick }, [])
  return (
    <PlaceHistoryProvider>
      <TicketDetailModalProvider><Probe claim={claim} /></TicketDetailModalProvider>
    </PlaceHistoryProvider>
  )
}
const tickRef: { fn: () => void } = { fn: () => {} }

function mount(initial = '/', claim = false) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Harness claim={claim} />
    </MemoryRouter>,
  )
}

const url = () => `${loc.pathname}${loc.search}`
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  h.toast.mockClear()
  h.tickets.list = [{ id: 15, title: 'Add achievements' }, { id: 16, title: 'Polish onboarding' }]
  h.tickets.isLoading = false
  h.tickets.error = null
  places = null
})

afterEach(() => { vi.useRealTimers() })

describe('spec modal as a place', () => {
  it('opening a spec writes ?spec=<id>; closing it pops back to where the user was', async () => {
    mount('/?status=done')
    act(() => api.openTicketDetail(15))
    await settle()
    expect(url()).toBe('/?status=done&spec=15')
    expect(screen.getByTestId('spec-modal')).toHaveAttribute('data-id', '15')

    act(() => screen.getByText('close-spec').click())
    await settle()
    expect(url()).toBe('/?status=done')
    expect(screen.queryByTestId('spec-modal')).not.toBeInTheDocument()
    // Closing popped the pushed entry: no phantom Back stop is left behind.
    expect(places?.canBack).toBe(false)
    expect(places?.canForward).toBe(true)
  })

  it('Back closes the modal and Forward reopens it', async () => {
    mount()
    act(() => api.openTicketDetail(15))
    await settle()
    act(() => places?.back())
    await settle()
    expect(screen.queryByTestId('spec-modal')).not.toBeInTheDocument()
    expect(url()).toBe('/')
    act(() => places?.forward())
    await settle()
    expect(screen.getByTestId('spec-modal')).toHaveAttribute('data-id', '15')
    expect(url()).toBe('/?spec=15')
  })

  it('opening the same spec twice adds one entry', async () => {
    mount()
    act(() => api.openTicketDetail(15))
    await settle()
    act(() => api.openTicketDetail(15))
    await settle()
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/')
  })

  it('navigating spec → spec is a place of its own: Back returns to the first spec', async () => {
    mount()
    act(() => api.openTicketDetail(15))
    await settle()
    act(() => screen.getByText('next-spec').click())
    await settle()
    expect(screen.getByTestId('spec-modal')).toHaveAttribute('data-id', '16')
    act(() => places?.back())
    await settle()
    expect(screen.getByTestId('spec-modal')).toHaveAttribute('data-id', '15')
  })

  it('a link with ?spec= opens the modal', async () => {
    mount('/?spec=16')
    await settle()
    expect(screen.getByTestId('spec-modal')).toHaveAttribute('data-id', '16')
  })

  it('labels the history target with the spec number and title', async () => {
    mount()
    act(() => api.openTicketDetail(15))
    await settle()
    act(() => api.openTicketDetail(16))
    await settle()
    expect(places?.backTarget?.label).toBe('#15 · Add achievements')
  })

  it('a surface that hosts the modal itself claims it: the provider mounts none', async () => {
    mount('/?spec=15', true)
    await settle()
    expect(screen.queryByTestId('spec-modal')).not.toBeInTheDocument()
  })

  it('skips a spec that was deleted (deep link): quiet toast and the param is dropped', async () => {
    vi.useFakeTimers()
    mount('/?spec=99')
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(h.toast).toHaveBeenCalledWith('That spec no longer exists, so it was skipped.', expect.anything())
    expect(url()).toBe('/')
  })

  it('skips a spec deleted since it was visited when going Back, continuing to the previous place', async () => {
    mount('/')
    act(() => api.openTicketDetail(15))
    await settle()
    act(() => api.openTicketDetail(16))
    await settle()
    // Spec 15 is deleted while the person looks at 16.
    h.tickets.list = [{ id: 16, title: 'Polish onboarding' }]
    vi.useFakeTimers()
    act(() => places?.back())
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(h.toast).toHaveBeenCalledWith('That spec no longer exists, so it was skipped.', expect.anything())
    // The history went on to the place before it (the plain board), not a dead modal.
    expect(url()).toBe('/')
    expect(screen.queryByTestId('spec-modal')).not.toBeInTheDocument()
  })

  it('does not call a spec missing while the list is still loading or failed', async () => {
    vi.useFakeTimers()
    h.tickets.isLoading = true
    mount('/?spec=99')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(h.toast).not.toHaveBeenCalled()
    expect(url()).toBe('/?spec=99')
  })
})
