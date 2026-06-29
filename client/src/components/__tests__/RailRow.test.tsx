import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '../../test-utils'
import { DndContext } from '@dnd-kit/core'
import { RailRow } from '../RailRow'
import type { LocalTicket } from '../../types'

const defaultProps = {
  id: 'rail-1',
  label: 'Rail 1',
  tickets: [] as LocalTicket[],
  mode: 'implement' as const,
  status: 'idle' as const,
  jiggleMode: false,
  onModeChange: vi.fn(),
  onToggle: vi.fn(),
  onTicketClick: vi.fn(),
  onDelete: vi.fn(),
  onLongPress: vi.fn(),
  onRename: vi.fn(),
}

function renderRailRow(props = defaultProps) {
  return render(
    <DndContext>
      <RailRow {...props} />
    </DndContext>
  )
}

describe('RailRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders label', () => {
    renderRailRow()
    expect(screen.getByText('Rail 1')).toBeInTheDocument()
  })

  it('shows empty drop zone when no tickets', () => {
    renderRailRow()
    expect(screen.getByText('Drag specs here')).toBeInTheDocument()
  })

  it('clicking label enters edit mode', () => {
    renderRailRow()
    const labelBtn = screen.getByRole('button', { name: 'Rail 1' })
    fireEvent.click(labelBtn)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('onChange updates input value', () => {
    renderRailRow()
    fireEvent.click(screen.getByRole('button', { name: 'Rail 1' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '2' } })
    expect((input as HTMLInputElement).value).toBe('2')
  })

  it('submit form calls onRename', () => {
    const onRename = vi.fn()
    renderRailRow({ ...defaultProps, onRename })
    fireEvent.click(screen.getByRole('button', { name: 'Rail 1' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.submit(input.closest('form')!)
    expect(onRename).toHaveBeenCalledWith('2')
  })

  it('Escape key cancels editing', () => {
    renderRailRow()
    fireEvent.click(screen.getByRole('button', { name: 'Rail 1' }))
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('blur calls onRename with current value', () => {
    const onRename = vi.fn()
    renderRailRow({ ...defaultProps, onRename })
    fireEvent.click(screen.getByRole('button', { name: 'Rail 1' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith('New Name')
  })

  it('shows live execution metrics in the normal layout when running, hidden when idle', () => {
    const running = renderRailRow({
      ...defaultProps,
      status: 'running' as const,
      executionMetric: { startedAt: Date.now() - 5000, steps: 3, lines: 42 },
    })
    // scope to this render's container (testing-library doesn't clean up between renders in one test)
    const info = running.container.querySelector('[data-testid="rail-exec-info"]')
    expect(info).not.toBeNull()
    expect(info!.textContent).toContain('3')   // steps
    expect(info!.textContent).toContain('42')  // lines

    const idle = renderRailRow({ ...defaultProps, status: 'idle' as const, executionMetric: { startedAt: Date.now(), steps: 1, lines: 1 } })
    expect(idle.container.querySelector('[data-testid="rail-exec-info"]')).toBeNull()
  })

  it('delete button calls onDelete in jiggle mode', () => {
    const onDelete = vi.fn()
    const { container } = renderRailRow({ ...defaultProps, jiggleMode: true, onDelete })
    // Jiggle delete button has only a Trash2 icon, no text — find by svg
    const svgs = container.querySelectorAll('button svg')
    const deleteBtn = Array.from(svgs).map(s => s.closest('button')!).find(
      b => b.classList.contains('bg-red-500')
    )
    expect(deleteBtn).toBeDefined()
    fireEvent.click(deleteBtn!)
    expect(onDelete).toHaveBeenCalled()
  })

  it('running status disables delete', () => {
    renderRailRow({ ...defaultProps, status: 'running', jiggleMode: true })
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })

  describe('compact density', () => {
    it('renders the compact mini-card variant', () => {
      const { container } = renderRailRow({ ...defaultProps, density: 'compact' } as any)
      const card = container.querySelector('[data-testid="rail-row-compact-rail-1"]')
      expect(card).toBeInTheDocument()
      expect(card).toHaveAttribute('data-density', 'compact')
    })

    it('keeps the label clickable for rename in compact mode', () => {
      renderRailRow({ ...defaultProps, density: 'compact' } as any)
      const labelBtn = screen.getByRole('button', { name: 'Rail 1' })
      fireEvent.click(labelBtn)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('omits the drop zone in compact mode', () => {
      renderRailRow({ ...defaultProps, density: 'compact' } as any)
      expect(screen.queryByText('Drag specs here')).not.toBeInTheDocument()
    })

    it('renders clickable id pills for each assigned ticket and opens via onTicketClick', () => {
      const onTicketClick = vi.fn()
      const tickets: LocalTicket[] = [
        { id: 19, title: 'Training Mode', description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'u', source: 'manual' },
        { id: 54, title: 'Audio capture', description: '', status: 'todo', priority: 'high', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'u', source: 'manual' },
      ]
      renderRailRow({ ...defaultProps, density: 'compact', tickets, onTicketClick } as any)
      const pillContainer = screen.getByTestId('rail-row-compact-tickets-rail-1')
      const pill19 = within(pillContainer).getByRole('button', { name: /#19/ })
      const pill54 = within(pillContainer).getByRole('button', { name: /#54/ })
      expect(pill19).toBeInTheDocument()
      expect(pill54).toBeInTheDocument()
      fireEvent.click(pill54)
      expect(onTicketClick).toHaveBeenCalledWith(tickets[1])
    })

    it('renders a destructive delete button in jiggle mode', () => {
      const onDelete = vi.fn()
      const { container } = renderRailRow({
        ...defaultProps,
        density: 'compact',
        jiggleMode: true,
        onDelete,
      } as any)
      const btn = within(container).getByRole('button', { name: /Delete Rail 1/i })
      fireEvent.click(btn)
      expect(onDelete).toHaveBeenCalled()
    })
  })

  describe('custom loop model picker', () => {
    it('renders a loop model picker only when mode is loop (custom loop) and not for factory modes', () => {
      // Custom loop — model picker must appear.
      const { rerender } = renderRailRow({
        ...defaultProps,
        mode: 'loop' as const,
        selectedLoopId: 'custom-uuid-123',
        onLoopModelChange: vi.fn(),
      } as any)
      expect(screen.getByTestId('loop-model-selector')).toBeInTheDocument()

      // Factory mode (implement) — model picker must NOT appear.
      rerender(
        <DndContext>
          <RailRow {...defaultProps} mode="implement" onLoopModelChange={vi.fn()} />
        </DndContext>
      )
      expect(screen.queryByTestId('loop-model-selector')).not.toBeInTheDocument()
    })
  })
})
