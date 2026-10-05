import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, renderHook, within } from '@testing-library/react'

vi.mock('../../../providers/hooks/useProviderDetection', () => ({
  useProviderDetection: () => ({
    detected: ['claude', 'codex'],
    providers: { claude: { id: 'claude', displayName: 'Claude Code' }, codex: { id: 'codex', displayName: 'Codex CLI' } },
    loading: false,
  }),
}))
vi.mock('../../../loops/lib/loops-api', () => ({ loopsApi: { list: vi.fn(async () => []) } }))

import { AgentRailLaunchCard, FOCUS_PR_CARD_EVENT } from '../AgentRailLaunchCard'
import { AgentMessage } from '../AgentMessage'
import { useRailLaunchProposals } from '../useRailLaunchProposals'
import { recordLocalIntent, resetLocalIntents } from '../../../rails/lib/rail-launch-intents'
import type { RailLaunchProposal } from '../../../rails/lib/rail-launch-draft'
import type { AgentMessage as ApiAgentMessage, AgentMessageIntent } from '../../lib/agent-api'
import type { ProjectRepository } from '../../../projects/lib/project-repositories'
import { StrictMode } from 'react'
import { setActiveProjectId } from '../../../../lib/api'

vi.mock('../../../jobs/components/JobDetailModal', () => ({
  JobDetailModal: ({ jobId, projectId, onClose }: { jobId: string; projectId?: string; onClose: () => void }) => (
    <div data-testid="job-detail-modal">{jobId}@{projectId}<button data-testid="job-detail-modal-close" onClick={onClose}>close</button></div>
  ),
}))

const proposal = (over: Partial<RailLaunchProposal> = {}): RailLaunchProposal => ({
  version: 1, railIndex: 1, newRail: null, ticketIds: [12, 14], mode: 'implement', loopId: null,
  aiEngine: 'claude', model: 'opus', reasoningEffort: 'high', profileName: null, targetPrNumber: null,
  baseBranch: null, railName: null, rationale: 'both touch auth', ...over,
})

const railsPayload = {
  rails: [
    { railIndex: 0, ticketIds: [3], mode: 'implement', name: null },
    { railIndex: 1, ticketIds: [], mode: 'implement', name: 'Auth' },
  ],
  activeJobs: { '0': { jobId: 'j0', mode: 'implement' } },
  activeLoopRuns: {},
  prDeliveries: {},
}
const ticketsPayload = {
  tickets: [
    { id: 12, title: 'Login form', status: 'todo', labels: [] },
    { id: 14, title: 'Session refresh', status: 'todo', labels: [] },
    { id: 20, title: 'Spare', status: 'todo', labels: [] },
  ],
}

const primaryRepository: ProjectRepository = { id: 'primary-p1', projectId: 'p1', name: 'App', path: '/skills', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }
const apiRepository: ProjectRepository = { ...primaryRepository, id: 'api', name: 'API', path: '/api', isPrimary: false }
const extraRepository: ProjectRepository = { ...apiRepository, id: 'extra', name: 'Extra', path: '/extra', workspacePaths: ['/extra/ui', '/extra/service'] }

type Call = { url: string; init?: RequestInit }
let calls: Call[]
function mockFetch(overrides: Partial<Record<string, (init?: RequestInit) => { status: number; body: unknown }>> = {}) {
  calls = []
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    const key = Object.keys(overrides).find((k) => url.includes(k))
    if (key) {
      const r = overrides[key]!(init)
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response
    }
    if (url.endsWith('/rails') && (!init || !init.method)) return { ok: true, status: 200, json: async () => railsPayload } as Response
    if (url.endsWith('/tickets') && (!init || !init.method)) return { ok: true, status: 200, json: async () => ticketsPayload } as Response
    if (url.endsWith('/repositories')) return { ok: true, status: 200, json: async () => ({ repositories: [primaryRepository] }) } as Response
    if (url.includes('/profiles')) return { ok: true, status: 200, json: async () => ({ profiles: [{ name: 'fast', isDefault: false, updatedAt: 0 }] }) } as Response
    if (url.endsWith('/rails') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ rail: { railIndex: 2 } }) } as Response
    if (/\/rails\/\d+\/(tickets|name|engine|profile)$/.test(url)) return { ok: true, status: 200, json: async () => ({ rail: {} }) } as Response
    if (/\/rails\/\d+\/launch$/.test(url)) return { ok: true, status: 202, json: async () => ({ loopRunIds: ['run-1', 'run-2'], railIndex: 1, mode: 'implement', isolated: true }) } as Response
    if (url.includes('/intent')) return { ok: true, status: 200, json: async () => ({ message: { intents: [{ ...JSON.parse(String(init?.body)), at: '2026-09-18T00:00:00Z' }] } }) } as Response
    return { ok: true, status: 200, json: async () => ({}) } as Response
  })
}

