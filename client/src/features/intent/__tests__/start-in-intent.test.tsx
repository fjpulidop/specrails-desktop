import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('../../../hooks/useDesktop', async (importOriginal) => ({ ...(await importOriginal<object>()), useDesktop: () => ({ activeProjectId: 'p1', projects: [{ id: 'p1', name: 'App', provider: 'claude' }] }) }))
const chat = vi.hoisted(() => ({ selectConversation: vi.fn(async () => {}), open: vi.fn(), refreshConversations: vi.fn(async () => {}), active: null }))
vi.mock('../../missions/context/AgentChatContext', async (importOriginal) => ({ ...(await importOriginal<object>()), useAgentChat: () => chat }))
const detail = vi.hoisted(() => ({ openTicketDetail: vi.fn() }))
vi.mock('../../specs/context/TicketDetailModalContext', async (importOriginal) => ({ ...(await importOriginal<object>()), useTicketDetailModal: () => detail }))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { IntentProvider } from '../context/IntentContext'
import { IntentRailLaunchAlternative, StartInFlowButton, StartInFlowMenuItem, specSuggestedRepository, startInFlowBlock, type StartInFlowSpec } from '../components/StartInIntent'

const ws = { registerHandler: vi.fn(), unregisterHandler: vi.fn(), connectionStatus: 'connected' as const }
function Providers({ children }: { children: ReactNode }) {
  return <SharedWebSocketContext.Provider value={ws}><IntentProvider>{children}</IntentProvider></SharedWebSocketContext.Provider>
}
const respond = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
const spec = (over: Partial<StartInFlowSpec> = {}): StartInFlowSpec => ({ id: 12, title: 'Calmer onboarding', status: 'todo', metadata: {}, origin_conversation_id: 'c-origin', ...over })

let posts: Array<{ url: string; body: Record<string, unknown> }>
let flowResponses: Array<() => Response>
let repositories: unknown[]
const flowPosts = () => posts.filter((post) => post.url.endsWith('/flow'))
/** One Git repository: the entry card shows no picker and the server runs the Intent there. */
const ONE_REPOSITORY = [{ id: 'repo-app', name: 'app', path: '/w/app', isPrimary: true, kind: 'git' }]

beforeEach(() => {
  vi.clearAllMocks()
  posts = []
  flowResponses = []
  repositories = ONE_REPOSITORY
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (init?.method === 'POST' || init?.method === 'PATCH') posts.push({ url, body })
    if (url.endsWith('/api/projects/p1/repositories')) return respond(200, { repositories })
    if (url.endsWith('/flow/availability')) return respond(200, { available: true, reason: 'ok', missing: [] })
    if (url.endsWith('/api/projects/p1/flow') && init?.method === 'POST') {
      const next = flowResponses.shift()
      return next ? next() : respond(201, { flow: { id: 'f1', conversationId: body.conversationId, ticketId: 12, state: 'active', branch: 'feat/12-calmer-onboarding', specOrigin: 'existing' } })
    }
    if (url.endsWith('/conversations') && init?.method === 'POST') return respond(201, { conversation: { id: 'c-new', pinned_project_id: 'p1' } })
    if (url.includes('/conversations/c-new') && init?.method === 'PATCH') return respond(200, { conversation: { id: 'c-new' } })
    return respond(200, {})
  }) as unknown as typeof fetch
})

/** Open the header door and wait for its entry card to be ready to start. */
async function openEntry() {
  const button = screen.getByTestId('spec-start-in-flow')
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  const dialog = await screen.findByTestId('flow-start-entry-dialog')
  await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
  return dialog
}

