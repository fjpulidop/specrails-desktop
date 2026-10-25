import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '../../../../../test-utils'
import userEvent from '@testing-library/user-event'

/** Open a Radix select trigger and choose the option with the given name. */
async function choose(trigger: HTMLElement, name: string) {
  const user = userEvent.setup()
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name }))
}

/** Open a Radix select, wait for `expected` to be listed, return all option names, then close. */
async function optionNames(trigger: HTMLElement, expected: string): Promise<string[]> {
  const user = userEvent.setup()
  await user.click(trigger)
  await screen.findByRole('option', { name: expected })
  const names = screen.getAllByRole('option').map((o) => o.textContent ?? '')
  await user.keyboard('{Escape}')
  return names
}

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

    const select = await screen.findByTestId('jira-discard-status-select')
    // No discard status configured yet → default empty option selected.
    expect(select).toHaveTextContent('None — delete normally')
    const names = await optionNames(select, STATUSES[STATUSES.length - 1].name)
    for (const st of STATUSES) expect(names).toContain(st.name)
  })

  it('defaults the picker to the connection.discardStatus when set', async () => {
    render(<JiraConnectedCard state={makeState('Cancelled')} onChanged={vi.fn()} />)

    expect(await screen.findByTestId('jira-discard-status-select')).toHaveTextContent('Cancelled')
  })

  it('patches the connection and calls onChanged when the discard status changes', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)

    const select = await screen.findByTestId('jira-discard-status-select')
    await choose(select, 'Cancelled')

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ discardStatus: 'Cancelled' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(select).toHaveTextContent('Cancelled')
  })

  it('threads an explicit apiBase through project-scoped management calls', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} apiBase="/api/projects/proj-42" />)

    await waitFor(() => expect(api.listOutbox).toHaveBeenCalledWith('dead', '/api/projects/proj-42'))
    await waitFor(() => expect(api.listStatuses).toHaveBeenCalledWith('/api/projects/proj-42'))

    await choose(await screen.findByTestId('jira-discard-status-select'), 'Cancelled')

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ discardStatus: 'Cancelled' }, '/api/projects/proj-42'))
  })

  it('patches discardStatus null when the picker is reset to the none option', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState('Cancelled')} onChanged={onChanged} />)

    const select = await screen.findByTestId('jira-discard-status-select')
    expect(select).toHaveTextContent('Cancelled')

    await choose(select, 'None — delete normally')

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ discardStatus: null }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('patches the status map when a logical-state mapping changes', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)

    await choose(await screen.findByTestId('jira-statusmap-todo'), 'To Do')

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ statusMap: { todo: 'To Do' } }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('renders the On Review mapping row and patches on_review when a status is selected', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)

    const onReview = await screen.findByTestId('jira-statusmap-on_review')
    expect(onReview).toHaveTextContent('Automatic (by category)')
    await choose(onReview, 'In Review')

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
    const todo = screen.getByTestId('jira-statusmap-todo')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(todo).toHaveTextContent('To Do')
    expect(await optionNames(todo, 'In Progress')).toContain('In Progress')
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
    await choose(screen.getByTestId('jira-statusmap-todo'), 'Automatic (by category)')
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
    const todo = screen.getByTestId('jira-statusmap-todo')
    expect(todo).toHaveTextContent('Ready')
    expect(await optionNames(todo, 'Ready')).not.toContain('To Do')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('patches statusMap null when the only mapping (on_review) is cleared', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null, { on_review: 'In Review' })} onChanged={onChanged} />)

    const onReview = await screen.findByTestId('jira-statusmap-on_review')
    expect(onReview).toHaveTextContent('In Review')

    await choose(onReview, 'Automatic (by category)')

    await waitFor(() => expect(api.patchConnection).toHaveBeenCalledWith({ statusMap: null }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})

describe('JiraConnectedCard — disconnect confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    desktop.activeProjectId = null
    api.listOutbox.mockResolvedValue({ ops: [], counts: { pending: 0, inflight: 0, done: 0, dead: 0 } })
    api.listStatuses.mockResolvedValue({ statuses: STATUSES })
    api.disconnect.mockResolvedValue({ ok: true })
  })

  it('asks before disconnecting and only calls the API after confirming', async () => {
    const onChanged = vi.fn()
    render(<JiraConnectedCard state={makeState(null)} onChanged={onChanged} />)
    await waitFor(() => expect(api.listStatuses).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Disconnect from Jira?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.disconnect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('renders sync enabled as a labelled switch', async () => {
    render(<JiraConnectedCard state={makeState(null)} onChanged={vi.fn()} />)
    const sw = await screen.findByRole('switch', { name: 'Sync enabled' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })
})
