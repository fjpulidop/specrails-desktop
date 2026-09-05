import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'

// ── Mocks ─────────────────────────────────────────────────────────────────────
let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
  { id: 'p2', name: 'deckdex', slug: 'deckdex', path: '/deck', provider: 'claude' },
]
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('../../../hooks/useAvailableProviders', () => ({
  useAvailableProviders: () => ({
    available: { claude: true, codex: true, gemini: true, kimi: true },
    availableIds: ['claude', 'codex', 'gemini', 'kimi'],
    issues: {},
    launchDescriptors: {},
    loading: false,
  }),
}))

const api = {
  conv: { id: 'c1', title: null, provider: 'claude', model: null, session_id: null, pinned_project_id: null, tier_level: 0 as const, created_at: '', updated_at: '' },
}
vi.mock('../../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => []),
    createAgentConversation: vi.fn(async () => api.conv),
    getAgentConversation: vi.fn(async () => ({ conversation: api.conv, messages: [] })),
    patchAgentConversation: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...api.conv, ...patch, tier_level: patch.tierLevel ?? api.conv.tier_level })),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    uploadAgentAttachment: vi.fn(async (_conversationId: string, file: File) => ({
      id: 'att-1',
      filename: file.name,
      storedName: `stored-${file.name}`,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      addedAt: '',
    })),
    listAgentAttachments: vi.fn(async () => []),
    fetchAgentAttachmentBlob: vi.fn(async () => new Blob(['x'], { type: 'application/octet-stream' })),
    abortAgentTurn: vi.fn(async () => {}),
    editQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAgentModels: vi.fn(async (p: string) => ({
      models: p === 'codex'
        ? [{ value: 'gpt-5.5', label: 'GPT-5.5', default: true }, { value: 'gpt-5.4', label: 'GPT-5.4' }]
        : p === 'kimi'
          ? [{ value: 'k3', label: 'Kimi K3', default: true }, { value: 'kimi-for-coding', label: 'Kimi for Coding' }]
        : [{ value: 'sonnet', label: 'Claude Sonnet', default: true }, { value: 'opus', label: 'Claude Opus' }],
      supportsImageInput: p !== 'gemini',
      customModelAliases: p === 'kimi',
      efforts: p === 'gemini'
        ? []
        : p === 'codex'
          ? ['minimal', 'low', 'medium', 'high']
          : p === 'kimi'
            ? ['low', 'high', 'max']
            : ['low', 'medium', 'high', 'xhigh'],
    })),
  }
})

const mockOpenWebView = vi.fn()
vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: mockOpenWebView, canOpenWebView: true }),
}))

// Queue-edit surfaces its dispatched-race notice via sonner — mock to assert.
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

import { toast } from 'sonner'
import * as agentApi from '../../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'
import { AgentWorkspaceProvider, useAgentWorkspace } from '../../../context/AgentWorkspaceContext'
import { AgentComposer, __clearComposerDrafts } from '../AgentComposer'
import { AgentTierChip } from '../AgentTierChip'
import { AgentProjectSelector } from '../AgentProjectSelector'
import { AgentActivityChip, toolChipLabel } from '../AgentActivityChip'
import { AgentBubble } from '../AgentBubble'
import { AgentMessage } from '../AgentMessage'
import { AgentModelSelector } from '../AgentModelSelector'

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
  __clearComposerDrafts()
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([])
  vi.mocked(agentApi.createAgentConversation).mockResolvedValue(api.conv)
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv, messages: [] })
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
  vi.mocked(agentApi.editQueuedAgentMessage).mockResolvedValue('saved')
  vi.mocked(agentApi.uploadAgentAttachment).mockImplementation(async (_conversationId: string, file: File) => ({
    id: 'att-1',
    filename: file.name,
    storedName: `stored-${file.name}`,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    addedAt: '',
  }))
  vi.mocked(agentApi.listAgentAttachments).mockResolvedValue([])
  vi.mocked(agentApi.fetchAgentAttachmentBlob).mockResolvedValue(new Blob(['x'], { type: 'application/octet-stream' }))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:agent-attachment'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})


/** Read the editable document as the user-facing tokens, without the pill's label
 *  or remove-button text becoming part of the message. */
function editorText(editor: HTMLElement): string {
  const document = editor.cloneNode(true) as HTMLElement
  document.querySelectorAll<HTMLElement>('[data-inline-reference]').forEach((pill) => {
    pill.replaceWith(pill.dataset.token ?? '')
  })
  return visibleNodeText(document)
}

function visibleNodeText(node: Node | null): string {
  return (node?.textContent ?? '').replace(/\u200b/g, '')
}

/** Place a real DOM caret at a token-aware offset. Atomic pills occupy the
 *  length of their token; a caret can only sit before or after a pill. */
