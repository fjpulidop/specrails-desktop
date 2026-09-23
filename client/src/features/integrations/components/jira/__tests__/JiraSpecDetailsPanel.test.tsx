import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../../test-utils'
import type {
  JiraSpecDetails,
  JiraDetailField,
  JiraDevPullRequest,
  JiraDevBranch,
  JiraDevCommit,
} from '../../../lib/jira-api'

// --- Mocks -----------------------------------------------------------------

// jira-api: only getSpecDetails is used by the panel.
vi.mock('../../../lib/jira-api', () => ({
  jiraApi: {
    getSpecDetails: vi.fn(),
  },
}))

// useJiraConnection: connected by default; individual tests override.
const connectionState = { connected: true }
vi.mock('../../../hooks/useJiraConnection', () => ({
  useJiraConnection: () => connectionState,
}))

// useDesktop: the panel reads activeProjectId off it (effect dependency).
vi.mock('../../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-test' }),
}))

// tauri-shell: openExternalUrl is asserted on click.
vi.mock('../../../../../lib/tauri-shell', () => ({
  openExternalUrl: vi.fn(),
}))

import { JiraSpecDetailsPanel } from '../JiraSpecDetailsPanel'
import { jiraApi } from '../../../lib/jira-api'
import { openExternalUrl } from '../../../../../lib/tauri-shell'

const getSpecDetails = jiraApi.getSpecDetails as ReturnType<typeof vi.fn>
const openExternal = openExternalUrl as ReturnType<typeof vi.fn>

// --- Fixtures --------------------------------------------------------------

function field(over: Partial<JiraDetailField> = {}): JiraDetailField {
  return { label: 'Status', value: 'In Progress', ...over }
}

function pr(over: Partial<JiraDevPullRequest> = {}): JiraDevPullRequest {
  return {
    id: 'pr-1',
    title: 'Add login flow',
    url: 'https://git.example/pr/1',
    status: 'OPEN',
    sourceBranch: 'feature/login',
    destBranch: 'main',
    author: 'Ada',
    lastUpdate: null,
    ...over,
  }
}

function branch(over: Partial<JiraDevBranch> = {}): JiraDevBranch {
  return {
    name: 'feature/login',
    url: 'https://git.example/branch/login',
    createPullRequestUrl: null,
    repo: 'web-app',
    repoUrl: null,
    lastCommit: null,
    ...over,
  }
}

function commit(over: Partial<JiraDevCommit> = {}): JiraDevCommit {
  return {
    id: 'abcdef0',
    displayId: 'abcdef0',
    message: 'Wire up auth',
    url: 'https://git.example/commit/abcdef0',
    author: 'Ada',
    timestamp: null,
    ...over,
  }
}

function details(over: Partial<JiraSpecDetails> = {}): JiraSpecDetails {
  return {
    fields: [],
    development: { pullRequests: [], branches: [], commits: [] },
    ...over,
  }
}

