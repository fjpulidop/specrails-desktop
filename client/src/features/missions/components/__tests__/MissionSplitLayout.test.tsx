import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentChatProvider, useAgentChat } from '../../context/AgentChatContext'
import { useActiveLive } from '../../hooks/useAgentLive'
import { useMissionPaneClose, useMissionPaneLayoutId } from '../../context/MissionSplitViewsContext'
import { AgentConversationView } from '../AgentConversationView'
import { MissionSplitLayout } from '../MissionSplitLayout'
import { MissionConversationMenu } from '../MissionConversationMenu'
import { AgentComposer, __clearComposerDrafts } from '../AgentComposer'
import * as api from '../../lib/agent-api'

const ws = vi.hoisted(() => {
  const handlers = new Map<string, (message: unknown) => void>()
  return { handlers, registerHandler: vi.fn((id: string, handler: (message: unknown) => void) => { handlers.set(id, handler) }),
    unregisterHandler: vi.fn((id: string) => { handlers.delete(id) }), setProject: vi.fn() }
})
vi.mock('../../../../hooks/useSharedWebSocket', () => ({ useSharedWebSocket: () => ({ ...ws, connectionStatus: 'connected' }) }))
vi.mock('../../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: 'agent' }) }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'p1', projects: [], setActiveProjectId: ws.setProject }) }))
vi.mock('../../../providers/hooks/useAvailableProviders', () => ({ useAvailableProviders: () => ({ availableIds: ['claude'], loading: false }) }))
vi.mock('../../lib/agent-api', async original => {
  const actual = await original<typeof import('../../lib/agent-api')>()
  const conversations = ['one', 'two', 'three'].map((title, index) => ({ id: `c${index + 1}`, title, provider: 'claude', model: 'sonnet', session_id: null,
    pinned_project_id: `p${index + 1}`, tier_level: 0, created_at: '', updated_at: '' }))
  return { ...actual, listAgentConversations: vi.fn(async () => conversations),
    getAgentConversation: vi.fn(async (id: string) => ({ conversation: conversations.find(conversation => conversation.id === id), messages: [{ id: `${id}-message`, conversation_id: id, role: 'user', content: 'Selected mission text', created_at: '' }], live: { isStreaming: false, streamingText: '' }, pendingMessages: [] })),
    getAgentModels: vi.fn(async () => ({ models: [{ value: 'sonnet', label: 'Sonnet 5.5', default: true }], efforts: ['medium', 'high'], customModelAliases: false, supportsImageInput: true })),
    sendAgentMessage: vi.fn(async () => ({ queued: false })), abortAgentTurn: vi.fn(async () => {}),
    listAgentAttachments: vi.fn(async () => []),
    branchAgentConversation: vi.fn(async () => conversations[2]),
    patchAgentConversation: vi.fn(), createAgentConversation: vi.fn(), deleteAgentConversation: vi.fn(),
    getMcpStatus: vi.fn(async () => ({ enabled: true })), getAvailableProviders: vi.fn(async () => ({ any: true, installed: ['claude'] })) }
})
vi.mock('../AgentModeSurface', () => ({ AgentModeSurface: () => <Pane /> }))

let showConversation = false
function Pane() {
  const chat = useAgentChat()
  const live = useActiveLive()
  const close = useMissionPaneClose()
  const layoutId = useMissionPaneLayoutId()
  return <div data-testid={`pane-${chat.active?.id}`} data-layout-id={layoutId}>
    <span>{chat.active?.title}</span>
    {close && <button onClick={close}>Close {chat.active?.title}</button>}
    <output data-testid={`stream-${chat.active?.id}`}>{live.streamingText}</output>
    {showConversation ? <AgentConversationView variant="inline" /> : <AgentComposer />}
  </div>
}
function Workspace() {
  const chat = useAgentChat()
  useEffect(() => { void chat.selectConversation('c1'); void chat.refreshConversations() }, [chat.selectConversation, chat.refreshConversations])
  return <>
    <output data-testid="primary-id">{chat.active?.id}</output>
    {['c1', 'c2', 'c3'].map(id => <MissionConversationMenu key={id} conversationId={id}><button>Open {id}</button></MissionConversationMenu>)}
    <MissionSplitLayout><Pane /></MissionSplitLayout>
  </>
}
beforeEach(() => { showConversation = false; window.getSelection()?.removeAllRanges(); ws.handlers.clear(); vi.clearAllMocks(); __clearComposerDrafts() })

it('adds conversations without replacing the current one, isolates drafts and live events, and collapses only the closed pane', async () => {
  const user = userEvent.setup()
  render(<AgentChatProvider><Workspace /></AgentChatProvider>)
  const primary = await screen.findByTestId('pane-c1')
  const primaryEditor = within(primary).getByRole('textbox')
  await user.type(primaryEditor, 'Unsent first draft')
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open c2' }), { clientX: 20, clientY: 30 })
  await user.click(screen.getByRole('menuitem', { name: 'Split view' }))
  const second = await screen.findByTestId('pane-c2')
  expect(screen.getByTestId('primary-id')).toHaveTextContent('c1')
  expect(second.dataset.layoutId).not.toBe(primary.dataset.layoutId)
  expect([...ws.handlers.keys()].filter((id) => !String(id).startsWith('mission-sessions:'))).toHaveLength(2)
  const secondEditor = within(second).getByRole('textbox')
  await user.type(secondEditor, 'Second input')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(api.sendAgentMessage).toHaveBeenCalledWith('c2', 'Second input', expect.anything()))
  expect(primaryEditor).toHaveTextContent('Unsent first draft')
  act(() => { for (const handler of ws.handlers.values()) handler({ type: 'agent_stream', conversationId: 'c2', delta: 'Second stream' }) })
  await waitFor(() => expect(screen.getByTestId('stream-c2')).toHaveTextContent('Second stream'))
  expect(screen.getByTestId('stream-c1')).toBeEmptyDOMElement()
  // Already visible conversations offer no redundant split action.
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open c2' }))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Open c1' }), { key: 'F10', shiftKey: true })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('pane-c2')).toHaveLength(1)
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open c3' }))
  await user.click(screen.getByRole('menuitem', { name: 'Split view' }))
  await screen.findByTestId('pane-c3')
  expect(screen.getByTestId('pane-c3').closest('section')).toHaveStyle({ gridColumn: '1', gridRow: '2 / span 1' })
  expect(second.closest('section')).toHaveStyle({ gridColumn: '2', gridRow: '1 / span 2' })
  await user.click(screen.getByRole('button', { name: 'Close three' }))
  expect(screen.queryByTestId('pane-c3')).not.toBeInTheDocument()
  expect(screen.getByTestId('pane-c2')).toBe(second)
  expect(screen.getByTestId('pane-c1')).toBe(primary)
  await user.click(screen.getByRole('button', { name: 'Close two' }))
  expect(screen.queryByTestId('pane-c2')).not.toBeInTheDocument()
  expect(screen.getByTestId('pane-c1')).toBe(primary)
  expect(primaryEditor).toHaveTextContent('Unsent first draft')
  expect(api.abortAgentTurn).not.toHaveBeenCalled()
  expect(api.deleteAgentConversation).not.toHaveBeenCalled()
  expect(ws.setProject).not.toHaveBeenCalled()
  expect([...ws.handlers.keys()].filter((id) => !String(id).startsWith('mission-sessions:'))).toHaveLength(1)
})