function selectEditor(editor: HTMLElement, offset: number, report = true): void {
  editor.focus()
  const range = document.createRange()
  let remaining = offset
  let placed = false
  const visit = (node: Node): void => {
    if (placed) return
    if (node instanceof HTMLElement && node.hasAttribute('data-inline-reference')) {
      const size = (node.dataset.token ?? '').length
      if (remaining <= size) {
        if (remaining === 0) range.setStartBefore(node)
        else if (node.nextSibling?.nodeType === Node.TEXT_NODE && node.nextSibling.textContent?.startsWith('\u200b')) {
          range.setStart(node.nextSibling, 1)
        } else range.setStartAfter(node)
        placed = true
      } else remaining -= size
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? ''
      const length = visibleNodeText(node).length
      if (remaining <= length) {
        let rawOffset = 0
        let plainOffset = 0
        while (rawOffset < raw.length && (plainOffset < remaining || raw[rawOffset] === '\u200b')) {
          if (raw[rawOffset] !== '\u200b') plainOffset += 1
          rawOffset += 1
        }
        range.setStart(node, rawOffset)
        placed = true
      } else remaining -= length
      return
    }
    node.childNodes.forEach(visit)
  }
  visit(editor)
  if (!placed) {
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  if (report) fireEvent(document, new Event('selectionchange'))
}

function inputEditor(editor: HTMLElement, text: string, caret = text.length): void {
  editor.textContent = text
  selectEditor(editor, caret, false)
  fireEvent.input(editor, { inputType: 'insertText' })
}

function insertEditorText(editor: HTMLElement, text: string): void {
  const selection = window.getSelection()!
  const range = selection.getRangeAt(0)
  const node = document.createTextNode(text)
  range.deleteContents()
  range.insertNode(node)
  range.setStart(node, text.length)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.input(editor, { inputType: 'insertText', data: text })
}

// ── AgentTierChip ─────────────────────────────────────────────────────────────
describe('AgentTierChip', () => {
  it('renders the level name and cycles on click', () => {
    const onCycle = vi.fn()
    render(<AgentTierChip level={2} onCycle={onCycle} />)
    expect(screen.getByText('Operate')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(onCycle).toHaveBeenCalled()
  })
})

// ── AgentProjectSelector ──────────────────────────────────────────────────────
describe('AgentProjectSelector', () => {
  it('shows Home when nothing pinned and lists projects on open', () => {
    const onSelect = vi.fn()
    render(<AgentProjectSelector pinnedProjectId={null} onSelect={onSelect} />)
    expect(screen.getByText('Home')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Home'))
    expect(screen.getByText('acme-api')).toBeInTheDocument()
    fireEvent.click(screen.getByText('acme-api'))
    expect(onSelect).toHaveBeenCalledWith('p1')
  })

  it('shows the pinned project name', () => {
    render(<AgentProjectSelector pinnedProjectId="p2" onSelect={vi.fn()} />)
    expect(screen.getByText('deckdex')).toBeInTheDocument()
  })

  it('supports keyboard search/selection and restores focus to the trigger', () => {
    const onSelect = vi.fn()
    render(<AgentProjectSelector pinnedProjectId={null} onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: 'Home' })

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const search = screen.getByRole('combobox', { name: 'Search projects…' })
    fireEvent.change(search, { target: { value: 'deck' } })
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-option-1$/)
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('p2')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('clears a search when the dropdown closes without a selection', () => {
    render(<AgentProjectSelector pinnedProjectId={null} onSelect={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Home' })
    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole('combobox', { name: 'Search projects…' }), { target: { value: 'deck' } })
    fireEvent.mouseDown(document.body)

    fireEvent.click(trigger)
    expect(screen.getByRole('combobox', { name: 'Search projects…' })).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Home' })).toHaveAttribute('aria-selected', 'true')
  })

  it('does not unpin the project when a search has no matches and Enter is pressed', () => {
    const onSelect = vi.fn()
    render(<AgentProjectSelector pinnedProjectId="p1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'acme-api' }))
    const search = screen.getByRole('combobox', { name: 'Search projects…' })
    fireEvent.change(search, { target: { value: 'no-such-project' } })

    expect(search).not.toHaveAttribute('aria-activedescendant')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// ── AgentActivityChip (single synthetic chip) ─────────────────────────────────
describe('AgentActivityChip', () => {
  it('abbreviates tool names', () => {
    expect(toolChipLabel('mcp__specrails__specrails_jobs')).toBe('MCP · jobs')
    expect(toolChipLabel('mcp__whatever')).toBe('MCP · whatever')
    expect(toolChipLabel('Bash')).toBe('Terminal')
    expect(toolChipLabel('Grep')).toBe('Searching')
    expect(toolChipLabel('SomethingElse')).toBe('SomethingElse')
  })

  it('shows Thinking… when no tool is active', () => {
    render(<AgentActivityChip tool={null} />)
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })

  it('shows the abbreviated label once a tool is active', () => {
    render(<AgentActivityChip tool="mcp__specrails__specrails_jobs" />)
    expect(screen.getByText('MCP · jobs')).toBeInTheDocument()
  })

  it('falls back to Thinking… for a nameless (<unnamed>) tool', () => {
    render(<AgentActivityChip tool="<unnamed>" />)
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })
})

// ── AgentMessage (markdown + copy) ────────────────────────────────────────────
describe('AgentMessage', () => {
  it('renders a plain user bubble with a copy button', () => {
    render(<AgentMessage role="user" content="hola mundo" />)
    expect(screen.getByText('hola mundo')).toBeInTheDocument()
    expect(screen.getByLabelText('Copy')).toBeInTheDocument()
  })

  it('renders selected @, #, and / refs as inline chips in user bubbles', () => {
    const { container } = render(
      <AgentMessage
        role="user"
        content="inspect this"
        contextRefs={[
          { kind: 'project', id: 'p2', label: 'deckdex', token: '@deckdex' },
          { kind: 'trace', id: 'job1234', label: 'job1234', token: '#job1234' },
          { kind: 'action', id: 'action:status', label: 'Show status', token: '/status' },
        ]}
      />,
    )
    expect(container.querySelectorAll('[data-agent-context-token]').length).toBe(3)
    expect(screen.getByText('deckdex')).toBeInTheDocument()
    expect(screen.getByText('job1234')).toBeInTheDocument()
    expect(screen.getByText('Show status')).toBeInTheDocument()
    expect(screen.getByText('inspect this')).toBeInTheDocument()
  })

  it('opens an in-app preview for image attachments in user bubbles', async () => {
    vi.mocked(agentApi.fetchAgentAttachmentBlob).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const { container } = render(
      <AgentMessage
        role="user"
        content="mira esta imagen"
        conversationId="c1"
        attachments={[{
          id: 'img-1',
          filename: 'screen.png',
          storedName: 'stored-screen.png',
          mimeType: 'image/png',
          size: 2048,
          addedAt: '',
        }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Preview screen.png' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(await screen.findByRole('img', { name: 'screen.png' })).toBeInTheDocument()
    expect(agentApi.fetchAgentAttachmentBlob).toHaveBeenCalledWith('c1', 'img-1')
  })

  it('opens a download confirmation modal for non-image attachments', async () => {
    vi.mocked(agentApi.fetchAgentAttachmentBlob).mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }))
    render(
      <AgentMessage
        role="user"
        content="revisa este archivo"
        conversationId="c1"
        attachments={[{
          id: 'file-1',
          filename: 'brief.pdf',
          storedName: 'stored-brief.pdf',
          mimeType: 'application/pdf',
          size: 4096,
          addedAt: '',
        }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download brief.pdf' }))

    expect(await screen.findByRole('dialog', { name: 'Download file?' })).toBeInTheDocument()
    expect(screen.getByText('This file cannot be previewed here. Do you want to download it?')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute('download', 'brief.pdf')
  })

  it('renders assistant markdown: bold + a table', () => {
    const md = '**strong text**\n\n| A | B |\n| - | - |\n| 1 | 2 |'
    const { container } = render(<AgentMessage role="assistant" content={md} />)
    expect(container.querySelector('strong')?.textContent).toBe('strong text')
    expect(container.querySelector('table')).toBeInTheDocument()
    expect(container.querySelectorAll('td').length).toBe(2)
  })

  it('hides the copy button while streaming', () => {
    render(<AgentMessage role="assistant" content="partial" streaming />)
    expect(screen.queryByLabelText('Copy')).not.toBeInTheDocument()
  })

  it('opens http(s) links in the embedded browser instead of navigating the app', () => {
    render(<AgentMessage role="assistant" content="See [the docs](https://specrails.dev/docs) for more." />)
    const link = screen.getByRole('link', { name: 'the docs' })
    expect(link).toHaveAttribute('target', '_blank')
    fireEvent.click(link)
    expect(mockOpenWebView).toHaveBeenCalledWith('https://specrails.dev/docs')
  })

  it('copies the content to the clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<AgentMessage role="user" content="copy me" />)
    await act(async () => { fireEvent.click(screen.getByLabelText('Copy')) })
    expect(writeText).toHaveBeenCalledWith('copy me')
    vi.unstubAllGlobals()
  })
})

// ── AgentMessage option chips (```options protocol) ───────────────────────────
describe('AgentMessage option chips', () => {
  const withOptions = 'Which one do you prefer?\n\n```options\n["Option A", "Option B"]\n```'

  it('renders chips and strips the block on the last settled message', () => {
    const { container } = render(
      <AgentMessage role="assistant" content={withOptions} isLast onPickOption={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Option A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Option B' })).toBeInTheDocument()
    expect(screen.getByText('Which one do you prefer?')).toBeInTheDocument()
    expect(container.querySelector('pre')).not.toBeInTheDocument() // block stripped
  })

  it('clicking a chip sends that option text', () => {
    const onPick = vi.fn()
    render(<AgentMessage role="assistant" content={withOptions} isLast onPickOption={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Option B' }))
    expect(onPick).toHaveBeenCalledWith('Option B')
  })

  it.each([
    ['invalid JSON', '```options\nnot json at all\n```'],
    ['a single option', '```options\n["Only one"]\n```'],
    ['too many options', '```options\n' + JSON.stringify(Array.from({ length: 9 }, (_, i) => `O${i}`)) + '\n```'],
    ['a non-string item', '```options\n["A", 2]\n```'],
    ['an overlong label', '```options\n["A", "' + 'x'.repeat(81) + '"]\n```'],
    ['a non-array payload', '```options\n{"a": "b"}\n```'],
  ])('renders %s as a normal code block (no chips)', (_name, block) => {
    const { container } = render(
      <AgentMessage role="assistant" content={'Pick:\n\n' + block} isLast onPickOption={vi.fn()} />,
    )
    expect(container.querySelector('pre')).toBeInTheDocument() // kept as code
    expect(container.querySelectorAll('button').length).toBe(1) // only the copy button
  })

  it('ignores an options block that is not at the end of the message', () => {
    const content = 'Intro\n\n```options\n["A", "B"]\n```\n\ntrailing prose'
    const { container } = render(
      <AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'A' })).not.toBeInTheDocument()
    expect(container.querySelector('pre')).toBeInTheDocument()
  })

  it('renders chips for a REAL-WORLD malformed fence: glued to prose, inline JSON, no closing fence', () => {
    // Regression: the model emitted "…extra?```options [\"A\", \"B\"]" (no
    // newline before the fence, array on the fence line, unclosed) and the raw
    // protocol text leaked into the bubble alongside an empty code block.
    const content = 'sin tocar mayúsculas/espacios extra?```options ["Sí a ambas", "Live lessons también", "Decide tú"]'
    const { container } = render(
      <AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Sí a ambas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Decide tú' })).toBeInTheDocument()
    expect(container.querySelector('pre')).not.toBeInTheDocument()
    expect(container.textContent).not.toContain('```options')
  })

  it('renders chips when the closing fence is present but the array sits on the fence line', () => {
    const content = 'Pick one:\n\n```options ["A", "B"]\n```'
    render(<AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument()
  })

  it('an ```options mention INSIDE a label does not shadow the real block (first-valid wins)', () => {
    const content = 'Pick one:\n\n```options\n["Use the ```options fence", "Skip it"]\n```'
    render(<AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Use the ```options fence' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip it' })).toBeInTheDocument()
  })

  it('never treats a longer ````options fence as the protocol block', () => {
    const content = 'The protocol looks like this:\n\n````options\n["A", "B"]'
    const { container } = render(
      <AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'A' })).not.toBeInTheDocument()
    expect(container.textContent).toContain('The protocol looks like this:')
  })

  it('suppresses chips while streaming but still strips a complete block', () => {
    const { container } = render(
      <AgentMessage role="assistant" content={withOptions} isLast streaming onPickOption={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Option A' })).not.toBeInTheDocument()
    expect(container.querySelector('pre')).not.toBeInTheDocument()
  })

  it('hides chips entirely on non-last messages but still strips the block', () => {
    const { container } = render(
      <AgentMessage role="assistant" content={withOptions} onPickOption={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Option A' })).not.toBeInTheDocument()
    expect(container.querySelector('pre')).not.toBeInTheDocument()
    expect(screen.getByText('Which one do you prefer?')).toBeInTheDocument()
  })
})

// ── AgentModelSelector ────────────────────────────────────────────────────────
describe('AgentModelSelector', () => {
  it('uses the themed listbox and reports selection', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentModelSelector
        models={[
          { value: 'gpt-5.5', label: 'GPT-5.5', default: true },
          { value: 'gpt-5.4', label: 'GPT-5.4' },
        ]}
        model={null}
        onSelect={onSelect}
      />,
    )
    const trigger = screen.getByRole('combobox', { name: 'Model' })
    expect(trigger).toHaveTextContent('GPT-5.5')
    expect(trigger).toHaveClass('rounded-md', 'text-sm')
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'GPT-5.4' }))
    expect(onSelect).toHaveBeenCalledWith('gpt-5.4')
  })

  it('shows an explicit disabled loading state instead of stale options', () => {
    render(<AgentModelSelector models={[]} model={null} status="loading" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox', { name: 'Model' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('Loading models…')
  })
})

// ── Provider behaviour via a consumer ─────────────────────────────────────────
function Harness() {
  const a = useAgentChat()
  return (
    <div>
      <span data-testid="vis">{a.visibility}</span>
      <span data-testid="streaming">{String(a.isStreaming)}</span>
      <span data-testid="stream">{a.streamingText}</span>
      <span data-testid="tools">{a.liveTools.length}</span>
      <span data-testid="turn-tools">{a.turnTools.length}</span>
      <span data-testid="tool-detail">
        {a.liveTools.map((t) => `${t.tool}:${t.input ?? ''}:${t.output ?? ''}${t.isError ? ':err' : ''}`).join('|')}
      </span>
      <span data-testid="queued">{a.queuedMessages.length}</span>
      <span data-testid="queued-texts">{a.queuedMessages.map((q) => q.text).join('|')}</span>
      <span data-testid="live-ids">{[...a.streamingConversationIds].sort().join(',')}</span>
      <span data-testid="mcp">{String(a.mcpEnabled)}</span>
      <span data-testid="tier">{a.active?.tier_level ?? -1}</span>
      <span data-testid="msgs">{a.messages.length}</span>
      <button onClick={a.open}>open</button>
      <button onClick={() => void a.send('hi')}>send</button>
      <button onClick={() => void a.send('extra')}>send-extra</button>
      <button onClick={() => void a.abort()}>abort</button>
      <button onClick={() => void a.selectConversation('c2')}>go-c2</button>
      <button onClick={() => void a.selectConversation('c1')}>go-c1</button>
      <button onClick={() => void a.cycleTier()}>cycle</button>
      <button onClick={a.minimize}>min</button>
      <button onClick={a.close}>close</button>
    </div>
  )
}

describe('Browser-capture adoption (mission flow)', () => {
  it('adopts a queued capture as a VISIBLE thumbnail chip after materializing the mission', async () => {
    // The exact empty-compose-screen flow AgentBrowserCapture runs: materialize
    // the draft mission, upload, queueCapture — the composer must show the chip.
    let workspace: ReturnType<typeof useAgentWorkspace> | null = null
    let chat: ReturnType<typeof useAgentChat> | null = null
    function Probe() {
      workspace = useAgentWorkspace()
      chat = useAgentChat()
      return null
    }
    vi.mocked(agentApi.fetchAgentAttachmentBlob).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    render(
      <AgentWorkspaceProvider>
        <AgentChatProvider>
          <AgentComposer />
          <Probe />
        </AgentChatProvider>
      </AgentWorkspaceProvider>,
    )

    await act(async () => { await chat!.materializeDraftConversation() })
    act(() => {
      workspace!.queueCapture({ id: 'att-cap', filename: 'capture-9.png', mimeType: 'image/png', size: 3 } as agentApi.AgentAttachment)
    })

    expect(await screen.findByTestId('composer-attachment-thumb')).toBeInTheDocument()
    expect(await screen.findByAltText('capture-9.png')).toBeInTheDocument()
  })
})

describe('AgentChatProvider', () => {
  it('keeps project, provider, model and effort selectors visually coherent', async () => {
    const user = userEvent.setup()
    render(<AgentChatProvider><AgentComposer /></AgentChatProvider>)

    const projectTrigger = screen.getByText('Home').closest('button')
    const providerTrigger = screen.getByTestId('agent-provider-selector')
    const modelTrigger = await screen.findByTestId('agent-model-selector')
    const effortTrigger = await screen.findByTestId('agent-effort-selector')

    expect(projectTrigger).not.toBeNull()
    expect(providerTrigger.className).toBe(projectTrigger!.className)
    expect(modelTrigger.className).toBe(providerTrigger.className)
    expect(effortTrigger.className).toBe(providerTrigger.className)

    await user.click(providerTrigger)
    await user.click(screen.getByRole('option', { name: 'Codex' }))
    await waitFor(() => expect(providerTrigger).toHaveTextContent('Codex'))
    await waitFor(() => expect(modelTrigger).toHaveTextContent('GPT-5.5'))

    const codexEffortTrigger = await screen.findByTestId('agent-effort-selector')
    await user.click(codexEffortTrigger)
    await user.click(screen.getByRole('option', { name: 'High' }))
    await waitFor(() => expect(codexEffortTrigger).toHaveTextContent('High'))
  })

  it('accepts an exact custom Kimi alias and hides K3-only effort immediately', async () => {
    const user = userEvent.setup()
    render(<AgentChatProvider><AgentComposer /></AgentChatProvider>)

    const providerTrigger = screen.getByTestId('agent-provider-selector')
    await user.click(providerTrigger)
    await user.click(screen.getByRole('option', { name: 'Kimi' }))
    await waitFor(() => expect(providerTrigger).toHaveTextContent('Kimi'))
    expect(await screen.findByTestId('agent-effort-selector')).toBeInTheDocument()

    const modelInput = screen.getByTestId('agent-model-selector')
    fireEvent.change(modelInput, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(modelInput)
    await waitFor(() => expect(modelInput).toHaveValue('Moonshot-Team/Private_Coder:v2'))
    expect(screen.queryByTestId('agent-effort-selector')).not.toBeInTheDocument()
  })

  it('surfaces provider selection persistence failures instead of failing silently', async () => {
    const user = userEvent.setup()
    vi.mocked(agentApi.patchAgentConversation).mockRejectedValueOnce(new Error('offline'))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await user.click(screen.getByRole('button', { name: 'open' }))

    const providerTrigger = await screen.findByTestId('agent-provider-selector')
    await user.click(providerTrigger)
    await user.click(screen.getByRole('option', { name: 'Codex' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong. Try again.'))
    expect(providerTrigger).toHaveTextContent('Claude')
  })

  it('opens, ensures a conversation, streams a turn, persists on done', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('vis').textContent).toBe('open'))
    expect(agentApi.createAgentConversation).toHaveBeenCalled()

    await act(async () => { fireEvent.click(screen.getByText('send')) })
    expect(agentApi.sendAgentMessage).toHaveBeenCalledWith('c1', 'hi', expect.anything())
    await waitFor(() => expect(screen.getByTestId('msgs').textContent).toBe('1')) // user msg

    // simulate the streamed turn over WS
    await act(async () => {
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Hel' })
      wsHandler!({ type: 'agent_tool', conversationId: 'c1', tool: 'specrails_rails' })
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'lo' })
    })
    expect(screen.getByTestId('stream').textContent).toBe('Hello')
    expect(screen.getByTestId('tools').textContent).toBe('1')

    await act(async () => {
      wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText: 'Hello' })
    })
    expect(screen.getByTestId('streaming').textContent).toBe('false')
    await waitFor(() => expect(screen.getByTestId('msgs').textContent).toBe('2')) // + assistant
  })

  it('ignores WS events for other conversations', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'OTHER', delta: 'x' }) })
    expect(screen.getByTestId('stream').textContent).toBe('')
  })

  it('accumulates tool inputs, merges tool results, and keeps the turn log past settle', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
    await act(async () => { fireEvent.click(screen.getByText('send')) })

    await act(async () => {
      wsHandler!({ type: 'agent_tool', conversationId: 'c1', tool: 'Bash', input: '{"command":"ls"}', toolId: 'tu_1', timestamp: '2026-07-27T10:00:00.000Z' })
      wsHandler!({ type: 'agent_tool', conversationId: 'c1', tool: 'Read', input: '{"file_path":"/a"}' })
      // Correlated by toolId → lands on the Bash entry, not the last one.
      wsHandler!({ type: 'agent_tool_result', conversationId: 'c1', toolId: 'tu_1', output: 'file-a\nfile-b' })
      // No toolId → falls back to the LAST entry still missing an output.
      wsHandler!({ type: 'agent_tool_result', conversationId: 'c1', output: 'boom', isError: true })
    })
    expect(screen.getByTestId('tools').textContent).toBe('2')
    expect(screen.getByTestId('tool-detail').textContent)
      .toBe('Bash:{"command":"ls"}:file-a\nfile-b|Read:{"file_path":"/a"}:boom:err')

    // Settle: live slice resets but the finished turn survives as turnTools.
    await act(async () => { wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText: 'done' }) })
    expect(screen.getByTestId('tools').textContent).toBe('0')
    expect(screen.getByTestId('turn-tools').textContent).toBe('2')
  })

  it('cycles the tier through the API', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('tier').textContent).toBe('0'))
    await act(async () => { fireEvent.click(screen.getByText('cycle')) })
    expect(agentApi.patchAgentConversation).toHaveBeenCalledWith('c1', { tierLevel: 1 })
  })

  it('minimize and close change visibility', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => { fireEvent.click(screen.getByText('min')) })
    expect(screen.getByTestId('vis').textContent).toBe('minimized')
    await act(async () => { fireEvent.click(screen.getByText('close')) })
    expect(screen.getByTestId('vis').textContent).toBe('hidden')
  })

  it('recalls prompt history with ↑/↓ from an empty composer', async () => {
    vi.mocked(agentApi.listAgentConversations).mockResolvedValue([api.conv]) // load path (not create)
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv,
      messages: [
        { id: 'u1', conversation_id: 'c1', role: 'user', content: 'first prompt', created_at: '' },
        { id: 'u2', conversation_id: 'c1', role: 'user', content: 'second prompt', created_at: '' },
      ],
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = (await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' }))
    // ↑ from empty → most recent
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('second prompt')
    // ↑ again → older
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('first prompt')
    // ↓ → newer, then ↓ past newest → cleared
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(editorText(box)).toBe('second prompt')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(editorText(box)).toBe('')
  })

  it('reflects a disabled MCP server', async () => {
    vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: false, running: false })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('false'))
  })

  it('renders the persistent bubble when not open and opens on click', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    // visibility starts hidden → bubble present
    const bubble = screen.getByLabelText('Mission Control')
    expect(bubble).toBeInTheDocument()
    await act(async () => { fireEvent.click(bubble) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
  })

  it('restores the bubble at the remembered position', () => {
    localStorage.setItem('specrails-desktop:agent-bubble-pos', JSON.stringify({ left: 123, top: 234 }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    const bubble = screen.getByLabelText('Mission Control')
    expect(bubble.style.left).toBe('123px')
    expect(bubble.style.top).toBe('234px')
    localStorage.clear()
  })

  it('clicking an option chip in the panel sends that option as the reply', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
    // A settled assistant turn asking the user to choose, with an options block.
    await act(async () => {
      wsHandler!({
        type: 'agent_done',
        conversationId: 'c1',
        fullText: 'Which rail?\n\n```options\n["Launch it", "Not yet"]\n```',
      })
    })
    const chip = await screen.findByRole('button', { name: 'Launch it' })
    await act(async () => { fireEvent.click(chip) })
    expect(agentApi.sendAgentMessage).toHaveBeenCalledWith('c1', 'Launch it', expect.anything())
  })

  it('parks a mid-stream send as a queued chip and promotes it on agent_dequeued', async () => {
    vi.mocked(agentApi.sendAgentMessage)
      .mockResolvedValueOnce({ queued: false }) // first turn runs directly
      .mockResolvedValue({ queued: true })      // mid-stream send parks
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    await waitFor(() => expect(screen.getByTestId('msgs').textContent).toBe('1'))
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Working…' }) })

    await act(async () => { fireEvent.click(screen.getByText('send-extra')) })
    // Parked, NOT appended to the thread.
    expect(screen.getByTestId('queued').textContent).toBe('1')
    expect(screen.getByTestId('msgs').textContent).toBe('1')
    const opts = vi.mocked(agentApi.sendAgentMessage).mock.calls[1][2] as { queueId?: string }
    expect(typeof opts.queueId).toBe('string')

    // First turn settles → the chip SURVIVES (its drained turn is about to start).
    await act(async () => { wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText: 'First reply' }) })
    expect(screen.getByTestId('queued').textContent).toBe('1')
    expect(screen.getByTestId('msgs').textContent).toBe('2')

    // Dequeue: chip → real user bubble, streaming resumes for the drained turn.
    await act(async () => {
      wsHandler!({ type: 'agent_dequeued', conversationId: 'c1', queueId: opts.queueId, text: 'extra' })
    })
    expect(screen.getByTestId('queued').textContent).toBe('0')
    expect(screen.getByTestId('msgs').textContent).toBe('3')
    expect(screen.getByTestId('streaming').textContent).toBe('true')
  })

  it('abort drops the queued chips immediately', async () => {
    vi.mocked(agentApi.sendAgentMessage)
      .mockResolvedValueOnce({ queued: false })
      .mockResolvedValue({ queued: true })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'x' }) })
    await act(async () => { fireEvent.click(screen.getByText('send-extra')) })
    expect(screen.getByTestId('queued').textContent).toBe('1')
    await act(async () => { fireEvent.click(screen.getByText('abort')) })
    expect(agentApi.abortAgentTurn).toHaveBeenCalledWith('c1')
    expect(screen.getByTestId('queued').textContent).toBe('0')
    expect(screen.getByTestId('streaming').textContent).toBe('false')
  })

  it('keeps a running turn and queued messages visible when stop is rejected', async () => {
    vi.mocked(agentApi.sendAgentMessage)
      .mockResolvedValueOnce({ queued: false })
      .mockResolvedValue({ queued: true })
    vi.mocked(agentApi.abortAgentTurn).mockRejectedValueOnce(new Error('Could not stop provider'))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'x' }) })
    await act(async () => { fireEvent.click(screen.getByText('send-extra')) })
    await act(async () => { fireEvent.click(screen.getByText('abort')) })
    expect(screen.getByTestId('queued')).toHaveTextContent('1')
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(toast.error).toHaveBeenCalledWith('Could not stop provider')
  })

  it('keeps a background conversation streaming and restores its text on switch-back', async () => {
    const conv2 = { ...api.conv, id: 'c2' }
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => ({
      conversation: id === 'c2' ? conv2 : api.conv,
      messages: [],
    }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Hel' }) })
    expect(screen.getByTestId('stream').textContent).toBe('Hel')

    // Focus another thread mid-stream: the view empties but NOTHING is lost.
    await act(async () => { fireEvent.click(screen.getByText('go-c2')) })
    expect(screen.getByTestId('stream').textContent).toBe('')
    expect(screen.getByTestId('streaming').textContent).toBe('false')

    // Background deltas keep accumulating + the working cue stays exposed.
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'lo' }) })
    expect(screen.getByTestId('live-ids').textContent).toBe('c1')
    expect(screen.getByTestId('stream').textContent).toBe('')

    // Switch back: the FULL accumulated stream re-appears mid-flight.
    await act(async () => { fireEvent.click(screen.getByText('go-c1')) })
    expect(screen.getByTestId('stream').textContent).toBe('Hello')
    expect(screen.getByTestId('streaming').textContent).toBe('true')
  })

  it('does not duplicate the assistant reply when the refetch already contains it', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv,
      messages: [{ id: 'a1', conversation_id: 'c1', role: 'assistant', content: 'Same reply', created_at: '' }],
    })
    vi.mocked(agentApi.listAgentConversations).mockResolvedValue([api.conv])
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('msgs').textContent).toBe('1'))
    await act(async () => { wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText: 'Same reply' }) })
    expect(screen.getByTestId('msgs').textContent).toBe('1') // deduped
  })

  it('composer tri-state: red stop only with an empty box; typing flips to queue-send', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
    // Start a turn → streaming, box empty → red Stop.
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    expect(screen.getByLabelText('Stop')).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: 'Add more while the agent works — it will queue…' })
    // Typing mid-stream → third state: send-to-queue (Stop hidden).
    inputEditor(box, 'follow-up')
    expect(screen.queryByLabelText('Stop')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Send to queue')).toBeInTheDocument()
    // Clearing the box restores the red Stop.
    inputEditor(box, '')
    expect(screen.getByLabelText('Stop')).toBeInTheDocument()
    expect(screen.queryByLabelText('Send to queue')).not.toBeInTheDocument()
  })

  it('a typed-but-unsent draft SURVIVES unmounting the composer (Mission⇄Board switch)', async () => {
    const first = render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    inputEditor(box, 'idea a medio escribir')
    // Switch to Board mode = the whole agent surface unmounts.
    first.unmount()
    // Back to Mission Control: the draft is right where it was left.
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box2 = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    expect(editorText(box2)).toBe('idea a medio escribir')
    // Sending clears the stored draft — a fresh mount starts empty again.
    await act(async () => { fireEvent.keyDown(box2, { key: 'Enter' }) })
    expect(editorText(box2)).toBe('')
  })

  it('lets @ select a project and sends the resolved context reference', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    inputEditor(box, '@deck', 5)
    expect(await screen.findByTestId('agent-context-palette')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('deckdex')) })
    await waitFor(() => expect(editorText(box)).toBe('@deckdex'))
    expect(screen.getByText('deckdex')).toBeInTheDocument()

    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    const call = vi.mocked(agentApi.sendAgentMessage).mock.calls.at(-1)!
    expect(call[1]).toBe('@deckdex')
    expect(call[2]).toMatchObject({
      contextRefs: [{ kind: 'project', id: 'p2', label: 'deckdex', token: '@deckdex' }],
    })
  })

  it('inserts @ at the invoked position and sends the surrounding text in its original order', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    inputEditor(box, 'revisa @deck y explica los cambios', 'revisa @deck'.length)
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /deckdex/ })) })
    const pill = box.querySelector('[data-inline-reference]')!
    expect(pill).toHaveAttribute('data-token', '@deckdex')
    expect(visibleNodeText(pill.previousSibling)).toBe('revisa ')
    expect(visibleNodeText(pill.nextSibling)).toBe(' y explica los cambios')
    expect(editorText(box)).toBe('revisa @deckdex y explica los cambios')

    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(agentApi.sendAgentMessage).toHaveBeenLastCalledWith(
      'c1',
      'revisa @deckdex y explica los cambios',
      expect.objectContaining({
        contextRefs: [expect.objectContaining({ kind: 'project', id: 'p2', token: '@deckdex' })],
      }),
    )
  })

  it('selects the exact # spec first and keeps it after the words that introduced it', async () => {
    vi.mocked(agentApi.createAgentConversation).mockResolvedValue({ ...api.conv, pinned_project_id: 'p1' })
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tickets: [
          { id: 10, title: 'Later spec', status: 'todo', labels: [] },
          { id: 1, title: 'Scaffold the runnable project foundation', status: 'todo', labels: [] },
        ],
        jobs: [{ id: '1deadbeef', command: 'Implement #1', status: 'canceled' }],
      }),
    } as Response)
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    inputEditor(box, 'implementemos el #1 y verifica los tests', 'implementemos el #1'.length)
    const palette = await screen.findByTestId('agent-context-palette')
    const spec = await within(palette).findByRole('option', { name: /Scaffold the runnable project foundation/ })
    expect(within(palette).getAllByRole('option')[0]).toBe(spec)
    expect(spec).toHaveAttribute('aria-selected', 'true')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })

    const pill = box.querySelector('[data-inline-reference]')!
    expect(pill).toHaveAttribute('data-token', '#1')
    expect(visibleNodeText(pill.previousSibling)).toBe('implementemos el ')
    expect(visibleNodeText(pill.nextSibling)).toBe(' y verifica los tests')
    expect(editorText(box)).toBe('implementemos el #1 y verifica los tests')
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()

    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(agentApi.sendAgentMessage).toHaveBeenLastCalledWith(
      'c1',
      'implementemos el #1 y verifica los tests',
      expect.objectContaining({
        contextRefs: [expect.objectContaining({ id: '1', token: '#1', scope: { projectId: 'p1', projectName: 'acme-api' } })],
      }),
    )
  })

  it('keeps repeated references at both positions and removing one preserves the other metadata', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    inputEditor(box, 'revisa @deck')
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /deckdex/ })) })
    selectEditor(box, editorText(box).length)
    insertEditorText(box, ' y compara @deck')
    await act(async () => { fireEvent.click((await screen.findAllByRole('option', { name: /deckdex/ }))[0]) })
    expect(editorText(box)).toBe('revisa @deckdex y compara @deckdex')
    const pills = box.querySelectorAll<HTMLElement>('[data-inline-reference]')
    expect(pills).toHaveLength(2)
    fireEvent.click(within(pills[0]).getByRole('button'))
    expect(box.querySelectorAll('[data-inline-reference]')).toHaveLength(1)
    expect(editorText(box)).toBe('revisa  y compara @deckdex')

    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    const call = vi.mocked(agentApi.sendAgentMessage).mock.calls.at(-1)!
    expect(call[1]).toBe('revisa  y compara @deckdex')
    expect(call[2]).toMatchObject({
      contextRefs: [{ kind: 'project', id: 'p2', token: '@deckdex' }],
    })
  })

  it('preserves the position and metadata of an unsent reference across Mission/Board remounts', async () => {
    const first = render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    inputEditor(box, 'trabaja en @deck y resume', 'trabaja en @deck'.length)
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /deckdex/ })) })
    first.unmount()

    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const restored = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    expect(editorText(restored)).toBe('trabaja en @deckdex y resume')
    const pill = restored.querySelector('[data-inline-reference]')!
    expect(visibleNodeText(pill.previousSibling)).toBe('trabaja en ')
    expect(visibleNodeText(pill.nextSibling)).toBe(' y resume')

    await act(async () => { fireEvent.keyDown(restored, { key: 'Enter' }) })
    expect(agentApi.sendAgentMessage).toHaveBeenLastCalledWith(
      'c1',
      'trabaja en @deckdex y resume',
      expect.objectContaining({ contextRefs: [expect.objectContaining({ id: 'p2', token: '@deckdex' })] }),
    )
  })

  it('never restores another mission’s text or reference through Undo after switching conversations', async () => {
    const secondConversation = { ...api.conv, id: 'c2' }
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id) => ({
      conversation: id === 'c2' ? secondConversation : api.conv,
      messages: [],
    }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const firstEditor = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    inputEditor(firstEditor, 'revisa @deck en la primera misión', 'revisa @deck'.length)
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /deckdex/ })) })

    await act(async () => { fireEvent.click(screen.getByText('go-c2')) })
    const secondEditor = screen.getByRole('textbox', { name: 'Ask the agent to do anything…' })
    expect(secondEditor).not.toBe(firstEditor)
    expect(editorText(secondEditor)).toBe('')
    fireEvent.keyDown(secondEditor, { key: 'z', metaKey: true })
    expect(editorText(secondEditor)).toBe('')
    expect(secondEditor.querySelector('[data-inline-reference]')).toBeNull()
    inputEditor(secondEditor, 'borrador de la segunda misión')

    await act(async () => { fireEvent.click(screen.getByText('go-c1')) })
    const restored = screen.getByRole('textbox', { name: 'Ask the agent to do anything…' })
    fireEvent.keyDown(restored, { key: 'z', metaKey: true })
    expect(editorText(restored)).toBe('revisa @deckdex en la primera misión')
    expect(restored.querySelector('[data-inline-reference]')).toHaveAttribute('data-token', '@deckdex')

    await act(async () => { fireEvent.click(screen.getByText('go-c2')) })
    const secondRestored = screen.getByRole('textbox', { name: 'Ask the agent to do anything…' })
    fireEvent.keyDown(secondRestored, { key: 'z', metaKey: true })
    expect(editorText(secondRestored)).toBe('borrador de la segunda misión')
    expect(secondRestored.querySelector('[data-inline-reference]')).toBeNull()
  })

  it('materializes a new mission before uploading an attachment from the empty composer', async () => {
    render(<StrictMode><AgentChatProvider><AgentComposer /></AgentChatProvider></StrictMode>)
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    inputEditor(box, 'usa este archivo')

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()
    const file = new File(['hello'], 'brief.txt', { type: 'text/plain' })

    await act(async () => {
      fireEvent.change(fileInput!, { target: { files: [file] } })
    })

    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalledTimes(1))
    expect(agentApi.uploadAgentAttachment).toHaveBeenCalledWith('c1', file)
    expect(editorText(screen.getByRole('textbox', { name: 'Ask the agent to do anything…' }))).toBe('usa este archivo')
    expect(await screen.findByText('brief.txt')).toBeInTheDocument()
  })

  it('opens the same command palette from + and inserts a selected action', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    fireEvent.click(screen.getByLabelText('Add context or action'))
    fireEvent.click(screen.getByText('Action'))
    expect(editorText(box)).toBe('/')
    expect(await screen.findByText('Create spec')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('Create spec')) })
    await waitFor(() => expect(editorText(box)).toBe('/create spec'))
    expect(screen.getByText('Create spec')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    const call = vi.mocked(agentApi.sendAgentMessage).mock.calls.at(-1)!
    expect(call[1]).toBe('/create spec')
    expect(call[2]).toMatchObject({
      contextRefs: [{ kind: 'action', id: 'action:create-spec', label: 'Create spec', token: '/create spec' }],
    })
  })

  it('closes the + menu on outside click and Escape', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    fireEvent.click(screen.getByLabelText('Add context or action'))
    expect(screen.getByText('Reference')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('Reference')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Add context or action'))
    expect(screen.getByText('Reference')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Reference')).not.toBeInTheDocument()
  })

  it('filters / actions while typing and accepts the highlighted result with Enter', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    inputEditor(box, '/sta', 4)
    expect(await screen.findByText('Show status')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(editorText(box)).toBe('/status'))
    expect(screen.getByText('Show status')).toBeInTheDocument()
  })

  it('turns no-result @ queries into recovery actions', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })

    inputEditor(box, '@missing-x', 10)
    expect(await screen.findByText('Search all Specrails')).toBeInTheDocument()
    expect(screen.getByText('Create "missing-x"')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(editorText(box)).toBe('/search all projects missing-x'))
  })

  it('Shift+Tab inside the panel cycles the tier', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const dialog = await screen.findByRole('dialog')
    await act(async () => { fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }) })
    expect(agentApi.patchAgentConversation).toHaveBeenCalledWith('c1', { tierLevel: 1 })
  })

  it('Shift+Tab inside the composer editor cycles the tier exactly once (no focus jump, no double-cycle)', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' })
    await act(async () => { fireEvent.keyDown(box, { key: 'Tab', shiftKey: true }) })
    // Once — the composer handler stops propagation so the view wrapper's
    // Shift+Tab listener doesn't cycle a second time.
    const cycleCalls = vi.mocked(agentApi.patchAgentConversation).mock.calls.filter(
      (c) => (c[1] as { tierLevel?: number }).tierLevel !== undefined,
    )
    expect(cycleCalls).toEqual([['c1', { tierLevel: 1 }]])
  })
})

// ── Queue-edit mode (↑/↓ navigate + edit queued messages in place) ────────────
describe('AgentComposer queue-edit mode', () => {
  /** Open the panel, run one direct turn (streaming), then park `texts` on the
   *  queue through the composer — the exact user flow that builds a queue. */
  async function openWithQueuedMessages(texts: string[]): Promise<HTMLElement> {
    vi.mocked(agentApi.sendAgentMessage)
      .mockResolvedValueOnce({ queued: false }) // first turn runs directly
      .mockResolvedValue({ queued: true })      // mid-stream sends park
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Working…' }) })
    const box = screen.getByRole('textbox', { name: 'Add more while the agent works — it will queue…' })
    for (const t of texts) {
      inputEditor(box, t)
      await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    }
    expect(screen.getByTestId('queued').textContent).toBe(String(texts.length))
    return box
  }
  /** The queueId the composer generated for the Nth parked send (1-based). */
  function queueIdOf(n: number): string {
    return (vi.mocked(agentApi.sendAgentMessage).mock.calls[n][2] as { queueId: string }).queueId
  }

  it('↑ enters queue-edit at the LAST queued item; ↑/↓ move through slots; ↓ past the newest exits', async () => {
    const box = await openWithQueuedMessages(['first queued', 'second queued'])
    // ↑ from the empty box → the QUEUE takes precedence over prompt history.
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('second queued')
    expect(screen.getByTestId('queue-edit-chip').textContent).toContain('Editing queued message 2 of 2')
    // ↑ at caret start (pristine) → older slot.
    selectEditor(box, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('first queued')
    expect(screen.getByTestId('queue-edit-chip').textContent).toContain('1 of 2')
    // ↑ at the oldest → stays (no wrap, no history bleed-through).
    selectEditor(box, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('first queued')
    // ↓ at caret end → newer slot; ↓ past the newest → exit, empty draft back.
    selectEditor(box, editorText(box).length)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(editorText(box)).toBe('second queued')
    selectEditor(box, editorText(box).length)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(editorText(box)).toBe('')
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('entering queue-edit stashes the un-sent draft; Esc cancels and restores it untouched', async () => {
    const box = await openWithQueuedMessages(['queued msg'])
    inputEditor(box, 'wip draft')
    selectEditor(box, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('queued msg')
    inputEditor(box, 'queued msg but edited')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(editorText(box)).toBe('wip draft') // draft survived the whole round-trip
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
    // The abandoned edit did NOT touch the parked chip.
    expect(screen.getByTestId('queued-texts').textContent).toBe('queued msg')
  })

  it('Enter SAVES the edited slot in place (no new send) and updates the parked chip', async () => {
    const box = await openWithQueuedMessages(['polish me'])
    const sendCalls = vi.mocked(agentApi.sendAgentMessage).mock.calls.length
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    inputEditor(box, 'polished text')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(agentApi.editQueuedAgentMessage).toHaveBeenCalledWith('c1', queueIdOf(1), 'polished text')
    expect(vi.mocked(agentApi.sendAgentMessage).mock.calls.length).toBe(sendCalls) // Enter saved, never sent
    expect(editorText(box)).toBe('') // empty draft restored
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
    expect(screen.getByTestId('queued-texts').textContent).toBe('polished text')
  })

  it('a dirty slot never navigates away on ↑ (keystrokes cannot be lost by an arrow)', async () => {
    const box = await openWithQueuedMessages(['one', 'two'])
    fireEvent.keyDown(box, { key: 'ArrowUp' }) // editing 'two'
    inputEditor(box, 'two edited')
    selectEditor(box, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('two edited') // stayed put
    expect(screen.getByTestId('queue-edit-chip').textContent).toContain('2 of 2')
  })

  it('409 conflict (already dispatched) exits keeping the text as a draft + informs via toast', async () => {
    vi.mocked(agentApi.editQueuedAgentMessage).mockResolvedValue('conflict')
    const box = await openWithQueuedMessages(['racing'])
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    inputEditor(box, 'edited too late')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(toast.info).toHaveBeenCalledWith('That queued message was already sent — your text is kept as a draft')
    expect(editorText(box)).toBe('edited too late') // NOTHING lost
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('a save failure keeps the edit mode alive with the text intact (retryable)', async () => {
    vi.mocked(agentApi.editQueuedAgentMessage).mockRejectedValue(new Error('network down'))
    const box = await openWithQueuedMessages(['fragile'])
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    inputEditor(box, 'fragile edited')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the queued message")
    expect(editorText(box)).toBe('fragile edited')
    expect(screen.getByTestId('queue-edit-chip')).toBeInTheDocument() // still editing — Enter retries
  })

  it('drain race: the slot being edited is dispatched mid-edit → toast + dirty text kept as draft', async () => {
    const box = await openWithQueuedMessages(['about to go'])
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    inputEditor(box, 'dirty edit in progress')
    await act(async () => {
      wsHandler!({ type: 'agent_dequeued', conversationId: 'c1', queueId: queueIdOf(1), text: 'about to go' })
    })
    expect(toast.info).toHaveBeenCalledWith('That queued message was already sent — your text is kept as a draft')
    expect(editorText(box)).toBe('dirty edit in progress') // nothing lost
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('queue cleared (Stop) while editing pristine exits silently and restores the stashed draft', async () => {
    const box = await openWithQueuedMessages(['parked'])
    inputEditor(box, 'my draft')
    selectEditor(box, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    await act(async () => { wsHandler!({ type: 'agent_queue_cleared', conversationId: 'c1' }) })
    expect(toast.info).not.toHaveBeenCalled() // self-initiated Stop — no notice
    expect(editorText(box)).toBe('my draft')
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('keeps destination draft references in the undo baseline when switching out of queue-edit mode', async () => {
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id) => ({
      conversation: { ...api.conv, id },
      messages: [],
    }))
    await openWithQueuedMessages(['parked in c1'])
    await act(async () => { fireEvent.click(screen.getByText('go-c2')) })
    const secondEditor = screen.getByRole('textbox', { name: 'Ask the agent to do anything…' })
    inputEditor(secondEditor, 'revisa @deck')
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /deckdex/ })) })

    await act(async () => { fireEvent.click(screen.getByText('go-c1')) })
    const firstEditor = screen.getByRole('textbox', { name: 'Add more while the agent works — it will queue…' })
    fireEvent.keyDown(firstEditor, { key: 'ArrowUp' })
    expect(screen.getByTestId('queue-edit-chip')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('go-c2')) })
    const restored = screen.getByRole('textbox', { name: 'Ask the agent to do anything…' })
    expect(restored.querySelector('[data-inline-reference]')).toHaveAttribute('data-token', '@deckdex')
    fireEvent.keyDown(restored, { key: 'z', metaKey: true })
    expect(editorText(restored)).toBe('revisa @deckdex')
    expect(restored.querySelector('[data-inline-reference]')).toHaveAttribute('data-token', '@deckdex')
  })

  it('agent_queue_edited from another window updates the parked chip text', async () => {
    await openWithQueuedMessages(['original'])
    await act(async () => {
      wsHandler!({ type: 'agent_queue_edited', conversationId: 'c1', queueId: queueIdOf(1), text: 'rewritten elsewhere' })
    })
    expect(screen.getByTestId('queued-texts').textContent).toBe('rewritten elsewhere')
  })

  it('regression pin: with NO queue the arrows still drive prompt history exactly as before', async () => {
    vi.mocked(agentApi.listAgentConversations).mockResolvedValue([api.conv])
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv,
      messages: [{ id: 'u1', conversation_id: 'c1', role: 'user', content: 'past prompt', created_at: '' }],
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = (await screen.findByRole('textbox', { name: 'Ask the agent to do anything…' }))
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(editorText(box)).toBe('past prompt') // history, not queue-edit
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(editorText(box)).toBe('')
  })
})
