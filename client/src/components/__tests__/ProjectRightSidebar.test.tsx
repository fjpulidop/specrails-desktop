import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '../../test-utils'
import { ProjectRightSidebar } from '../ProjectRightSidebar'

beforeEach(() => {
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('ProjectRightSidebar', () => {
  it('renders nav items inside a labelled landmark', () => {
    render(<ProjectRightSidebar />)
    expect(screen.getByRole('complementary', { name: 'Project navigation' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Project' })).toBeInTheDocument()
    // Collapsed rail: icon-only links keep an accessible name.
    expect(screen.getByRole('link', { name: 'Project settings' })).toBeInTheDocument()
  })

  it('is drag-resizable when expanded', () => {
    window.localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    const { container } = render(<ProjectRightSidebar />)
    expect(screen.getByTestId('sidebar-resize-grip-right')).toBeInTheDocument()
    expect((container.querySelector('aside') as HTMLElement).style.width).toBe('208px')
  })

  it('renders pin button in unpinned default state', () => {
    render(<ProjectRightSidebar />)
    expect(screen.getByRole('button', { name: /Pin right sidebar open/i })).toBeInTheDocument()
  })

  it('cycle unpinned → pinned-open expands and labels collapse', () => {
    render(<ProjectRightSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /Pin right sidebar open/i }))
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Collapse right sidebar/i })).toBeInTheDocument()
  })

  it('cycle pinned-open → pinned-collapsed collapses and labels unpin', () => {
    render(<ProjectRightSidebar />)
    const btn = () => screen.getByRole('button', { name: /sidebar/i })
    fireEvent.click(btn()) // pinned-open
    fireEvent.click(btn()) // pinned-collapsed
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unpin right sidebar/i })).toBeInTheDocument()
  })

  it('expands on hover intent when unpinned, overlaying the content', () => {
    vi.useFakeTimers()
    const { container } = render(<ProjectRightSidebar />)
    fireEvent.mouseEnter(container.firstChild as Element)
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect((container.firstChild as HTMLElement).style.width).toBe('44px')
    expect(screen.getByTestId('project-right-sidebar-panel')).toHaveAttribute('data-overlay', 'true')
  })

  it('collapses on mouse leave when unpinned', () => {
    vi.useFakeTimers()
    const { container } = render(<ProjectRightSidebar />)
    fireEvent.mouseEnter(container.firstChild as Element)
    act(() => { vi.advanceTimersByTime(150) })
    fireEvent.mouseLeave(container.firstChild as Element)
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
  })

  it('does not expand on hover when pinned-collapsed', () => {
    const { container } = render(<ProjectRightSidebar />)
    const btn = () => screen.getByRole('button', { name: /sidebar/i })
    fireEvent.click(btn()) // pinned-open
    fireEvent.click(btn()) // pinned-collapsed
    fireEvent.mouseEnter(container.firstChild as Element)
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
  })
})
