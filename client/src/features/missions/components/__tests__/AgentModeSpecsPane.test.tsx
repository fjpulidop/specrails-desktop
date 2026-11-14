import { composerDrafts, composerReferenceDrafts, writeComposerDraft, clearSubmittedComposerDraft } from '../../lib/agent-composer-drafts'
import { SPEC_DRAG_TYPE, readSpecDrag, insertDroppedSpec } from '../../lib/agent-spec-drag'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { LocalTicket, TicketStatus } from '../../../../types'
import { AgentModeSpecsPane, groupSpecs } from '../AgentModeSpecsPane'

const state = vi.hoisted(() => ({
  tickets: [] as unknown[],
  newTicketIds: new Set<number>(),
  isLoading: false,
  openTicketDetail: vi.fn(),
  closeSpecsPane: vi.fn(),
}))
vi.mock('../../../specs/hooks/useTickets', () => ({
  useTickets: () => ({ tickets: state.tickets, isLoading: state.isLoading, newTicketIds: state.newTicketIds }),
}))
vi.mock('../../../specs/context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail: state.openTicketDetail }),
}))
vi.mock('../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({ closeSpecsPane: state.closeSpecsPane }),
}))

function spec(id: number, status: TicketStatus, title = `Spec ${id}`): LocalTicket {
  return { id, title, status } as LocalTicket
}

describe('AgentModeSpecsPane', () => {
  it('blocks native text selection during resize and restores it on completion or unmount', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    const view = render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    try {
      const handle = screen.getByRole('separator')
      const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 500 })
      fireEvent(handle, down)
      expect(down.defaultPrevented).toBe(true)
      expect(document.body.style.userSelect).toBe('none')
      expect(document.body.style.cursor).toBe('col-resize')
      const select = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(select)
      expect(select.defaultPrevented).toBe(true)
      const pane = handle.parentElement as HTMLElement
      const width = Number.parseFloat(pane.style.width)
      fireEvent.pointerMove(window, { clientX: 480 })
      expect(Number.parseFloat(pane.style.width)).toBe(width + 20)
      fireEvent.pointerUp(window)
      expect(document.body.style.userSelect).toBe(previousSelect)
      expect(document.body.style.cursor).toBe(previousCursor)
      const normalSelect = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(normalSelect)
      expect(normalSelect.defaultPrevented).toBe(false)
      fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
      fireEvent.blur(window)
      expect(document.body.style.userSelect).toBe(previousSelect)
      fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
      view.unmount()
      expect(document.body.style.userSelect).toBe(previousSelect)
      expect(document.body.style.cursor).toBe(previousCursor)
    } finally {
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('anchors the resize handle inside the pane across its full height', () => {
    render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    const handle = screen.getByRole('separator')
    expect(handle.parentElement).toHaveClass('relative')
    expect(handle).toHaveClass('absolute', 'inset-y-0', 'left-0', 'z-20')
    expect(handle).not.toHaveClass('-translate-x-full')
    fireEvent.click(screen.getByLabelText('Maximize'))
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Restore'))
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    composerDrafts.clear()
    composerReferenceDrafts.clear()
    state.tickets = []
    state.isLoading = false
    state.newTicketIds = new Set()
  })

  it('drags a spec into the mission draft, hides it, and restores it after removal or send', () => {
    state.tickets = [spec(9, 'todo', 'Drag me')]
    render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    const data = new Map<string, string>()
    const dataTransfer = { effectAllowed: '', setData: (type: string, value: string) => data.set(type, value) }
    const row = screen.getByRole('button', { name: /Drag me/ })
    expect(row).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(row, { dataTransfer })
    const chip = readSpecDrag(data.get(SPEC_DRAG_TYPE)!, 'mission-1', 'p1')!
    expect(chip.id).toBe('9')
    act(() => { insertDroppedSpec('mission-1', chip, 0) })
    expect(screen.queryByRole('button', { name: /Drag me/ })).not.toBeInTheDocument()
    act(() => { writeComposerDraft('mission-1', '', []) })
    expect(screen.getByRole('button', { name: /Drag me/ })).toBeInTheDocument()
    act(() => { insertDroppedSpec('mission-1', chip, 0) })
    act(() => { clearSubmittedComposerDraft('mission-1', {
      text: composerDrafts.get('mission-1')!, references: composerReferenceDrafts.get('mission-1')!, attachments: [],
    }) })
    expect(screen.getByRole('button', { name: /Drag me/ })).toBeInTheDocument()
  })

  it('keeps references in other projects and missions from hiding local specs', () => {
    state.tickets = [spec(9, 'todo', 'Local spec')]
    writeComposerDraft('mission-1', '@Other', [{ key: 'other', start: 0, end: 6, chip: {
      kind: 'spec', id: '9', label: 'Other', token: '@Other', projectId: 'p2',
    } }])
    const view = render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    expect(screen.getByRole('button', { name: /Local spec/ })).toBeInTheDocument()
    view.rerender(<AgentModeSpecsPane projectId="p2" draftKey="mission-2" />)
    expect(screen.getByRole('button', { name: /Local spec/ })).toBeInTheDocument()
  })

  it('animates new arrivals but not the initial load or status updates', () => {
    state.isLoading = true
    const view = render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    state.tickets = [spec(1, 'todo', 'Existing')]
    state.isLoading = false
    view.rerender(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    expect(view.container.querySelector('[data-spec-arriving]')).toBeNull()
    state.tickets = [spec(1, 'in_progress', 'Existing'), spec(2, 'todo', 'New arrival')]
    state.newTicketIds = new Set([2])
    view.rerender(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    expect(screen.getByRole('button', { name: /New arrival/ }).parentElement).toHaveAttribute('data-spec-arriving', 'true')
    expect(screen.getByRole('button', { name: /Existing/ }).parentElement).not.toHaveAttribute('data-spec-arriving')
  })

  it('orders open specs by progress and separates closed ones', () => {
    const { open, closed } = groupSpecs([
      spec(1, 'done'), spec(2, 'todo'), spec(3, 'in_progress'), spec(4, 'cancelled'), spec(5, 'on_review'), spec(6, 'draft'), spec(7, 'todo'),
    ])
    expect(open.map((s) => s.id)).toEqual([3, 5, 7, 2, 6])
    expect(closed.map((s) => s.id)).toEqual([4, 1])
  })

  it('lists open specs with their status and keeps closed specs collapsed until expanded', () => {
    state.tickets = [spec(1, 'done', 'Shipped thing'), spec(2, 'todo', 'Pending thing'), spec(3, 'in_progress', 'Running thing')]
    render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)

    const running = screen.getByRole('button', { name: /Running thing/ })
    expect(within(running).getByText('#3')).toBeInTheDocument()
    expect(within(running).getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pending thing/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Shipped thing/ })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /Closed/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Shipped thing/ })).toBeInTheDocument()
  })

  it('opens the spec detail when a spec is clicked', () => {
    state.tickets = [spec(9, 'on_review', 'Review me')]
    render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    fireEvent.click(screen.getByRole('button', { name: /Review me/ }))
    expect(state.openTicketDetail).toHaveBeenCalledWith(9)
  })

  it('shows the empty state when the project has no specs and closes from the header', () => {
    render(<AgentModeSpecsPane projectId="p1" draftKey="mission-1" />)
    expect(screen.getByText('No specs yet — ask the agent to create one')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close specs' }))
    expect(state.closeSpecsPane).toHaveBeenCalled()
  })
})