it('keeps the remaining split full width when the original pane is closed, then restores the original when all splits close', async () => {
  const user = userEvent.setup()
  const { container } = render(<AgentChatProvider><Workspace /></AgentChatProvider>)
  await screen.findByTestId('pane-c1')
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open c2' }))
  await user.click(screen.getByRole('menuitem', { name: 'Split view' }))
  const second = await screen.findByTestId('pane-c2')
  await user.click(screen.getByRole('button', { name: 'Close one' }))
  expect(screen.getByTestId('pane-c1')).not.toBeVisible()
  expect(second).toBeVisible()
  expect(container.querySelector('[data-split-count]')).toHaveAttribute('data-split-count', '1')
  await user.click(screen.getByRole('button', { name: 'Close two' }))
  expect(screen.getByTestId('pane-c1')).toBeVisible()
})

it('shows a failed pane with retry and allows closing it without changing the original mission', async () => {
  const user = userEvent.setup()
  render(<AgentChatProvider><Workspace /></AgentChatProvider>)
  await screen.findByTestId('pane-c1')
  vi.mocked(api.getAgentConversation).mockRejectedValueOnce(new Error('offline'))
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open c2' }))
  await user.click(screen.getByRole('menuitem', { name: 'Split view' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this conversation.')
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }))
  await screen.findByTestId('pane-c2')
  expect(screen.getByTestId('primary-id')).toHaveTextContent('c1')
})

it.each([['From scratch', 'empty'], ['With context · Fork', 'fork']])('[spec:mission-text-reuse/prepare-an-unsent-mission-in-an-additional-pane] selection prepares %s with an editable focused draft and preserves existing work', async (label, mode) => {
  showConversation = true
  Range.prototype.getBoundingClientRect = () => ({ left: 20, bottom: 30 }) as DOMRect
  const user = userEvent.setup()
  render(<AgentChatProvider><Workspace /></AgentChatProvider>)
  const primary = await screen.findByTestId('pane-c1')
  const primaryEditor = await within(primary).findByRole('textbox')
  await user.type(primaryEditor, 'Unsent source draft')
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open c2' }))
  await user.click(screen.getByRole('menuitem', { name: 'Split view' }))
  const second = await screen.findByTestId('pane-c2')
  const secondEditor = within(second).getByRole('textbox')
  await user.type(secondEditor, 'Other pane draft')
  const sourceLog = within(primary).getByRole('log')
  sourceLog.scrollTop = 137
  fireEvent.scroll(sourceLog)
  const identities = [primary.dataset.layoutId, second.dataset.layoutId]
  const selected = await within(primary).findByText('Selected mission text')
  const range = document.createRange()
  range.selectNodeContents(selected.firstChild!)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.pointerUp(selected, { button: 0 })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Start a separate mission' }))
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(label) }))
  const added = await screen.findByTestId('pane-c3')
  const editor = await within(added).findByRole('textbox')
  await waitFor(() => expect(editor).toHaveTextContent('Selected mission text'))
  await waitFor(() => expect(editor).toHaveFocus())
  expect(api.branchAgentConversation).toHaveBeenCalledExactlyOnceWith('c1', 'c1-message', mode)
  expect(document.querySelector('[data-split-count]')).toHaveAttribute('data-split-count', '3')
  expect(screen.getByTestId('pane-c1')).toBe(primary)
  expect(screen.getByTestId('pane-c2')).toBe(second)
  expect([primary.dataset.layoutId, second.dataset.layoutId]).toEqual(identities)
  expect(within(primary).getByRole('textbox')).toBe(primaryEditor)
  expect(within(primary).getByRole('log')).toBe(sourceLog)
  expect(sourceLog.scrollTop).toBe(137)
  expect(primaryEditor).toHaveTextContent('Unsent source draft')
  expect(secondEditor).toHaveTextContent('Other pane draft')
  await user.type(editor, ' edited')
  expect(editor).toHaveTextContent('Selected mission text edited')
  expect(api.sendAgentMessage).not.toHaveBeenCalled()
})