describe('startInFlowBlock', () => {
  it('explains every case where a spec cannot start in Intent', () => {
    const base = { projectId: 'p1', available: true, rail: null }
    expect(startInFlowBlock(spec(), base)).toBeNull()
    expect(startInFlowBlock(spec(), { ...base, projectId: null })).toBe('noProject')
    expect(startInFlowBlock(spec({ metadata: { flow: { state: 'paused' } } }), base)).toBe('inFlow')
    expect(startInFlowBlock(spec({ metadata: { flow: { state: 'delivered' } } }), base)).toBeNull()
    expect(startInFlowBlock(spec({ status: 'done' }), base)).toBe('closed')
    expect(startInFlowBlock(spec(), { ...base, rail: { running: true } })).toBe('running')
    expect(startInFlowBlock(spec(), { ...base, rail: { running: false } })).toBe('onRail')
    expect(startInFlowBlock(spec(), { ...base, available: null })).toBe('loading')
    expect(startInFlowBlock(spec(), { ...base, available: false })).toBe('unavailable')
  })

  it('preselects the one repository a spec names, never a guess among several', () => {
    expect(specSuggestedRepository({ repositoryIds: ['repo-api'] })).toBe('repo-api')
    expect(specSuggestedRepository({ repositoryIds: ['repo-api', 'repo-app'] })).toBeNull()
    expect(specSuggestedRepository({})).toBeNull()
  })
})

