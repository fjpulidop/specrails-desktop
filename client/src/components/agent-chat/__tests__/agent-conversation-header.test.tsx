import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const renameConversation = vi.fn(async () => {})
const deleteConversation = vi.fn(async () => {})
const startNewConversation = vi.fn()
const toggleFavoriteConversation = vi.fn()
let active: { id: string; title: string | null; pinned_project_id: string | null } | null = {
  id: 'conv-1', title: 'Greeting And Friendly Introduction', pinned_project_id: 'p1',
}
let messages = [
  {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'Hello agent\nCan you help?',
    created_at: '2026-07-07T10:00:00.000Z',
  },
  {
    id: 'msg-2',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: 'Yes, I can.',
    created_at: '2026-07-07T10:01:00.000Z',
  },
]
let favoriteConversationIds = new Set<string>()
vi.mock('../../../context/AgentChatContext', () => ({
  useAgentChat: () => ({
    active,
    messages,
    renameConversation,
    deleteConversation,
    startNewConversation,
    favoriteConversationIds,
    toggleFavoriteConversation,
  }),
}))
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [{ id: 'p1', slug: 'outrun', name: 'outrun', path: '/Users/javi/repos/outrun' }] }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AgentConversationHeader, formatMissionTranscript, safeTranscriptFilename } from '../AgentConversationHeader'
import { toast } from 'sonner'
import enAgent from '../../../locales/en/agent.json'
import esAgent from '../../../locales/es/agent.json'
import frAgent from '../../../locales/fr/agent.json'
import deAgent from '../../../locales/de/agent.json'
import ptAgent from '../../../locales/pt/agent.json'
import itAgent from '../../../locales/it/agent.json'
import zhAgent from '../../../locales/zh/agent.json'
import jaAgent from '../../../locales/ja/agent.json'

const writeText = vi.fn(async () => {})
const createObjectURL = vi.fn(() => 'blob:transcript')
const revokeObjectURL = vi.fn()
const localeFiles = { en: enAgent, es: esAgent, fr: frAgent, de: deAgent, pt: ptAgent, it: itAgent, zh: zhAgent, ja: jaAgent }
const transcriptLocaleKeys = [
  'copyTranscript',
  'copyTranscriptSuccess',
  'copyTranscriptFailed',
  'exportTranscript',
  'exportTranscriptSuccess',
  'exportTranscriptFailed',
]
beforeEach(() => {
  vi.clearAllMocks()
  active = { id: 'conv-1', title: 'Greeting And Friendly Introduction', pinned_project_id: 'p1' }
  messages = [
    {
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'user',
      content: 'Hello agent\nCan you help?',
      created_at: '2026-07-07T10:00:00.000Z',
    },
    {
      id: 'msg-2',
      conversation_id: 'conv-1',
      role: 'assistant',
      content: 'Yes, I can.',
      created_at: '2026-07-07T10:01:00.000Z',
    },
  ]
  favoriteConversationIds = new Set()
  Object.assign(navigator, { clipboard: { writeText } })
  Object.assign(URL, { createObjectURL, revokeObjectURL })
})

