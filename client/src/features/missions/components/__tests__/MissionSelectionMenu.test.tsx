import { act, fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { MissionSelectionMenu, readMissionSelection } from '../MissionSelectionMenu'
import { branchAgentConversation } from '../../lib/agent-api'
import { ApiResponseError } from '../../../../lib/api-response'
import { toast } from 'sonner'
import { __clearComposerDrafts, captureComposerDraft, writeComposerDraft } from '../../lib/agent-composer-drafts'

const state = vi.hoisted(() => ({
  providersReady: true,
  active: { id: 'source', archivedAt: null as string | null },
  send: vi.fn(), refreshConversations: vi.fn(), open: vi.fn(), toggle: vi.fn(),
}))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => state }))
vi.mock('../../context/MissionSplitViewsContext', () => ({ useMissionSplitViews: () => ({ open: state.open }) }))
vi.mock('../../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: 'agent', toggleUiMode: state.toggle }) }))
vi.mock('../../lib/agent-api', () => ({ branchAgentConversation: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  state.providersReady = true
  __clearComposerDrafts()
  window.getSelection()?.removeAllRanges()
  state.active = { id: 'source', archivedAt: null }
  state.send = vi.fn(async () => ({ accepted: true, conversationId: 'source' }))
  state.refreshConversations.mockResolvedValue(undefined)
  vi.mocked(branchAgentConversation).mockResolvedValue({ id: 'new-mission' } as Awaited<ReturnType<typeof branchAgentConversation>>)
  Range.prototype.getBoundingClientRect = () => ({ left: 50, bottom: 60 }) as DOMRect
})

function Transcript() {
  return <MissionSelectionMenu><div data-testid="transcript" tabIndex={0}>
    <p data-mission-message="first">First message</p>
    <p data-mission-message="last">Selected message</p>
    <p data-testid="live">Uncommitted stream</p>
  </div></MissionSelectionMenu>
}
function select(start: Node, end: Node = start, startOffset = 0, endOffset = end.textContent!.length) {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}
function open() {
  const text = screen.getByText('Selected message')
  select(text.firstChild!)
  fireEvent.pointerUp(text, { button: 0 })
}

it('[spec:mission-text-reuse/add-selection-to-the-captured-source-mission] shows both actions after selection and sends once through the captured source, preserving its draft', async () => {
  writeComposerDraft('source', 'My unfinished draft', [])
  const { rerender } = render(<Transcript />)
  open()
  expect(screen.getByRole('menuitem', { name: 'Start a separate mission' })).toBeInTheDocument()
  const sourceSend = state.send
  let settle!: (result: { accepted: boolean }) => void
  sourceSend.mockImplementation(() => new Promise(resolve => { settle = resolve }))
  state.active = { id: 'other', archivedAt: null }
  state.send = vi.fn()
  rerender(<Transcript />)
  const add = screen.getByRole('menuitem', { name: 'Add to mission' })
  fireEvent.click(add)
  fireEvent.click(add)
  expect(sourceSend).toHaveBeenCalledExactlyOnceWith('Selected message', { queueId: expect.stringMatching(/^selection-/) })
  expect(state.send).not.toHaveBeenCalled()
  expect(captureComposerDraft('source').text).toBe('My unfinished draft')
  await act(async () => { settle({ accepted: true }) })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it.each([['From scratch', 'empty'], ['With context · Fork', 'fork']])('[spec:mission-text-reuse/prepare-an-unsent-mission-in-an-additional-pane] prepares %s in an additional pane without sending it', async (label, mode) => {
  writeComposerDraft('source', 'Keep this draft', [])
  render(<Transcript />)
  const first = screen.getByText('First message')
  const last = screen.getByText('Selected message')
  select(first.firstChild!, last.firstChild!)
  fireEvent.contextMenu(last, { clientX: 20, clientY: 30 })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Start a separate mission' }))
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(label) }))
  await waitFor(() => expect(state.open).toHaveBeenCalledExactlyOnceWith('new-mission', { focusComposer: true }))
  expect(branchAgentConversation).toHaveBeenCalledExactlyOnceWith('source', 'last', mode)
  expect(captureComposerDraft('new-mission').text).toBe('First messageSelected message')
  expect(captureComposerDraft('source').text).toBe('Keep this draft')
  expect(state.send).not.toHaveBeenCalled()
})

it('[spec:mission-text-reuse/add-selection-to-the-captured-source-mission] retains the selection and admission ID for a failed send retry', async () => {
  state.send.mockResolvedValueOnce({ accepted: false }).mockResolvedValueOnce({ accepted: true })
  render(<Transcript />)
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add to mission' }))
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Add to mission' })).toBeEnabled())
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add to mission' }))
  await waitFor(() => expect(state.send).toHaveBeenCalledTimes(2))
  expect(state.send.mock.calls[0]).toEqual(state.send.mock.calls[1])
})

it('[spec:mission-text-reuse/selection-menu-supports-pointer-and-keyboard-operation] opens with Shift+F10, supports arrow navigation and dismisses with Escape', async () => {
  render(<Transcript />)
  const transcript = screen.getByTestId('transcript')
  transcript.focus()
  select(screen.getByText('Selected message').firstChild!)
  fireEvent.keyDown(transcript, { key: 'F10', shiftKey: true })
  const start = screen.getByRole('menuitem', { name: 'Start a separate mission' })
  await waitFor(() => expect(start).toHaveFocus())
  fireEvent.keyDown(start, { key: 'ArrowDown' })
  expect(screen.getByRole('menuitem', { name: 'Add to mission' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(transcript).toHaveFocus()
})

it('[spec:mission-text-reuse/add-selection-to-the-captured-source-mission] keeps archived history selectable but prevents sending to it', () => {
  state.active.archivedAt = '2026-01-01'
  render(<Transcript />)
  open()
  expect(screen.getByRole('menuitem', { name: 'Add to mission' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Start a separate mission' })).toBeEnabled()
})

it('[spec:mission-text-reuse/selection-actions-target-committed-transcript-text] uses the last actually selected message, excluding an endpoint at the next message start', () => {
  render(<Transcript />)
  const first = screen.getByText('First message')
  const last = screen.getByText('Selected message')
  const selection = select(first.firstChild!, last.firstChild!, 3, 0)
  expect(readMissionSelection(screen.getByTestId('transcript'), selection)).toMatchObject({ text: 'st message', throughMessageId: 'first' })
})

it('[spec:mission-text-reuse/selection-actions-target-committed-transcript-text] rejects selections crossing a different pane or an uncommitted stream', () => {
  render(<><Transcript /><p data-mission-message="foreign">Other pane</p></>)
  const root = screen.getByTestId('transcript')
  const first = screen.getByText('First message').firstChild!
  expect(readMissionSelection(root, select(first, screen.getByTestId('live').firstChild!))).toBeNull()
  expect(readMissionSelection(root, select(first, screen.getByText('Other pane').firstChild!))).toBeNull()
})

it('[spec:mission-text-reuse/failed-fork-preparation-preserves-user-work] preserves the menu for a failed branch and creates neither a draft nor a pane', async () => {
  vi.mocked(branchAgentConversation).mockRejectedValue(new Error('Missing attachment'))
  render(<Transcript />)
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Start a separate mission' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /With context/ }))
  await waitFor(() => expect(screen.getByRole('menuitem', { name: /With context/ })).toBeEnabled())
  expect(state.open).not.toHaveBeenCalled()
  expect(captureComposerDraft('new-mission').text).toBe('')
})

it('[spec:mission-text-reuse/failed-fork-preparation-preserves-user-work] explains when the running server does not support forks, preserving the selection and drafts', async () => {
  const error = new ApiResponseError('endpointUnavailable', 404)
  vi.mocked(branchAgentConversation).mockRejectedValue(error)
  writeComposerDraft('source', 'Keep my draft', [])
  render(<Transcript />)
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Start a separate mission' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /With context/ }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(error.message))
  expect(screen.getByRole('menuitem', { name: /With context/ })).toBeEnabled()
  expect(state.open).not.toHaveBeenCalled()
  expect(captureComposerDraft('source').text).toBe('Keep my draft')
  expect(captureComposerDraft('new-mission').text).toBe('')
})

it('[spec:mission-text-reuse/add-selection-to-the-captured-source-mission] disables sending while providers are unavailable', () => {
  state.providersReady = false
  render(<Transcript />)
  open()
  const add = screen.getByRole('menuitem', { name: 'Add to mission' })
  expect(add).toBeDisabled()
  fireEvent.click(add)
  expect(state.send).not.toHaveBeenCalled()
  expect(screen.getByRole('menuitem', { name: 'Start a separate mission' })).toBeEnabled()
})
