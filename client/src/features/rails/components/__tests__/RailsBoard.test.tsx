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

describe('RailsBoard loop model wiring', () => {
  it('passes loopModel and onLoopModelChange through to RailRow so the loop model selector renders', () => {
    const onLoopModelChange = vi.fn()
    const rails: RailState[] = [
      {
        id: 'rail-loop',
        label: 'Loop Rail',
        ticketIds: [],
        mode: 'loop',
        status: 'idle',
        loopModel: 'haiku',
      },
    ]
    const { container } = render(
      <MemoryRouter>
        <DndContext>
          <RailsBoard
            rails={rails}
            ticketMap={new Map()}
            onModeChange={noop}
            onToggle={noop}
            onTicketClick={noop}
            onAddRail={noop}
            onDeleteRail={noop}
            onRenameRail={noop}
            onLoopModelChange={onLoopModelChange}
          />
        </DndContext>
      </MemoryRouter>,
    )
    expect(container.querySelector('[data-testid="loop-model-selector"]')).not.toBeNull()
  })
})

describe('RailsBoard execution-metric mapping', () => {
  // Rails are server-backed now: launches/stops/config all target the SERVER
  // railIndex derived from the rail id (`rail-N` ↔ N-1), so metric events come
  // back keyed by that same index — identity mapping, immune to board reorder
  // and middle-rail deletion (the old positional mapping broke both).
  it('keys metrics by the id-derived SERVER railIndex, not array position', () => {
    const rails: RailState[] = [
      { id: 'rail-1', label: 'A', ticketIds: [], mode: 'loop', status: 'idle' },
      { id: 'rail-4', label: 'B', ticketIds: [], mode: 'loop', status: 'running' },
    ]
    // Metric belongs to rail-4 = server railIndex 3 (its array position is 1).
    const { container } = renderBoard(rails, { 3: { startedAt: Date.now() - 3000, steps: 2, lines: 9 } })
    const infos = container.querySelectorAll('[data-testid="rail-exec-info"]')
    expect(infos).toHaveLength(1) // only the running rail shows it
    expect(infos[0].textContent).toContain('2') // steps
    expect(infos[0].textContent).toContain('9') // lines
  })

  it('a metric keyed by the running rail\'s ARRAY POSITION no longer matches it', () => {
    const rails: RailState[] = [
      { id: 'rail-1', label: 'A', ticketIds: [], mode: 'loop', status: 'idle' },
      { id: 'rail-4', label: 'B', ticketIds: [], mode: 'loop', status: 'running' },
    ]
    const { container } = renderBoard(rails, { 1: { startedAt: Date.now() - 3000, steps: 2, lines: 9 } })
    expect(container.querySelectorAll('[data-testid="rail-exec-info"]')).toHaveLength(0)
  })
})
