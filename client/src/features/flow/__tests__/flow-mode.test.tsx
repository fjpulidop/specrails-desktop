import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, renderHook, within } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('../../providers/hooks/useProviderDetection', () => ({
  useProviderDetection: () => ({
    detected: ['claude'],
    providers: { claude: { id: 'claude', displayName: 'Claude Code' } },
    loading: false,
  }),
}))
vi.mock('../../loops/lib/loops-api', () => ({ loopsApi: { list: vi.fn(async () => []) } }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
// The mission's background processes (the agent's apps) and the system browser.
const background = vi.hoisted(() => ({ processes: [] as unknown[], kill: vi.fn(async () => {}) }))
vi.mock('../../background/context/BackgroundProcessesContext', () => ({
  useBackgroundProcesses: () => ({ processes: background.processes, history: background.processes, historyLoading: false, historyError: null, refreshHistory: async () => {}, kill: background.kill }),
}))
const shell = vi.hoisted(() => ({ openExternalUrl: vi.fn(async () => {}) }))
vi.mock('../../../lib/tauri-shell', async (importOriginal) => ({ ...(await importOriginal<object>()), openExternalUrl: shell.openExternalUrl }))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { FlowProvider, useConversationFlow } from '../context/FlowContext'
import { FlowMissionsBridge, useFlowConversationMode } from '../components/FlowMissionsBridge'
import { FlowEntryCard } from '../components/FlowEntryCard'
import { FlowDock } from '../components/FlowDock'
import { AgentRunStrip } from '../../missions/components/AgentRunStrip'
import { FlowOfferCard } from '../components/FlowOfferCard'
import { describeFlowRun } from '../components/FlowLiveRuns'
import { useFlowConversationMarks } from '../components/FlowConversationMarks'
import i18n from '../../../lib/i18n'
import { AgentMessage } from '../../missions/components/AgentMessage'
import { resetLocalIntents } from '../../rails/lib/rail-launch-intents'
import type { Flow } from '../lib/flow-api'

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1', conversationId: 'c1', ticketId: 7, state: 'active', branch: 'feat/7-calm-dashboard', worktreePath: '/wt/f1/ticket-7',
  baseSha: 'a', headSha: 'b', railIndex: null, deliveryId: null, step: null, ...over,
})

let wsHandlers: Map<string, (msg: unknown) => void>
const ws = {
  registerHandler: (id: string, fn: (msg: unknown) => void) => { wsHandlers.set(id, fn) },
  unregisterHandler: (id: string) => { wsHandlers.delete(id) },
  connectionStatus: 'connected' as const,
}

type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[]
let current: Flow | null
let availability: { available: boolean; reason: string; missing: string[] }

function respond(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body, clone() { return this } } as unknown as Response
}

function mockFetch() {
  calls = []
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ url, method, body })
    if (url.endsWith('/flow/availability')) return respond(200, availability)
    if (url.includes('/flow/by-conversation/')) return respond(200, { flow: current })
    if (url.endsWith('/flow') && method === 'POST') { current = flow(); return respond(201, { flow: current }) }
    if (url.endsWith('/flow/f1/pause')) { current = flow({ state: 'paused' }); return respond(200, { flow: current }) }
    if (url.endsWith('/flow/f1/resume')) { current = flow(); return respond(200, { flow: current }) }
    if (url.endsWith('/flow/f1/discard')) { current = flow({ state: 'discarded' }); return respond(200, { flow: current }) }
    if (url.endsWith('/flow/f1/hand-off')) { current = flow({ state: 'handed_off', railIndex: 1, deliveryId: 'd1' }); return respond(202, { flow: current, loopRunIds: ['run-9'], deliveryId: 'd1' }) }
    if (url.endsWith('/flow/f1/diff')) return respond(200, { branch: 'feat/7-calm-dashboard', baseSha: 'a', headSha: 'b', files: [{ path: 'src/App.tsx', status: 'modified', additions: 8, deletions: 2 }, { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 }, { path: 'logo.png', status: 'untracked', additions: null, deletions: null }], totals: { files: 3, additions: 10, deletions: 2 } })
    if (url.endsWith('/flow/open')) return respond(200, { flows: current && ['active', 'paused', 'needs-review'].includes(current.state) ? [{ id: current.id, conversationId: current.conversationId, state: current.state, branch: current.branch }] : [] })
    if (url.endsWith('/flow/f1/cost')) return respond(200, { flowId: 'f1', costUsd: 0.42, turns: 3, unpricedTurns: 0 })
    if (url.endsWith('/rails') && method === 'GET') return respond(200, { rails: [{ railIndex: 0, ticketIds: [3], mode: 'implement' }, { railIndex: 1, ticketIds: [], mode: 'implement' }], activeJobs: { 0: { jobId: 'j' } }, activeLoopRuns: {}, prDeliveries: {} })
    if (url.endsWith('/tickets') && method === 'GET') return respond(200, { tickets: [{ id: 7, title: 'Calm dashboard', status: 'in_progress', labels: [] }] })
    if (url.endsWith('/repositories')) return respond(200, { repositories: [{ id: 'primary', projectId: 'p1', name: 'App', path: '/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }] })
    if (url.includes('/intent')) return respond(200, { message: { intents: [{ ...body, at: 'now' }] } })
    return respond(200, {})
  })
}

/** What missions mounts above the composer: the run strip and the extension dock. */
function FlowStrip() {
  return (
    <>
      <AgentRunStrip conversationId="c1" projectId="p1" inline />
      <FlowDock conversationId="c1" projectId="p1" inline />
    </>
  )
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <SharedWebSocketContext.Provider value={ws}>
      <FlowMissionsBridge>{children}</FlowMissionsBridge>
    </SharedWebSocketContext.Provider>
  )
}

