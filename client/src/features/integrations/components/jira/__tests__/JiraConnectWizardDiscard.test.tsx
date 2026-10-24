import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../../test-utils'
import userEvent from '@testing-library/user-event'

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
  { id: '11', name: 'In Progress', category: 'indeterminate' },
  { id: '12', name: 'Cancelled', category: 'done' },
]

/**
 * Drive the wizard through step 1 (test) → step 2 (pick project) → step 3
 * (statuses loaded). Leaves the wizard sitting on step 3 with the discard
 * <select> populated from the discovered statuses.
 */
async function driveToStep3(apiBase?: string) {
  api.test.mockResolvedValue({ ok: true, deployment: 'cloud', displayName: 'Jane' })
  api.discoverProjects.mockResolvedValue({ projects: [{ id: '1', key: 'OPS', name: 'Ops' }] })
  api.discoverStatuses.mockResolvedValue({ statuses: STATUSES })
  api.connect.mockResolvedValue({ connection: {} })

  // Step 1 — credentials + test.
  fireEvent.change(screen.getByPlaceholderText(/your-company\.atlassian\.net/i), { target: { value: 'https://acme.atlassian.net' } })
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), { target: { value: 'a@b.com' } })
  const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement
  fireEvent.change(tokenInput, { target: { value: 'tok' } })
  fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
  await waitFor(() => expect(screen.getByTestId('jira-test-ok')).toBeInTheDocument())

  // Step 2 — discover + pick project.
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  await waitFor(() => expect(api.discoverProjects).toHaveBeenCalledWith(expect.any(Object), apiBase))
  await waitFor(() => expect(screen.getByTestId('jira-project-list')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /OPS/ }))

  // Step 3 — statuses (auto-discovered).
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  await waitFor(() => expect(api.discoverStatuses).toHaveBeenCalledWith(expect.objectContaining({ projectKey: 'OPS' }), apiBase))
  await waitFor(() => expect(screen.getByTestId('jira-discard-status-select')).toBeInTheDocument())
}

describe('JiraConnectWizard — discard status step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastError.mockClear()
  })

  it('renders the discovered statuses as discard options, and connect() sends the picked discardStatus', async () => {
    const onConnected = vi.fn()
    render(<JiraConnectWizard onConnected={onConnected} />)

    await driveToStep3(undefined)

    const select = screen.getByTestId('jira-discard-status-select')
    // The discovered statuses populate the picker.
    const user = userEvent.setup()
    await user.click(select)
    for (const st of STATUSES) {
      expect(await screen.findByRole('option', { name: st.name })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('option', { name: 'Cancelled' }))
    expect(select).toHaveTextContent('Cancelled')

    // Step 4 — review + connect.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => expect(api.connect).toHaveBeenCalled())
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({ jiraProjectKey: 'OPS', discardStatus: 'Cancelled' }),
      undefined
    )
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
  })

  it('sends discardStatus null when the picker is left at its default (none)', async () => {
    const apiBase = '/api/projects/proj-42'
    render(<JiraConnectWizard onConnected={vi.fn()} apiBase={apiBase} />)

    await driveToStep3(apiBase)

    // Leave the discard select untouched (default empty option).
    expect(screen.getByTestId('jira-discard-status-select')).toHaveTextContent('None — delete normally')

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => expect(api.connect).toHaveBeenCalled())
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({ jiraProjectKey: 'OPS', discardStatus: null }),
      apiBase
    )
  })
})
