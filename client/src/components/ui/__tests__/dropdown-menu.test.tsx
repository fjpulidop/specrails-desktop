import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu'

function Harness({ onDelete = vi.fn() }: { onDelete?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="More">…</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => {}}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem disabled>Export</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onDelete}>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('DropdownMenu', () => {
  it('exposes the menu-button pattern and toggles on click', () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'More' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  })

  it('runs the item action and closes', () => {
    const onDelete = vi.fn()
    render(<Harness onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('moves focus with arrow keys, skipping disabled items, and closes on Escape', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'More' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on an outside pointer press', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('DropdownMenu side', () => {
  it('opens above the trigger with side="top" (a trigger docked at the bottom edge)', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Up">^</DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem>One</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Up' }))
    const menu = screen.getByRole('menu')
    expect(menu.style.bottom).not.toBe('')
    expect(menu.style.top).toBe('')
  })

  it('still opens below by default', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    const menu = screen.getByRole('menu')
    expect(menu.style.top).not.toBe('')
    expect(menu.style.bottom).toBe('')
  })
})

