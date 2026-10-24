import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../../test-utils'
import { AgentWorkspaceSidebar } from '../AgentWorkspaceSidebar'

vi.mock('../../../../hooks/useDesktop', async () => {
  const actual = await vi.importActual<typeof import('../../../../hooks/useDesktop')>('../../../../hooks/useDesktop')
  return {
    ...actual,
    useDesktop: () => ({
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        slug: 'project-1',
        name: 'Project 1',
        path: '/tmp/project-1',
        db_path: '/tmp/project-1/.specrails/specrails.db',
        provider: 'claude',
        providers: ['claude'],
        added_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z',
      }],
    }),
  }
})

vi.mock('../../../terminals/context/TerminalsContext', () => ({
  useTerminals: () => ({ togglePanel: vi.fn(), getState: () => ({ visibility: 'hidden' }) }),
}))

const workspaceState = vi.hoisted(() => ({ jobsPaneOpen: false, codePaneOpen: false }))
vi.mock('../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({
    toggleJobsPane: vi.fn(),
    toggleAnalyticsPane: vi.fn(),
    openBrowser: vi.fn(),
    toggleCodePane: vi.fn(),
    jobsPaneOpen: workspaceState.jobsPaneOpen,
    codePaneOpen: workspaceState.codePaneOpen,
    analyticsPaneOpen: false,
    browserOpen: false,
  }),
}))

vi.mock('../../context/AgentChatContext', () => ({
  useAgentChat: () => ({ active: { id: 'conversation-1' }, builderMode: { active: false, enter: () => {}, exit: () => {}, session: { phase: 'chat', blueprint: null } } }),
}))

describe('AgentWorkspaceSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    workspaceState.jobsPaneOpen = false
    workspaceState.codePaneOpen = false
  })

  it('shows workspace tools without the old Integrations entry', () => {
    localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    render(<AgentWorkspaceSidebar />)

    const toolLabels = screen.getAllByRole('button').map((button) => button.textContent)
    expect(toolLabels).toEqual(expect.arrayContaining(['Jobs', 'Files']))
    expect(screen.queryByRole('button', { name: /integrations/i })).not.toBeInTheDocument()
  })

  it('shows which workspace pane is open (aria-pressed + lit row)', () => {
    workspaceState.jobsPaneOpen = true
    localStorage.setItem('specrails-desktop:sidebar-mode:right', 'pinned-open')
    render(<AgentWorkspaceSidebar />)
    expect(screen.getByRole('complementary', { name: 'On workspace' })).toBeInTheDocument()
    const jobs = screen.getByRole('button', { name: 'Jobs' })
    expect(jobs).toHaveAttribute('aria-pressed', 'true')
    expect(jobs.className).toContain('bg-muted')
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps icon-only tools named on the collapsed rail', () => {
    render(<AgentWorkspaceSidebar />)
    expect(screen.getByRole('button', { name: 'Jobs' })).toBeInTheDocument()
  })
})
