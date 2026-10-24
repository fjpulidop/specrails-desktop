import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  it('is a labelled Radix modal on the entity layer with a named resize separator', () => {
    renderShell()
    const dialog = screen.getByRole('dialog', { name: 'Compare specs' })
    expect(dialog).toHaveAttribute('data-dialog-layer', 'entity')
    expect(dialog.classList.contains('z-[65]')).toBe(true)
    expect(screen.getByRole('separator', { name: 'Resize panels' })).toBeInTheDocument()
  })

  it('traps focus inside the shell', async () => {
    const user = userEvent.setup()
    renderShell()
    const dialog = screen.getByRole('dialog', { name: 'Compare specs' })
    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('returns focus to the trigger when the shell closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open split</button>
          {open && (
            <SplitViewShell
              state={{ leftId: 1, rightId: null, originSide: 'left', splitRatio: 0.5 } as never}
              leftTicket={ticket}
              rightTicket={null}
              allTickets={[ticket]}
              allLabels={[]}
              onSave={vi.fn()}
              onDelete={vi.fn()}
              onOpenTicket={vi.fn()}
              onCloseAll={() => setOpen(false)}
              onSetCompared={vi.fn()}
              onSetRatio={vi.fn()}
              onExitSplit={vi.fn()}
            />
          )}
        </>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open split' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Compare specs' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
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
