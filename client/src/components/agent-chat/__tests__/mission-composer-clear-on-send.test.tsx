import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// Regression cover for the composer's clear-on-send contract, driven through the
// surfaces users actually see. The pre-existing suite mounts <AgentComposer/> in
// isolation (or reaches it with a conversation already active), which is exactly
// why a deterministic bug shipped under a green assertion: materializing a new
// mission REMOUNTS the composer, and the clear used to land in the instance that
// had just been unmounted.

let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

const projects = [{ id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' }]
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('../../../hooks/useAvailableProviders', () => ({
  useAvailableProviders: () => ({
    available: { claude: true }, availableIds: ['claude'], issues: {}, launchDescriptors: {}, loading: false,
  }),
}))

const conversation = (id: string) => ({
  id, title: null, provider: 'claude', model: null, session_id: null,
  pinned_project_id: null, tier_level: 0 as const, created_at: '', updated_at: '',
})

vi.mock('../../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../../lib/agent-api')>()
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
      models: [{ value: 'sonnet', label: 'Claude Sonnet', default: true }],
      supportsImageInput: true, customModelAliases: false, efforts: ['low', 'medium', 'high'],
    })),
  }
})

vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: true }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

import * as agentApi from '../../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'
import { AgentWorkspaceProvider } from '../../../context/AgentWorkspaceContext'
import { UiModeProvider } from '../../../context/UiModeContext'
import { AgentModeSurface } from '../AgentModeSurface'
import {
  __clearComposerDrafts, composerDrafts, composerSubmissionIds, writeComposerDraft,
} from '../../../lib/agent-composer-drafts'
import { editorText, inputEditor } from './editor-harness'

/** Reaches into the provider for the actions no surface exposes as a button. */
let chat: ReturnType<typeof useAgentChat> | null = null
function Probe() { chat = useAgentChat(); return null }

// The composer's accessible name is its placeholder, which changes once a turn
// is in flight ("Add a message to the queue…"), so the box is addressed by role.

/** Agent Mode: EMPTY hero composer, then the docked one after materialization. */
function renderAgentMode() {
  return render(
    <UiModeProvider initialMode="agent" persist={false}>
      <AgentWorkspaceProvider>
        <AgentChatProvider>
          <AgentModeSurface />
          <Probe />
        </AgentChatProvider>
      </AgentWorkspaceProvider>
    </UiModeProvider>,
  )
}

/** Board mode: the floating panel the provider renders next to its children. */
function renderFloatingPanel() {
  return render(
    <UiModeProvider initialMode="kanban" persist={false}>
      <AgentWorkspaceProvider>
        <AgentChatProvider>
          <Probe />
        </AgentChatProvider>
      </AgentWorkspaceProvider>
    </UiModeProvider>,
  )
}

const composerBox = async (): Promise<HTMLElement> => screen.findByRole('textbox')

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

describe('the composer empties on send, on the real mission surfaces', () => {
  it('keeps an existing mission empty after button send and late composition events', async () => {
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    await waitFor(() => expect(chat!.active?.id).toBe('c-new'))
    const box = await composerBox()
    inputEditor(box, 'revisa el código')
    fireEvent.compositionStart(box)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true })) })
    expect(agentApi.sendAgentMessage).toHaveBeenCalledWith('c-new', 'revisa el código', expect.anything())
    fireEvent.compositionEnd(box)
    fireEvent.input(box, { inputType: 'insertCompositionText' })
    expect(editorText(box)).toBe('')
    expect(composerDrafts.get('c-new')).toBeUndefined()
  })

  it('Agent Mode: the docked composer that replaces the hero card is empty', async () => {
    renderAgentMode()
    await waitFor(() => expect(chat).not.toBeNull())
    // The provider materializes a conversation on mount; New Mission is what
    // puts the user on the EMPTY compose screen this bug lives on.
    await act(async () => { chat!.startNewConversation() })
    const hero = await composerBox()
    inputEditor(hero, 'arregla el bug del composer')
    // The send materializes the mission, which swaps the EMPTY branch for the
    // conversation view — a DIFFERENT composer instance from the one that
    // submitted.
    await act(async () => { fireEvent.keyDown(hero, { key: 'Enter' }) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
    await waitFor(() => expect(chat!.active?.id).toBe('c-new'))
    expect(editorText(await composerBox())).toBe('')
    expect(composerDrafts.get('c-new')).toBeUndefined()
    expect(composerDrafts.get('__new-mission__')).toBeUndefined()
  })

  it('floating panel: the remounted composer is empty after materialization', async () => {
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    // The panel opens on an existing conversation; New Mission is what puts the
    // user back on the empty compose screen where the remount happens.
    await act(async () => { chat!.startNewConversation() })
    const box = await composerBox()
    inputEditor(box, 'una misión nueva desde el panel')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(chat!.active?.id).toBe('c-new'))
    expect(editorText(await composerBox())).toBe('')
  })

  it('empties before the send settles, not after', async () => {
    let release!: () => void
    vi.mocked(agentApi.sendAgentMessage).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ queued: false }) }),
    )
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    await act(async () => { chat!.startNewConversation() })
    const box = await composerBox()
    inputEditor(box, 'no me quedo escrito mientras se procesa')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalled())
    // Still in flight — the box is already empty.
    expect(editorText(await composerBox())).toBe('')
    await act(async () => { release() })
    expect(editorText(await composerBox())).toBe('')
  })
})

