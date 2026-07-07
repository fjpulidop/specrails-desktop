import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { AgentWorkspaceSidebar } from '../AgentWorkspaceSidebar'

const toggleIntegrationsModal = vi.fn()
let visibleForProviders = true

vi.mock('../../../hooks/useDesktop', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useDesktop')>('../../../hooks/useDesktop')
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

vi.mock('../../../context/TerminalsContext', () => ({
  useTerminals: () => ({ togglePanel: vi.fn() }),
}))

vi.mock('../../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({
    toggleJobsPane: vi.fn(),
    openBrowser: vi.fn(),
    toggleCodePane: vi.fn(),
    toggleIntegrationsModal,
  }),
}))

vi.mock('../../../context/AgentChatContext', () => ({
  useAgentChat: () => ({ active: { id: 'conversation-1' } }),
}))

vi.mock('../../../lib/provider-capabilities', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/provider-capabilities')>('../../../lib/provider-capabilities')
  return {
    ...actual,
    sectionVisibleForProviders: vi.fn(() => visibleForProviders),
  }
})

describe('AgentWorkspaceSidebar', () => {
  beforeEach(() => {
    toggleIntegrationsModal.mockClear()
    visibleForProviders = true
  })

  it('shows Integrations immediately after Files and toggles the modal', () => {
    const { container } = render(<AgentWorkspaceSidebar />)

    fireEvent.mouseEnter(container.firstChild as Element)

    const toolLabels = screen.getAllByRole('button').map((button) => button.textContent)
    expect(toolLabels).toEqual(expect.arrayContaining(['Files', 'Integrations']))
    expect(toolLabels.indexOf('Integrations')).toBe(toolLabels.indexOf('Files') + 1)

    fireEvent.click(screen.getByRole('button', { name: /integrations/i }))

    expect(toggleIntegrationsModal).toHaveBeenCalledTimes(1)
  })

  it('hides Integrations when provider visibility rejects it', () => {
    visibleForProviders = false

    const { container } = render(<AgentWorkspaceSidebar />)
    fireEvent.mouseEnter(container.firstChild as Element)

    expect(screen.queryByRole('button', { name: /integrations/i })).not.toBeInTheDocument()
  })
})