beforeEach(() => {
  background.processes = []
  background.kill.mockClear()
  shell.openExternalUrl.mockClear()
  wsHandlers = new Map()
  current = flow()
  availability = { available: true, reason: 'Flow is available', missing: [] }
  resetLocalIntents()
  mockFetch()
})

describe('FlowEntryCard', () => {
  it('explains the isolated worktree and starts the Flow on Start', async () => {
    current = null
    const onStarted = vi.fn()
    render(<Providers><FlowEntryCard idea="Try a calmer dashboard" projectId="p1" conversationId="c1" provider="claude" onStarted={onStarted} onCancel={vi.fn()} /></Providers>)
    expect(screen.getByText(/isolated worktree where the agent can write code\. Your main branch is not touched\./)).toBeInTheDocument()
    expect(screen.getByTestId('flow-entry-idea')).toHaveTextContent('Try a calmer dashboard')
    expect(screen.getByText(/works with Claude/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' })))
    expect(calls.find((c) => c.url.endsWith('/api/projects/p1/flow') && c.method === 'POST')!.body).toEqual({ conversationId: 'c1', idea: 'Try a calmer dashboard' })
  })

  it('explains a repository without commits in plain words instead of the raw Git error', async () => {
    current = null
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/flow') && init?.method === 'POST') {
        return respond(409, { error: 'repository_has_no_commits', detail: 'git worktree add failed: fatal: invalid reference: HEAD' })
      }
      return base(input, init)
    })
    const onStarted = vi.fn()
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={onStarted} onCancel={vi.fn()} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    const error = await screen.findByTestId('flow-entry-error')
    expect(error).toHaveTextContent('This repository has no commits yet. Make an initial commit so Specrails can create an isolated worktree.')
    expect(error).not.toHaveTextContent('invalid reference')
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('Create initial commit retries Start on its own after a repository_has_no_commits refusal', async () => {
    current = null
    const base = vi.mocked(fetch).getMockImplementation()!
    let starts = 0
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/flow') && init?.method === 'POST' && ++starts === 1) return respond(409, { error: 'repository_has_no_commits', detail: 'raw' })
      if (url.endsWith('/git/initial-commit')) { calls.push({ url, method: 'POST', body: null }); return respond(201, { sha: 'c'.repeat(40), repositoryId: 'primary' }) }
      return base(input, init)
    })
    const onStarted = vi.fn()
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={onStarted} onCancel={vi.fn()} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await act(async () => { fireEvent.click(await screen.findByTestId('initial-commit-create')) })
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' })))
    expect(starts).toBe(2)
    expect(calls.some((c) => c.url.endsWith('/api/projects/p1/git/initial-commit'))).toBe(true)
    expect(screen.queryByTestId('flow-entry-error')).not.toBeInTheDocument()
  })

  it('is disabled with the missing capabilities in plain words when Flow is unavailable', async () => {
    availability = { available: false, reason: 'update Core', missing: ['flowSessions', 'deriveChange'] }
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    const note = await screen.findByTestId('flow-entry-blocked')
    expect(note).toHaveTextContent('Flow needs a newer Specrails Core')
    expect(note).toHaveTextContent('cannot interrupt a running agent yet')
    expect(note).toHaveTextContent('cannot derive a spec from code yet')
    expect(screen.getByTestId('flow-entry-start')).toBeDisabled()
  })

  it('treats a 409 feature_unavailable availability answer as unavailable', async () => {
    vi.mocked(fetch).mockImplementation(async () => respond(409, { error: 'feature_unavailable', detail: 'Flow is not available in this project' }))
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    expect(await screen.findByTestId('flow-entry-blocked')).toHaveTextContent('Flow is not available right now')
    expect(screen.getByTestId('flow-entry-start')).toBeDisabled()
  })
})

