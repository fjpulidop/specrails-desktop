import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SidebarPinProvider, useSidebarPin } from '../SidebarPinContext'

function Harness() {
  const { leftMode, rightMode, effectiveLeftMode, effectiveRightMode, cycleLeftMode, cycleRightMode, setLeftMode } = useSidebarPin()
  return (
    <div>
      <span data-testid="left">{leftMode}</span>
      <span data-testid="right">{rightMode}</span>
      <span data-testid="effective-left">{effectiveLeftMode}</span>
      <span data-testid="effective-right">{effectiveRightMode}</span>
      <button onClick={cycleLeftMode}>cycle-left</button>
      <button onClick={cycleRightMode}>cycle-right</button>
      <button onClick={() => setLeftMode('pinned-open')}>force-open</button>
      <button onClick={() => setLeftMode('unpinned')}>force-unpinned</button>
    </div>
  )
}

const originalMatchMedia = window.matchMedia
function mockNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe('SidebarPinContext', () => {
  it('defaults a new user to a pinned-open left sidebar and an unpinned right one', () => {
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    expect(screen.getByTestId('left').textContent).toBe('pinned-open')
    expect(screen.getByTestId('right').textContent).toBe('unpinned')
  })

  it('cycles left through pinned-open → pinned-collapsed → unpinned', () => {
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    const btn = screen.getByText('cycle-left')
    expect(screen.getByTestId('left').textContent).toBe('pinned-open')
    fireEvent.click(btn)
    expect(screen.getByTestId('left').textContent).toBe('pinned-collapsed')
    fireEvent.click(btn)
    expect(screen.getByTestId('left').textContent).toBe('unpinned')
    fireEvent.click(btn)
    expect(screen.getByTestId('left').textContent).toBe('pinned-open')
  })

  it('cycles right independently of left', () => {
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    fireEvent.click(screen.getByText('cycle-left'))
    expect(screen.getByTestId('right').textContent).toBe('unpinned')
    fireEvent.click(screen.getByText('cycle-right'))
    expect(screen.getByTestId('right').textContent).toBe('pinned-open')
    expect(screen.getByTestId('left').textContent).toBe('pinned-collapsed')
  })

  it('persists left mode to localStorage', () => {
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    fireEvent.click(screen.getByText('cycle-left'))
    expect(window.localStorage.getItem('specrails-desktop:sidebar-mode:left')).toBe('pinned-collapsed')
  })

  it('renders a pinned-open sidebar as unpinned in a narrow window without persisting it', () => {
    mockNarrow(true)
    window.localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    expect(screen.getByTestId('left').textContent).toBe('pinned-open')
    expect(screen.getByTestId('effective-left').textContent).toBe('unpinned')
    expect(screen.getByTestId('effective-right').textContent).toBe('unpinned')
    expect(window.localStorage.getItem('specrails-desktop:sidebar-mode:left')).toBe('pinned-open')
    expect(window.localStorage.getItem('specrails-desktop:sidebar-mode:right')).toBe('pinned-open')
  })

  it('keeps the chosen mode as the effective one in a wide window', () => {
    mockNarrow(false)
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    expect(screen.getByTestId('effective-left').textContent).toBe('pinned-open')
  })

  it('restores persisted mode on mount', () => {
    window.localStorage.setItem('specrails-desktop:sidebar-mode:left', 'pinned-collapsed')
    window.localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    expect(screen.getByTestId('left').textContent).toBe('pinned-collapsed')
    expect(screen.getByTestId('right').textContent).toBe('pinned-open')
  })

  it('falls back to the side default on an invalid persisted value', () => {
    window.localStorage.setItem('specrails-desktop:sidebar-mode:left', 'wat')
    window.localStorage.setItem('specrails-desktop:sidebar-mode:right', 'wat')
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    expect(screen.getByTestId('left').textContent).toBe('pinned-open')
    expect(screen.getByTestId('right').textContent).toBe('unpinned')
  })

  it('survives localStorage.setItem throwing', () => {
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('quota') }
    try {
      render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
      expect(() => fireEvent.click(screen.getByText('cycle-left'))).not.toThrow()
      expect(screen.getByTestId('left').textContent).toBe('pinned-collapsed')
    } finally {
      Storage.prototype.setItem = originalSet
    }
  })

  it('setLeftMode escape hatch jumps to a specific mode', () => {
    render(<SidebarPinProvider><Harness /></SidebarPinProvider>)
    act(() => {
      fireEvent.click(screen.getByText('force-unpinned'))
    })
    expect(screen.getByTestId('left').textContent).toBe('unpinned')
    act(() => {
      fireEvent.click(screen.getByText('force-open'))
    })
    expect(screen.getByTestId('left').textContent).toBe('pinned-open')
  })
})
