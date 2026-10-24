import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('../../../hooks/useDesktop', async (importOriginal) => ({ ...(await importOriginal<object>()), useDesktop: () => ({ activeProjectId: 'p1', projects: [] }) }))
const chat = vi.hoisted(() => ({ selectConversation: vi.fn(async () => {}), open: vi.fn(), refreshConversations: vi.fn(async () => {}) }))
vi.mock('../../missions/context/AgentChatContext', async (importOriginal) => ({ ...(await importOriginal<object>()), useAgentChat: () => chat }))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { FlowProvider } from '../context/FlowContext'
import { FlowRepositoryPromptProvider } from '../components/FlowRepositoryPrompt'
import { FlowRailLaunchAlternative, StartInFlowButton, StartInFlowMenuItem, startInFlowBlock, type StartInFlowSpec } from '../components/StartInFlow'

const ws = { registerHandler: vi.fn(), unregisterHandler: vi.fn(), connectionStatus: 'connected' as const }
function Providers({ children }: { children: ReactNode }) {
  return <SharedWebSocketContext.Provider value={ws}><FlowProvider><FlowRepositoryPromptProvider>{children}</FlowRepositoryPromptProvider></FlowProvider></SharedWebSocketContext.Provider>
}
const respond = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
const spec = (over: Partial<StartInFlowSpec> = {}): StartInFlowSpec => ({ id: 12, title: 'Calmer onboarding', status: 'todo', metadata: {}, origin_conversation_id: 'c-origin', ...over })

let posts: Array<{ url: string; body: Record<string, unknown> }>
let flowResponses: Array<() => Response>
let repositories: unknown[]

beforeEach(() => {
  vi.clearAllMocks()
  posts = []
  flowResponses = []
  repositories = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (init?.method === 'POST' || init?.method === 'PATCH') posts.push({ url, body })
    if (url.endsWith('/api/projects/p1/repositories')) return respond(200, { repositories })
    if (url.endsWith('/flow/availability')) return respond(200, { available: true, reason: 'ok', missing: [] })
    if (url.endsWith('/api/projects/p1/flow') && init?.method === 'POST') {
      const next = flowResponses.shift()
      return next ? next() : respond(201, { flow: { id: 'f1', conversationId: body.conversationId, ticketId: 12, state: 'active', specOrigin: 'existing' } })
    }
    if (url.endsWith('/conversations') && init?.method === 'POST') return respond(201, { conversation: { id: 'c-new', pinned_project_id: 'p1' } })
    if (url.includes('/conversations/c-new') && init?.method === 'PATCH') return respond(200, { conversation: { id: 'c-new' } })
    return respond(200, {})
  }) as unknown as typeof fetch
})

describe('startInFlowBlock', () => {
  it('explains every case where a spec cannot start in Flow', () => {
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
})

describe('Start in Flow from the board / spec detail', () => {
  it('starts in the spec\'s own mission and opens it', async () => {
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    const button = screen.getByTestId('spec-start-in-flow')
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).toHaveTextContent('Start in Flow')
    await act(async () => { fireEvent.click(button) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(posts.find((post) => post.url.endsWith('/flow'))!.body).toEqual({ conversationId: 'c-origin', idea: '', ticketId: 12 })
    expect(chat.selectConversation).toHaveBeenCalledWith('c-origin')
  })

  it('opens a new mission (titled after the spec) when the spec\'s mission cannot take the Flow', async () => {
    flowResponses.push(() => respond(409, { error: 'flow_already_open', detail: 'open' }))
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('spec-start-in-flow')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('spec-start-in-flow')) })
    await waitFor(() => expect(chat.selectConversation).toHaveBeenCalledWith('c-new'))
    expect(posts.find((post) => post.url.endsWith('/conversations'))!.body).toEqual({ pinnedProjectId: 'p1' })
    expect(posts.find((post) => post.url.endsWith('/conversations/c-new'))!.body).toEqual({ title: 'Calmer onboarding' })
    expect(posts.filter((post) => post.url.endsWith('/flow')).map((post) => post.body.conversationId)).toEqual(['c-origin', 'c-new'])
  })

  it('says why it cannot start, and reports a refusal by the server in plain words', async () => {
    render(<Providers><StartInFlowMenuItem spec={spec()} rail={{ running: false }} onDone={vi.fn()} /></Providers>)
    const item = screen.getByTestId('spec-menu-start-in-flow')
    expect(item).toBeDisabled()
    expect(item).toHaveTextContent('On a rail: take it off the rail first')

    flowResponses.push(() => respond(409, { error: 'spec_running', detail: 'Spec #12 is running on Rail 2' }))
    const onDone = vi.fn()
    render(<Providers><StartInFlowMenuItem spec={spec({ id: 12, origin_conversation_id: null })} rail={null} onDone={onDone} /></Providers>)
    const enabled = screen.getAllByTestId('spec-menu-start-in-flow')[1]!
    await waitFor(() => expect(enabled).toBeEnabled())
    await act(async () => { fireEvent.click(enabled) })
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith('Spec #12 could not start in Flow', expect.objectContaining({ description: expect.stringContaining('running on a rail') }))
  })
})