describe('FlowEntryCard in a workspace (repository target)', () => {
  const member = (id: string, kind: 'git' | 'folder', isPrimary = false) => ({ id, projectId: 'p1', name: id === 'ws' ? 'Workspace' : id.toUpperCase(), path: `/ws/${id}`, isPrimary, kind, integrationBranch: null, addedAt: '' })
  function withRepositories(repositories: unknown[]) {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/repositories')) return respond(200, { repositories })
      return base(input, init)
    })
  }

  it('preselects the repository the agent triaged, lets the person change it and starts the Flow there', async () => {
    current = null
    withRepositories([member('ws', 'folder', true), member('api', 'git'), member('web', 'git')])
    const onStarted = vi.fn()
    render(<Providers><FlowEntryCard idea="Rate-limit the API" repositoryId="api" projectId="p1" conversationId="c1" onStarted={onStarted} onCancel={vi.fn()} /></Providers>)
    const group = await screen.findByTestId('flow-entry-repository')
    expect(group).toHaveTextContent('Repository')
    // Only Git members are offered; the folder primary never is.
    expect(screen.queryByTestId('flow-entry-repository-ws')).not.toBeInTheDocument()
    expect(screen.getByTestId('flow-entry-repository-api')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('flow-entry-repository-api')).toHaveTextContent('Suggested by the agent')
    expect(screen.getByTestId('flow-entry-repository-web')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByTestId('flow-entry-repository-web'))
    expect(screen.getByTestId('flow-entry-repository-web')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(onStarted).toHaveBeenCalled())
    expect(calls.find((c) => c.url.endsWith('/api/projects/p1/flow') && c.method === 'POST')!.body).toEqual({ conversationId: 'c1', idea: 'Rate-limit the API', repositoryId: 'web' })
  })

  it('without a triage, waits for the person to choose among several Git repositories', async () => {
    current = null
    withRepositories([member('ws', 'folder', true), member('api', 'git'), member('web', 'git')])
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    await screen.findByTestId('flow-entry-repository')
    expect(screen.getByText('Choose the repository this Flow runs in')).toBeInTheDocument()
    expect(screen.getByTestId('flow-entry-start')).toBeDisabled()
    fireEvent.click(screen.getByTestId('flow-entry-repository-api'))
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
  })

  it('blocks a workspace without any Git repository and explains a refused target in plain words', async () => {
    current = null
    withRepositories([member('ws', 'folder', true), member('notes', 'folder')])
    const { unmount } = render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    expect(await screen.findByTestId('flow-entry-blocked')).toHaveTextContent('This project has no Git repository')
    expect(screen.getByTestId('flow-entry-start')).toBeDisabled()
    unmount()

    withRepositories([member('ws', 'folder', true), member('api', 'git'), member('web', 'git')])
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/flow') && init?.method === 'POST') return respond(400, { error: 'flow_repository_not_git', detail: 'raw' })
      return base(input, init)
    })
    render(<Providers><FlowEntryCard idea="x" repositoryId="api" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    expect(await screen.findByTestId('flow-entry-error')).toHaveTextContent('Flow needs a Git repository; a folder cannot hold its worktree.')
  })

  it('a single-repository project shows no choice and never sends a repository', async () => {
    current = null
    const onStarted = vi.fn()
    render(<Providers><FlowEntryCard idea="x" repositoryId="primary" projectId="p1" conversationId="c1" onStarted={onStarted} onCancel={vi.fn()} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    expect(screen.queryByTestId('flow-entry-repository')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(onStarted).toHaveBeenCalled())
    expect(calls.find((c) => c.url.endsWith('/api/projects/p1/flow') && c.method === 'POST')!.body).toEqual({ conversationId: 'c1', idea: 'x' })
  })
})

