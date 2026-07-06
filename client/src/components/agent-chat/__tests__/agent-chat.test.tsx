import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

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
    abortAgentTurn: vi.fn(async () => {}),
    editQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAgentModels: vi.fn(async (p: string) => ({
      models: p === 'codex'
        ? [{ value: 'gpt-5.5', label: 'GPT-5.5', default: true }, { value: 'gpt-5.4', label: 'GPT-5.4' }]
        : [{ value: 'sonnet', label: 'Claude Sonnet', default: true }, { value: 'opus', label: 'Claude Opus' }],
      supportsImageInput: p !== 'gemini',
      efforts: p === 'gemini' ? [] : p === 'codex' ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh'],
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
import { __clearComposerDrafts } from '../AgentComposer'
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
})

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
  it('loads the provider catalog and reports selection', async () => {
    const onSelect = vi.fn()
    render(<AgentModelSelector provider="codex" model={null} onSelect={onSelect} />)
    await waitFor(() => expect(screen.getByText('GPT-5.5')).toBeInTheDocument())
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gpt-5.4' } })
    expect(onSelect).toHaveBeenCalledWith('gpt-5.4')
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

describe('AgentChatProvider', () => {
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
    const box = (await screen.findByPlaceholderText('Ask the agent to do anything…')) as HTMLTextAreaElement
    // ↑ from empty → most recent
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('second prompt')
    // ↑ again → older
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('first prompt')
    // ↓ → newer, then ↓ past newest → cleared
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('second prompt')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('')
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
    const box = screen.getByPlaceholderText('Add more while the agent works — it will queue…') as HTMLTextAreaElement
    // Typing mid-stream → third state: send-to-queue (Stop hidden).
    fireEvent.change(box, { target: { value: 'follow-up' } })
    expect(screen.queryByLabelText('Stop')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Send to queue')).toBeInTheDocument()
    // Clearing the box restores the red Stop.
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.getByLabelText('Stop')).toBeInTheDocument()
    expect(screen.queryByLabelText('Send to queue')).not.toBeInTheDocument()
  })

  it('a typed-but-unsent draft SURVIVES unmounting the composer (Mission⇄Board switch)', async () => {
    const first = render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByPlaceholderText('Ask the agent to do anything…') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'idea a medio escribir' } })
    // Switch to Board mode = the whole agent surface unmounts.
    first.unmount()
    // Back to Mission Control: the draft is right where it was left.
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box2 = await screen.findByPlaceholderText('Ask the agent to do anything…') as HTMLTextAreaElement
    expect(box2.value).toBe('idea a medio escribir')
    // Sending clears the stored draft — a fresh mount starts empty again.
    await act(async () => { fireEvent.keyDown(box2, { key: 'Enter' }) })
    expect(box2.value).toBe('')
  })

  it('lets @ select a project and sends the resolved context reference', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByPlaceholderText('Ask the agent to do anything…') as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: '@deck', selectionStart: 5, selectionEnd: 5 } })
    expect(await screen.findByTestId('agent-context-palette')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('deckdex')) })
    await waitFor(() => expect(box.value).toBe(''))
    expect(screen.getByText('deckdex')).toBeInTheDocument()

    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    const call = vi.mocked(agentApi.sendAgentMessage).mock.calls.at(-1)!
    expect(call[1]).toBe('@deckdex')
    expect(call[2]).toMatchObject({
      contextRefs: [{ kind: 'project', id: 'p2', label: 'deckdex', token: '@deckdex' }],
    })
  })

  it('opens the same command palette from + and inserts a selected action', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByPlaceholderText('Ask the agent to do anything…') as HTMLTextAreaElement

    fireEvent.click(screen.getByLabelText('Add context or action'))
    fireEvent.click(screen.getByText('Action'))
    expect(box.value).toBe('/')
    expect(await screen.findByText('Create spec')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('Create spec')) })
    await waitFor(() => expect(box.value).toBe(''))
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
    await screen.findByPlaceholderText('Ask the agent to do anything…')

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
    const box = await screen.findByPlaceholderText('Ask the agent to do anything…') as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: '/sta', selectionStart: 4, selectionEnd: 4 } })
    expect(await screen.findByText('Show status')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(box.value).toBe(''))
    expect(screen.getByText('Show status')).toBeInTheDocument()
  })

  it('turns no-result @ queries into recovery actions', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByPlaceholderText('Ask the agent to do anything…') as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: '@missing-x', selectionStart: 10, selectionEnd: 10 } })
    expect(await screen.findByText('Search all Specrails')).toBeInTheDocument()
    expect(screen.getByText('Create "missing-x"')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await waitFor(() => expect(box.value).toBe('/search all projects missing-x'))
  })

  it('Shift+Tab inside the panel cycles the tier', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const dialog = await screen.findByRole('dialog')
    await act(async () => { fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }) })
    expect(agentApi.patchAgentConversation).toHaveBeenCalledWith('c1', { tierLevel: 1 })
  })

  it('Shift+Tab inside the TEXTAREA cycles the tier exactly once (no focus jump, no double-cycle)', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const box = await screen.findByPlaceholderText('Ask the agent to do anything…')
    await act(async () => { fireEvent.keyDown(box, { key: 'Tab', shiftKey: true }) })
    // Once — the textarea handler stops propagation so the view wrapper's
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
  async function openWithQueuedMessages(texts: string[]): Promise<HTMLTextAreaElement> {
    vi.mocked(agentApi.sendAgentMessage)
      .mockResolvedValueOnce({ queued: false }) // first turn runs directly
      .mockResolvedValue({ queued: true })      // mid-stream sends park
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Working…' }) })
    const box = screen.getByPlaceholderText('Add more while the agent works — it will queue…') as HTMLTextAreaElement
    for (const t of texts) {
      fireEvent.change(box, { target: { value: t } })
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
    expect(box.value).toBe('second queued')
    expect(screen.getByTestId('queue-edit-chip').textContent).toContain('Editing queued message 2 of 2')
    // ↑ at caret start (pristine) → older slot.
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('first queued')
    expect(screen.getByTestId('queue-edit-chip').textContent).toContain('1 of 2')
    // ↑ at the oldest → stays (no wrap, no history bleed-through).
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('first queued')
    // ↓ at caret end → newer slot; ↓ past the newest → exit, empty draft back.
    box.setSelectionRange(box.value.length, box.value.length)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('second queued')
    box.setSelectionRange(box.value.length, box.value.length)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('')
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('entering queue-edit stashes the un-sent draft; Esc cancels and restores it untouched', async () => {
    const box = await openWithQueuedMessages(['queued msg'])
    fireEvent.change(box, { target: { value: 'wip draft' } })
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('queued msg')
    fireEvent.change(box, { target: { value: 'queued msg but edited' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('wip draft') // draft survived the whole round-trip
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
    // The abandoned edit did NOT touch the parked chip.
    expect(screen.getByTestId('queued-texts').textContent).toBe('queued msg')
  })

  it('Enter SAVES the edited slot in place (no new send) and updates the parked chip', async () => {
    const box = await openWithQueuedMessages(['polish me'])
    const sendCalls = vi.mocked(agentApi.sendAgentMessage).mock.calls.length
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.change(box, { target: { value: 'polished text' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(agentApi.editQueuedAgentMessage).toHaveBeenCalledWith('c1', queueIdOf(1), 'polished text')
    expect(vi.mocked(agentApi.sendAgentMessage).mock.calls.length).toBe(sendCalls) // Enter saved, never sent
    expect(box.value).toBe('') // empty draft restored
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
    expect(screen.getByTestId('queued-texts').textContent).toBe('polished text')
  })

  it('a dirty slot never navigates away on ↑ (keystrokes cannot be lost by an arrow)', async () => {
    const box = await openWithQueuedMessages(['one', 'two'])
    fireEvent.keyDown(box, { key: 'ArrowUp' }) // editing 'two'
    fireEvent.change(box, { target: { value: 'two edited' } })
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('two edited') // stayed put
    expect(screen.getByTestId('queue-edit-chip').textContent).toContain('2 of 2')
  })

  it('409 conflict (already dispatched) exits keeping the text as a draft + informs via toast', async () => {
    vi.mocked(agentApi.editQueuedAgentMessage).mockResolvedValue('conflict')
    const box = await openWithQueuedMessages(['racing'])
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.change(box, { target: { value: 'edited too late' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(toast.info).toHaveBeenCalledWith('That queued message was already sent — your text is kept as a draft')
    expect(box.value).toBe('edited too late') // NOTHING lost
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('a save failure keeps the edit mode alive with the text intact (retryable)', async () => {
    vi.mocked(agentApi.editQueuedAgentMessage).mockRejectedValue(new Error('network down'))
    const box = await openWithQueuedMessages(['fragile'])
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.change(box, { target: { value: 'fragile edited' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the queued message")
    expect(box.value).toBe('fragile edited')
    expect(screen.getByTestId('queue-edit-chip')).toBeInTheDocument() // still editing — Enter retries
  })

  it('drain race: the slot being edited is dispatched mid-edit → toast + dirty text kept as draft', async () => {
    const box = await openWithQueuedMessages(['about to go'])
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.change(box, { target: { value: 'dirty edit in progress' } })
    await act(async () => {
      wsHandler!({ type: 'agent_dequeued', conversationId: 'c1', queueId: queueIdOf(1), text: 'about to go' })
    })
    expect(toast.info).toHaveBeenCalledWith('That queued message was already sent — your text is kept as a draft')
    expect(box.value).toBe('dirty edit in progress') // nothing lost
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
  })

  it('queue cleared (Stop) while editing pristine exits silently and restores the stashed draft', async () => {
    const box = await openWithQueuedMessages(['parked'])
    fireEvent.change(box, { target: { value: 'my draft' } })
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    await act(async () => { wsHandler!({ type: 'agent_queue_cleared', conversationId: 'c1' }) })
    expect(toast.info).not.toHaveBeenCalled() // self-initiated Stop — no notice
    expect(box.value).toBe('my draft')
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
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
    const box = (await screen.findByPlaceholderText('Ask the agent to do anything…')) as HTMLTextAreaElement
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('past prompt') // history, not queue-edit
    expect(screen.queryByTestId('queue-edit-chip')).not.toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('')
  })
})
