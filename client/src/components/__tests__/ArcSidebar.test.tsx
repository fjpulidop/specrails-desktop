import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLocation } from 'react-router-dom'
import { render, screen, fireEvent, act, within } from '../../test-utils'
import { ArcSidebar } from '../ArcSidebar'
import type { DesktopProject } from '../../hooks/useDesktop'

const mockProjects: DesktopProject[] = [
  { id: 'proj-1', slug: 'proj-1', name: 'Project Alpha', path: '/alpha', db_path: '/alpha/.db', added_at: '', last_seen_at: '' },
  { id: 'proj-2', slug: 'proj-2', name: 'Project Beta', path: '/beta', db_path: '/beta/.db', added_at: '', last_seen_at: '' },
]

const mockSetActiveProjectId = vi.fn()
const mockRemoveProject = vi.fn()

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: mockProjects,
    activeProjectId: 'proj-1',
    setActiveProjectId: mockSetActiveProjectId,
    removeProject: mockRemoveProject,
    isLoading: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
  }),
}))

const defaultProps = {
  onAddProject: vi.fn(),
  onOpenLoops: vi.fn(),
  onOpenPlugins: vi.fn(),
  onOpenAnalytics: vi.fn(),
  onOpenDocs: vi.fn(),
  onOpenSettings: vi.fn(),
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

const LEFT_MODE_KEY = 'specrails-desktop:sidebar-mode:left'
function startUnpinned() {
  window.localStorage.setItem(LEFT_MODE_KEY, 'unpinned')
}
function sidebarRoot(container: HTMLElement): Element {
  return container.querySelector('aside') as Element
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('ArcSidebar', () => {
  it('is a labelled landmark with labelled navigation lists', () => {
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getByRole('complementary', { name: 'Projects and missions' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Projects' })).toBeInTheDocument()
  })

  it('opens Companion setup straight from the footer', () => {
    const onOpenCompanion = vi.fn()
    render(<ArcSidebar {...defaultProps} onOpenCompanion={onOpenCompanion} />)
    fireEvent.click(screen.getByRole('button', { name: 'Companion' }))
    expect(onOpenCompanion).toHaveBeenCalledOnce()
    expect(defaultProps.onOpenSettings).not.toHaveBeenCalled()
  })

  it('lists app tools as plain rows above App settings (no disclosure)', () => {
    render(<ArcSidebar {...defaultProps} onOpenCompanion={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Expand', expanded: false })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'App settings' })).not.toBeInTheDocument()
    const footer = screen.getByRole('button', { name: 'App settings' }).parentElement as HTMLElement
    expect(within(footer).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'All-projects analytics', 'Docs', 'Companion', 'App settings',
    ])
  })

  it('renders pinned open by default for a new user', () => {
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Collapse left sidebar \(keep pinned\)/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Desktop')).toBeInTheDocument()
  })

  it('renders collapsed when the stored mode is unpinned', () => {
    startUnpinned()
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Pin left sidebar open/i })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })

  it('cycle from unpinned → pinned-open expands and updates label', () => {
    startUnpinned()
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /Pin left sidebar open/i }))
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Collapse left sidebar \(keep pinned\)/i })).toBeInTheDocument()
  })

  it('cycle from pinned-open → pinned-collapsed collapses and keeps lit label', () => {
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /Collapse left sidebar/i })) // → pinned-collapsed
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unpin left sidebar/i })).toBeInTheDocument()
  })

  it('cycle wraps pinned-collapsed → unpinned → pinned-open', () => {
    render(<ArcSidebar {...defaultProps} />)
    const btn = () => screen.getByRole('button', { name: /left sidebar/i })
    fireEvent.click(btn()) // pinned-collapsed
    fireEvent.click(btn()) // unpinned
    expect(screen.getByRole('button', { name: /Pin left sidebar open/i })).toBeInTheDocument()
    fireEvent.click(btn()) // pinned-open
    expect(screen.getByText('Desktop')).toBeInTheDocument()
  })

  it('expands on hover intent (after a short dwell) when unpinned, as an overlay', () => {
    vi.useFakeTimers()
    startUnpinned()
    const { container } = render(<ArcSidebar {...defaultProps} />)
    fireEvent.mouseEnter(sidebarRoot(container))
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    // The in-flow wrapper keeps the rail width; only the panel overlays.
    expect((sidebarRoot(container) as HTMLElement).style.width).toBe('44px')
    expect(screen.getByTestId('arc-sidebar-panel')).toHaveAttribute('data-overlay', 'true')
  })

  it('a pointer passing over the rail does not expand it', () => {
    vi.useFakeTimers()
    startUnpinned()
    const { container } = render(<ArcSidebar {...defaultProps} />)
    fireEvent.mouseEnter(sidebarRoot(container))
    act(() => { vi.advanceTimersByTime(100) })
    fireEvent.mouseLeave(sidebarRoot(container))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })

  it('collapses after a grace period on mouse leave when unpinned', () => {
    vi.useFakeTimers()
    startUnpinned()
    const { container } = render(<ArcSidebar {...defaultProps} />)
    fireEvent.mouseEnter(sidebarRoot(container))
    act(() => { vi.advanceTimersByTime(150) })
    fireEvent.mouseLeave(sidebarRoot(container))
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })

  it('Esc closes the hover overlay', () => {
    vi.useFakeTimers()
    startUnpinned()
    const { container } = render(<ArcSidebar {...defaultProps} />)
    fireEvent.mouseEnter(sidebarRoot(container))
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })

  it('expands while keyboard focus is inside and collapses when focus leaves', () => {
    startUnpinned()
    render(
      <>
        <ArcSidebar {...defaultProps} />
        <button type="button">outside</button>
      </>,
    )
    const addProject = screen.getByRole('button', { name: /Add project/i })
    act(() => { addProject.focus() })
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: 'outside' }).focus() })
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })

  it('does not expand on mouse enter when pinned-collapsed', () => {
    vi.useFakeTimers()
    window.localStorage.setItem(LEFT_MODE_KEY, 'pinned-collapsed')
    const { container } = render(<ArcSidebar {...defaultProps} />)
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
    fireEvent.mouseEnter(sidebarRoot(container))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })

  it('stays expanded on mouse leave when pinned-open and reserves its width', () => {
    const { container } = render(<ArcSidebar {...defaultProps} />)
    fireEvent.mouseLeave(sidebarRoot(container))
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    expect((sidebarRoot(container) as HTMLElement).style.width).toBe('300px')
  })

  it('shows distinguishable monogram tiles for projects on the collapsed rail', () => {
    window.localStorage.setItem(LEFT_MODE_KEY, 'pinned-collapsed')
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getAllByTestId('project-monogram').map((el) => el.textContent)).toEqual(['PA', 'PB'])
    expect(screen.getByRole('button', { name: 'Project Beta' })).toBeInTheDocument()
  })

  it('renders Add project button', () => {
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Add project/i })).toBeInTheDocument()
  })

  it('calls onAddProject when Add project button is clicked', () => {
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /Add project/i }))
    expect(defaultProps.onAddProject).toHaveBeenCalledOnce()
  })

  it('renders project rows as real buttons with sibling actions', () => {
    render(<ArcSidebar {...defaultProps} />)
    const row = screen.getByText('Project Alpha').closest('button') as HTMLElement
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row.querySelector('button')).toBeNull()
    expect(screen.getByText('Project Beta')).toBeInTheDocument()
    expect(document.querySelector('[role="button"]')).toBeNull()
  })

  it('calls setActiveProjectId when a project is clicked', () => {
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByText('Project Beta'))
    expect(mockSetActiveProjectId).toHaveBeenCalledWith('proj-2')
  })

  it('leaves Plugins route when active project is clicked in board mode', () => {
    render(
      <>
        <ArcSidebar {...defaultProps} />
        <LocationProbe />
      </>,
      { route: '/plugins' },
    )

    fireEvent.click(screen.getByText('Project Alpha'))

    expect(screen.getByTestId('location')).toHaveTextContent('/')
    expect(mockSetActiveProjectId).not.toHaveBeenCalled()
  })

  it('renders desktop nav items when expanded', () => {
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Docs/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All-projects analytics' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'App settings' })).toBeInTheDocument()
  })

  it('calls onOpenAnalytics when All-projects analytics is clicked', () => {
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'All-projects analytics' }))
    expect(defaultProps.onOpenAnalytics).toHaveBeenCalledOnce()
  })

  it('calls onOpenSettings when App settings is clicked', () => {
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'App settings' }))
    expect(defaultProps.onOpenSettings).toHaveBeenCalledOnce()
  })

  it('shows confirm prompt then removes project on second click', async () => {
    render(<ArcSidebar {...defaultProps} />)

    const removeBtn = screen.getByRole('button', { name: /Remove Project Beta/i })
    fireEvent.click(removeBtn)
    const confirm = screen.getByRole('button', { name: /Confirm remove Project Beta/i })
    expect(confirm).toHaveTextContent('Remove?')

    fireEvent.click(confirm)
    expect(mockRemoveProject).toHaveBeenCalledWith('proj-2')
  })

  it('keeps the remove confirmation armed for 5 seconds', () => {
    vi.useFakeTimers()
    render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /Remove Project Beta/i }))
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('button', { name: /Confirm remove Project Beta/i })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByRole('button', { name: /Confirm remove Project Beta/i })).not.toBeInTheDocument()
  })
})

