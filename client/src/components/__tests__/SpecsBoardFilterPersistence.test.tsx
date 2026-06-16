import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '../../test-utils'
import type { LocalTicket } from '../../types'

// Control the active project id the board sees, so we can simulate switches
// and remounts (app close/reopen) while localStorage persists between them.
const h = vi.hoisted(() => ({ activeId: 'proj-A' as string | null }))
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [],
    activeProjectId: h.activeId,
    setActiveProjectId: () => {},
    addProject: async () => null,
    removeProject: async () => {},
    isLoading: false,
    isSwitchingProject: false,
    setupProjectIds: new Set(),
    startSetupWizard: () => {},
    completeSetupWizard: () => {},
  }),
}))

vi.mock('@dnd-kit/core', () => ({ useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }) }))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } }))
vi.mock('../ProposeSpecModal', () => ({ ProposeSpecModal: () => null }))

import { SpecsBoard } from '../SpecsBoard'

function makeTicket(id: number, title: string, epicKey?: string, epicName?: string): LocalTicket {
  return {
    id, title, description: '', status: 'todo', priority: 'medium', labels: [], assignee: null,
    prerequisites: [], metadata: {}, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester', source: epicKey ? 'jira' : 'manual',
    ...(epicKey ? { jira_epic_key: epicKey, jira_epic_name: epicName ?? epicKey } : {}),
  }
}

const tickets = [
  makeTicket(1, 'Auth spec', 'PROJ-100', 'Authentication'),
  makeTicket(2, 'Billing spec', 'PROJ-200', 'Billing'),
]

const onTicketClick = vi.fn()

function renderBoard() {
  return render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
}

describe('SpecsBoard filter persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    h.activeId = 'proj-A'
  })

  it('restores the epic filter after a remount (app close/reopen)', () => {
    renderBoard()
    // Pick the Authentication epic → Billing disappears.
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Authentication/ }))
    expect(screen.queryByText('Billing spec')).toBeNull()

    // Simulate app close/reopen: unmount + fresh mount, same project.
    cleanup()
    renderBoard()

    // Filter survived: still scoped to Authentication.
    expect(screen.getByText('Auth spec')).toBeInTheDocument()
    expect(screen.queryByText('Billing spec')).toBeNull()
  })

  it('persisted the filter to a per-project localStorage key', () => {
    renderBoard()
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Authentication/ }))
    expect(localStorage.getItem('specrails-desktop:spec-filters:proj-A')).toContain('PROJ-100')
  })

  it('keeps filters separate per project on switch', () => {
    const { rerender } = renderBoard()
    // Filter proj-A to Authentication.
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Authentication/ }))
    expect(screen.queryByText('Billing spec')).toBeNull()

    // Switch to proj-B (no saved filter) → all specs visible.
    h.activeId = 'proj-B'
    rerender(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByText('Auth spec')).toBeInTheDocument()
    expect(screen.getByText('Billing spec')).toBeInTheDocument()

    // Switch back to proj-A → its filter is restored.
    h.activeId = 'proj-A'
    rerender(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByText('Auth spec')).toBeInTheDocument()
    expect(screen.queryByText('Billing spec')).toBeNull()
  })

  it('clearing the filter removes the persisted key', () => {
    renderBoard()
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Authentication/ }))
    expect(localStorage.getItem('specrails-desktop:spec-filters:proj-A')).not.toBeNull()
    // Re-open and choose "All epics".
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-epic-filter-all'))
    expect(localStorage.getItem('specrails-desktop:spec-filters:proj-A')).toBeNull()
  })
})
