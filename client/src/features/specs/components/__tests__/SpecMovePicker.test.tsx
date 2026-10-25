import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor, act } from '../../../../test-utils'
import { useLocation } from 'react-router-dom'
import type { LocalTicket } from '../../../../types'
import type { SpecBulkHandlers } from '../../lib/bulk-actions'
import { getPaletteSurface, resetPaletteSurfaces } from '../../../../lib/palette-bridge'

const h = vi.hoisted(() => ({ activeId: 'proj-A' as string | null }))
const toasts = vi.hoisted(() => ({ fn: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: toasts.fn }))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [], activeProjectId: h.activeId, setActiveProjectId: () => {}, addProject: async () => null, removeProject: async () => {},
    isLoading: false, isSwitchingProject: false, setupProjectIds: new Set(), startSetupWizard: () => {}, completeSetupWizard: () => {},
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

function ticket(id: number, overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id, title: `Spec ${id}`, description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {},
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', created_by: 'tester', source: 'manual', ...overrides,
  }
}

function handlers(overrides: Partial<SpecBulkHandlers> = {}): SpecBulkHandlers {
  return {
    jiraConnected: false,
    loadJiraStatuses: vi.fn(async () => ['To Do', 'Code Review']),
    allLabels: ['bug', 'ui'],
    onStatus: vi.fn(async () => {}),
    onLabel: vi.fn(async () => {}),
    onPriority: vi.fn(async () => {}),
    onMoveToRail: vi.fn(),
    onLaunch: vi.fn(),
    onDelete: vi.fn(async () => {}),
    ...overrides,
  }
}

