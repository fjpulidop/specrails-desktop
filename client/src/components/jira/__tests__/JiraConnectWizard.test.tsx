import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../test-utils'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: vi.fn() } }))

vi.mock('../../../lib/jira-api', () => ({
  jiraApi: {
    test: vi.fn(),
    discoverProjects: vi.fn(),
    discoverStatuses: vi.fn(),
    connect: vi.fn(),
  },
}))

import { JiraConnectWizard } from '../JiraConnectWizard'
import { jiraApi } from '../../../lib/jira-api'

const api = jiraApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const STATUSES = [
  { id: '10', name: 'To Do', category: 'new' },
  { id: '11', name: 'In Review', category: 'indeterminate' },
  { id: '12', name: 'Done', category: 'done' },
]

/** Walk the wizard through steps 1–2 into the status-map step (step 3). */
async function goToMappingStep() {
  fireEvent.change(screen.getByPlaceholderText(/your-company\.atlassian\.net/i), { target: { value: 'https://acme.atlassian.net' } })
  const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement
  fireEvent.change(tokenInput, { target: { value: 'tok' } })
  fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
  await waitFor(() => expect(screen.getByTestId('jira-test-ok')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  await waitFor(() => expect(screen.getByTestId('jira-project-list')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /OPS/ }))
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  await waitFor(() => expect(api.discoverStatuses).toHaveBeenCalled())
}

describe('JiraConnectWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastError.mockClear()
  })

  it('shows the "do it later" affordance only when onSkip is provided, and fires it', () => {
    const onSkip = vi.fn()
    render(<JiraConnectWizard onConnected={vi.fn()} onSkip={onSkip} />)
    const later = screen.getByTestId('jira-later')
    expect(later).toBeInTheDocument()
    fireEvent.click(later)
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('hides the "do it later" affordance when onSkip is absent', () => {
    render(<JiraConnectWizard onConnected={vi.fn()} />)
    expect(screen.queryByTestId('jira-later')).not.toBeInTheDocument()
  })

  it('threads an explicit apiBase into every jiraApi call through the happy path', async () => {
    const apiBase = '/api/projects/proj-99'
    api.test.mockResolvedValue({ ok: true, deployment: 'cloud', displayName: 'Jane' })
    api.discoverProjects.mockResolvedValue({ projects: [{ id: '1', key: 'OPS', name: 'Ops' }] })
    api.discoverStatuses.mockResolvedValue({ statuses: [] })
    api.connect.mockResolvedValue({ connection: {} })
    const onConnected = vi.fn()

    render(<JiraConnectWizard onConnected={onConnected} apiBase={apiBase} />)

    // Step 1 — credentials + test.
    fireEvent.change(screen.getByPlaceholderText(/your-company\.atlassian\.net/i), { target: { value: 'https://acme.atlassian.net' } })
    fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), { target: { value: 'a@b.com' } })
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(tokenInput, { target: { value: 'tok' } })
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    await waitFor(() => expect(screen.getByTestId('jira-test-ok')).toBeInTheDocument())
    expect(api.test).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://acme.atlassian.net' }), apiBase)

    // Step 2 — discover + pick project.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await waitFor(() => expect(api.discoverProjects).toHaveBeenCalledWith(expect.any(Object), apiBase))
    await waitFor(() => expect(screen.getByTestId('jira-project-list')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /OPS/ }))

    // Step 3 — statuses (auto).
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await waitFor(() => expect(api.discoverStatuses).toHaveBeenCalledWith(expect.objectContaining({ projectKey: 'OPS' }), apiBase))

    // Step 4 — review + connect.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({ jiraProjectKey: 'OPS' }), apiBase))
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
  })

  it('renders the On Review mapping row and includes on_review in the connect statusMap when mapped', async () => {
    api.test.mockResolvedValue({ ok: true, deployment: 'cloud', displayName: 'Jane' })
    api.discoverProjects.mockResolvedValue({ projects: [{ id: '1', key: 'OPS', name: 'Ops' }] })
    api.discoverStatuses.mockResolvedValue({ statuses: STATUSES })
    api.connect.mockResolvedValue({ connection: {} })

    render(<JiraConnectWizard onConnected={vi.fn()} />)
    await goToMappingStep()

    // The On Review row renders between In Progress and Done, same pattern as the others.
    const onReview = screen.getByLabelText('On Review') as HTMLSelectElement
    expect(onReview.value).toBe('')
    fireEvent.change(onReview, { target: { value: 'In Review' } })

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() =>
      expect(api.connect).toHaveBeenCalledWith(
        expect.objectContaining({ statusMap: { on_review: 'In Review' } }),
        undefined
      )
    )
  })

  it('omits on_review from the connect statusMap when left unmapped', async () => {
    api.test.mockResolvedValue({ ok: true, deployment: 'cloud', displayName: 'Jane' })
    api.discoverProjects.mockResolvedValue({ projects: [{ id: '1', key: 'OPS', name: 'Ops' }] })
    api.discoverStatuses.mockResolvedValue({ statuses: STATUSES })
    api.connect.mockResolvedValue({ connection: {} })

    render(<JiraConnectWizard onConnected={vi.fn()} />)
    await goToMappingStep()

    // Map another state but leave On Review on the automatic option.
    fireEvent.change(screen.getByLabelText('Backlog / To Do'), { target: { value: 'To Do' } })

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() =>
      expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({ statusMap: { todo: 'To Do' } }), undefined)
    )
    const sent = api.connect.mock.calls[0][0] as { statusMap: Record<string, string> }
    expect(sent.statusMap).not.toHaveProperty('on_review')
  })

  it('surfaces a toast and keeps Next disabled when the connection test fails', async () => {
    api.test.mockRejectedValue(new Error('Invalid email or token'))
    render(<JiraConnectWizard onConnected={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/your-company\.atlassian\.net/i), { target: { value: 'https://acme.atlassian.net' } })
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(tokenInput, { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Invalid email or token'))
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled()
  })
})
