import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'

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

vi.mock('../../lib/ws-url', () => ({
  WS_URL: 'ws://localhost:4200/hooks',
}))

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn().mockReturnValue({ connectionStatus: 'connected' }),
}))

vi.mock('../../components/PipelineProgress', () => ({
  PipelineProgress: () => <div data-testid="pipeline-progress">PipelineProgress</div>,
}))

vi.mock('../PipelineProgress', () => ({
  PipelineProgress: () => <div data-testid="pipeline-progress">PipelineProgress</div>,
}))

vi.mock('../LogViewer', () => ({
  LogViewer: ({ events, isLoading }: { events: unknown[]; isLoading: boolean }) => (
    <div data-testid="log-viewer">
      {isLoading ? 'loading...' : `${events.length} events`}
    </div>
  ),
}))

// Import the component after mocks
import { JobDetailModal } from '../JobDetailModal'

const mockJob = {
  id: 'job-abc123',
  command: '/specrails:implement --spec SPEA-001',
  started_at: '2024-03-21T10:00:00Z',
  finished_at: '2024-03-21T10:01:02Z',
  status: 'completed' as const,
  duration_ms: 62000,
  total_cost_usd: 0.0234,
  tokens_in: 5000,
  tokens_out: 3000,
  num_turns: 8,
}

const mockRunningJob = {
  ...mockJob,
  id: 'job-running',
  status: 'running' as const,
  finished_at: null as string | null,
  duration_ms: null,
  total_cost_usd: null,
}

describe('JobDetailModal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: mockJob,
        events: [],
        phaseDefinitions: [],
      }),
    })
  })

  it('shows loading text while fetching', () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders command after successful fetch', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })
  })

  it('mounts WITHOUT an ancestor TooltipProvider (Agent-Mode jobs pane)', async () => {
    // Regression: opening the modal from the Agent-Mode surface (a tree with no
    // ProjectLayout TooltipProvider) crashed Radix Tooltip and blanked the app.
    // test-utils wraps providers, so this renders BARE on purpose.
    const { render: bareRender, screen: bareScreen, waitFor: bareWaitFor } = await import('@testing-library/react')
    bareRender(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await bareWaitFor(() => {
      expect(bareScreen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })
  })

  it('renders status badge for completed job', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument()
    })
  })

  it('renders cost when total_cost_usd is non-null', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('$0.0234')).toBeInTheDocument()
    })
  })

  it('renders wall-clock duration when finished_at is set', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      // Wall-clock: 10:00:00 → 10:01:02 = 62s → "1m 2s"
      expect(screen.getByText('1m 2s')).toBeInTheDocument()
    })
  })

  it('renders LogViewer component', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByTestId('log-viewer')).toBeInTheDocument()
    })
  })

  it('shows "Job not found" when status 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 404, ok: false })
    render(<JobDetailModal jobId="job-missing" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Job not found')).toBeInTheDocument()
    })
  })

  it('shows "Job not found" on fetch error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Job not found')).toBeInTheDocument()
    })
  })

  it('calls onClose when backdrop is clicked', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    const backdrop = document.querySelector('.absolute.inset-0') as HTMLElement
    if (backdrop) {
      fireEvent.click(backdrop)
      expect(onClose).toHaveBeenCalled()
    }
  })

  it('calls onClose when X button is clicked', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })
    // Find the X close button (last button in header)
    const buttons = document.querySelectorAll('button')
    const xButton = Array.from(buttons).find((btn) =>
      btn.querySelector('svg') && btn.getAttribute('aria-label') !== 'Cancel'
    )
    if (xButton) {
      fireEvent.click(xButton)
      expect(onClose).toHaveBeenCalled()
    }
  })

  it('calls onClose when Escape key is pressed', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows Cancel button when job is running', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: mockRunningJob,
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })
  })

  it('does not show Cancel button when job is completed', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument()
  })

  it('shows cancel confirmation dialog when Cancel button is clicked', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: mockRunningJob,
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => {
      expect(screen.getByText('Cancel job?')).toBeInTheDocument()
    })
  })

  it('"Keep running" button dismisses the cancel confirmation dialog', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: mockRunningJob,
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /keep running/i }))
    await waitFor(() => {
      expect(screen.queryByText('Cancel job?')).not.toBeInTheDocument()
    })
  })

  it('"Cancel job" button in dialog calls DELETE endpoint', async () => {
    const { toast } = await import('sonner')
    // First fetch = load job, second fetch = DELETE cancel
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          job: mockRunningJob,
          events: [],
          phaseDefinitions: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/jobs/job-running',
        expect.objectContaining({ method: 'DELETE' })
      )
      expect(toast.success).toHaveBeenCalledWith(
        'Cancel signal sent',
        expect.objectContaining({ description: expect.stringContaining('next safe point') })
      )
    })
  })

  it('shows error toast when cancel DELETE fails', async () => {
    const { toast } = await import('sonner')
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          job: mockRunningJob,
          events: [],
          phaseDefinitions: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Cannot cancel' }),
      })

    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to cancel',
        expect.objectContaining({ description: 'Cannot cancel' })
      )
    })
  })

  it('shows error toast on network error during cancel', async () => {
    const { toast } = await import('sonner')
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          job: mockRunningJob,
          events: [],
          phaseDefinitions: [],
        }),
      })
      .mockRejectedValueOnce(new Error('Network error'))

    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Network error')
    })
  })

  it('renders running status badge for running job', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: mockRunningJob,
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('running')).toBeInTheDocument()
    })
  })

  it('renders zombie_terminated status badge', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: { ...mockJob, status: 'zombie_terminated' },
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('zombie')).toBeInTheDocument()
    })
  })

  it('renders external link anchor', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      const link = document.querySelector('a[href="/jobs/job-abc123"]') as HTMLAnchorElement
      expect(link).toBeTruthy()
      expect(link.getAttribute('target')).toBe('_blank')
    })
  })

  it('renders phaseDefinitions in PipelineProgress when provided', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: mockJob,
        events: [],
        phaseDefinitions: [
          { key: 'architect', label: 'Architect', order: 1 },
          { key: 'developer', label: 'Developer', order: 2 },
        ],
      }),
    })
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByTestId('pipeline-progress')).toBeInTheDocument()
    })
  })

  it('does not show cost when total_cost_usd is null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: { ...mockJob, total_cost_usd: null },
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument()
    })
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  it('does not show duration when finished_at is null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job: { ...mockJob, finished_at: null },
        events: [],
        phaseDefinitions: [],
      }),
    })
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument()
    })
    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument()
  })
})
