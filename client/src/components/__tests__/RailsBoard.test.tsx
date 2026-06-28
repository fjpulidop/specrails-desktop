import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DndContext } from '@dnd-kit/core'
import { RailsBoard, type RailState } from '../RailsBoard'

const noop = vi.fn()
function renderBoard(rails: RailState[], railMetrics: Record<number, { startedAt: number; steps: number; lines: number }> = {}) {
  return render(
    <MemoryRouter>
    <DndContext>
      <RailsBoard
        rails={rails}
        ticketMap={new Map()}
        railMetrics={railMetrics}
        onModeChange={noop}
        onToggle={noop}
        onTicketClick={noop}
        onAddRail={noop}
        onDeleteRail={noop}
        onRenameRail={noop}
      />
    </DndContext>
    </MemoryRouter>,
  )
}

describe('RailsBoard execution-metric mapping', () => {
  it('keys metrics by ARRAY INDEX, not by parsing rail.id (non-sequential ids after delete+add)', () => {
    const rails: RailState[] = [
      { id: 'rail-1', label: 'A', ticketIds: [], mode: 'loop', status: 'idle' },
      { id: 'rail-4', label: 'B', ticketIds: [], mode: 'loop', status: 'running' },
    ]
    // Metric belongs to the 2nd rail = array index 1. The old code parsed 'rail-4'
    // → index 3 and missed it entirely.
    const { container } = renderBoard(rails, { 1: { startedAt: Date.now() - 3000, steps: 2, lines: 9 } })
    const infos = container.querySelectorAll('[data-testid="rail-exec-info"]')
    expect(infos).toHaveLength(1) // only the running rail shows it
    expect(infos[0].textContent).toContain('2') // steps
    expect(infos[0].textContent).toContain('9') // lines
  })
})