describe('removing a project without the hover X', () => {
  it('takes the hover X out of the Tab order and announces Delete on the row', () => {
    render(<ArcSidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Remove Project Beta/i })).toHaveAttribute('tabindex', '-1')
    const row = document.querySelector('[data-project-row="proj-2"]')!
    expect(row).toHaveAttribute('aria-keyshortcuts', 'Delete')
  })

  it('Delete on the focused row arms the confirmation and a second Delete removes the project', () => {
    render(<ArcSidebar {...defaultProps} />)
    const row = document.querySelector('[data-project-row="proj-2"]')!
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(screen.getByRole('button', { name: /Confirm remove Project Beta/i })).toBeInTheDocument()
    expect(mockRemoveProject).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(mockRemoveProject).toHaveBeenCalledWith('proj-2')
  })

  it('the context menu offers the same two-step removal and Escape dismisses it', () => {
    render(<ArcSidebar {...defaultProps} />)
    const row = document.querySelector('[data-project-row="proj-2"]')!
    fireEvent.contextMenu(row)
    const item = screen.getByRole('menuitem', { name: /Remove Project Beta/i })
    fireEvent.click(item)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm remove Project Beta/i })).toBeInTheDocument()
    expect(mockRemoveProject).not.toHaveBeenCalled()

    fireEvent.contextMenu(row)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('projectMonogram', () => {
  it('uses the initials of the first two words, else the first two characters', async () => {
    const { projectMonogram } = await import('../ArcSidebar')
    expect(projectMonogram('specrails-desktop')).toBe('SD')
    expect(projectMonogram('Project Alpha')).toBe('PA')
    expect(projectMonogram('tetris')).toBe('TE')
    expect(projectMonogram('x')).toBe('X')
    expect(projectMonogram('---')).toBe('?')
  })
})
