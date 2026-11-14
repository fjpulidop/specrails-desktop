import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HoverPopover } from '../hover-popover'

afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = () => render(<HoverPopover label="Panel" trigger={<button type="button">Open</button>}><p>Inside</p></HoverPopover>)

describe('HoverPopover', () => {
  it('opens on mouse hover and closes shortly after the pointer leaves', async () => {
    vi.useFakeTimers()
    mount()
    const trigger = screen.getByRole('button', { name: 'Open' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(screen.getByText('Inside')).toBeTruthy()
    fireEvent.pointerLeave(trigger)
    await act(async () => { vi.advanceTimersByTime(250) })
    expect(screen.queryByText('Inside')).toBeNull()
  })

  it('stays open while the pointer moves onto the panel', async () => {
    vi.useFakeTimers()
    mount()
    const trigger = screen.getByRole('button', { name: 'Open' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(screen.getByText('Inside').closest('[data-hover-popover]')!)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('Inside')).toBeTruthy()
  })

  it('opens on click for touch and keyboard users', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByText('Inside')).toBeTruthy()
  })
})
