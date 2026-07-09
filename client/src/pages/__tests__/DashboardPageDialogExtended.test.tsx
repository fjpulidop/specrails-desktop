/**
 * Extended dialog tests for JobsPage (formerly in DashboardPage before the multi-project redesign
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

const mockRefreshJobs = vi.fn()

vi.mock('../../hooks/useProjectCache', () => ({
  useProjectCache: ({ namespace }: { namespace: string }) => ({
    data: namespace === 'proposals'
      ? [{ id: 'prop-1', idea: 'Build amazing feature', status: 'created', created_at: '2024-01-01T00:00:00Z', issue_url: null }]
      : namespace === 'jobs'
      ? []
      : [],
    isLoading: false,
    isFirstLoad: false,
    refresh: mockRefreshJobs,
  }),
}))

vi.mock('../../components/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}))

vi.mock('../../components/RecentJobs', () => ({
  RecentJobs: ({
    jobs,
    onProposalClick,
    onProposalDelete,
  }: {
    jobs: Array<{ id: string; command: string; status: string; started_at: string }>
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
      {onProposalDelete && <button data-testid="delete-prop-1" onClick={() => onProposalDelete('prop-1')}>Delete prop</button>}
    </div>
  ),
}))

function setupWithProposal(proposalOverrides: Record<string, unknown> = {}) {
  const defaultProposal = {
    id: 'prop-1',
    idea: 'Build amazing feature',
    status: 'created',
    result_markdown: '# Result\n\nSome markdown content',
    issue_url: null,
    created_at: '2024-01-01T00:00:00Z',
    ...proposalOverrides,
  }

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ proposal: defaultProposal }),
  })
}

async function openProposalDialog() {
  const proposalRow = screen.getByTestId('job-row-proposal:prop-1')
  fireEvent.click(proposalRow)
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/propose/'))
  })
}

describe('JobsPage - proposal dialog content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupWithProposal()
  })

  it('opens proposal dialog after clicking proposal row', async () => {
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('Proposal')).toBeInTheDocument()
    })
  })

  it('renders proposal idea text in dialog', async () => {
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('Build amazing feature')).toBeInTheDocument()
    })
  })

  it('renders a translated proposal status instead of the raw backend enum', async () => {
    setupWithProposal({ status: 'creating_issue' })
    render(<JobsPage />)
    await openProposalDialog()

    expect(await screen.findByText('Creating issue')).toBeInTheDocument()
    expect(screen.queryByText('creating_issue')).not.toBeInTheDocument()
  })

  it('renders result_markdown when present', async () => {
    setupWithProposal({ result_markdown: 'Proposal Result Content' })
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('Proposal Result Content')).toBeInTheDocument()
    })
  })

  it('shows "No proposal content yet." when result_markdown is null', async () => {
    setupWithProposal({ result_markdown: null })
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('No proposal content yet.')).toBeInTheDocument()
    })
  })

  it('renders GitHub Issue link when issue_url is set', async () => {
    setupWithProposal({
      issue_url: 'https://github.com/owner/repo/issues/42',
      result_markdown: null,
    })
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('https://github.com/owner/repo/issues/42')).toBeInTheDocument()
    })
  })

  it('does not render GitHub Issue section when issue_url is null', async () => {
    setupWithProposal({ issue_url: null, result_markdown: null })
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('No proposal content yet.')).toBeInTheDocument()
    })
    expect(screen.queryByText('GitHub Issue:')).not.toBeInTheDocument()
  })

  it('closes dialog when Close button is clicked', async () => {
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('Proposal')).toBeInTheDocument()
    })

    const closeButtons = screen.getAllByRole('button', { name: /close/i })
    fireEvent.click(closeButtons[closeButtons.length - 1])

    await waitFor(() => {
      expect(screen.queryByText('Proposal')).not.toBeInTheDocument()
    })
  })

  it('calls DELETE and refreshes when Delete button in dialog is clicked', async () => {
    const { toast } = await import('sonner')

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          proposal: {
            id: 'prop-1',
            idea: 'Build amazing feature',
            status: 'created',
            result_markdown: null,
            issue_url: null,
            created_at: '2024-01-01T00:00:00Z',
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/propose/prop-1'),
        expect.objectContaining({ method: 'DELETE' })
      )
      expect(toast.success).toHaveBeenCalledWith('Proposal deleted')
    })
  })

  it('shows status badge in proposal dialog', async () => {
    setupWithProposal({ status: 'created', result_markdown: null })
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('Created')).toBeInTheDocument()
    })
  })

  it('shows cancelled status badge in proposal dialog', async () => {
    setupWithProposal({ status: 'cancelled', result_markdown: null })
    render(<JobsPage />)
    await openProposalDialog()

    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument()
    })
  })

  it('Jobs heading always renders', () => {
    render(<JobsPage />)
    expect(screen.getByText('Jobs')).toBeInTheDocument()
  })

  it('proposal idea shorter than 60 chars is not truncated in command', () => {
    render(<JobsPage />)
    const row = screen.getByTestId('job-row-proposal:prop-1')
    expect(row.textContent).toContain('Build amazing feature')
    expect(row.textContent).not.toContain('...')
  })
})