describe('Flow mode in the conversation', () => {
  it('names Flow mode on the composer and the header while the Flow is open; only an active Flow interrupts', async () => {
    const { result } = renderHook(() => useFlowConversationMode('c1', 'p1'), { wrapper: Providers })
    // The run strip carries the (copyable) branch: the git strip steps aside.
    await waitFor(() => expect(result.current).toMatchObject({
      attributes: { 'data-flow': 'active' }, hideGitStrip: true, interruptWhileBusy: true,
      composer: { badge: { label: 'Flow' }, placeholder: 'Tell the agent what to change in the worktree…' },
      headerBadge: { label: 'In Flow' },
    }))
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'paused' }) }))
    // Paused is still Flow mode (composer + header), without interrupting sends.
    expect(result.current).toMatchObject({ hideGitStrip: true, composer: { badge: { label: 'Flow' } } })
    expect(result.current?.interruptWhileBusy).toBeUndefined()
    expect(result.current?.attributes).toBeUndefined()
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'handed_off' }) }))
    expect(result.current).toBeNull()
  })

  it('shows Flow in the run strip with branch, files, real cost and the controls', async () => {
    render(<Providers><FlowStrip /></Providers>)
    const bar = await screen.findByTestId('mission-run-strip')
    expect(bar).toHaveAttribute('data-flow-state', 'active')
    expect(bar).toHaveAttribute('data-tone', 'running')
    expect(screen.getByTestId('mission-run-strip-headline')).toHaveTextContent('Flow')
    // Flow has no panel: the strip itself is the Flow bar.
    expect(screen.queryByTestId('mission-run-strip-toggle')).toBeNull()
    expect(bar).toHaveTextContent('feat/7-calm-dashboard')
    await waitFor(() => expect(screen.getByTestId('flow-bar-stats')).toHaveTextContent('3 files+10−2'))
    expect(screen.getByTestId('flow-bar-cost')).toHaveTextContent('$0.420')
    for (const id of ['changes', 'pause', 'discard', 'this-is-it']) expect(screen.getByTestId(`flow-bar-${id}`)).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Flow actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('flow-bar-changes'))
    const dialog = await screen.findByTestId('flow-changes-dialog')
    await waitFor(() => expect(dialog.querySelectorAll('[data-testid="flow-changes-file"]')).toHaveLength(3))
    expect(dialog).toHaveTextContent('src/App.tsx')
    expect(dialog).toHaveTextContent('—')
  })

  it('keeps Discard apart from the primary action, and the file stat opens the changes', async () => {
    render(<Providers><FlowStrip /></Providers>)
    const toolbar = await screen.findByRole('toolbar', { name: 'Flow actions' })
    const order = [...toolbar.querySelectorAll('[data-testid^="flow-bar-"]')].map((node) => node.getAttribute('data-testid'))
    expect(order).toEqual(['flow-bar-discard', 'flow-bar-separator', 'flow-bar-pause', 'flow-bar-this-is-it'])
    await waitFor(() => expect(screen.getByTestId('flow-bar-changes')).toHaveAccessibleName('View changes · 3 files, +10 −2'))
    expect(screen.getByTestId('flow-bar-branch')).toHaveAccessibleName('Copy branch name: feat/7-calm-dashboard')
  })

  it('a disabled "This is it" says why (tooltip and description)', async () => {
    current = flow({ step: 'handoff:freeze' })
    render(<Providers><FlowStrip /></Providers>)
    const handOff = await screen.findByTestId('flow-bar-this-is-it')
    expect(handOff).toBeDisabled()
    expect(handOff).toHaveAccessibleDescription('Wait until the Flow finishes saving its state')
    expect(handOff.getAttribute('title')).toContain('Wait until the Flow finishes saving its state')
  })

  it('announces state changes politely, including the way back from a rail', async () => {
    const { rerender } = render(<Providers><FlowStrip /></Providers>)
    await screen.findByTestId('mission-run-strip')
    const announcer = screen.getByTestId('flow-state-announcer')
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer).toHaveTextContent('')
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'handed_off' }) }))
    await waitFor(() => expect(screen.getByTestId('flow-state-announcer')).toHaveTextContent('Flow handed off to a rail.'))
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'active' }) }))
    await waitFor(() => expect(screen.getByTestId('flow-state-announcer')).toHaveTextContent('Back in Flow'))
    rerender(<Providers><FlowStrip /></Providers>)
  })

  describe('Preview of the app the Flow agent started', () => {
    const app = (over: Record<string, unknown> = {}) => ({
      processId: 'proc-1', pid: 4242, command: 'npm run dev', cwd: '/wt/f1/ticket-7', startedAt: 1, status: 'running', chatId: 'c1', projectId: 'p1', flowId: 'f1',
      appUrls: { local: ['http://localhost:5173/'], network: ['http://192.168.1.20:5173/'] }, ...over,
    })

    it('stays hidden while no app of this Flow announced an address', async () => {
      background.processes = [
        app({ appUrls: undefined }),
        app({ processId: 'other-flow', flowId: 'f2' }),
        app({ processId: 'plain-mission', flowId: undefined }),
        app({ processId: 'other-chat', chatId: 'c2' }),
        app({ processId: 'ended', status: 'exited' }),
      ]
      render(<Providers><FlowStrip /></Providers>)
      await screen.findByTestId('mission-run-strip')
      expect(screen.queryByTestId('flow-bar-preview')).toBeNull()
    })

    it('shows Preview with a live dot that opens the local address in the browser', async () => {
      background.processes = [app()]
      render(<Providers><FlowStrip /></Providers>)
      const preview = await screen.findByTestId('flow-bar-preview')
      expect(preview).toHaveTextContent('Preview')
      expect(preview).toHaveAccessibleName('Open the app at http://localhost:5173/ in your browser')
      expect(screen.getByTestId('flow-app-dot')).toBeInTheDocument()
      fireEvent.click(preview)
      expect(shell.openExternalUrl).toHaveBeenCalledWith('http://localhost:5173/')
    })

    it('offers the network address and Stop app in its menu', async () => {
      background.processes = [app()]
      render(<Providers><FlowStrip /></Providers>)
      fireEvent.click(await screen.findByTestId('flow-bar-preview-menu'))
      expect(screen.getByRole('menu', { name: 'App actions' })).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('flow-preview-network'))
      expect(shell.openExternalUrl).toHaveBeenCalledWith('http://192.168.1.20:5173/')
      expect(screen.queryByRole('menu')).toBeNull()
      fireEvent.click(screen.getByTestId('flow-bar-preview-menu'))
      await act(async () => { fireEvent.click(screen.getByTestId('flow-preview-stop')) })
      expect(background.kill).toHaveBeenCalledWith(expect.objectContaining({ processId: 'proc-1', pid: 4242 }))
    })

    it('says when the app only listens on this computer, and shows Stopping… while it stops', async () => {
      background.processes = [app({ appUrls: { local: ['http://localhost:3000/'], network: [] } })]
      const view = render(<Providers><FlowStrip /></Providers>)
      fireEvent.click(await screen.findByTestId('flow-bar-preview-menu'))
      expect(screen.getByTestId('flow-preview-local-only')).toHaveTextContent('Only reachable from this computer')
      expect(screen.queryByTestId('flow-preview-network')).toBeNull()
      background.processes = [app({ status: 'stopping' })]
      view.rerender(<Providers><FlowStrip /></Providers>)
      await waitFor(() => expect(screen.getByTestId('flow-bar-preview')).toHaveTextContent('Stopping…'))
      expect(screen.getByTestId('flow-bar-preview')).toBeDisabled()
    })

    it('is not shown on a paused Flow (Specrails stopped its apps)', async () => {
      current = flow({ state: 'paused' })
      background.processes = [app()]
      render(<Providers><FlowStrip /></Providers>)
      await screen.findByTestId('flow-bar-resume')
      expect(screen.queryByTestId('flow-app-preview')).toBeNull()
    })
  })

  it('shows — when no turn is priced yet', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith('/cost')
      ? respond(200, { flowId: 'f1', costUsd: 0, turns: 1, unpricedTurns: 1 })
      : String(input).includes('/by-conversation/') ? respond(200, { flow: current }) : respond(200, { files: [], totals: { files: 0, additions: 0, deletions: 0 } }))
    render(<Providers><FlowStrip /></Providers>)
    await waitFor(() => expect(screen.getByTestId('flow-bar-cost')).toHaveTextContent('—'))
  })

  it('pauses, then offers Resume Flow and resumes', async () => {
    render(<Providers><FlowStrip /></Providers>)
    const pause = await screen.findByTestId('flow-bar-pause')
    await act(async () => { fireEvent.click(pause) })
    await waitFor(() => expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-flow-state', 'paused'))
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-tone', 'paused')
    expect(screen.getByTestId('flow-bar-note')).toHaveTextContent('The worktree and the spec are kept')
    await act(async () => { fireEvent.click(screen.getByTestId('flow-bar-resume')) })
    await waitFor(() => expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-flow-state', 'active'))
    expect(calls.map((c) => c.url).filter((u) => /\/(pause|resume)$/.test(u))).toEqual([
      expect.stringMatching(/\/api\/projects\/p1\/flow\/f1\/pause$/), expect.stringMatching(/\/flow\/f1\/resume$/),
    ])
  })

  it('asks before discarding and only then calls discard', async () => {
    render(<Providers><FlowStrip /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-discard'))
    const dialog = await screen.findByTestId('flow-discard-dialog')
    // It names what is lost: the changed files with their lines, the branch and the spec.
    expect(dialog).toHaveTextContent('cannot be undone')
    await waitFor(() => expect(screen.getByTestId('flow-discard-files')).toHaveTextContent('3 changed files+10−2'))
    expect(screen.getByTestId('flow-discard-loss')).toHaveTextContent('feat/7-calm-dashboard')
    expect(screen.getByTestId('flow-discard-loss')).toHaveTextContent('The placeholder spec on the board')
    expect(calls.some((c) => c.url.endsWith('/discard'))).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('flow-discard-confirm')) })
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/flow/f1/discard') && c.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.queryByTestId('mission-run-strip')).toBeNull())
  })

  it('explains needs-review without destructive controls', async () => {
    current = flow({ state: 'needs-review' })
    render(<Providers><FlowStrip /></Providers>)
    expect(await screen.findByTestId('flow-bar-note')).toHaveTextContent('Nothing was deleted')
    expect(screen.queryByTestId('flow-bar-discard')).toBeNull()
  })

  it('"This is it" morphs the strip into Flow → Spec and opens the hand-off as its panel; Launch goes through the hand-off route', async () => {
    const { result } = renderHook(() => useFlowConversationMode('c1', 'p1'), { wrapper: Providers })
    await waitFor(() => expect(result.current).not.toBeNull())
    render(<Providers><FlowStrip /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-this-is-it'))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    const strip = screen.getByTestId('mission-run-strip')
    // Same run, same place: the strip morphs (same key) instead of a new block appearing.
    expect(strip).toHaveAttribute('data-run-key', 'flow:f1')
    expect(strip).toHaveAttribute('data-flow-state', 'wrapping-up')
    expect(strip).toHaveAttribute('data-tone', 'decision')
    expect(screen.getByTestId('mission-run-strip-headline')).toHaveTextContent('Flow → Spec ready to launch')
    // The hand-off settings open on their own as the strip's panel.
    await waitFor(() => expect(screen.getByTestId('mission-run-strip-panel')).toHaveAttribute('data-open', 'true'))
    const card = within(screen.getByTestId('mission-run-strip-panel')).getByTestId('flow-hand-off-card')
    expect(screen.queryByTestId('flow-bar-this-is-it')).toBeNull()
    // ONE confirmation line: which rail, how many files, and the safety net.
    await waitFor(() => expect(within(card).getByTestId('rail-card-hand-off-line')).toHaveTextContent(
      'Rail 2 will turn your 3 changed files into a reviewed PR. If it fails, your work is safe.',
    ))
    expect(within(card).getByRole('group', { name: 'Turn this Flow into a reviewed PR' })).toBeInTheDocument()
    // How (rail, engine, model, effort) waits under "Change how", prefilled; no loop selector at all.
    const how = within(card).getByTestId('rail-card-hand-off-how')
    expect(how).toHaveAttribute('aria-expanded', 'false')
    expect(within(card).getByTestId('rail-card-hand-off-settings')).not.toBeVisible()
    expect(screen.queryByTestId('rail-card-loop')).toBeNull()
    fireEvent.click(how)
    expect(how).toHaveAttribute('aria-expanded', 'true')
    expect(within(card).getByTestId('rail-card-hand-off-settings')).toBeVisible()
    expect(within(card).getByTestId('rail-card-rail')).toBeInTheDocument()
    // What the Flow changed and cost so far lives there too.
    await waitFor(() => expect(screen.getByTestId('flow-hand-off-recap')).toHaveTextContent('3 files +10 −2 · $0.420 so far'))
    expect(screen.queryByTestId('rail-card-repositories')).toBeNull()
    expect(screen.queryByTestId('rail-card-target-pr')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    // Launched: the strip keeps a launching skeleton until the run itself shows (no gap).
    await waitFor(() => expect(screen.getByTestId('mission-run-strip-headline')).toHaveTextContent('Launching Flow → Spec on Rail 2…'))
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-tone', 'launching')
    expect(screen.getByTestId('mission-run-strip-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('flow-hand-off-card')).toBeNull()
    const handOff = calls.find((c) => c.url.endsWith('/flow/f1/hand-off'))!
    expect(handOff.body).toMatchObject({ railIndex: 1, loopId: 'factory:flow-spec' })
    expect(calls.some((c) => /\/rails\/\d+\/(launch|tickets)$/.test(c.url))).toBe(false)
    // No offer message anchors this Flow: nothing is patched on a phantom message.
    expect(calls.some((c) => c.url.includes('/intent'))).toBe(false)
  })

  it('the strip\'s own Launch never launches blind: it reopens the hand-off focused on Launch', async () => {
    render(<Providers><FlowStrip /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-this-is-it'))
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    // Close the panel: the strip still offers Launch, which only points at the card's own control.
    fireEvent.keyDown(screen.getByTestId('mission-run-strip-panel'), { key: 'Escape' })
    const launch = await screen.findByTestId('mission-run-strip-primary')
    expect(launch).toHaveTextContent('Launch')
    await act(async () => { fireEvent.click(launch) })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('rail-card-play')))
    expect(calls.some((c) => c.url.endsWith('/flow/f1/hand-off'))).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/flow/f1/hand-off'))).toBe(true))
    await waitFor(() => expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-tone', 'launching'))
  })

  it('"Not yet" returns to the Flow', async () => {
    render(<Providers><FlowStrip /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-this-is-it'))
    await screen.findByTestId('flow-hand-off-card')
    fireEvent.click(screen.getByTestId('rail-card-dismiss'))
    await waitFor(() => expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-flow-state', 'active'))
    expect(screen.getByTestId('flow-bar-this-is-it')).toBeInTheDocument()
  })

  it('applies flow.state events only for watched projects', async () => {
    const { result } = renderHook(() => useConversationFlow('c1', 'p1'), { wrapper: ({ children }) => <SharedWebSocketContext.Provider value={ws}><FlowProvider>{children}</FlowProvider></SharedWebSocketContext.Provider> })
    await waitFor(() => expect(result.current.flow?.state).toBe('active'))
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p2', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'discarded' }) }))
    expect(result.current.flow?.state).toBe('active')
    act(() => wsHandlers.get('flow-mode')!({ type: 'other', projectId: 'p1', conversationId: 'c1', flow: flow({ state: 'discarded' }) }))
    expect(result.current.flow?.state).toBe('active')
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'paused' }) }))
    expect(result.current.flow?.state).toBe('paused')
  })
})

