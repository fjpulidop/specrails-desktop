import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render as baseRender, screen, fireEvent, act } from '../../test-utils'
import { useSidebarPin } from '../../context/SidebarPinContext'
import { ProjectRightSidebar } from '../ProjectRightSidebar'

function PinControls() {
  const { cycleRightMode } = useSidebarPin()
  return <button onClick={cycleRightMode}>Cycle sidebar from header</button>
}
function render(ui: React.ReactElement) { return baseRender(<>{ui}<PinControls /></>) }

beforeEach(() => {
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('ProjectRightSidebar', () => {
  it('renders nav items inside a labelled landmark when open', () => {
    window.localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    render(<ProjectRightSidebar />)
    expect(screen.getByRole('complementary', { name: 'Project navigation' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Project' })).toBeInTheDocument()
    // Expanded navigation keeps accessible names.
    expect(screen.getByRole('link', { name: 'Project settings' })).toBeInTheDocument()
  })

  it('reveals the auto-hidden sidebar on keyboard focus without an icon rail', () => {
    render(<ProjectRightSidebar />)
    const sidebar = screen.getByRole('complementary', { name: 'Project navigation' })
    expect(sidebar).toHaveAttribute('tabindex', '0')
    act(() => sidebar.focus())
    expect(screen.getByRole('link', { name: 'Project settings' })).toBeInTheDocument()
    expect(screen.getByTestId('project-right-sidebar-panel')).not.toHaveAttribute('inert')
  })

  it('is drag-resizable when expanded', () => {
    window.localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    const { container } = render(<ProjectRightSidebar />)
    expect(screen.getByTestId('sidebar-resize-grip-right')).toBeInTheDocument()
    expect((container.querySelector('aside') as HTMLElement).style.width).toBe('208px')
  })

  it('[spec:app-area-chrome/sidebars-can-be-fully-hidden] hides icons and reserves no space in unpinned default state', () => {
    render(<ProjectRightSidebar />)
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('inert')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('cycle unpinned → pinned-open expands and labels collapse', () => {
    render(<ProjectRightSidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Cycle sidebar from header' }))
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('aria-hidden', 'false')
  })

  it('cycle pinned-open → pinned-collapsed collapses and labels unpin', () => {
    render(<ProjectRightSidebar />)
    const btn = () => screen.getByRole('button', { name: 'Cycle sidebar from header' })
    fireEvent.click(btn()) // pinned-open
    fireEvent.click(btn()) // pinned-collapsed
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByTestId('sidebar-edge-right')).not.toBeInTheDocument()
  })

  it('expands on hover intent when unpinned, overlaying the content', () => {
    vi.useFakeTimers()
    const { container } = render(<ProjectRightSidebar />)
    fireEvent.mouseEnter(container.firstChild as Element)
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('aria-hidden', 'false')
    expect((container.firstChild as HTMLElement).style.width).toBe('0px')
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('data-overlay', 'true')
  })

  it('collapses on mouse leave when unpinned', () => {
    vi.useFakeTimers()
    const { container } = render(<ProjectRightSidebar />)
    fireEvent.mouseEnter(container.firstChild as Element)
    act(() => { vi.advanceTimersByTime(150) })
    fireEvent.mouseLeave(container.firstChild as Element)
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('aria-hidden', 'true')
  })

  it('does not expand on hover when pinned-collapsed', () => {
    const { container } = render(<ProjectRightSidebar />)
    const btn = () => screen.getByRole('button', { name: 'Cycle sidebar from header' })
    fireEvent.click(btn()) // pinned-open
    fireEvent.click(btn()) // pinned-collapsed
    fireEvent.mouseEnter(container.firstChild as Element)
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('aria-hidden', 'true')
  })
})
