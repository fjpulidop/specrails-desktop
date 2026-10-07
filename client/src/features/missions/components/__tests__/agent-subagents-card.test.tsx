import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { AgentSubagentsCard } from '../AgentSubagentsCard'
import { AgentBackgroundTurn, AgentDeferredChangeNotice, AgentSessionNotices, AgentTurnOriginLabel } from '../AgentSessionIndicators'
import type { AgentSubagent } from '../../lib/agent-api'

const node = (over: Partial<AgentSubagent> = {}): AgentSubagent => ({
  subagentId: 'sa-1', parentId: null, kind: 'background', agentType: 'Explore', description: 'Scan the repo',
  phase: 'running', reason: null, restarts: 0, startedAt: new Date(Date.now() - 65_000).toISOString(), endedAt: null,
  usage: null, toolUses: null, durationMs: null, resultSummary: null, launchedInTurnId: 't1', ...over,
})

function mockEvents(pages: Array<{ events: unknown[]; hasMore: boolean }>) {
  const urls: string[] = []
  vi.mocked(fetch).mockImplementation(async (input) => {
    urls.push(String(input))
    const page = pages.shift() ?? { events: [], hasMore: false }
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return urls
}

describe('AgentSubagentsCard', () => {
  it('marks sub-agents Specrails launched on another provider', () => {
    render(<AgentSubagentsCard conversationId="c1" liveEvents={{}} onStop={vi.fn()} onRelaunch={vi.fn()} subagents={[
      node({ agentType: 'claude:sonnet', delegated: { driver: 'claude', model: 'sonnet' } }),
      node({ subagentId: 'native', description: 'Native one' }),
    ]} />)
    const badges = screen.getAllByTestId('agent-subagent-delegated')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('Claude · sonnet')
    expect(badges[0]).toHaveAttribute('title', expect.stringContaining('its cost is counted separately'))
    expect(screen.queryByText('claude:sonnet')).not.toBeInTheDocument()
  })

  it('renders nothing without sub-agents', () => {
    const { container } = render(<AgentSubagentsCard conversationId="c1" subagents={[]} liveEvents={{}} onStop={vi.fn()} onRelaunch={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays open while agents work, nests children and keeps usage for finished rows', () => {
    render(
      <AgentSubagentsCard conversationId="c1" liveEvents={{}} onStop={vi.fn()} onRelaunch={vi.fn()} subagents={[
        node(),
        node({ subagentId: 'child', parentId: 'sa-1', description: 'Child task' }),
        node({ subagentId: 'done', description: 'Write tests', phase: 'idle', endedAt: new Date().toISOString(), resultSummary: 'All green',
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 12_400, costUsd: 0.42, costEstimated: true, model: null }, toolUses: 3 }),
        node({ subagentId: 'gone', description: 'Lint', phase: 'interrupted', reason: 'restart', endedAt: new Date().toISOString() }),
      ]} />,
    )
    const summary = screen.getByTestId('agent-subagents-summary')
    expect(summary).toHaveTextContent('4 agents')
    expect(summary).toHaveTextContent('2 working · 1 done · 1 ended')
    // No usage totals while anything runs.
    expect(summary).not.toHaveTextContent('tokens')
    const rows = screen.getAllByTestId('agent-subagent-row')
    expect(rows.map((row) => row.getAttribute('data-phase'))).toEqual(['running', 'running', 'idle', 'interrupted'])
    expect(within(rows[1]).getByText('Child task')).toBeInTheDocument()
    // Rows are one line: results and usage appear when a row is expanded.
    expect(within(rows[2]).queryByText('All green')).not.toBeInTheDocument()
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ events: [], hasMore: false }), { status: 200, headers: { 'content-type': 'application/json' } }))
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Show activity of Write tests' }))
    expect(within(rows[2]).getByText('All green')).toBeInTheDocument()
    expect(within(rows[2]).getByTestId('agent-subagent-meta')).toHaveTextContent('12k tokens · 3 tool calls · ≈ $0.42')
    fireEvent.click(within(rows[3]).getByRole('button', { name: 'Show activity of Lint' }))
    expect(within(rows[3]).getByTestId('agent-subagent-meta')).toHaveTextContent('Interrupted · lost on restart')
  })

  it('folds to one line once every agent finished, and remembers the user choice', async () => {
    const finished = [
      node({ phase: 'idle', startedAt: '2026-10-07T10:00:00.000Z', endedAt: '2026-10-07T10:00:57.000Z', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 40_000, costUsd: null, costEstimated: false, model: null } }),
      node({ subagentId: 'b', phase: 'idle', startedAt: '2026-10-07T10:00:05.000Z', endedAt: '2026-10-07T10:00:44.000Z', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 98_000, costUsd: null, costEstimated: false, model: null } }),
    ]
    const props = { conversationId: 'c1', liveEvents: {}, onStop: vi.fn(), onRelaunch: vi.fn() }
    const { rerender } = render(<AgentSubagentsCard {...props} subagents={[node({ startedAt: '2026-10-07T10:00:00.000Z' }), finished[1]!]} />)
    expect(screen.getByTestId('agent-subagents-card')).toHaveAttribute('data-open', 'true')
    rerender(<AgentSubagentsCard {...props} subagents={finished} />)
    expect(screen.getByTestId('agent-subagents-card')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('agent-subagents-summary')).toHaveTextContent('2 agents')
    expect(screen.getByTestId('agent-subagents-summary')).toHaveTextContent('done in 57s · 138k tokens')
    await waitFor(() => expect(screen.queryAllByTestId('agent-subagent-row')).toHaveLength(0))
    fireEvent.click(screen.getByTestId('agent-subagents-summary'))
    expect(screen.getAllByTestId('agent-subagent-row')).toHaveLength(2)
  })

  it('stops one, stops all and surfaces a stop failure', async () => {
    const onStop = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'))
    render(<AgentSubagentsCard conversationId="c1" liveEvents={{}} onStop={onStop} onRelaunch={vi.fn()}
      subagents={[node(), node({ subagentId: 'sa-2', description: 'Second' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Second' }))
    expect(onStop).toHaveBeenLastCalledWith(['sa-2'])
    fireEvent.click(screen.getByRole('button', { name: 'Stop all agents' }))
    expect(onStop).toHaveBeenLastCalledWith(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Stop all agents' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not stop agents')
  })

  it('offers relaunch for interrupted agents only', () => {
    const onRelaunch = vi.fn()
    render(<AgentSubagentsCard conversationId="c1" liveEvents={{}} onStop={vi.fn()} onRelaunch={onRelaunch} subagents={[
      node({ phase: 'stopped', reason: 'user_stop', endedAt: new Date().toISOString() }),
      node({ subagentId: 'shell', agentType: 'shell', description: 'npm test', phase: 'killed', endedAt: new Date().toISOString() }),
      node({ subagentId: 'ok', phase: 'idle', endedAt: new Date().toISOString() }),
    ]} />)
    fireEvent.click(screen.getByTestId('agent-subagents-summary'))
    const buttons = screen.getAllByRole('button', { name: 'Relaunch' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onRelaunch).toHaveBeenCalledWith(expect.objectContaining({ subagentId: 'sa-1' }))
  })

  it('loads activity history on expand and appends newer live events', async () => {
    const urls = mockEvents([{ events: [
      { seq: 1, channel: 'text', delta: 'Reading files', tool: null },
      { seq: 2, channel: 'tool', delta: null, tool: { toolUseId: 'u1', name: 'Grep', phase: 'completed', output: '3 matches' } },
    ], hasMore: false }])
    render(<AgentSubagentsCard conversationId="c1" onStop={vi.fn()} onRelaunch={vi.fn()} subagents={[node()]}
      liveEvents={{ 'sa-1': [{ seq: 2, channel: 'text', delta: 'duplicate', tool: null }, { seq: 3, channel: 'text', delta: 'Found it', tool: null }] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show activity of Scan the repo' }))
    const activity = await screen.findByTestId('agent-subagent-activity')
    expect(urls[0]).toContain('/conversations/c1/subagents/sa-1/events?after=0&limit=500')
    expect(within(activity).getByText('Reading files')).toBeInTheDocument()
    expect(within(activity).getByText('Grep')).toBeInTheDocument()
    expect(within(activity).getByText(/3 matches/)).toBeInTheDocument()
    expect(within(activity).getByText('Found it')).toBeInTheDocument()
    expect(within(activity).queryByText('duplicate')).not.toBeInTheDocument()
  })

  it('pages older activity and reports load failures', async () => {
    const urls = mockEvents([
      { events: [{ seq: 1, channel: 'text', delta: 'first', tool: null }], hasMore: true },
      { events: [{ seq: 2, channel: 'text', delta: 'second', tool: null }], hasMore: false },
    ])
    render(<AgentSubagentsCard conversationId="c1" onStop={vi.fn()} onRelaunch={vi.fn()} subagents={[node()]} liveEvents={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show activity of Scan the repo' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(urls[1]).toContain('after=1')
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('shows an error when activity cannot load', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 500 }))
    render(<AgentSubagentsCard conversationId="c1" onStop={vi.fn()} onRelaunch={vi.fn()} subagents={[node()]} liveEvents={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show activity of Scan the repo' }))
    expect(await screen.findByText('Could not load activity')).toBeInTheDocument()
  })
})

describe('sub-agent results', () => {
  it('renders the full result as markdown when a row is expanded', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ events: [], hasMore: false }), { status: 200, headers: { 'content-type': 'application/json' } }))
    render(<AgentSubagentsCard conversationId="c1" liveEvents={{}} onStop={vi.fn()} onRelaunch={vi.fn()}
      subagents={[node({ phase: 'idle', endedAt: new Date().toISOString(), resultSummary: '**No backend yet.**\n\n- One commit\n- `openspec/` empty' })]} />)
    fireEvent.click(screen.getByTestId('agent-subagents-summary'))
    const toggle = screen.getByRole('button', { name: 'Show activity of Scan the repo' })
    // The folded row hints the result without raw markdown.
    expect(toggle).toHaveAttribute('title', 'No backend yet. One commit openspec/ empty')
    fireEvent.click(toggle)
    const result = await screen.findByTestId('agent-subagent-result')
    expect(within(result).getByText('No backend yet.').tagName).toBe('STRONG')
    expect(within(result).getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('session indicators', () => {
  it('background turn shows a placeholder, then the streamed text', () => {
    const { rerender } = render(<AgentBackgroundTurn turn={{ turnId: 'bg', origin: 'subagent', triggeredBy: [], text: '' }} />)
    expect(screen.getByText('Agent is reviewing background results…')).toBeInTheDocument()
    expect(screen.getByTestId('agent-turn-origin')).toHaveTextContent('Continued after background agents')
    rerender(<AgentBackgroundTurn turn={{ turnId: 'bg', origin: 'system', triggeredBy: [], text: 'All three agents finished.' }} />)
    expect(screen.getByText('All three agents finished.')).toBeInTheDocument()
    expect(screen.getByTestId('agent-turn-origin')).toHaveTextContent('Continued after background work')
  })

  it('origin label and deferred notice', async () => {
    render(<AgentTurnOriginLabel origin="subagent" />)
    const onApplyNow = vi.fn().mockResolvedValue(undefined)
    render(<AgentDeferredChangeNotice onApplyNow={onApplyNow} />)
    expect(screen.getByTestId('agent-deferred-change')).toHaveTextContent('Settings change will apply when background agents finish.')
    fireEvent.click(screen.getByRole('button', { name: 'Stop agents and apply now' }))
    await waitFor(() => expect(onApplyNow).toHaveBeenCalledTimes(1))
  })
})

describe('AgentActivityChip with sub-agents', () => {
  it('names the launched sub-agent on agent-spawn tools only', async () => {
    const { AgentActivityChip } = await import('../AgentActivityChip')
    const { rerender } = render(<AgentActivityChip tool="Agent" agentDescription="Scan the repo" />)
    expect(screen.getByText('Agent · Scan the repo')).toBeInTheDocument()
    rerender(<AgentActivityChip tool="spawnAgent" agentDescription={null} />)
    expect(await screen.findByText('Agent')).toBeInTheDocument()
    rerender(<AgentActivityChip tool="Read" agentDescription="Scan the repo" />)
    expect(await screen.findByText('Reading')).toBeInTheDocument()
  })
})

describe('AgentSessionNotices', () => {
  const hostNotice = { id: 'n1', code: 'journal_locked', level: 'warning' as const, message: 'raw', scope: 'acme' }

  it('names the provider when a sub-agent choice cannot be honoured, without a host retry', () => {
    render(<AgentSessionNotices notices={[{ id: 'n3', code: 'subagents.delegation_unsupported', level: 'warning', message: 'raw', scope: null, provider: 'claude' }]} onDismiss={vi.fn()} />)
    expect(screen.getByText(/Claude sub-agents need a newer Specrails Core/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('explains known notices, retries the host and dismisses on success', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ host: { scope: 'acme', status: 'ready', detail: null, code: null } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const onDismiss = vi.fn()
    render(<AgentSessionNotices notices={[hostNotice, { id: 'n2', code: 'policy.subagent_blocked', level: 'warning', message: 'raw', scope: null }]} onDismiss={onDismiss} />)
    expect(screen.getByText(/Another Specrails Desktop instance/)).toBeInTheDocument()
    expect(screen.getByText(/it was stopped/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('n1'))
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain('/session-hosts/acme/retry')
  })

  it('keeps the notice and says so when the retry does not help', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ host: { scope: 'acme', status: 'degraded', detail: 'x', code: 'journal_locked' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const onDismiss = vi.fn()
    render(<AgentSessionNotices notices={[hostNotice]} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Still unavailable/)).toBeInTheDocument()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('shows unknown notices as reported and dismisses them', () => {
    const onDismiss = vi.fn()
    const { container, rerender } = render(<AgentSessionNotices notices={[{ id: 'n3', code: 'provider.retrying', level: 'info', message: 'Rate limited, retrying', scope: null }]} onDismiss={onDismiss} />)
    expect(screen.getByRole('status')).toHaveTextContent('Rate limited, retrying')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith('n3')
    rerender(<AgentSessionNotices notices={[]} onDismiss={onDismiss} />)
    expect(container).toBeEmptyDOMElement()
  })
})

