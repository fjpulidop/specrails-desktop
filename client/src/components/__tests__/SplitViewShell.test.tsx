import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SplitViewShell } from '../SplitViewShell'
import type { LocalTicket } from '../../types'

vi.mock('../../features/specs/components/TicketDetailModal', () => ({
  TicketDetailModal: ({ ticket }: { ticket: LocalTicket }) => (
    <div>
      <span>{ticket.title}</span>
      <input aria-label="inline editor" />
    </div>
  ),
}))

vi.mock('../../features/specs/components/SpecComparePicker', () => ({
  SpecComparePicker: () => <div data-testid="compare-picker" />,
}))

const ticket = { id: 1, title: 'Left spec' } as LocalTicket

function renderShell() {
  const onCloseAll = vi.fn()
  render(
    <SplitViewShell
      state={{ leftId: 1, rightId: null, originSide: 'left', splitRatio: 0.5 } as never}
      leftTicket={ticket}
      rightTicket={null}
      allTickets={[ticket]}
      allLabels={[]}
      onSave={vi.fn()}
      onDelete={vi.fn()}
      onOpenTicket={vi.fn()}
      onCloseAll={onCloseAll}
      onSetCompared={vi.fn()}
      onSetRatio={vi.fn()}
      onExitSplit={vi.fn()}
    />,
  )
  return { onCloseAll }
}

describe('SplitViewShell semantics', () => {
  it('is a labelled modal dialog with a named resize separator', () => {
    renderShell()
    const dialog = screen.getByRole('dialog', { name: 'Compare specs' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('separator', { name: 'Resize panels' })).toBeInTheDocument()
  })

  it('closes both panels on Escape', () => {
    const { onCloseAll } = renderShell()
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Escape' })
    expect(onCloseAll).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an inline editor while typing', () => {
    const { onCloseAll } = renderShell()
    fireEvent.keyDown(screen.getByLabelText('inline editor'), { key: 'Escape' })
    expect(onCloseAll).not.toHaveBeenCalled()
  })
})
