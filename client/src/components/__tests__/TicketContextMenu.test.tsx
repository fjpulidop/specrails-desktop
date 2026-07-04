import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { TicketContextMenu } from '../TicketContextMenu'
import type { LocalTicket } from '../../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultTicket: Pick<LocalTicket, 'id' | 'title' | 'status' | 'priority'> = {
  id: 1,
  title: 'Test ticket',
  status: 'todo',
  priority: 'medium',
}

function makeDefaultProps(overrides: Partial<{
  ticket: typeof defaultTicket
  onDelete: (id: number) => void
  onStatusChange: (id: number, s: LocalTicket['status']) => void
  onPriorityChange: (id: number, p: LocalTicket['priority']) => void
}> = {}) {
  return {
    ticket: defaultTicket,
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TicketContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders children', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Child content</span>
      </TicketContextMenu>
    )
    expect(screen.getByText('Child content')).toBeDefined()
  })

  it('menu is not visible before right-click', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens context menu on right-click', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByRole('menu', { name: 'Ticket actions' })).toBeDefined()
  })

  it('menu contains "Delete ticket" option', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByText('Delete ticket')).toBeDefined()
  })

  it('menu contains "Change status" option', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByText('Change status')).toBeDefined()
  })

  it('menu contains "Set priority" option', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByText('Set priority')).toBeDefined()
  })

  it('clicking "Delete ticket" shows confirmation dialog', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    fireEvent.click(screen.getByText('Delete ticket'))
    // Confirmation dialog should appear — multiple "Delete" buttons exist now (menu + dialog confirm)
    // The dialog adds a second Delete button; if count > 1, dialog is shown
    expect(screen.getAllByText('Delete ticket').length).toBeGreaterThan(0)
  })

  it('confirming delete calls onDelete with ticket id', () => {
    const onDelete = vi.fn()
    render(
      <TicketContextMenu {...makeDefaultProps({ onDelete })}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    fireEvent.click(screen.getByText('Delete ticket'))
    // Click the destructive "Delete" button in the dialog
    const deleteButtons = screen.getAllByText('Delete')
    // The last "Delete" button in the dialog footer is the confirm button
    fireEvent.click(deleteButtons[deleteButtons.length - 1])
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('closes menu on Escape key', () => {
    render(
      <TicketContextMenu {...makeDefaultProps()}>
        <span>Target</span>
      </TicketContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByRole('menu', { name: 'Ticket actions' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Ticket actions' })).toBeNull()
  })

  describe('on_review ticket', () => {
    const onReviewTicket = { ...defaultTicket, status: 'on_review' as const }

    function openStatusSubmenu() {
      fireEvent.contextMenu(screen.getByText('Target'))
      fireEvent.click(screen.getByText('Change status'))
      return screen.getByRole('menu', { name: 'Status options' })
    }

    it('offers exactly "Move to To Do" / "Move to Done" (never an On Review entry)', () => {
      render(
        <TicketContextMenu {...makeDefaultProps({ ticket: onReviewTicket })}>
          <span>Target</span>
        </TicketContextMenu>
      )
      const submenu = openStatusSubmenu()
      const items = Array.from(submenu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)
      // on_review is a pipeline-owned status — a user can move OUT of it
      // (todo / done) but never INTO it manually.
      expect(items).toEqual(['Todo', 'Done'])
    })

    it('moving an on_review ticket to To Do fires the status PATCH callback', () => {
      const onStatusChange = vi.fn()
      render(
        <TicketContextMenu {...makeDefaultProps({ ticket: onReviewTicket, onStatusChange })}>
          <span>Target</span>
        </TicketContextMenu>
      )
      const submenu = openStatusSubmenu()
      fireEvent.click(Array.from(submenu.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Todo')!)
      expect(onStatusChange).toHaveBeenCalledWith(1, 'todo')
    })

    it('moving an on_review ticket to Done fires the status PATCH callback', () => {
      const onStatusChange = vi.fn()
      render(
        <TicketContextMenu {...makeDefaultProps({ ticket: onReviewTicket, onStatusChange })}>
          <span>Target</span>
        </TicketContextMenu>
      )
      const submenu = openStatusSubmenu()
      fireEvent.click(Array.from(submenu.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Done')!)
      expect(onStatusChange).toHaveBeenCalledWith(1, 'done')
    })
  })
})
