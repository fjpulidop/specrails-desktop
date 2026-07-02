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
    sendAgentMessage: vi.fn(async () => {}),
    abortAgentTurn: vi.fn(async () => {}),
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

import * as agentApi from '../../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'
import { AgentTierChip } from '../AgentTierChip'
import { AgentProjectSelector } from '../AgentProjectSelector'
import { AgentActivityChip, toolChipLabel } from '../AgentActivityChip'
import { AgentBubble } from '../AgentBubble'
import { AgentMessage } from '../AgentMessage'
import { AgentModelSelector } from '../AgentModelSelector'

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([])
  vi.mocked(agentApi.createAgentConversation).mockResolvedValue(api.conv)
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv, messages: [] })
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
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
      <span data-testid="mcp">{String(a.mcpEnabled)}</span>
      <span data-testid="tier">{a.active?.tier_level ?? -1}</span>
      <span data-testid="msgs">{a.messages.length}</span>
      <button onClick={a.open}>open</button>
      <button onClick={() => void a.send('hi')}>send</button>
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
    const bubble = screen.getByLabelText('Agent')
    expect(bubble).toBeInTheDocument()
    await act(async () => { fireEvent.click(bubble) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())
  })

  it('restores the bubble at the remembered position', () => {
    localStorage.setItem('specrails-desktop:agent-bubble-pos', JSON.stringify({ left: 123, top: 234 }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    const bubble = screen.getByLabelText('Agent')
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

  it('Shift+Tab inside the panel cycles the tier', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const dialog = await screen.findByRole('dialog')
    await act(async () => { fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }) })
    expect(agentApi.patchAgentConversation).toHaveBeenCalledWith('c1', { tierLevel: 1 })
  })
})