describe('JiraSpecDetailsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionState.connected = true
  })

  it('renders field rows with verbatim labels and values', async () => {
    getSpecDetails.mockResolvedValue(
      details({
        fields: [
          field({ label: 'Status', value: 'In Progress' }),
          field({ label: 'Assignee', value: 'Ada Lovelace' }),
        ],
      }),
    )

    render(<JiraSpecDetailsPanel localId={42} />)

    const panel = await screen.findByTestId('jira-details-panel')
    expect(panel).toBeInTheDocument()
    // Labels and values rendered verbatim.
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Assignee')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(getSpecDetails).toHaveBeenCalledWith(42)
  })

  it('renders an href field as a button that opens the external URL on click', async () => {
    const href = 'https://jira.example/browse/PROJ-7'
    getSpecDetails.mockResolvedValue(
      details({
        fields: [field({ label: 'Epic Link', value: 'PROJ-7', href })],
      }),
    )

    render(<JiraSpecDetailsPanel localId={7} />)

    await screen.findByTestId('jira-details-panel')
    const btn = screen.getByRole('button', { name: /PROJ-7/ })
    fireEvent.click(btn)

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(href)
  })

  it('renders Development PRs, branches, and commits when their arrays are non-empty', async () => {
    getSpecDetails.mockResolvedValue(
      details({
        development: {
          pullRequests: [pr({ title: 'Add login flow' })],
          branches: [branch({ name: 'feature/login' })],
          commits: [commit({ message: 'Wire up auth' })],
        },
      }),
    )

    render(<JiraSpecDetailsPanel localId={1} />)

    await screen.findByTestId('jira-details-panel')
    expect(screen.getByTestId('jira-dev-pr')).toBeInTheDocument()
    expect(screen.getByText('Add login flow')).toBeInTheDocument()
    expect(screen.getByTestId('jira-dev-branch')).toBeInTheDocument()
    expect(screen.getByText('feature/login')).toBeInTheDocument()
    expect(screen.getByTestId('jira-dev-commit')).toBeInTheDocument()
    expect(screen.getByText('Wire up auth')).toBeInTheDocument()
  })

  it('omits the dev sub-sections whose arrays are empty', async () => {
    getSpecDetails.mockResolvedValue(
      details({
        development: {
          pullRequests: [pr()],
          branches: [],
          commits: [],
        },
      }),
    )

    render(<JiraSpecDetailsPanel localId={2} />)

    await screen.findByTestId('jira-dev-pr')
    expect(screen.queryByTestId('jira-dev-branch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('jira-dev-commit')).not.toBeInTheDocument()
  })

  it('clicking a PR / branch / commit opens its external URL', async () => {
    getSpecDetails.mockResolvedValue(
      details({
        development: {
          pullRequests: [pr({ url: 'https://git.example/pr/9' })],
          branches: [branch({ url: 'https://git.example/branch/x' })],
          commits: [commit({ url: 'https://git.example/commit/y' })],
        },
      }),
    )

    render(<JiraSpecDetailsPanel localId={3} />)

    fireEvent.click(await screen.findByTestId('jira-dev-pr'))
    fireEvent.click(screen.getByTestId('jira-dev-branch'))
    fireEvent.click(screen.getByTestId('jira-dev-commit'))

    expect(openExternal).toHaveBeenCalledWith('https://git.example/pr/9')
    expect(openExternal).toHaveBeenCalledWith('https://git.example/branch/x')
    expect(openExternal).toHaveBeenCalledWith('https://git.example/commit/y')
  })

  it('renders nothing when fields and development are both empty', async () => {
    getSpecDetails.mockResolvedValue(details())

    const { container } = render(<JiraSpecDetailsPanel localId={5} />)

    // Allow the lazy fetch to resolve, then assert the panel never appears.
    await waitFor(() => expect(getSpecDetails).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.queryByTestId('jira-details-panel')).not.toBeInTheDocument()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing and skips the fetch when the connection is disconnected', async () => {
    connectionState.connected = false
    getSpecDetails.mockResolvedValue(
      details({ fields: [field({ label: 'Status', value: 'In Progress' })] }),
    )

    const { container } = render(<JiraSpecDetailsPanel localId={6} />)

    expect(screen.queryByTestId('jira-details-panel')).not.toBeInTheDocument()
    expect(getSpecDetails).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an ISO datetime field value as relative time, not the raw ISO string', async () => {
    const iso = '2020-01-01T00:00:00.000Z'
    getSpecDetails.mockResolvedValue(
      details({ fields: [field({ label: 'Created', value: iso })] }),
    )

    render(<JiraSpecDetailsPanel localId={8} />)

    await screen.findByTestId('jira-details-panel')
    // The raw ISO string must NOT be rendered as the visible value.
    expect(screen.queryByText(iso)).not.toBeInTheDocument()
    // A relative-time string (date-fns "... ago") is shown instead.
    expect(screen.getByText(/ago$/)).toBeInTheDocument()
    // The raw ISO is preserved as the title attribute for hover.
    expect(screen.getByText(/ago$/).getAttribute('title')).toBe(iso)
  })
})