describe('FlowOfferCard through the AgentMessage extension chain', () => {
  const offer = (recommended?: 'flow' | 'implement') => `This one is exploratory.\n\n\`\`\`flow-offer\n${JSON.stringify({ idea: 'Prototype a calmer dashboard', reason: 'The look is still open.', ...(recommended ? { recommended } : {}) })}\n\`\`\``

  it('strips the fence and shows both paths with equal weight, Flow first, and the reason as neutral context', async () => {
    current = null
    render(<Providers><AgentMessage role="assistant" content={offer()} messageId="m1" conversationId="c1" refsProjectId="p1" isLatest /></Providers>)
    const card = await screen.findByTestId('flow-offer-card')
    expect(card).not.toHaveAttribute('data-recommended')
    expect(screen.getByTestId('flow-offer-reason')).toHaveTextContent('Why the agent asked')
    expect(screen.getByTestId('flow-offer-reason')).toHaveTextContent('The look is still open.')
    const choices = [...card.querySelectorAll('[data-testid^="flow-offer-choose-"]')]
    expect(choices.map((choice) => choice.getAttribute('data-testid'))).toEqual(['flow-offer-choose-flow', 'flow-offer-choose-implement'])
    expect(choices[0]!.className).toBe(choices[1]!.className.replace(/accent-primary/g, 'accent-info'))
    expect(card).not.toHaveTextContent('Recommended')
    expect(screen.queryByText(/"recommended"/)).toBeNull()
  })

  it('a legacy offer that still recommends a path renders the same neutral card', async () => {
    current = null
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'Prototype it', recommended: 'implement' }} index={0} messageId="m1" conversationId="c1" projectId="p1" intents={null} isLatest isStreaming={false} /></Providers>)
    const choices = [...screen.getByTestId('flow-offer-card').querySelectorAll('[data-testid^="flow-offer-choose-"]')]
    expect(choices.map((choice) => choice.getAttribute('data-testid'))).toEqual(['flow-offer-choose-flow', 'flow-offer-choose-implement'])
    expect(screen.getByTestId('flow-offer-card')).not.toHaveTextContent('Recommended')
  })

  it('while the agent is still replying, the choices wait and say why', () => {
    current = null
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'Prototype it', reason: 'Open' }} index={0} messageId="m1" conversationId="c1" projectId="p1" intents={null} isLatest isStreaming /></Providers>)
    const flowChoice = screen.getByTestId('flow-offer-choose-flow')
    expect(flowChoice).toBeDisabled()
    const hint = screen.getByTestId('flow-offer-streaming-hint')
    expect(hint).toHaveTextContent('You can choose once the agent finishes this reply.')
    expect(flowChoice.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('Implement records the choice and replies to the agent', async () => {
    current = null
    const onSend = vi.fn()
    render(<Providers><AgentMessage role="assistant" content={offer('flow')} messageId="m1" conversationId="c1" refsProjectId="p1" isLatest onPickOption={onSend} /></Providers>)
    const implement = await screen.findByTestId('flow-offer-choose-implement')
    await act(async () => { fireEvent.click(implement) })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Let's write the spec first and run Implement."))
    expect(calls.find((c) => c.url.includes('/messages/m1/intent'))!.body).toEqual({ kind: 'flow-offer', proposalIndex: 0, status: 'accepted', chosenMode: 'implement' })
    expect(await screen.findByTestId('flow-offer-stub-implement')).not.toHaveTextContent('recommended')
  })

  it('Flow opens the entry card and Start records chosenMode + flowId', async () => {
    current = null
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'Prototype it', recommended: 'implement' }} index={0} messageId="m1" conversationId="c1" projectId="p1" intents={null} isLatest isStreaming={false} /></Providers>)
    fireEvent.click(screen.getByTestId('flow-offer-choose-flow'))
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(calls.find((c) => c.url.includes('/intent'))?.body).toEqual({
      kind: 'flow-offer', proposalIndex: 0, status: 'accepted', chosenMode: 'flow', config: { flowId: 'f1' },
    }))
    expect(await screen.findByTestId('flow-offer-stub-flow')).toHaveTextContent('Flow in progress')
  })

  it('renders the frozen record (with the hand-off) from persisted intents', () => {
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'x', recommended: 'flow' }} index={0} messageId="m1" conversationId="c1" projectId="p1" isLatest={false} isStreaming={false}
      intents={[
        { kind: 'flow-offer', proposalIndex: 0, status: 'accepted', at: 't', chosenMode: 'flow', recommendedMode: 'flow', config: { flowId: 'f1' } },
        { kind: 'flow-hand-off', proposalIndex: 0, status: 'launched', at: 't', railIndex: 1 },
      ]} /></Providers>)
    expect(screen.getByTestId('flow-offer-stub-flow')).toHaveTextContent('Flow handed off to Rail 2')
  })

  it('the hand-off record links to its run card', () => {
    const focused = vi.fn()
    window.addEventListener('specrails:focus-pr-card', focused)
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'x', reason: 'r' }} index={0} messageId="m1" conversationId="c1" projectId="p1" isLatest={false} isStreaming={false}
      intents={[
        { kind: 'flow-offer', proposalIndex: 0, status: 'accepted', at: 't', chosenMode: 'flow', config: { flowId: 'f1' } },
        { kind: 'flow-hand-off', proposalIndex: 0, status: 'launched', at: 't', railIndex: 1, runIds: ['run-1'], prDeliveryId: 'delivery-1' },
      ]} /></Providers>)
    fireEvent.click(screen.getByTestId('flow-offer-stub-view-run'))
    expect((focused.mock.calls[0]![0] as CustomEvent).detail).toEqual({ prDeliveryId: 'delivery-1', runIds: ['run-1'], conversationId: 'c1' })
    window.removeEventListener('specrails:focus-pr-card', focused)
  })
})

