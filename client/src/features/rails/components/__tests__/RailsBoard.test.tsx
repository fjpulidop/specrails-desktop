import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DndContext } from '@dnd-kit/core'
import { screen, fireEvent } from '@testing-library/react'
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

describe('RailsBoard toolbar', () => {
  const rail = (n: number, status: RailState['status'] = 'idle'): RailState => ({
    id: `rail-${n}`, label: `Rail ${n}`, ticketIds: [], mode: 'implement', status,
  })
  function renderToolbar(rails: RailState[], extra: Partial<React.ComponentProps<typeof RailsBoard>> = {}) {
    return render(
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
            {...extra}
          />
        </DndContext>
      </MemoryRouter>,
    )
  }

  it('summarises running, ready and failed rails and omits zero items', () => {
    renderToolbar([rail(1, 'running'), rail(2, 'failed'), rail(3), rail(4)], { onLaunchAll: noop, launchAllCount: 2 })
    expect(screen.getByTestId('rails-summary')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('rails-summary-running')).toHaveTextContent('1 running')
    expect(screen.getByTestId('rails-summary-ready')).toHaveTextContent('2 ready')
    expect(screen.getByTestId('rails-summary-failed')).toHaveTextContent('1 failed')
    expect(screen.getByTestId('rails-summary-total')).toHaveTextContent('4 rails')
  })

  it('omits zero summary items but always shows the total', () => {
    renderToolbar([rail(1)])
    expect(screen.queryByTestId('rails-summary-running')).toBeNull()
    expect(screen.queryByTestId('rails-summary-ready')).toBeNull()
    expect(screen.queryByTestId('rails-summary-failed')).toBeNull()
    expect(screen.getByTestId('rails-summary-total')).toHaveTextContent('1 rail')
  })

  it('disables Add rail at the rail limit and explains why', () => {
    const onAddRail = vi.fn()
    renderToolbar(Array.from({ length: 12 }, (_, i) => rail(i + 1)), { onAddRail })
    const add = screen.getByTestId('rails-add')
    expect(add).toBeDisabled()
    expect(screen.getByText('Rail limit reached (12 max)')).toBeInTheDocument()
    fireEvent.click(add)
    expect(onAddRail).not.toHaveBeenCalled()
  })

  it('Add rail is enabled below the limit and calls onAddRail', () => {
    const onAddRail = vi.fn()
    renderToolbar([rail(1)], { onAddRail })
    fireEvent.click(screen.getByTestId('rails-add'))
    expect(onAddRail).toHaveBeenCalledTimes(1)
  })

  it('Launch all is the filled primary with its ready-count badge', () => {
    const onLaunchAll = vi.fn()
    renderToolbar([rail(1), rail(2)], { onLaunchAll, launchAllCount: 2 })
    const launch = screen.getByTestId('rails-launch-all')
    expect(launch).not.toBeDisabled()
    expect(launch.className).toMatch(/bg-accent-success/)
    expect(screen.getByTestId('rails-launch-all-count')).toHaveTextContent('2')
    fireEvent.click(launch)
    expect(onLaunchAll).toHaveBeenCalled()
  })
})
