import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

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
import { RunPrimaryButton } from '../run-primary'

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

  describe('composer mode (Flow named on the composer)', () => {
    const Icon = (props: { className?: string }) => <svg data-testid="mode-icon" {...props} />
    const COMPOSER_MODE: MissionExtensions = {
      useConversationMode: () => ({
        hideGitStrip: true,
        composer: { badge: { label: 'Flow', description: 'Flow mode: the agent writes in the worktree', icon: Icon, accent: 'var(--color-accent-flow)' }, placeholder: 'Tell the agent what to change in the worktree…' },
        headerBadge: { label: 'In Flow', icon: Icon },
      }),
    }

    it('shows the mode chip next to the tier chip, the top accent line and the mode placeholder', async () => {
      renderPanel(COMPOSER_MODE)
      await waitFor(() => expect(chat).not.toBeNull())
      await act(async () => { chat!.open() })
      await waitFor(() => expect(chat!.active?.id).toBe('c-new'))
      const chip = await screen.findByTestId('agent-composer-mode-chip')
      expect(chip).toHaveTextContent('Flow')
      expect(chip).toHaveAttribute('title', 'Flow mode: the agent writes in the worktree')
      expect(within(chip).getByTestId('mode-icon')).toBeInTheDocument()
      // The chip names the mode; no unlabeled accent line along the composer.
      expect(screen.queryByTestId('agent-composer-mode-line')).toBeNull()
      expect(chip.style.getPropertyValue('--mode-accent')).toBe('var(--color-accent-flow)')
      expect(screen.getByTestId('agent-composer-box')).toHaveAttribute('data-composer-mode', 'extension')
      expect(screen.getByRole('textbox')).toHaveAttribute('data-placeholder', 'Tell the agent what to change in the worktree…')
    })

    it('without a mode the composer is plain', async () => {
      renderPanel()
      await waitFor(() => expect(chat).not.toBeNull())
      await act(async () => { chat!.open() })
      await screen.findByRole('textbox')
      expect(screen.queryByTestId('agent-composer-mode-chip')).toBeNull()
      expect(screen.queryByTestId('agent-composer-mode-line')).toBeNull()
    })
  })

  describe('extension runs and Flow history', () => {
    const message = (id: string, role: 'user' | 'assistant' | 'system', content: string) => ({ id, conversation_id: 'c1', role, content, created_at: '2026-10-22T10:00:00.000Z' })
    const boundary = (id: string, event: 'entered' | 'left', reason: string) => message(id, 'system', JSON.stringify({ kind: 'flow-boundary', flowId: 'f1', event, reason, branch: 'feat/7-calm', at: '' }))

    async function openWith(messages: ReturnType<typeof message>[], extensions?: MissionExtensions, listed: string[] = ['c1']) {
      vi.mocked(agentApi.listAgentConversations).mockResolvedValue(listed.map(conversation) as never)
      vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: conversation('c1'), messages } as never)
      renderPanel(extensions)
      await waitFor(() => expect(chat).not.toBeNull())
      await act(async () => { chat!.open() })
      await act(async () => { await chat!.selectConversation('c1') })
    }

    it('an extension run shows in the same strip, with its controls and its panel', async () => {
      const RUNS: MissionExtensions = {
        useLiveRuns: () => [{
          key: 'flow:f1', label: 'Flow', tone: 'decision', headline: 'Flow → Spec ready to launch',
          controls: <button type="button">Copy branch</button>,
          panel: <RunPrimaryButton primary={{ id: 'launch', label: 'Launch', kind: 'outward' }} onClick={() => undefined}>Play</RunPrimaryButton>,
        }],
      }
      await openWith([message('m1', 'user', 'hi')], RUNS)
      const strip = await screen.findByTestId('mission-run-strip')
      expect(strip).toHaveAttribute('data-run-key', 'flow:f1')
      expect(within(strip).getByRole('button', { name: 'Copy branch' })).toBeInTheDocument()
      // The panel's content DECLARES the primary (label, kind): an outward one opens the panel on it.
      const primary = await within(strip).findByTestId('mission-run-strip-primary')
      expect(primary).toHaveTextContent('Launch')
      await act(async () => { fireEvent.click(primary) })
      const play = within(screen.getByTestId('mission-run-strip-panel')).getByRole('button', { name: 'Play' })
      await waitFor(() => expect(document.activeElement).toBe(play))
    })

    it('an extension run that waits for the person feeds the mission list attention dot; a calm one does not', async () => {
      let tone: 'decision' | 'info' = 'info'
      const RUNS: MissionExtensions = {
        useLiveRuns: () => [{ key: 'flow:f1', label: 'Flow', tone, headline: 'Ready to turn into a PR' }],
      }
      await openWith([message('m1', 'user', 'hi')], RUNS)
      await screen.findByTestId('mission-run-strip')
      expect(chat!.attentionConversationIds.has('c1')).toBe(false)
      tone = 'decision'
      // Re-render with the new tone (the slot is read on render).
      await act(async () => { await chat!.selectConversation('c1') })
      await waitFor(() => expect(chat!.attentionConversationIds.has('c1')).toBe(true))
    })

    it('an extension with an app-wide attention source feeds the dot for missions that are not open, live, and the strip leaves its runs to it', async () => {
      // A tiny external store standing in for the extension's own app-wide watch (Flow: GET /flow/open + flow.state).
      let attention: ReadonlyMap<string, ReadonlySet<string>> = new Map()
      const listeners = new Set<() => void>()
      const setAttention = (next: ReadonlyMap<string, ReadonlySet<string>>) => { attention = next; for (const l of listeners) l() }
      const seen: string[][] = []
      const RUNS: MissionExtensions = {
        // The open mission's run waits for the person, but the extension owns its attention.
        useLiveRuns: () => [{ key: 'flow:f1', label: 'Flow', tone: 'decision', headline: 'Waiting' }],
        useRunAttention: (conversations) => {
          seen.push(conversations.map((c) => c.id))
          return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => attention)
        },
      }
      await openWith([message('m1', 'user', 'hi')], RUNS, ['c1', 'c2'])
      await screen.findByTestId('mission-run-strip')
      // The strip does not report the extension's runs: no dot from the open mission's strip.
      expect(chat!.attentionConversationIds.has('c1')).toBe(false)
      // The hook sees every listed mission, open or not.
      await waitFor(() => expect(seen.at(-1)).toEqual(['c1', 'c2']))
      // A mission that is NOT open gets the dot live, and loses it when the run stops waiting.
      act(() => setAttention(new Map([['c2', new Set(['flow'])]])))
      await waitFor(() => expect(chat!.attentionConversationIds.has('c2')).toBe(true))
      expect(chat!.attentionConversationIds.has('c1')).toBe(false)
      act(() => setAttention(new Map()))
      await waitFor(() => expect(chat!.attentionConversationIds.has('c2')).toBe(false))
    })

    it('the turn mark comes from the extension seam (its icon and color), never hard-coded', async () => {
      const TurnIcon = (props: { className?: string }) => <svg data-testid="turn-mode-icon" {...props} />
      await openWith([
        boundary('b1', 'entered', 'started'),
        message('m2', 'assistant', 'inside Flow'),
      ], { useTurnMark: () => ({ label: 'Flow', icon: TurnIcon, accent: 'var(--color-accent-flow)' }) })
      const mark = await screen.findByTestId('agent-message-mode-mark')
      expect(mark).toHaveTextContent('Flow')
      expect(within(mark).getByTestId('turn-mode-icon')).toBeInTheDocument()
      expect(mark.style.getPropertyValue('--turn-mode-accent')).toBe('var(--color-accent-flow)')
    })

    it('boundaries are event lines; the agent turns between them carry a Flow mark next to their time', async () => {
      await openWith([
        message('m1', 'assistant', 'before Flow'),
        boundary('b1', 'entered', 'started'),
        message('m2', 'assistant', 'inside Flow'),
        boundary('b2', 'left', 'handed_off'),
        message('m3', 'assistant', 'after Flow'),
        boundary('b3', 'entered', 'returned'),
        message('m4', 'assistant', 'back in Flow'),
      ])
      const lines = await screen.findAllByTestId('agent-flow-boundary')
      // The return is told by the Back to Flow line: its boundary only marks the turns.
      expect(lines).toHaveLength(2)
      expect(lines[0]).toHaveTextContent('Entered Flow')
      expect(lines[0]).toHaveTextContent('feat/7-calm')
      expect(lines[1]).toHaveTextContent('Left Flow')
      expect(lines[1]).toHaveTextContent('handed off to a rail')
      const marks = screen.getAllByTestId('agent-message-mode-mark')
      expect(marks).toHaveLength(2)
      const markedTexts = marks.map((mark) => mark.closest('.group')?.textContent ?? '')
      expect(markedTexts.some((text) => text.includes('inside Flow'))).toBe(true)
      expect(markedTexts.some((text) => text.includes('back in Flow'))).toBe(true)
      expect(markedTexts.some((text) => text.includes('before Flow') || text.includes('after Flow'))).toBe(false)
    })
  })

  describe('option chips', () => {
    const OPTIONS_REPLY = 'Which trail should the cursor leave?\n\n```options\n["Particle trail", "Solid trail", "No trail"]\n```'
    const message = (id: string, role: 'user' | 'assistant', content: string) => ({ id, conversation_id: 'c1', role, content, created_at: '2026-10-22T10:00:00.000Z' })

    async function openWithOptions(extensions?: MissionExtensions) {
      vi.mocked(agentApi.listAgentConversations).mockResolvedValue([conversation('c1')] as never)
      vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
        conversation: conversation('c1'),
        messages: [message('m1', 'user', 'make the cursor fun'), message('m2', 'assistant', OPTIONS_REPLY)],
      } as never)
      renderPanel(extensions)
      await waitFor(() => expect(chat).not.toBeNull())
      await act(async () => { chat!.open() })
      await act(async () => { await chat!.selectConversation('c1') })
      return screen.findByRole('button', { name: 'Solid trail' })
    }

    it('renders the Flow agent options as chips and sends a pick normally when the agent is idle', async () => {
      const chip = await openWithOptions(FLOW_MODE)
      expect(screen.getByRole('button', { name: 'Particle trail' })).toBeInTheDocument()
      expect(screen.queryByText(/```options/)).toBeNull()
      await act(async () => { fireEvent.click(chip) })
      await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(1))
      expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[0][1]).toBe('Solid trail')
      expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[0][2]).not.toHaveProperty('deliveryMode')
    })

    it('keeps the chips while the Flow agent is busy and a pick interrupts the running turn', async () => {
      await openWithOptions(FLOW_MODE)
      // A busy continuation turn (no newer settled message yet): the server streams.
      act(() => { wsHandler?.({ type: 'agent_stream', conversationId: 'c1', delta: 'Working on it' }) })
      await waitFor(() => expect(chat!.isStreaming).toBe(true))
      vi.mocked(agentApi.sendAgentMessage).mockClear()
      vi.mocked(agentApi.sendAgentMessage).mockResolvedValue({ queued: true, deliveryMode: 'interrupt' })
      const chip = screen.queryByRole('button', { name: 'Solid trail' })
      expect(chip).not.toBeNull()
      await act(async () => { fireEvent.click(chip!) })
      await waitFor(() => expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(1))
      expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[0][1]).toBe('Solid trail')
      expect(vi.mocked(agentApi.sendAgentMessage).mock.calls[0][2]).toMatchObject({ deliveryMode: 'interrupt' })
    })

    it('outside Flow a busy turn still suppresses the chips', async () => {
      await openWithOptions()
      act(() => { wsHandler?.({ type: 'agent_stream', conversationId: 'c1', delta: 'Working on it' }) })
      await waitFor(() => expect(chat!.isStreaming).toBe(true))
      expect(screen.queryByRole('button', { name: 'Solid trail' })).toBeNull()
    })
  })
})
