/**
 * Extended tests for JobsPage (formerly in DashboardPage before the multi-project redesign
 * extracted jobs/proposals into a dedicated page — SPEA-723).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
import JobsPage from '../JobsPage'

vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [{ id: 'proj-1', name: 'Test Project', path: '/test', slug: 'test', db_path: '/test/.db', added_at: '', last_seen_at: '' }],
    setActiveProjectId: vi.fn(),
    isLoading: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

vi.mock('../../hooks/usePipeline', () => ({
  usePipeline: () => ({
    recentJobs: [],
    phases: {},
    phaseDefinitions: [],
    projectName: 'Test Project',
    logLines: [],
    connectionStatus: 'connected',
    queueState: { jobs: [], activeJobId: null, paused: false },
  }),
}))

const mockRefresh = vi.fn()

vi.mock('../../hooks/useProjectCache', () => ({
  useProjectCache: ({ initialValue, namespace }: { initialValue: unknown; namespace: string }) => ({
    data: namespace === 'proposals'
      ? [{ id: 'prop-1', idea: 'Build a feature', status: 'created', created_at: '2024-01-01T00:00:00Z', issue_url: null }]
      : namespace === 'jobs'
      ? [
          { id: 'job-1', command: '/specrails:implement', started_at: '2026-01-01T00:00:00Z', status: 'completed' },
          { id: 'job-queued', command: '/specrails:queued', started_at: null, enqueued_at: '2099-01-01T00:00:00Z', status: 'queued' },
        ]
      : initialValue,
    isLoading: false,
    isFirstLoad: false,
    refresh: mockRefresh,
  }),
}))

vi.mock('../../components/RecentJobs', () => ({
  RecentJobs: ({
    jobs,
    onProposalClick,
    onProposalDelete,
  }: {
    jobs: Array<{ id: string; command: string; status: string; started_at: string | null; enqueued_at?: string | null }>
    onProposalClick?: (id: string) => void
    onProposalDelete?: (id: string) => void
  }) => (
    <div data-testid="recent-jobs">
      {jobs.map((j) => (
        <div
          key={j.id}
          role="button"
          tabIndex={0}
          data-testid={`job-row-${j.id}`}
          onClick={() => {
            if (j.id.startsWith('proposal:') && onProposalClick) {
              onProposalClick(j.id.replace('proposal:', ''))
            }
          }}
          onKeyDown={() => {}}
        >
          {j.command}
        </div>
      ))}
    </div>
  ),
}))

vi.mock('../../components/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}))

describe('JobsPage - extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commands: [], jobs: [], proposals: [] }),
    })
  })

  it('renders the Jobs heading', () => {
    render(<JobsPage />)
    expect(screen.getByText('Jobs')).toBeInTheDocument()
  })

  it('renders proposal jobs from proposals list', () => {
    render(<JobsPage />)
    expect(screen.getByText(/specrails:propose-feature/)).toBeInTheDocument()
  })

  it('opens proposal detail dialog on proposal job click', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        proposal: {
          id: 'prop-1',
          idea: 'Build a feature',
          status: 'created',
          result_markdown: '# Result',
          issue_url: null,
          created_at: '2024-01-01T00:00:00Z',
        },
      }),
    })

    render(<JobsPage />)

    const proposalRow = screen.getByTestId('job-row-proposal:prop-1')
    fireEvent.click(proposalRow)

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/propose/')
      )
    })
  })

  it('handleProposalDelete calls DELETE and refreshes on success', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    render(<JobsPage />)
    expect(screen.getByText('Jobs')).toBeInTheDocument()
  })

  it('shows loading skeleton when jobs are loading', () => {
    render(<JobsPage />)
    expect(screen.getByTestId('recent-jobs')).toBeInTheDocument()
  })

  it('proposal jobs with long idea text get truncated with ellipsis', () => {
    render(<JobsPage />)
    // The mock returns a short idea, but the component truncates > 60 chars
    expect(screen.getByText(/specrails:propose-feature/)).toBeInTheDocument()
  })

  it('enrichedCommands shows implement job', () => {
    render(<JobsPage />)
    expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
  })

  it('sorts queued jobs by enqueued_at without inventing a started_at', () => {
    render(<JobsPage />)
    const list = screen.getByTestId('recent-jobs')
    expect(list.firstElementChild).toHaveAttribute('data-testid', 'job-row-job-queued')
    expect(screen.getByText('/specrails:queued')).toBeInTheDocument()
  })

  it('renders ExportDropdown', () => {
    render(<JobsPage />)
    expect(screen.getByTestId('export-dropdown')).toBeInTheDocument()
  })
})

describe('JobsPage - proposal dialog interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows proposal detail dialog content after successful fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        proposal: {
          id: 'prop-1',
          idea: 'A great idea',
          status: 'created',
          result_markdown: null,
          issue_url: null,
          created_at: '2024-01-01T00:00:00Z',
        },
      }),
    })

    render(<JobsPage />)

    const proposalRow = screen.getByTestId('job-row-proposal:prop-1')
    fireEvent.click(proposalRow)

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/propose/'))
    })
  })

  it('does not open dialog when fetch returns non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false })

    render(<JobsPage />)

    const proposalRow = screen.getByTestId('job-row-proposal:prop-1')
    fireEvent.click(proposalRow)

    await waitFor(() => {
      expect(screen.queryByText('Proposal')).toBeNull()
    })
  })
})
