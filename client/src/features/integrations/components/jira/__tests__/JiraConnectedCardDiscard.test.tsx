import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '../../../../../test-utils'

const desktop = vi.hoisted(() => ({ activeProjectId: null as string | null }))
vi.mock('../../../../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) } }))

vi.mock('../../../lib/jira-api', () => ({
  jiraApi: {
    listOutbox: vi.fn(),
    listStatuses: vi.fn(),
    patchConnection: vi.fn(),
    setEnabled: vi.fn(),
    syncNow: vi.fn(),
    disconnect: vi.fn(),
    retryOutbox: vi.fn(),
  },
}))

import { JiraConnectedCard } from '../JiraConnectedCard'
import { jiraApi, type ConnectionState, type SpecLogicalState } from '../../../lib/jira-api'

const api = jiraApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const STATUSES = [
  { id: '10', name: 'To Do', category: 'new' },
  { id: '11', name: 'In Progress', category: 'indeterminate' },
  { id: '12', name: 'Cancelled', category: 'done' },
  { id: '13', name: 'In Review', category: 'indeterminate' },
]

function makeState(
  discardStatus: string | null,
  statusMap: Partial<Record<SpecLogicalState, string>> | null = null
): ConnectionState {
  return {
    connected: true,
    connection: {
      projectId: 'p1',
      baseUrl: 'https://acme.atlassian.net',
      deployment: 'cloud',
      apiVersion: '3',
      authScheme: 'basic',
      accountEmail: 'a@b.com',
      jiraProjectKey: 'PROJ',
      jiraProjectId: '1',
      enabled: true,
      statusMap,
      highWaterMs: null,
      discardStatus,
      hasToken: true,
    },
    outbox: { pending: 0, inflight: 0, done: 0, dead: 0 },
  }
}

describe('JiraConnectedCard — discard status picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    desktop.activeProjectId = null
    api.listOutbox.mockResolvedValue({ ops: [], counts: { pending: 0, inflight: 0, done: 0, dead: 0 } })
    api.listStatuses.mockResolvedValue({ statuses: STATUSES })
    api.patchConnection.mockResolvedValue({ connection: makeState(null).connection })
  })

  it('loads the board statuses and renders them in the discard picker (default null)', async () => {
    render(<JiraConnectedCard state={makeState(null)} onChanged={vi.fn()} />)

    await waitFor(() => expect(api.listStatuses).toHaveBeenCalled())

    const select = (await screen.findByTestId('jira-discard-status-select')) as HTMLSelectElement
    // No discard status configured yet → default empty option selected.
    expect(select.value).toBe('')
    await waitFor(() => {
      for (const st of STATUSES) {
        expect(within(select).getByRole('option', { name: st.name })).toBeInTheDocument()
      }
    })
  })

  it('defaults the picker to the connection.discardStatus when set', async () => {
    render(<JiraConnectedCard state={makeState('Cancelled')} onChanged={vi.fn()} />)

    const select = (await screen.findByTestId('jira-discard-status-select')) as HTMLSelectElement
    expect(select.value).toBe('Cancelled')
  })

  it('patches the connection and calls onChanged when the discard status changes', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)

    const select = (await screen.findByTestId('jira-discard-status-select')) as HTMLSelectElement
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Cancelled' })).toBeInTheDocument())

    fireEvent.change(select, { target: { value: 'Cancelled' } })

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ discardStatus: 'Cancelled' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(select.value).toBe('Cancelled')
  })

  it('threads an explicit apiBase through project-scoped management calls', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} apiBase="/api/projects/proj-42" />)

    await waitFor(() => expect(api.listOutbox).toHaveBeenCalledWith('dead', '/api/projects/proj-42'))
    await waitFor(() => expect(api.listStatuses).toHaveBeenCalledWith('/api/projects/proj-42'))

    const select = (await screen.findByTestId('jira-discard-status-select')) as HTMLSelectElement
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Cancelled' })).toBeInTheDocument())
    fireEvent.change(select, { target: { value: 'Cancelled' } })

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ discardStatus: 'Cancelled' }, '/api/projects/proj-42'))
  })

  it('patches discardStatus null when the picker is reset to the none option', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState('Cancelled')} onChanged={onChanged} />)

    const select = (await screen.findByTestId('jira-discard-status-select')) as HTMLSelectElement
    expect(select.value).toBe('Cancelled')

    fireEvent.change(select, { target: { value: '' } })

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ discardStatus: null }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('patches the status map when a logical-state mapping changes', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)

    const todo = (await screen.findByTestId('jira-statusmap-todo')) as HTMLSelectElement
    await waitFor(() => expect(within(todo).getByRole('option', { name: 'To Do' })).toBeInTheDocument())

    fireEvent.change(todo, { target: { value: 'To Do' } })

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ statusMap: { todo: 'To Do' } }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('renders the On Review mapping row and patches on_review when a status is selected', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)

    const onReview = (await screen.findByTestId('jira-statusmap-on_review')) as HTMLSelectElement
    expect(onReview.value).toBe('')
    await waitFor(() => expect(within(onReview).getByRole('option', { name: 'In Review' })).toBeInTheDocument())

    fireEvent.change(onReview, { target: { value: 'In Review' } })

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ statusMap: { on_review: 'In Review' } }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('identifies blocked issues and refreshes the attention count after retry', async () => {
    api.listOutbox.mockResolvedValueOnce({
      ops: [{ id: 8, jiraIssueId: '10008', jiraKey: 'PROJ-8', opType: 'transition', state: 'dead', logicalState: 'todo', targetStatus: 'Ready', deadReason: 'No permitted transition to Ready' }],
      counts: { pending: 0, inflight: 0, done: 0, dead: 1 },
    }).mockResolvedValue({ ops: [], counts: { pending: 1, inflight: 0, done: 0, dead: 0 } })
    api.retryOutbox.mockResolvedValue({ ok: true, disposition: 'pending' })
    const state = makeState(null)
    state.outbox = { pending: 0, inflight: 0, done: 0, dead: 1 }
    render(<JiraConnectedCard state={state} onChanged={vi.fn()} apiBase="/api/projects/p1" />)

    expect(await screen.findByRole('link', { name: 'PROJ-8' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/PROJ-8')
    expect(screen.getByText('Target: Ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(api.retryOutbox).toHaveBeenCalledWith(8, '/api/projects/p1'))
    expect(await screen.findByText('1 pending')).toBeInTheDocument()
    expect(screen.queryByText('1 need attention')).not.toBeInTheDocument()
  })

  it('explains status discovery failures and can retry without resetting the mapping', async () => {
    api.listStatuses.mockRejectedValueOnce(new Error('Unauthorized')).mockResolvedValue({ statuses: STATUSES })
    render(<JiraConnectedCard state={makeState(null, { todo: 'To Do' })} onChanged={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load Jira statuses")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const todo = screen.getByTestId('jira-statusmap-todo') as HTMLSelectElement
    await waitFor(() => expect(within(todo).getByRole('option', { name: 'In Progress' })).toBeInTheDocument())
    expect(todo.value).toBe('To Do')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores old project rows, statuses and save completion after the active project switches', async () => {
    let oldOutbox!: (value: unknown) => void
    let oldStatuses!: (value: unknown) => void
    let oldSave!: (value: unknown) => void
    api.listOutbox.mockImplementationOnce(() => new Promise((resolve) => { oldOutbox = resolve }))
    api.listStatuses.mockImplementationOnce(() => new Promise((resolve) => { oldStatuses = resolve }))
    api.patchConnection.mockImplementationOnce(() => new Promise((resolve) => { oldSave = resolve }))
    desktop.activeProjectId = 'p1'
    const onChanged = vi.fn()
    const { rerender } = render(<JiraConnectedCard state={makeState(null, { todo: 'To Do' })} onChanged={onChanged} />)
    fireEvent.change(screen.getByTestId('jira-statusmap-todo'), { target: { value: '' } })
    await waitFor(() => expect(api.patchConnection).toHaveBeenCalled())

    desktop.activeProjectId = 'p2'
    const nextState = makeState(null, { todo: 'Ready' })
    nextState.connection!.projectId = 'p2'
    api.listOutbox.mockResolvedValue({ ops: [{ id: 9, jiraKey: 'NEW-9', jiraIssueId: '9', state: 'dead', opType: 'transition' }], counts: { pending: 0, inflight: 0, done: 0, dead: 1 } })
    api.listStatuses.mockResolvedValue({ statuses: [{ id: '77', name: 'Ready', category: 'new' }] })
    rerender(<JiraConnectedCard state={nextState} onChanged={onChanged} />)
    await screen.findByRole('link', { name: 'NEW-9' })
    await act(async () => {
      oldOutbox({ ops: [{ id: 8, jiraKey: 'OLD-8', jiraIssueId: '8', state: 'dead', opType: 'transition' }], counts: { pending: 0, inflight: 0, done: 0, dead: 28 } })
      oldStatuses({ statuses: STATUSES })
      oldSave({ connection: makeState(null).connection })
    })
    expect(screen.queryByRole('link', { name: 'OLD-8' })).not.toBeInTheDocument()
    expect((screen.getByTestId('jira-statusmap-todo') as HTMLSelectElement).value).toBe('Ready')
    expect(within(screen.getByTestId('jira-statusmap-todo')).queryByRole('option', { name: 'To Do' })).not.toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('patches statusMap null when the only mapping (on_review) is cleared', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null, { on_review: 'In Review' })} onChanged={onChanged} />)

    const onReview = (await screen.findByTestId('jira-statusmap-on_review')) as HTMLSelectElement
    expect(onReview.value).toBe('In Review')

    fireEvent.change(onReview, { target: { value: '' } })

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ statusMap: null }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