const body = (c: Call) => JSON.parse(String(c.init?.body)) as Record<string, unknown>

beforeEach(() => {
  resetLocalIntents()
  mockFetch()
})

function renderCard(over: Partial<RailLaunchProposal> = {}, intent: AgentMessageIntent | null = null, projectId: string | null = 'p1') {
  return render(
    <AgentRailLaunchCard proposal={proposal(over)} proposalIndex={0} messageId="m1" conversationId="c1" projectId={projectId} intent={intent} />,
  )
}

describe('AgentRailLaunchCard', () => {
  it('shows saved historical assignments even in a single-repository project', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    expect(screen.getByRole('group', { name: 'Repositories for this launch' })).toHaveTextContent('App')
    expect(screen.getByTestId('rail-card-spec-scope-12')).toHaveTextContent('App')
    expect(screen.getByTestId('rail-card-spec-scope-14')).toHaveTextContent('App')
  })

  it('merges current spec requirements into a stale proposal and freezes the resolved launch selection', async () => {
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository] } }),
      '/tickets': () => ({ status: 200, body: { tickets: [{ ...ticketsPayload.tickets[0], repositoryIds: ['api'] }] } }),
    })
    renderCard({ ticketIds: [12], repositoryIds: ['primary-p1'] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    expect(screen.getByRole('checkbox', { name: 'App' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'API' })).toBeChecked()
    expect(screen.getByTestId('rail-card-spec-scope-12')).toHaveTextContent('API')
    fireEvent.click(screen.getByTestId('rail-card-play'))
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    expect(body(calls.find(c => c.url.endsWith('/launch'))!).repositoryIds).toEqual(['primary-p1', 'api'])
    expect(body(calls.find(c => c.url.includes('/intent'))!).config).toMatchObject({ repositoryIds: ['primary-p1', 'api'] })
  })

  it('blocks an omitted required repository, then saves a replacement spec scope without losing an extra target', async () => {
    const ticket = { ...ticketsPayload.tickets[0], repositoryIds: ['api'] }
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository, extraRepository] } }),
      '/tickets': init => ({ status: 200, body: init?.method === 'PATCH' ? { ticket: { ...ticket, repositoryIds: JSON.parse(String(init.body)).repositoryIds } } : { tickets: [ticket] } }),
    })
    renderCard({ ticketIds: [12], repositoryIds: ['api', 'extra'], workspaceSelection: { api: ['/api'], extra: ['/extra/ui'] } })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox', { name: 'API' }))
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    expect(screen.getByText(/Required repositories missing: API/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit repositories for #12' }))
    const editor = within(screen.getByTestId('rail-card-scope-editor'))
    fireEvent.click(editor.getByRole('checkbox', { name: 'App' }))
    fireEvent.click(editor.getByRole('checkbox', { name: 'API' }))
    expect(calls.some(c => c.init?.method === 'PATCH')).toBe(false)
    fireEvent.click(editor.getByRole('button', { name: 'Save repositories' }))
    await waitFor(() => expect(screen.queryByTestId('rail-card-scope-editor')).not.toBeInTheDocument())
    const save = calls.find(c => c.init?.method === 'PATCH')!
    expect(save.url).toContain('/api/projects/p1/tickets/12')
    expect(body(save)).toEqual({ repositoryIds: ['primary-p1'] })
    expect(screen.getByTestId('rail-card-spec-scope-12')).toHaveTextContent('App')
    expect(screen.getByRole('checkbox', { name: 'API' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Extra/ })).toBeChecked()
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
    fireEvent.click(screen.getByTestId('rail-card-play'))
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    expect(body(calls.find(c => c.url.endsWith('/launch'))!)).toMatchObject({ repositoryIds: ['extra', 'primary-p1'], workspaceSelection: { extra: ['/extra/ui'] } })
  })

  it('cancel discards a scope draft and never writes or launches', async () => {
    mockFetch({ '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository] } }) })
    renderCard({ ticketIds: [12] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Edit repositories for #12' }))
    fireEvent.click(within(screen.getByTestId('rail-card-scope-editor')).getByRole('checkbox', { name: 'API' }))
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('rail-card-spec-scope-12')).not.toHaveTextContent('API')
    expect(screen.getByRole('checkbox', { name: 'API' })).not.toBeChecked()
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
    expect(calls.some(c => c.init?.method === 'PATCH' || c.url.endsWith('/launch'))).toBe(false)
  })

  it('retains the saved scope and draft when its save fails', async () => {
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository] } }),
      '/tickets': init => init?.method === 'PATCH' ? { status: 409, body: { error: 'repository_in_use' } } : { status: 200, body: ticketsPayload },
    })
    renderCard({ ticketIds: [12] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Edit repositories for #12' }))
    fireEvent.click(within(screen.getByTestId('rail-card-scope-editor')).getByRole('checkbox', { name: 'API' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save repositories' }))
    await waitFor(() => expect(screen.getByText("Could not save the spec's repositories.")).toBeInTheDocument())
    expect(screen.getByText('repository_in_use')).toBeInTheDocument()
    expect(within(screen.getByTestId('rail-card-scope-editor')).getByRole('checkbox', { name: 'API' })).toBeChecked()
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    expect(calls.some(c => c.url.endsWith('/launch'))).toBe(false)
  })

  it('removes optional launch targets and their workspace selections without changing specs', async () => {
    mockFetch({ '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, extraRepository] } }) })
    renderCard({ ticketIds: [12], repositoryIds: ['primary-p1', 'extra'], workspaceSelection: { extra: ['/extra/ui'] } })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox', { name: /Extra/ }))
    expect(screen.queryByRole('checkbox', { name: '/extra/ui' })).not.toBeInTheDocument()
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
    fireEvent.click(screen.getByTestId('rail-card-play'))
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    const launch = body(calls.find(c => c.url.endsWith('/launch'))!)
    expect(launch).toMatchObject({ repositoryIds: ['primary-p1'] })
    expect(launch).not.toHaveProperty('workspaceSelection')
    expect(calls.some(c => c.init?.method === 'PATCH' && c.url.includes('/tickets/'))).toBe(false)
  })

  it('blocks before repository loading completes and fails closed when that request fails', async () => {
    let resolveRepositories!: (response: Response) => void
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/repositories') ? new Promise<Response>(resolve => { resolveRepositories = resolve }) : original(input, init))
    renderCard()
    await waitFor(() => expect(screen.getByText('#12')).toBeInTheDocument())
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    await act(async () => resolveRepositories({ ok: false, status: 503 } as Response))
    expect(screen.getByText(/Could not load the project's rails, specs or repositories/)).toBeInTheDocument()
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    expect(calls.some(c => c.url.endsWith('/launch'))).toBe(false)
  })

  it('keeps a missing target visible and blocks launch until scope is repaired', async () => {
    renderCard({ repositoryIds: ['removed-repo'] })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Unavailable: removed-repo' })).toBeInTheDocument())
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unavailable: removed-repo' }))
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
  })

  it('can add an optional repository to the launch without writing a spec', async () => {
    mockFetch({ '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository] } }) })
    renderCard({ ticketIds: [12] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox', { name: 'API' }))
    fireEvent.click(screen.getByTestId('rail-card-play'))
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    expect(body(calls.find(c => c.url.endsWith('/launch'))!).repositoryIds).toEqual(['primary-p1', 'api'])
    expect(calls.some(c => c.init?.method === 'PATCH' && c.url.includes('/tickets/'))).toBe(false)
  })

  it('reconciles adding and removing specs, preserving shared requirements and optional targets', async () => {
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository, extraRepository] } }),
      '/tickets': () => ({ status: 200, body: { tickets: [
        { ...ticketsPayload.tickets[0], repositoryIds: ['api'] },
        { ...ticketsPayload.tickets[1], repositoryIds: ['api', 'primary-p1'] },
      ] } }),
    })
    renderCard({ ticketIds: [12], repositoryIds: ['extra'], workspaceSelection: { api: ['/api'], extra: ['/extra/ui'] } })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.keyDown(screen.getByTestId('rail-card-add-spec'), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: '#14 Session refresh' }))
    expect(screen.getByRole('checkbox', { name: 'App' })).toBeChecked()
    fireEvent.click(screen.getByLabelText('Remove #12'))
    expect(screen.getByRole('checkbox', { name: 'API' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Extra/ })).toBeChecked()
    expect(screen.getByTestId('rail-card-spec-scope-14')).toHaveTextContent('API · App')
    fireEvent.click(screen.getByLabelText('Remove #14'))
    expect(screen.getByRole('checkbox', { name: 'API' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Extra/ })).toBeChecked()
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
  })

  it('does not drop a repository still assigned to a sibling spec after saving a narrower scope', async () => {
    const tickets = [
      { ...ticketsPayload.tickets[0], repositoryIds: ['api'] },
      { ...ticketsPayload.tickets[1], repositoryIds: ['api'] },
    ]
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository] } }),
      '/tickets': init => ({ status: 200, body: init?.method === 'PATCH' ? { ticket: { ...tickets[0], repositoryIds: ['primary-p1'] } } : { tickets } }),
    })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Edit repositories for #12' }))
    const editor = within(screen.getByTestId('rail-card-scope-editor'))
    fireEvent.click(editor.getByRole('checkbox', { name: 'App' }))
    fireEvent.click(editor.getByRole('checkbox', { name: 'API' }))
    fireEvent.click(editor.getByRole('button', { name: 'Save repositories' }))
    await waitFor(() => expect(screen.queryByTestId('rail-card-scope-editor')).not.toBeInTheDocument())
    expect(screen.getByRole('checkbox', { name: 'API' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'App' })).toBeChecked()
    expect(screen.getByTestId('rail-card-spec-scope-14')).toHaveTextContent('API')
  })

  it('updates assignments and requirements on Refresh while retaining extra launch targets', async () => {
    let scope = ['api']
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository, extraRepository] } }),
      '/tickets': () => ({ status: 200, body: { tickets: [{ ...ticketsPayload.tickets[0], repositoryIds: scope }] } }),
    })
    renderCard({ ticketIds: [12], repositoryIds: ['extra'] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    scope = ['primary-p1']
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByTestId('rail-card-spec-scope-12')).toHaveTextContent('App'))
    expect(screen.getByRole('checkbox', { name: 'API' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Extra/ })).toBeChecked()
  })

  it('retries failed repository loading and still refuses offline implementation targets', async () => {
    let status = 503
    mockFetch({ '/repositories': () => ({ status, body: { repositories: [primaryRepository, { ...apiRepository, available: false }] } }) })
    renderCard({ repositoryIds: ['api'] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry loading' })).toBeInTheDocument())
    status = 200
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))
    await waitFor(() => expect(screen.getByText(/unavailable for implementation: API/)).toBeInTheDocument())
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unavailable: API' }))
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
  })

  it('saves scope to the pinned project even if a different project is globally active', async () => {
    setActiveProjectId('other-project')
    mockFetch({
      '/repositories': () => ({ status: 200, body: { repositories: [primaryRepository, apiRepository] } }),
      '/tickets': init => ({ status: 200, body: init?.method === 'PATCH' ? { ticket: { ...ticketsPayload.tickets[0], repositoryIds: ['primary-p1', 'api'] } } : ticketsPayload }),
    })
    renderCard({ ticketIds: [12] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Edit repositories for #12' }))
    fireEvent.click(within(screen.getByTestId('rail-card-scope-editor')).getByRole('checkbox', { name: 'API' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save repositories' }))
    await waitFor(() => expect(screen.queryByTestId('rail-card-scope-editor')).not.toBeInTheDocument())
    expect(calls.filter(c => c.url.includes('/api/projects/')).every(c => c.url.includes('/api/projects/p1/'))).toBe(true)
  })

  it('blocks a switched project until its own repository snapshot loads', async () => {
    let resolveRepositories!: (response: Response) => void
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/p2/repositories') ? new Promise<Response>(resolve => { resolveRepositories = resolve }) : original(input, init))
    const { rerender } = renderCard({ ticketIds: [12] })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    rerender(<AgentRailLaunchCard proposal={proposal({ ticketIds: [12] })} proposalIndex={0} messageId="m1" conversationId="c1" projectId="p2" intent={null} />)
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    expect(screen.queryByTestId('rail-card-repositories')).not.toBeInTheDocument()
    await act(async () => resolveRepositories({ ok: true, json: async () => ({ repositories: [{ ...primaryRepository, id: 'primary-p2', projectId: 'p2', name: 'Project Two' }] }) } as Response))
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    expect(screen.getByTestId('rail-card-spec-scope-12')).toHaveTextContent('Project Two')
    expect(screen.queryByText('App')).not.toBeInTheDocument()
  })

  it('clears Launching after a rejected launch even under Strict Mode and remains editable', async () => {
    mockFetch({ '/launch': () => ({ status: 400, body: { error: 'repository_scope_incomplete', detail: 'Spec scope changed concurrently.' } }) })
    render(<StrictMode><AgentRailLaunchCard proposal={proposal()} proposalIndex={0} messageId="m1" conversationId="c1" projectId="p1" intent={null} /></StrictMode>)
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    fireEvent.click(screen.getByTestId('rail-card-play'))
    await waitFor(() => expect(screen.getByText('Spec scope changed concurrently.')).toBeInTheDocument())
    expect(screen.getByTestId('rail-card-play')).toHaveTextContent('Play')
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit repositories for #12' })).toBeEnabled()
  })

  it('renders the proposal pre-filled and reconciled against live rails/tickets', async () => {
    renderCard()
    expect(screen.getByTestId('agent-rail-launch-card')).toBeInTheDocument()
    expect(screen.getByText('both touch auth')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument())
    expect(screen.getByText('#12 Login form')).toBeInTheDocument()
    expect(screen.getByText('#14 Session refresh')).toBeInTheDocument()
    // Rail 2 (index 1, named Auth) is the proposed one and is free.
    expect(screen.getByTestId('rail-card-rail')).toHaveTextContent('Rail 2 · Auth')
    expect(screen.getByTestId('rail-card-engine')).toHaveTextContent('Claude Code')
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
  })

  it('warns when the proposed rail is busy and offers the free one', async () => {
    renderCard({ railIndex: 0 })
    await waitFor(() => expect(screen.getByText(/Rail 1 is running/)).toBeInTheDocument())
    fireEvent.click(screen.getByText('Use Rail 2'))
    await waitFor(() => expect(screen.getByTestId('rail-card-rail')).toHaveTextContent('Rail 2 · Auth'))
  })

  it('drops specs that no longer exist and blocks Play with zero valid specs', async () => {
    renderCard({ ticketIds: [99] })
    await waitFor(() => expect(screen.getByText(/Not in this project any more: #99/)).toBeInTheDocument())
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    expect(screen.getByText('Add at least one spec to launch.')).toBeInTheDocument()
  })

  it('preserves agent-selected workspace paths in the launch and frozen intent', async () => {
    renderCard({ repositoryIds: ['primary-p1'], workspaceSelection: { 'primary-p1': ['/skills/studio'] } })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    expect(body(calls.find(c => c.url.endsWith('/rails/1/launch'))!)).toMatchObject({ repositoryIds: ['primary-p1'], workspaceSelection: { 'primary-p1': ['/skills/studio'] } })
  })

  it('Play: edits win, launches with the mission origin, then freezes as launched', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    // Remove #14, rename the rail, set a base branch.
    fireEvent.click(screen.getByLabelText('Remove #14'))
    fireEvent.change(screen.getByTestId('rail-card-name'), { target: { value: 'Auth v2' } })
    fireEvent.change(screen.getByTestId('rail-card-base-branch'), { target: { value: 'develop' } })
    fireEvent.change(screen.getByTestId('rail-card-target-pr'), { target: { value: '42' } })
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())

    const name = calls.find((c) => c.url.endsWith('/rails/1/name'))!
    expect(body(name)).toEqual({ name: 'Auth v2' })
    const tickets = calls.find((c) => c.url.endsWith('/rails/1/tickets'))!
    expect(body(tickets)).toMatchObject({ ticketIds: [12], mode: 'implement', aiEngine: 'claude' })
    const launch = calls.find((c) => c.url.endsWith('/rails/1/launch'))!
    expect(body(launch)).toMatchObject({
      mode: 'implement', loopId: 'factory:implement', aiEngine: 'claude', model: 'opus', reasoning_effort: 'high',
      originConversationId: 'c1', originSurface: 'agent-chat', baseBranch: 'develop', targetPrNumber: 42,
    })
    const intent = calls.find((c) => c.url.includes('/messages/m1/intent'))!
    expect(intent.init?.method).toBe('PATCH')
    expect(body(intent)).toMatchObject({ kind: 'rail-launch', proposalIndex: 0, status: 'launched', railIndex: 1, runIds: ['run-1', 'run-2'], prDeliveryId: null })
    expect(screen.getByTestId('agent-rail-launch-stub-launched')).toHaveTextContent('Launched → Rail 2')

    // "Go to card" brings the PR card into view; "View run" opens the run's live log.
    const listener = vi.fn()
    window.addEventListener(FOCUS_PR_CARD_EVENT, listener)
    fireEvent.click(screen.getByTestId('agent-rail-launch-focus-card'))
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ prDeliveryId: null, runIds: ['run-1', 'run-2'] })
    expect(screen.queryByTestId('job-detail-modal')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-rail-launch-view-run'))
    await waitFor(() => expect(screen.getByTestId('job-detail-modal')).toHaveTextContent('run-1@p1'))
    fireEvent.click(screen.getByTestId('job-detail-modal-close'))
    await waitFor(() => expect(screen.queryByTestId('job-detail-modal')).toBeNull())
  })

  it('retains historical Roles launches without offering Roles in the selector', async () => {
    renderCard({ aiEngine: 'roles', model: 'opus', reasoningEffort: 'high' })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    expect(screen.getByTestId('rail-card-engine')).not.toHaveTextContent('Roles')
    expect(screen.queryByTestId('rail-card-model')).toBeNull()
    expect(screen.queryByTestId('rail-card-effort')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    const launch = body(calls.find((c) => c.url.endsWith('/rails/1/launch'))!) as Record<string, unknown>
    expect(launch).toMatchObject({ aiEngine: 'roles', mode: 'implement' })
    expect(launch).not.toHaveProperty('model')
    expect(launch).not.toHaveProperty('reasoning_effort')
  })

  it('renders a PR follow-up scope block and sends the follow-up on Play, never a spec edit', async () => {
    const followUp = {
      version: 1 as const, kind: 'pr-review-fix' as const,
      comments: [
        { id: 'c1', source: 'user-paste' as const, author: 'reviewer', path: 'lib/api.ts', line: null, body: 'send Idempotency-Key per pair' },
        { id: 'c2', source: 'github' as const, author: null, path: 'lib/promoteRun.ts', line: 40, body: 'unknown for ambiguous failures' },
      ],
      scope: { objective: 'Resolve only the two comments', requiredOutcomes: [], excludedChanges: ['Lesson selection UI'], verification: ['Distinct keys across pairs'] },
      openspecChangeName: 'fix-selected-pr-comments',
    }
    renderCard({ targetPrNumber: 51, followUp })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    const block = screen.getByTestId('rail-card-follow-up')
    expect(block).toHaveTextContent('Resolve 2 review comment(s) on the PR')
    expect(block).toHaveTextContent('lib/api.ts')
    expect(block).toHaveTextContent('lib/promoteRun.ts:40')
    expect(block).toHaveTextContent('Lesson selection UI')
    expect(block).toHaveTextContent('from GitHub')
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    const launch = body(calls.find((c) => c.url.endsWith('/rails/1/launch'))!) as Record<string, unknown>
    expect(launch).toMatchObject({ targetPrNumber: 51, followUp: { openspecChangeName: 'fix-selected-pr-comments', comments: [{ id: 'c1' }, { id: 'c2', line: 40 }] } })
    expect(calls.some((c) => /\/tickets\/\d+/.test(c.url) && c.init?.method && c.init.method !== 'GET')).toBe(false)
  })

  it('surfaces the open addenda the launch will brief the run with (applied ones excluded)', async () => {
    const addendum = (id: string, status: 'open' | 'applied', title: string) => ({
      id, version: 1, kind: 'change-request', title, body: 'b', status, hash: 'h', created_at: 'x', updated_at: 'x',
      created_by: 'user', origin_conversation_id: null, run_id: null, applied_at: null,
    })
    mockFetch({
      '/api/projects/p1/rails': (init) => ({ status: init?.method === 'POST' ? 202 : 200, body: init?.method === 'POST' ? { loopRunIds: ['next-run'] } : { ...railsPayload, rails: [
        { railIndex: 0, ticketIds: [3], mode: 'implement', availability: 'free' },
        { railIndex: 1, ticketIds: [12, 14], mode: 'implement', availability: 'pending_decision' },
      ] } }),
      '/tickets': () => ({ status: 200, body: { tickets: [
        { id: 12, title: 'Login form', status: 'todo', labels: [], addenda: [addendum('a1', 'open', 'Use idempotency keys'), addendum('a0', 'applied', 'Old')] },
        { id: 14, title: 'Session refresh', status: 'todo', labels: [], addenda: [addendum('a2', 'open', 'Classify 502 as unknown')] },
      ] } }),
    })
    renderCard({ railIndex: null })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    const note = screen.getByTestId('rail-card-addenda')
    expect(note).toHaveTextContent('2 open addenda ride into this launch:')
    expect(screen.getByTestId('rail-card-rail')).toHaveTextContent('Rail 2')
    expect(screen.queryByText(/Use Rail 1/)).not.toBeInTheDocument()
    expect(screen.getByTestId('rail-card-loop')).toHaveTextContent('Implement')
    expect(screen.getByTestId('rail-card-loop')).toBeEnabled()
    fireEvent.click(screen.getByTestId('rail-card-play'))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/rails/1/launch'))).toBe(true))
    expect(body(calls.find((c) => c.url.endsWith('/rails/1/launch'))!)).toMatchObject({ mode: 'implement', loopId: 'factory:implement' })
    expect(note).toHaveTextContent('#12 Use idempotency keys')
    expect(note).toHaveTextContent('#14 Classify 502 as unknown')
    expect(note).not.toHaveTextContent('Old')
  })

  it('creates a new rail first when the proposal asks for one', async () => {
    renderCard({ railIndex: null, newRail: { name: 'Fresh' } })
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    expect(screen.getByTestId('rail-card-rail')).toHaveTextContent('New rail')
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    const create = calls.find((c) => c.url.endsWith('/rails') && c.init?.method === 'POST')!
    expect(body(create)).toEqual({ name: 'Fresh' })
    expect(calls.some((c) => c.url.endsWith('/rails/2/launch'))).toBe(true)
  })

  it('renders a 409 inline and stays editable', async () => {
    mockFetch({ '/rails/1/launch': () => ({ status: 409, body: { error: 'tickets_in_flight', detail: 'spec #12 is running', action: 'wait for it' } }) })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('rail-card-error')).toBeInTheDocument())
    expect(screen.getByTestId('rail-card-error')).toHaveTextContent('One of these specs is already running on another rail.')
    expect(screen.getByTestId('rail-card-error')).toHaveTextContent('spec #12 is running')
    expect(screen.getByTestId('rail-card-error')).toHaveTextContent('wait for it')
    expect(screen.getByTestId('rail-card-play')).toBeEnabled()
    expect(calls.some((c) => c.url.includes('/intent'))).toBe(false)
  })

  it('Dismiss persists a dismissed intent', async () => {
    renderCard()
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-dismiss')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-dismissed')).toBeInTheDocument())
    const intent = calls.find((c) => c.url.includes('/intent'))!
    expect(body(intent)).toMatchObject({ status: 'dismissed', proposalIndex: 0 })
  })

  it('renders frozen stubs from a persisted intent without fetching', () => {
    renderCard({}, { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'x', railIndex: 3, runIds: ['r'] })
    expect(screen.getByTestId('agent-rail-launch-stub-launched')).toHaveTextContent('Launched → Rail 4')
    expect(calls).toHaveLength(0)
  })

  it('blocks Play when the mission has no project', () => {
    renderCard({}, null, null)
    expect(screen.getByTestId('rail-card-play')).toBeDisabled()
    expect(screen.getByText('This mission is not pinned to a project.')).toBeInTheDocument()
  })
})