const RAILS = [
  { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement' as const, status: 'idle' as const },
  { id: 'rail-2', label: 'Rail 2', ticketIds: [9], mode: 'implement' as const, status: 'running' as const },
]

function Probe() {
  const loc = useLocation()
  return <output data-testid="loc">{loc.search}</output>
}

const TODO = [ticket(1), ticket(2), ticket(3), ticket(4)]
const DONE = [ticket(20, { status: 'done' }), ticket(21, { status: 'done' })]

function renderBoard(opts: { bulk?: SpecBulkHandlers; tickets?: LocalTicket[]; doneTickets?: LocalTicket[]; route?: string; onTicketClick?: (t: LocalTicket) => void; viewTier?: 'row' | 'postit'; onSortChange?: () => void; onViewTierChange?: (t: 'row' | 'postit') => void } = {}) {
  const bulk = opts.bulk ?? handlers()
  const onTicketClick = opts.onTicketClick ?? vi.fn()
  const view = render(
    <>
      <SpecsBoard
        tickets={opts.tickets ?? TODO}
        doneTickets={opts.doneTickets ?? []}
        isLoading={false}
        onTicketClick={onTicketClick}
        viewTier={opts.viewTier ?? 'row'}
        onViewTierChange={opts.onViewTierChange}
        onSortChange={opts.onSortChange}
        rails={RAILS}
        bulk={bulk}
      />
      <Probe />
    </>,
    { route: opts.route },
  )
  return { ...view, bulk, onTicketClick }
}

const card = (id: number) => document.querySelector<HTMLElement>(`[data-ticket-id="${id}"]`)!
const bar = () => screen.queryByTestId('specs-bulk-bar')
const selectedIds = () => [...document.querySelectorAll<HTMLElement>('[data-ticket-id][aria-selected="true"]')].map((el) => Number(el.dataset.ticketId))


describe('SpecsBoard keyboard move picker (BB4)', () => {
  beforeEach(() => {
    localStorage.clear()
    h.activeId = 'proj-A'
    resetPaletteSurfaces()
  })

  const picker = () => screen.queryByTestId('spec-move-picker')

  it('m on a focused card opens a picker with the status targets and the rails', () => {
    renderBoard()
    fireEvent.keyDown(card(2), { key: 'm' })
    const dialog = screen.getByTestId('spec-move-picker')
    expect(within(dialog).getByText('Move spec #2')).toBeInTheDocument()
    for (const st of ['todo', 'in_progress', 'done', 'cancelled']) expect(within(dialog).getByTestId(`move-picker-status-${st}`)).toBeInTheDocument()
    expect(within(dialog).getByTestId('move-picker-rail-rail-1')).toBeInTheDocument()
    expect(within(dialog).getByTestId('move-picker-rail-rail-2')).toHaveTextContent('Running')
  })

  it('picking a status runs the same handler as the bulk bar and closes the picker', () => {
    const { bulk } = renderBoard()
    fireEvent.keyDown(card(2), { key: 'm' })
    fireEvent.click(screen.getByTestId('move-picker-status-done'))
    expect(bulk.onStatus).toHaveBeenCalledWith([2], { kind: 'local', status: 'done' })
    expect(picker()).toBeNull()
  })

  it('picking a rail hands the spec to the board rail handler', () => {
    const { bulk } = renderBoard()
    fireEvent.keyDown(card(3), { key: 'm' })
    fireEvent.click(screen.getByTestId('move-picker-rail-rail-1'))
    expect(bulk.onMoveToRail).toHaveBeenCalledWith([3], 'rail-1')
    expect(picker()).toBeNull()
  })

  it('moves the whole multi-selection when the focused card belongs to it', () => {
    const { bulk } = renderBoard()
    fireEvent.keyDown(card(1), { key: 'x' })
    fireEvent.keyDown(card(2), { key: 'x' })
    fireEvent.keyDown(card(2), { key: 'm' })
    expect(within(screen.getByTestId('spec-move-picker')).getByText('Move 2 specs')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('move-picker-rail-rail-1'))
    expect(bulk.onMoveToRail).toHaveBeenCalledWith([1, 2], 'rail-1')
  })

  it('moves only the focused card when it is outside the selection', () => {
    const { bulk } = renderBoard()
    fireEvent.keyDown(card(1), { key: 'x' })
    fireEvent.keyDown(card(2), { key: 'x' })
    fireEvent.keyDown(card(4), { key: 'm' })
    fireEvent.click(screen.getByTestId('move-picker-status-cancelled'))
    expect(bulk.onStatus).toHaveBeenCalledWith([4], { kind: 'local', status: 'cancelled' })
  })

  it('offers Jira workflow statuses for a Jira-backed spec and moves it through the Jira path', async () => {
    const jira = ticket(7, { source: 'jira', jira_key: 'PRJ-7' } as Partial<LocalTicket>)
    const { bulk } = renderBoard({ bulk: handlers({ jiraConnected: true }), tickets: [ticket(1), jira] })
    fireEvent.keyDown(card(7), { key: 'm' })
    const dialog = screen.getByTestId('spec-move-picker')
    expect(within(dialog).queryByTestId('move-picker-status-done')).toBeNull()
    fireEvent.click(await within(dialog).findByTestId('move-picker-jira-Code Review'))
    expect(bulk.onStatus).toHaveBeenCalledWith([7], { kind: 'jira', status: 'Code Review' })
  })

  it('does nothing while typing, with a modifier, or without bulk handlers', () => {
    renderBoard()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'm' })
    fireEvent.keyDown(card(1), { key: 'm', metaKey: true })
    fireEvent.keyDown(card(1), { key: 'm', shiftKey: true })
    expect(picker()).toBeNull()
  })

  it('does nothing on a board without bulk handlers', () => {
    render(<SpecsBoard tickets={TODO} isLoading={false} onTicketClick={vi.fn()} viewTier="row" />)
    fireEvent.keyDown(card(1), { key: 'm' })
    expect(picker()).toBeNull()
  })

  it('is reachable from the palette after a card was focused', () => {
    renderBoard()
    const specs = () => getPaletteSurface('specs')!
    expect(specs().canMoveFocused()).toBe(false)
    act(() => { card(3).focus() })
    expect(specs().canMoveFocused()).toBe(true)
    act(() => { specs().openMovePicker() })
    expect(within(screen.getByTestId('spec-move-picker')).getByText('Move spec #3')).toBeInTheDocument()
  })
})
