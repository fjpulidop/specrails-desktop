import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Popover } from '../popover'

afterEach(() => cleanup())

const mount = (onOpenChange?: (open: boolean) => void) => render(<>
  <Popover label="Panel" onOpenChange={onOpenChange} trigger={<button type="button">Open</button>}><button type="button">Inside</button></Popover>
  <button type="button">Outside</button>
</>)

describe('Popover', () => {
  it('toggles on click, names its panel and links it to the trigger', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mount(onOpenChange)
    const trigger = screen.getByRole('button', { name: 'Open' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Panel' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveFocus()
    await user.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it('closes on Escape before any outer listener and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    document.addEventListener('keydown', outer, true)
    try {
      mount()
      await user.click(screen.getByRole('button', { name: 'Open' }))
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus()
      expect(outer).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', outer, true)
    }
  })

  it('closes on an outside pointer down but not inside the panel', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