describe('Explore with the agent from the spec detail (header door)', () => {
  it('opens the entry confirmation first: nothing starts on the bare click', async () => {
    render(<Providers><StartInFlowButton spec={spec({ intent: { problem: 'Setup asks for a key too early', outcome: 'Finish setup in 2 minutes', affects: [], signals: [], constraints: [], questions: [] } })} rail={null} /></Providers>)
    const button = screen.getByTestId('spec-start-in-flow')
    expect(button).toHaveTextContent('Explore with the agent')
    // A11y: the visible text is the name; no aria-label override, no aria-disabled.
    expect(button).not.toHaveAttribute('aria-label')
    expect(button).not.toHaveAttribute('aria-disabled')
    const dialog = await openEntry()
    expect(dialog).toHaveTextContent('Spec #12')
    expect(dialog).toHaveTextContent('Calmer onboarding')
    expect(screen.getByTestId('flow-entry-spec-summary')).toHaveTextContent('Setup asks for a key too early')
    expect(dialog).toHaveTextContent('Claude')
    expect(flowPosts()).toEqual([])
    expect(chat.open).not.toHaveBeenCalled()
  })

  it('Start begins the Intent in the spec\'s own mission, brings it to the front and says where', async () => {
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    await openEntry()
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c-origin', idea: '', ticketId: 12 })
    expect(chat.selectConversation).toHaveBeenCalledWith('c-origin')
    expect(toast.success).toHaveBeenCalledWith('Exploring spec #12 on feat/12-calmer-onboarding', expect.objectContaining({ action: expect.objectContaining({ label: 'Open the Intent mission' }) }))
    await waitFor(() => expect(screen.queryByTestId('flow-start-entry-dialog')).not.toBeInTheDocument())
  })

  it('Cancel closes the confirmation and starts nothing', async () => {
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    await openEntry()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('flow-start-entry-dialog')).not.toBeInTheDocument())
    expect(flowPosts()).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('opens a new mission (titled after the spec) when the spec\'s mission cannot take the Intent', async () => {
    flowResponses.push(() => respond(409, { error: 'flow_already_open', detail: 'open' }))
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    await openEntry()
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(chat.selectConversation).toHaveBeenCalledWith('c-new'))
    expect(posts.find((post) => post.url.endsWith('/conversations'))!.body).toEqual({ pinnedProjectId: 'p1' })
    expect(posts.find((post) => post.url.endsWith('/conversations/c-new'))!.body).toEqual({ title: 'Calmer onboarding' })
    expect(flowPosts().map((post) => post.body.conversationId)).toEqual(['c-origin', 'c-new'])
  })

  it('keeps the confirmation open and says why when the server refuses', async () => {
    flowResponses.push(() => respond(409, { error: 'spec_running', detail: 'Spec #12 is running on Rail 2' }))
    render(<Providers><StartInFlowButton spec={spec({ origin_conversation_id: null })} rail={null} /></Providers>)
    await openEntry()
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    expect(await screen.findByTestId('flow-entry-error')).toHaveTextContent('running on a rail')
    expect(screen.getByTestId('flow-start-entry-dialog')).toBeInTheDocument()
    expect(chat.open).not.toHaveBeenCalled()
  })

  it('says why it cannot start (one reason, inside the button)', async () => {
    render(<Providers><StartInFlowButton spec={spec()} rail={{ running: false }} /></Providers>)
    const button = screen.getByTestId('spec-start-in-flow')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Explore with the agent (On a rail: take it off the rail first)')
    expect(button.querySelectorAll('.sr-only')).toHaveLength(1)
    expect(button).toHaveAttribute('title', 'On a rail: take it off the rail first')
  })

  it('offers "Open the Intent mission" instead of a greyed Start while the spec is in Intent', async () => {
    render(<Providers><StartInFlowButton spec={spec({ metadata: { flow: { state: 'active', conversationId: 'c-flow', flowId: 'f9' } } })} rail={null} /></Providers>)
    expect(screen.queryByTestId('spec-start-in-flow')).not.toBeInTheDocument()
    const open = screen.getByTestId('spec-open-flow-mission')
    expect(open).toHaveTextContent('Open the Intent mission')
    expect(open).toBeEnabled()
    await act(async () => { fireEvent.click(open) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(chat.selectConversation).toHaveBeenCalledWith('c-flow')
    expect(flowPosts()).toEqual([])
  })
})

describe('Explore with the agent from the card context menu', () => {
  it('closes the menu, opens the spec detail, and the detail shows the entry at once', async () => {
    const onDone = vi.fn()
    render(<Providers><StartInFlowMenuItem spec={spec()} rail={null} onDone={onDone} /></Providers>)
    const item = screen.getByTestId('spec-menu-start-in-flow')
    await waitFor(() => expect(item).toBeEnabled())
    expect(item).toHaveTextContent('Explore with the agent')
    fireEvent.click(item)
    expect(onDone).toHaveBeenCalled()
    expect(detail.openTicketDetail).toHaveBeenCalledWith(12)
    expect(flowPosts()).toEqual([])
    // The spec detail mounts its header door for that spec: the entry opens without another click.
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    expect(await screen.findByTestId('flow-start-entry-dialog')).toBeInTheDocument()
  })

  it('says why it cannot start', () => {
    render(<Providers><StartInFlowMenuItem spec={spec()} rail={{ running: false }} onDone={vi.fn()} /></Providers>)
    const item = screen.getByTestId('spec-menu-start-in-flow')
    expect(item).toBeDisabled()
    expect(item).toHaveTextContent('On a rail: take it off the rail first')
  })

  it('jumps to the mission holding the Intent when the spec is already in Intent', async () => {
    const onDone = vi.fn()
    render(<Providers><StartInFlowMenuItem spec={spec({ metadata: { flow: { state: 'paused', conversationId: 'c-flow' } } })} rail={null} onDone={onDone} /></Providers>)
    const item = screen.getByTestId('spec-menu-start-in-flow')
    expect(item).toHaveTextContent('Open the Intent mission')
    await act(async () => { fireEvent.click(item) })
    expect(onDone).toHaveBeenCalled()
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(chat.selectConversation).toHaveBeenCalledWith('c-flow')
    expect(detail.openTicketDetail).not.toHaveBeenCalled()
  })
})

describe('Explore with the agent in a project with several Git repositories', () => {
  const several = () => [
    { id: 'repo-app', name: 'app', path: '/w/app', isPrimary: true, kind: 'git' },
    { id: 'repo-api', name: 'api', path: '/w/api', isPrimary: false, kind: 'git' },
    { id: 'repo-docs', name: 'docs', path: '/w/docs', isPrimary: false, kind: 'folder' },
  ]

  it('the entry shows where the Intent runs (Git members only) and starts there', async () => {
    repositories = several()
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    await openEntry()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('data-testid'))).toEqual(['flow-entry-repository-repo-app', 'flow-entry-repository-repo-api'])
    fireEvent.click(screen.getByTestId('flow-entry-repository-repo-api'))
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c-origin', idea: '', ticketId: 12, repositoryId: 'repo-api' })
  })

  it('preselects the one repository the spec names', async () => {
    repositories = several()
    render(<Providers><StartInFlowButton spec={spec({ repositoryIds: ['repo-api'] })} rail={null} /></Providers>)
    await openEntry()
    expect(screen.getByTestId('flow-entry-repository-repo-api')).toHaveAttribute('aria-checked', 'true')
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c-origin', idea: '', ticketId: 12, repositoryId: 'repo-api' })
  })
})