describe('a rejected send gives the work back', () => {
  it('restores text and reuses the retry identity so it is delivered once', async () => {
    vi.mocked(agentApi.sendAgentMessage).mockRejectedValue(new Error('network down'))
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    await act(async () => { chat!.startNewConversation() })
    const box = await composerBox()
    inputEditor(box, 'esto no debe perderse')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(1))

    await waitFor(() => expect(editorText(screen.getByRole('textbox'))).toBe('esto no debe perderse'))
    const firstQueueId = vi.mocked(agentApi.sendAgentMessage).mock.calls[0][2]?.queueId
    expect(firstQueueId).toBeTruthy()
    expect(composerSubmissionIds.get('c-new')?.queueId).toBe(firstQueueId)

    // The retry must not become a second delivery of the same turn.
    vi.mocked(agentApi.sendAgentMessage).mockResolvedValue({ queued: false })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }) })
    await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[1][2]?.queueId).toBe(firstQueueId)
    await waitFor(() => expect(editorText(screen.getByRole('textbox'))).toBe(''))
  })
})

describe('work created during an in-flight send is never overwritten', () => {
  it('keeps a newly typed prompt even when it matches the previous submission', async () => {
    let release!: () => void
    vi.mocked(agentApi.sendAgentMessage).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ queued: false }) }),
    )
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    await act(async () => { chat!.startNewConversation() })
    inputEditor(await composerBox(), 'continúa')
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }) })
    await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalled())
    inputEditor(await composerBox(), 'continúa')
    await act(async () => { release() })
    expect(editorText(await composerBox())).toBe('continúa')
  })

  it('keeps the next prompt typed while the previous send is settling', async () => {
    let release!: () => void
    vi.mocked(agentApi.sendAgentMessage).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ queued: false }) }),
    )
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    await act(async () => { chat!.startNewConversation() })
    const box = await composerBox()
    inputEditor(box, 'primer mensaje')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(chat!.active?.id).toBe('c-new'))

    inputEditor(await composerBox(), 'ya estoy escribiendo el siguiente')
    await act(async () => { release() })
    expect(editorText(await composerBox())).toBe('ya estoy escribiendo el siguiente')
  })

  it('leaves another mission\'s unsent draft untouched', async () => {
    let release!: () => void
    vi.mocked(agentApi.sendAgentMessage).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ queued: false }) }),
    )
    renderFloatingPanel()
    await waitFor(() => expect(chat).not.toBeNull())
    await act(async () => { chat!.open() })
    await act(async () => { chat!.startNewConversation() })
    // A draft parked on a different mission, exactly as leaving it mid-sentence
    // and switching away would have stored it.
    writeComposerDraft('c-otra', 'borrador de otra misión', [])
    const box = await composerBox()
    inputEditor(box, 'mensaje de esta misión')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await act(async () => { release() })
    expect(composerDrafts.get('c-otra')).toBe('borrador de otra misión')
  })
})
