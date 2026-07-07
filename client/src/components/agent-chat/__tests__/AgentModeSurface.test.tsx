import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentModeSurface } from '../AgentModeSurface'

let activeThemeId = 'dracula'
const refreshConversations = vi.fn()

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
  }),
}))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'project-1' }),
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

describe('AgentModeSurface', () => {
  beforeEach(() => {
    activeThemeId = 'dracula'
    refreshConversations.mockClear()
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
})
