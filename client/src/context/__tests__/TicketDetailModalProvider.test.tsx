import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'

// ── A tiny external store standing in for DesktopProvider's active project ────
const desktop = vi.hoisted(() => {
  const store = {
    activeProjectId: 'p1' as string | null,
    listeners: new Set<() => void>(),
    set(id: string | null) {
      store.activeProjectId = id
      for (const l of store.listeners) l()
    },
  }
  return { store, setActiveProjectId: vi.fn((id: string | null) => store.set(id)) }
})

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => {
    const activeProjectId = useSyncExternalStore(
      (cb) => {
        desktop.store.listeners.add(cb)
        return () => desktop.store.listeners.delete(cb)
      },
      () => desktop.store.activeProjectId,
    )
    return { activeProjectId, setActiveProjectId: desktop.setActiveProjectId, projects: [] }
  },
}))

vi.mock('../../hooks/useTickets', () => ({
  useTickets: () => ({
    tickets: [
      { id: 3, title: 'Dark mode', status: 'todo', priority: 'high', labels: [] },
      { id: 7, title: 'Fix nav', status: 'todo', priority: 'low', labels: [] },
    ],
    updateTicket: vi.fn(),
    deleteTicket: vi.fn(),
  }),
}))

vi.mock('../../components/TicketDetailModal', () => ({
  TicketDetailModal: ({ ticket }: { ticket: { id: number } }) => (
    <div data-testid="ticket-modal">ticket-{ticket.id}</div>
  ),
}))

vi.mock('../../components/SplitViewShell', () => ({
  SplitViewShell: () => <div data-testid="split-shell" />,
}))

import { TicketDetailModalProvider, useTicketDetailModal } from '../TicketDetailModalContext'

function Opener() {
  const { openTicketDetail, openTicketDetailInProject } = useTicketDetailModal()
  return (
    <div>
      <button onClick={() => openTicketDetail(3)}>open-active</button>
      <button onClick={() => openTicketDetailInProject('p1', 7)}>open-same-project</button>
      <button onClick={() => openTicketDetailInProject('p2', 3)}>open-cross-project</button>
    </div>
  )
}

const ui = () => (
  <TicketDetailModalProvider>
    <Opener />
  </TicketDetailModalProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  act(() => desktop.store.set('p1'))
})

describe('TicketDetailModalProvider — openTicketDetailInProject', () => {
  it('same project: opens directly without touching the active project', () => {
    render(ui())
    fireEvent.click(screen.getByText('open-same-project'))
    expect(screen.getByTestId('ticket-modal').textContent).toBe('ticket-7')
    expect(desktop.setActiveProjectId).not.toHaveBeenCalled()
  })

  it('cross project: switches the active project, then completes the open', () => {
    render(ui())
    fireEvent.click(screen.getByText('open-cross-project'))
    expect(desktop.setActiveProjectId).toHaveBeenCalledWith('p2')
    // The switch effect ran closeAll THEN the pending openCentered.
    expect(screen.getByTestId('ticket-modal').textContent).toBe('ticket-3')
  })

  it('a plain project switch still closes any open modal (M22 guard intact)', () => {
    render(ui())
    fireEvent.click(screen.getByText('open-active'))
    expect(screen.getByTestId('ticket-modal')).toBeInTheDocument()
    act(() => desktop.store.set('p3'))
    expect(screen.queryByTestId('ticket-modal')).toBeNull()
  })

  it('a stale pending open never fires on a later unrelated switch', () => {
    render(ui())
    fireEvent.click(screen.getByText('open-cross-project'))
    expect(screen.getByTestId('ticket-modal')).toBeInTheDocument()
    // User moves on: p3 — modal closes and the (cleared) pending stays cleared.
    act(() => desktop.store.set('p3'))
    expect(screen.queryByTestId('ticket-modal')).toBeNull()
    act(() => desktop.store.set('p2'))
    expect(screen.queryByTestId('ticket-modal')).toBeNull()
  })
})
