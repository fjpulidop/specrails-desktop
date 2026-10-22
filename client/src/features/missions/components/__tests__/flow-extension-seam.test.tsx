import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// Flow mode through the missions extension seam: the conversation surface gets
// the extension's data attributes and a busy send interrupts. Harness mirrors
// mission-composer-clear-on-send (same mocks).
// (Original note:) Regression cover for the composer's clear-on-send contract, driven through the
// surfaces users actually see. The pre-existing suite mounts <AgentComposer/> in
// isolation (or reaches it with a conversation already active), which is exactly
// why a deterministic bug shipped under a green assertion: materializing a new
// mission REMOUNTS the composer, and the clear used to land in the instance that
// had just been unmounted.

let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

const projects = [{ id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' }]
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('../../../providers/hooks/useAvailableProviders', () => ({
  useAvailableProviders: () => ({
    available: { claude: true }, availableIds: ['claude'], issues: {}, launchDescriptors: {}, loading: false,
  }),
}))

const conversation = (id: string) => ({
  id, title: null, provider: 'claude', model: null, session_id: null,
  pinned_project_id: null, tier_level: 0 as const, created_at: '', updated_at: '',
})

vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => []),
    createAgentConversation: vi.fn(async () => conversation('c-new')),
    getAgentConversation: vi.fn(async () => ({ conversation: conversation('c-new'), messages: [] })),
    patchAgentConversation: vi.fn(async () => conversation('c-new')),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    uploadAgentAttachment: vi.fn(async () => ({ id: 'att-1', filename: 'a.png', storedName: 's', mimeType: 'image/png', size: 1, addedAt: '' })),
    listAgentAttachments: vi.fn(async () => []),
    fetchAgentAttachmentBlob: vi.fn(async () => new Blob(['x'])),
    abortAgentTurn: vi.fn(async () => {}),
    editQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    steerQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    removeQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAgentModels: vi.fn(async () => ({
      models: [{ value: 'sonnet', label: 'Sonnet 5.5', default: true }],
      supportsImageInput: true, customModelAliases: false, efforts: ['low', 'medium', 'high'],
    })),
  }
})

vi.mock('../../../browser/context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: true }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

import * as agentApi from '../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../context/AgentChatContext'
import { AgentWorkspaceProvider } from '../../context/AgentWorkspaceContext'
import { UiModeProvider } from '../../../../context/UiModeContext'
import { __clearComposerDrafts } from '../../lib/agent-composer-drafts'
import { inputEditor } from './editor-harness'
import { MissionExtensionsProvider, type MissionExtensions } from '../../context/MissionExtensionsContext'

let chat: ReturnType<typeof useAgentChat> | null = null
function Probe() { chat = useAgentChat(); return null }

const FLOW_MODE: MissionExtensions = {
  useConversationMode: () => ({ attributes: { 'data-flow': 'active' }, gitBranch: null, interruptWhileBusy: true }),
  ConversationDock: ({ conversationId }) => <div data-testid="test-dock">{conversationId}</div>,
}

function renderPanel(extensions?: MissionExtensions) {
  const tree = (
    <UiModeProvider initialMode="kanban" persist={false}>
      <AgentWorkspaceProvider>
        <AgentChatProvider>
          <Probe />
        </AgentChatProvider>
      </AgentWorkspaceProvider>
    </UiModeProvider>
  )
  return render(extensions ? <MissionExtensionsProvider value={extensions}>{tree}</MissionExtensionsProvider> : tree)
}

async function startBusyTurn() {
  await waitFor(() => expect(chat).not.toBeNull())
  await act(async () => { chat!.open() })
  await waitFor(() => expect(chat!.active?.id).toBe('c-new'))
  const box = await screen.findByRole('textbox')
  inputEditor(box, 'build the board')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true })) })
  await waitFor(() => expect(chat!.isStreaming).toBe(true))
  return box
}

beforeEach(() => {
  vi.clearAllMocks()
  __clearComposerDrafts()
  chat = null
  wsHandler = null
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([])
  vi.mocked(agentApi.createAgentConversation).mockResolvedValue(conversation('c-new'))
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: conversation('c-new'), messages: [] })
  vi.mocked(agentApi.sendAgentMessage).mockResolvedValue({ queued: false })
  vi.mocked(agentApi.listAgentAttachments).mockResolvedValue([])
})

describe('missions extension seam (Flow mode)', () => {
  it('applies the extension surface attributes, renders the dock and interrupts a busy turn', async () => {
    const { container } = renderPanel(FLOW_MODE)
    const box = await startBusyTurn()
    expect(container.ownerDocument.querySelector('[data-mission-surface][data-flow="active"]')).not.toBeNull()
    expect(screen.getByTestId('test-dock')).toHaveTextContent('c-new')
    expect(box).toHaveAttribute('data-placeholder', expect.stringContaining('interrupt'))
    vi.mocked(agentApi.sendAgentMessage).mockResolvedValue({ queued: true, deliveryMode: 'interrupt' })
    inputEditor(box, 'actually make it blue')
    await act(async () => { fireEvent.click(screen.getByTestId('agent-composer-interrupt')) })
    await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[1][2]).toMatchObject({ deliveryMode: 'interrupt' })
    // Interrupt inputs are steers: never parked as a queued chip.
    expect(chat!.queuedMessages.every((item) => item.deliveryMode === 'steer')).toBe(true)
  })

  it('without an extension the surface is plain and a busy send queues as before', async () => {
    const { container } = renderPanel()
    const box = await startBusyTurn()
    expect(container.ownerDocument.querySelector('[data-flow]')).toBeNull()
    expect(screen.queryByTestId('agent-composer-interrupt')).toBeNull()
    inputEditor(box, 'one more thing')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[1][2]).not.toHaveProperty('deliveryMode')
  })
})
