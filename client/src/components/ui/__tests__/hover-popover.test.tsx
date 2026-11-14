import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HoverPopover } from '../hover-popover'

afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = () => render(<HoverPopover label="Panel" trigger={<button type="button">Open</button>}><p>Inside</p></HoverPopover>)

describe('HoverPopover', () => {
  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] opens on mouse hover and closes shortly after the pointer leaves', async () => {
    vi.useFakeTimers()
    mount()
    const trigger = screen.getByRole('button', { name: 'Open' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(screen.getByText('Inside')).toBeTruthy()
    fireEvent.pointerLeave(trigger)
    await act(async () => { vi.advanceTimersByTime(250) })
    expect(screen.queryByText('Inside')).toBeNull()
  })

  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] stays open while the pointer moves onto the panel', async () => {
    vi.useFakeTimers()
    mount()
    const trigger = screen.getByRole('button', { name: 'Open' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(screen.getByText('Inside').closest('[data-hover-popover]')!)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('Inside')).toBeTruthy()
  })

  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] opens on focus, permits keyboard panel access and closes when focus leaves both surfaces', async () => {
    const user = userEvent.setup()
    render(<><HoverPopover label="Panel" trigger={<button>Open</button>}><button>Scan disk</button></HoverPopover><button>Outside</button></>)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeTruthy()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Scan disk' }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] lets Shift+Tab leave the panel through the trigger', async () => {
    const user = userEvent.setup()
    const tierShortcut = vi.fn()
    render(<div onKeyDown={event => { if (event.shiftKey && event.key === 'Tab') { event.preventDefault(); tierShortcut() } }}><button>Before</button><HoverPopover label="Panel" trigger={<button>Open</button>}><button>Scan disk</button></HoverPopover></div>)
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Scan disk' }))
    tierShortcut.mockClear()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }))
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }))
    expect(tierShortcut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] dismisses on Escape and outside pointer interaction', async () => {
    const user = userEvent.setup()
    render(<><HoverPopover label="Panel" trigger={<button>Open</button>}><button>Scan disk</button></HoverPopover><button>Outside</button></>)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] opens on click for touch and keyboard users', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByText('Inside')).toBeTruthy()
  })
})