describe('Start in Flow in a project with several Git repositories', () => {
  const several = () => [
    { id: 'repo-app', name: 'app', path: '/w/app', isPrimary: true, kind: 'git' },
    { id: 'repo-api', name: 'api', path: '/w/api', isPrimary: false, kind: 'git' },
    { id: 'repo-docs', name: 'docs', path: '/w/docs', isPrimary: false, kind: 'folder' },
  ]
  const flowPosts = () => posts.filter((post) => post.url.endsWith('/flow'))

  it('asks where the Flow runs (Git members only, the primary preselected) and starts there', async () => {
    repositories = several()
    render(<Providers><StartInFlowButton spec={spec()} rail={null} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('spec-start-in-flow')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('spec-start-in-flow')) })
    const dialog = await screen.findByTestId('flow-start-repository-dialog')
    expect(dialog).toHaveTextContent('Where should this Flow run?')
    expect(dialog).toHaveTextContent('Calmer onboarding')
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('data-testid'))).toEqual(['flow-start-repository-repo-app', 'flow-start-repository-repo-api'])
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    expect(radios[0]).toHaveAttribute('tabindex', '0')
    expect(radios[1]).toHaveAttribute('tabindex', '-1')
    expect(flowPosts()).toEqual([])
    fireEvent.keyDown(radios[0]!, { key: 'ArrowDown' })
    expect(screen.getByTestId('flow-start-repository-repo-api')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('flow-start-repository-repo-api')).toHaveFocus()
    await act(async () => { fireEvent.click(screen.getByTestId('flow-start-repository-confirm')) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c-origin', idea: '', ticketId: 12, repositoryId: 'repo-api' })
    expect(screen.queryByTestId('flow-start-repository-dialog')).not.toBeInTheDocument()
  })

  it('preselects the spec\'s repository among several it names, and cancelling starts nothing', async () => {
    repositories = several()
    render(<Providers><StartInFlowButton spec={spec({ repositoryIds: ['repo-docs', 'repo-api', 'repo-app'] })} rail={null} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('spec-start-in-flow')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('spec-start-in-flow')) })
    await screen.findByTestId('flow-start-repository-dialog')
    const api = screen.getByTestId('flow-start-repository-repo-api')
    expect(api).toHaveAttribute('aria-checked', 'true')
    expect(api).toHaveTextContent('Named in the spec')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await waitFor(() => expect(screen.queryByTestId('flow-start-repository-dialog')).not.toBeInTheDocument())
    expect(flowPosts()).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('spec-start-in-flow')).toBeEnabled()
  })

  it('does not ask when the spec targets exactly one Git repository (the server runs it there)', async () => {
    repositories = several()
    render(<Providers><StartInFlowButton spec={spec({ repositoryIds: ['repo-api'] })} rail={null} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('spec-start-in-flow')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('spec-start-in-flow')) })
    await waitFor(() => expect(chat.open).toHaveBeenCalled())
    expect(screen.queryByTestId('flow-start-repository-dialog')).not.toBeInTheDocument()
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c-origin', idea: '', ticketId: 12 })
  })

  it('asks with nothing preselected in a workspace (folder primary), and the board menu closes as the dialog opens', async () => {
    repositories = [
      { id: 'ws', name: 'workspace', path: '/w', isPrimary: true, kind: 'folder' },
      { id: 'repo-app', name: 'app', path: '/w/app', isPrimary: false, kind: 'git' },
      { id: 'repo-api', name: 'api', path: '/w/api', isPrimary: false, kind: 'git' },
    ]
    const onDone = vi.fn()
    render(<Providers><StartInFlowMenuItem spec={spec({ origin_conversation_id: null })} rail={null} onDone={onDone} /></Providers>)
    await waitFor(() => expect(screen.getByTestId('spec-menu-start-in-flow')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('spec-menu-start-in-flow')) })
    await screen.findByTestId('flow-start-repository-dialog')
    expect(onDone).toHaveBeenCalled()
    expect(screen.getAllByRole('radio').every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(screen.getByTestId('flow-start-repository-confirm')).toBeDisabled()
    expect(screen.getByText('Choose the repository this Flow runs in')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('flow-start-repository-repo-app'))
    await act(async () => { fireEvent.click(screen.getByTestId('flow-start-repository-confirm')) })
    await waitFor(() => expect(chat.selectConversation).toHaveBeenCalledWith('c-new'))
    expect(flowPosts()[0]!.body).toEqual({ conversationId: 'c-new', idea: '', ticketId: 12, repositoryId: 'repo-app' })
  })
})