describe('the rail-launch card\'s Intent path', () => {
  it('shows the entry in place and starts the card\'s one spec in THIS mission', async () => {
    const onChosen = vi.fn()
    render(<Providers><IntentRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} ticketTitle="Calmer onboarding" disabled={false} onChosen={onChosen} /></Providers>)
    const button = screen.getByTestId('rail-card-start-in-flow')
    expect(button).toHaveTextContent('Explore with the agent')
    fireEvent.click(button)
    const entry = await screen.findByTestId('rail-card-flow-entry')
    expect(entry).toHaveTextContent('Spec #12')
    expect(flowPosts()).toEqual([])
    expect(onChosen).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(onChosen).toHaveBeenCalled())
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c1', idea: '', ticketId: 12 })
    expect(toast.success).toHaveBeenCalledWith('Exploring spec #12 on feat/12-calmer-onboarding')
  })

  it('offers the repository choice in place in a project with several Git repositories', async () => {
    repositories = [
      { id: 'repo-app', name: 'app', path: '/w/app', isPrimary: true, kind: 'git' },
      { id: 'repo-api', name: 'api', path: '/w/api', isPrimary: false, kind: 'git' },
    ]
    const onChosen = vi.fn()
    render(<Providers><IntentRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} ticketTitle="Calmer onboarding" ticketRepositoryIds={['repo-api']} disabled={false} onChosen={onChosen} /></Providers>)
    fireEvent.click(screen.getByTestId('rail-card-start-in-flow'))
    await screen.findByTestId('rail-card-flow-entry')
    await waitFor(() => expect(screen.getByTestId('flow-entry-repository-repo-api')).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(screen.getByTestId('flow-entry-repository-repo-app'))
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(onChosen).toHaveBeenCalled())
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c1', idea: '', ticketId: 12, repositoryId: 'repo-app' })
  })

  it('Cancel keeps the card and starts nothing', async () => {
    const onChosen = vi.fn()
    render(<Providers><IntentRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} disabled={false} onChosen={onChosen} /></Providers>)
    fireEvent.click(screen.getByTestId('rail-card-start-in-flow'))
    await screen.findByTestId('rail-card-flow-entry')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByTestId('rail-card-start-in-flow')).toBeEnabled())
    expect(flowPosts()).toEqual([])
    expect(onChosen).not.toHaveBeenCalled()
  })

  it('keeps the entry when the server refuses, saying why', async () => {
    flowResponses.push(() => respond(409, { error: 'spec_in_flow' }))
    const onChosen = vi.fn()
    render(<Providers><IntentRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} disabled={false} onChosen={onChosen} /></Providers>)
    fireEvent.click(screen.getByTestId('rail-card-start-in-flow'))
    await screen.findByTestId('rail-card-flow-entry')
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    expect(await screen.findByTestId('flow-entry-error')).toHaveTextContent('already in Intent')
    expect(onChosen).not.toHaveBeenCalled()
  })
})