describe('AgentMessage rail-launch extraction', () => {
  const fence = (obj: unknown) => '```rail-launch\n' + JSON.stringify(obj) + '\n```'

  it('strips the fence and renders the card below the prose', async () => {
    render(<AgentMessage role="assistant" content={'Plan:\n' + fence({ ticketIds: [12], railIndex: 1 })} messageId="m1" conversationId="c1" refsProjectId="p1" />)
    expect(screen.getByText('Plan:')).toBeInTheDocument()
    expect(screen.queryByText(/rail-launch/)).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-rail-launch-card')).toBeInTheDocument()
  })

  it('shows a pending chip while streaming and an unreadable note when settled', () => {
    const { rerender } = render(<AgentMessage role="assistant" content={'Plan:\n```rail-launch\n{"ticketIds": [1'} streaming messageId="m1" conversationId="c1" refsProjectId="p1" />)
    expect(screen.getByTestId('agent-rail-launch-pending')).toBeInTheDocument()
    expect(screen.queryByText(/ticketIds/)).not.toBeInTheDocument()
    rerender(<AgentMessage role="assistant" content={'Plan:\n```rail-launch\n{"ticketIds": [1'} messageId="m1" conversationId="c1" refsProjectId="p1" />)
    expect(screen.getByTestId('agent-rail-launch-unreadable')).toHaveTextContent("The agent's launch proposal could not be read.")
  })

  it('hides an undecided proposal when it is pinned elsewhere, but still shows a decided one', () => {
    const content = fence({ ticketIds: [12] })
    const { rerender } = render(<AgentMessage role="assistant" content={content} messageId="m1" conversationId="c1" refsProjectId="p1" railProposalsPinned />)
    expect(screen.queryByTestId('agent-rail-launch-card')).not.toBeInTheDocument()
    rerender(<AgentMessage role="assistant" content={content} messageId="m1" conversationId="c1" refsProjectId="p1" railProposalsPinned intents={[{ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed', at: 'x' }]} />)
    expect(screen.getByTestId('agent-rail-launch-stub-dismissed')).toBeInTheDocument()
  })
})

describe('useRailLaunchProposals', () => {
  const msg = (id: string, content: string, over: Partial<ApiAgentMessage> = {}): ApiAgentMessage => ({ id, conversation_id: 'c1', role: 'assistant', content, created_at: '', ...over })
  const fence = (obj: unknown) => '```rail-launch\n' + JSON.stringify(obj) + '\n```'

  it('lists undecided proposals in message order and honours persisted + local intents', () => {
    const messages = [
      msg('a', 'x ' + fence({ ticketIds: [1] })),
      msg('b', 'plain'),
      msg('c', fence({ ticketIds: [2] }) + fence({ ticketIds: [3] }), { intents: [{ kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'x' }] }),
      msg('d', fence({ ticketIds: [4] }), { role: 'user' }),
    ]
    const { result, rerender } = renderHook(({ m }) => useRailLaunchProposals(m), { initialProps: { m: messages } })
    expect(result.current.pinned.map((p) => [p.messageId, p.proposalIndex, p.proposal.ticketIds])).toEqual([['a', 0, [1]], ['c', 1, [3]]])
    expect([...result.current.pinnedMessageIds]).toEqual(['a', 'c'])
    act(() => recordLocalIntent('a', { kind: 'rail-launch', proposalIndex: 0, status: 'dismissed', at: 'x' }))
    rerender({ m: messages })
    expect(result.current.pinned.map((p) => p.messageId)).toEqual(['c'])
  })
})