describe('the rail-launch card\'s Flow path', () => {
  it('starts the card\'s one spec in Flow in this mission and closes the card', async () => {
    const onChosen = vi.fn()
    render(<Providers><FlowRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} disabled={false} onChosen={onChosen} /></Providers>)
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-start-in-flow')) })
    await waitFor(() => expect(onChosen).toHaveBeenCalled())
    expect(posts.find((post) => post.url.endsWith('/flow'))!.body).toEqual({ conversationId: 'c1', idea: '', ticketId: 12 })
  })

  it('asks where the Flow runs in a project with several Git repositories, and starts there in this mission', async () => {
    repositories = [
      { id: 'repo-app', name: 'app', path: '/w/app', isPrimary: true, kind: 'git' },
      { id: 'repo-api', name: 'api', path: '/w/api', isPrimary: false, kind: 'git' },
    ]
    const onChosen = vi.fn()
    render(<Providers><FlowRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} ticketTitle="Calmer onboarding" ticketRepositoryIds={['repo-app', 'repo-api']} disabled={false} onChosen={onChosen} /></Providers>)
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-start-in-flow')) })
    const dialog = await screen.findByTestId('flow-start-repository-dialog')
    expect(dialog).toHaveTextContent('Calmer onboarding')
    expect(screen.getByTestId('flow-start-repository-repo-app')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('flow-start-repository-repo-app')).toHaveTextContent('Named in the spec')
    expect(onChosen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('flow-start-repository-repo-api'))
    await act(async () => { fireEvent.click(screen.getByTestId('flow-start-repository-confirm')) })
    await waitFor(() => expect(onChosen).toHaveBeenCalled())
    expect(posts.find((post) => post.url.endsWith('/flow'))!.body).toEqual({ conversationId: 'c1', idea: '', ticketId: 12, repositoryId: 'repo-api' })
  })

  it('keeps the card and starts nothing when the repository dialog is cancelled', async () => {
    repositories = [
      { id: 'repo-app', name: 'app', path: '/w/app', isPrimary: true, kind: 'git' },
      { id: 'repo-api', name: 'api', path: '/w/api', isPrimary: false, kind: 'git' },
    ]
    const onChosen = vi.fn()
    render(<Providers><FlowRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} disabled={false} onChosen={onChosen} /></Providers>)
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-start-in-flow')) })
    await screen.findByTestId('flow-start-repository-dialog')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await waitFor(() => expect(screen.queryByTestId('flow-start-repository-dialog')).not.toBeInTheDocument())
    expect(posts.filter((post) => post.url.endsWith('/flow'))).toEqual([])
    expect(onChosen).not.toHaveBeenCalled()
    expect(screen.getByTestId('rail-card-start-in-flow')).toBeEnabled()
  })

  it('keeps the card when the server refuses, saying why', async () => {
    flowResponses.push(() => respond(409, { error: 'spec_in_flow' }))
    const onChosen = vi.fn()
    render(<Providers><FlowRailLaunchAlternative projectId="p1" conversationId="c1" ticketId={12} disabled={false} onChosen={onChosen} /></Providers>)
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-start-in-flow')) })
    expect(await screen.findByTestId('rail-card-flow-error')).toHaveTextContent('already in Flow')
    expect(onChosen).not.toHaveBeenCalled()
  })
})