describe('AgentConversationHeader', () => {
  it('defines transcript action header keys in every agent locale', () => {
    for (const [locale, resource] of Object.entries(localeFiles)) {
      for (const key of transcriptLocaleKeys) {
        expect(resource.header, `${locale} missing header.${key}`).toHaveProperty(key)
      }
    }
  })

  it('formats a plain-text transcript with mission metadata and loaded messages in order', () => {
    const transcript = formatMissionTranscript(
      { id: 'conv-1', title: 'Greeting And Friendly Introduction' },
      messages,
      { name: 'outrun', path: '/Users/javi/repos/outrun' },
      { exportedAt: '2026-07-07T10:02:00.000Z' },
    )

    expect(transcript).toContain('Mission: Greeting And Friendly Introduction')
    expect(transcript).toContain('Mission ID: conv-1')
    expect(transcript).toContain('Project: outrun')
    expect(transcript).toContain('Project path: /Users/javi/repos/outrun')
    expect(transcript).toContain('Exported at: 2026-07-07T10:02:00.000Z')
    expect(transcript).toContain('[2026-07-07T10:00:00.000Z] User')
    expect(transcript).toContain('Hello agent\nCan you help?')
    expect(transcript).toContain('[2026-07-07T10:01:00.000Z] Assistant')
    expect(transcript.indexOf('Hello agent')).toBeLessThan(transcript.indexOf('Yes, I can.'))
  })

  it('renders the breadcrumb: project path / conversation title', () => {
    render(<AgentConversationHeader />)
    expect(screen.getByText('/Users/javi/repos/outrun')).toBeInTheDocument()
    expect(screen.getByText('Greeting And Friendly Introduction')).toBeInTheDocument()
  })

  it('renders nothing when there is no active conversation', () => {
    active = null
    const { container } = render(<AgentConversationHeader />)
    expect(container.firstChild).toBeNull()
  })

  it('opens the ⋮ menu with Rename + copy items', () => {
    render(<AgentConversationHeader />)
    expect(screen.queryByTestId('agent-conv-menu')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    expect(screen.getByTestId('agent-conv-menu')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-rename')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-favorite')).toHaveTextContent('Add to favorites')
    expect(screen.getByTestId('agent-conv-copy-name')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-id')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-project')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-path')).toBeInTheDocument()
  })

  it('Rename → inline input → Enter commits via renameConversation', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-rename'))
    const input = screen.getByPlaceholderText(/mission name/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Deploy checklist' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameConversation).toHaveBeenCalledWith('conv-1', 'Deploy checklist'))
  })

  it('Escape in the rename input cancels without renaming', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-rename'))
    const input = screen.getByPlaceholderText(/mission name/i)
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(renameConversation).not.toHaveBeenCalled()
  })

  it('Copy Conversation ID writes the id to the clipboard', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-copy-id'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('conv-1'))
  })

  it('Copy project path writes the absolute path', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-copy-path'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/Users/javi/repos/outrun'))
  })

  it('Copy transcript writes the full formatted mission transcript to the clipboard', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-copy-transcript'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Mission: Greeting And Friendly Introduction'))
    })
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Hello agent\nCan you help?'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[2026-07-07T10:01:00.000Z] Assistant'))
  })

  it('Copy transcript shows a localized failure toast when clipboard write fails', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-copy-transcript'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy transcript'))
    expect(active?.id).toBe('conv-1')
    expect(messages).toHaveLength(2)
  })

  it('Export transcript downloads a plain-text Blob with a safe mission-title filename', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    const anchor = document.createElement('a')
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => {})
    const createElement = vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      if (tagName === 'a') return anchor
      return Document.prototype.createElement.call(document, tagName, options)
    })

    fireEvent.click(screen.getByTestId('agent-conv-export-transcript'))

    expect(createObjectURL).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/plain;charset=utf-8')
    await expect(blob.text()).resolves.toContain('Mission: Greeting And Friendly Introduction')
    await expect(blob.text()).resolves.toContain('Hello agent\nCan you help?')
    expect(anchor.download).toBe('greeting-and-friendly-introduction.txt')
    expect(anchor.href).toBe('blob:transcript')
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:transcript')
    createElement.mockRestore()
  })

  it('falls back to the mission id when the transcript filename title is unsafe', () => {
    expect(safeTranscriptFilename('!!!', 'conv-1')).toBe('conv-1.txt')
    expect(safeTranscriptFilename('   ', 'conv-1')).toBe('conv-1.txt')
  })

  it('Add to favorites toggles the active mission favorite state', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-favorite'))
    expect(toggleFavoriteConversation).toHaveBeenCalledWith('conv-1')
  })

  it('shows Remove from favorites when the active mission is already favorited', () => {
    favoriteConversationIds = new Set(['conv-1'])
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    expect(screen.getByTestId('agent-conv-favorite')).toHaveTextContent('Remove from favorites')
    fireEvent.click(screen.getByTestId('agent-conv-favorite'))
    expect(toggleFavoriteConversation).toHaveBeenCalledWith('conv-1')
  })
})

describe('AgentConversationHeader — delete mission', () => {
  it('shows Delete mission below Rename, confirms inline, deletes + returns to New Mission', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    const del = screen.getByTestId('agent-conv-delete')
    expect(del).toBeInTheDocument()
    // Clicking Delete does NOT delete immediately — it asks for confirmation.
    fireEvent.click(del)
    expect(deleteConversation).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-conv-delete-confirm')).toBeInTheDocument()
    // Confirm → delete + jump back to the "+ New Mission" screen (pinned project).
    fireEvent.click(screen.getByTestId('agent-conv-delete-confirm-btn'))
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('conv-1'))
    expect(startNewConversation).toHaveBeenCalledWith('p1')
  })

  it('Cancel drops back to the menu without deleting', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-delete'))
    fireEvent.click(screen.getByRole('button', { name: /cancel|cancelar/i }))
    expect(screen.queryByTestId('agent-conv-delete-confirm')).toBeNull()
    expect(screen.getByTestId('agent-conv-rename')).toBeInTheDocument() // back to the menu
    expect(deleteConversation).not.toHaveBeenCalled()
  })
})
