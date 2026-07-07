import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentModeSurface } from '../AgentModeSurface'

let activeThemeId = 'dracula'
let activeProjectId: string | null = 'project-1'
let integrationsModalOpen = false
const refreshConversations = vi.fn()
const closeIntegrationsModal = vi.fn()

vi.mock('../../../context/ThemeContext', () => ({
  useActiveTheme: () => ({ id: activeThemeId }),
}))

vi.mock('../../../context/AgentChatContext', () => ({
  useAgentChat: () => ({
    active: null,
    refreshConversations,
  }),
}))

vi.mock('../../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({
    codePaneOpen: false,
    jobsPaneOpen: false,
    browserOpen: false,
    integrationsModalOpen,
    closeIntegrationsModal,
  }),
}))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId }),
}))

vi.mock('../../theme-effects/Starfield', () => ({
  Starfield: () => <div data-testid="agent-mode-starfield" />,
}))

vi.mock('../AgentComposer', () => ({
  AgentComposer: () => <div data-testid="agent-composer" />,
}))

vi.mock('../AgentConversationView', () => ({
  AgentConversationView: () => <div data-testid="agent-conversation" />,
}))

vi.mock('../AgentIntegrationsModal', () => ({
  AgentIntegrationsModal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" data-testid="agent-integrations-modal" onClick={onClose}>
      Agent integrations modal
    </button>
  ),
}))

describe('AgentModeSurface', () => {
  beforeEach(() => {
    activeThemeId = 'dracula'
    activeProjectId = 'project-1'
    integrationsModalOpen = false
    refreshConversations.mockClear()
    closeIntegrationsModal.mockClear()
  })

  it('exposes a narrow root styling hook', () => {
    const { container } = render(<AgentModeSurface />)

    expect(container.querySelector('[data-agent-mode-surface]')).not.toBeNull()
  })

  it('mounts Starfield only for the Galaxy theme', () => {
    activeThemeId = 'galaxy'
    const { rerender } = render(<AgentModeSurface />)

    expect(screen.getByTestId('agent-mode-starfield')).toBeInTheDocument()

    activeThemeId = 'dracula'
    rerender(<AgentModeSurface />)

    expect(screen.queryByTestId('agent-mode-starfield')).toBeNull()
  })

  it('renders the integrations modal when it is open for an active project', async () => {
    integrationsModalOpen = true

    render(<AgentModeSurface />)

    expect(await screen.findByTestId('agent-integrations-modal')).toBeInTheDocument()
  })

  it('does not render the integrations modal without an active project', () => {
    integrationsModalOpen = true
    activeProjectId = null

    render(<AgentModeSurface />)

    expect(screen.queryByTestId('agent-integrations-modal')).not.toBeInTheDocument()
  })
})