describe('Flow words and marks', () => {
  it('names the steps and failures of Flow → Spec in the person\'s words (other loops: nothing)', () => {
    const t = i18n.getFixedT('en', 'agent')
    expect(describeFlowRun(t, { loopId: 'factory:flow-spec', stepId: 'derive', codes: [] })).toEqual({ step: 'Writing the spec from your changes', failure: 'Couldn’t write the spec from your changes' })
    expect(describeFlowRun(t, { loopId: 'factory:flow-spec', stepId: 'review-findings', codes: [] })?.step).toBe('Reviewing the change')
    expect(describeFlowRun(t, { loopId: 'factory:flow-spec', stepId: null, codes: ['push_failed'] })).toEqual({ step: 'Handing the result back', failure: 'Couldn’t hand the result back' })
    expect(describeFlowRun(t, { loopId: 'factory:flow-spec', stepId: 'mystery', codes: [] })?.step).toBeNull()
    expect(describeFlowRun(t, { loopId: 'factory:implement', stepId: 'derive', codes: [] })).toBeNull()
  })

  it('marks the missions in Flow with "In Flow", kept current by flow.state events', async () => {
    const conversations = [{ id: 'c1', pinned_project_id: 'p1' }, { id: 'c2', pinned_project_id: 'p1' }, { id: 'c3', pinned_project_id: null }]
    const { result } = renderHook(() => useFlowConversationMarks(conversations), { wrapper: Providers })
    await waitFor(() => expect([...result.current.keys()]).toEqual(['c1']))
    expect(result.current.get('c1')).toMatchObject({ label: 'In Flow' })
    expect(calls.filter((c) => c.url.endsWith('/flow/open'))).toHaveLength(1)
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c2', flowId: 'f2', flow: flow({ id: 'f2', conversationId: 'c2', state: 'paused' }) }))
    expect([...result.current.keys()].sort()).toEqual(['c1', 'c2'])
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'handed_off' }) }))
    expect([...result.current.keys()]).toEqual(['c2'])
  })
})
