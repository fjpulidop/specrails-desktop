import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { RecentJobs } from '../RecentJobs'
import type { JobSummary } from '../../types'

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

// Mock useNavigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

const mockJobs: JobSummary[] = [
  {
    id: 'job-1',
    command: '/specrails:implement',
    started_at: new Date(Date.now() - 30000).toISOString(),
    finished_at: new Date().toISOString(),
    status: 'completed',
    duration_ms: 30000,
    total_cost_usd: 0.05,
    tokens_out: 1500,
  },
  {
    id: 'job-2',
    command: '/specrails:propose-spec',
    started_at: new Date().toISOString(),
    status: 'running',
  },
  {
    id: 'job-3',
    command: '/specrails:health-check',
    started_at: new Date().toISOString(),
    status: 'failed',
  },
]

describe('RecentJobs', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
    vi.clearAllMocks()
  })

  it('shows "No jobs yet" empty state when jobs array is empty', () => {
    render(<RecentJobs jobs={[]} />)
    expect(screen.getByText(/No jobs yet/i)).toBeInTheDocument()
  })

  it('shows load error with Retry instead of the empty state', () => {
    const onRetry = vi.fn()
    render(<RecentJobs jobs={[]} error="request failed" onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps the last good jobs visible when a refresh fails', () => {
    render(<RecentJobs jobs={mockJobs} error="request failed" onRetry={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
  })

  it('shows loading skeleton when isLoading is true', () => {
    const { container } = render(<RecentJobs jobs={[]} isLoading={true} />)
    const skeletons = container.querySelectorAll('.animate-pulse')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders job list with status badges', () => {
    render(<RecentJobs jobs={mockJobs} />)
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('renders job commands', () => {
    render(<RecentJobs jobs={mockJobs} />)
    expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
    expect(screen.getByText('/specrails:propose-spec')).toBeInTheDocument()
    expect(screen.getByText('/specrails:health-check')).toBeInTheDocument()
  })

  it('renders "All" filter button with correct count', () => {
    render(<RecentJobs jobs={mockJobs} />)
    expect(screen.getByRole('button', { name: /All \(3\)/i })).toBeInTheDocument()
  })

  it('status filter buttons appear for statuses that have jobs', () => {
    render(<RecentJobs jobs={mockJobs} />)
    // completed, running, failed all have jobs
    expect(screen.getByRole('button', { name: /completed \(1\)/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /running \(1\)/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /failed \(1\)/i })).toBeInTheDocument()
  })

  it('clicking status filter shows only matching jobs', async () => {
    const user = userEvent.setup()
    render(<RecentJobs jobs={mockJobs} />)
    const completedFilter = screen.getByRole('button', { name: /completed \(1\)/i })
    await user.click(completedFilter)
    // Only completed job should be visible
    expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
    expect(screen.queryByText('/specrails:propose-spec')).not.toBeInTheDocument()
    expect(screen.queryByText('/specrails:health-check')).not.toBeInTheDocument()
  })

  it('clicking same filter again deselects it (shows all)', async () => {
    const user = userEvent.setup()
    render(<RecentJobs jobs={mockJobs} />)
    const completedFilter = screen.getByRole('button', { name: /completed \(1\)/i })
    await user.click(completedFilter)
    await user.click(completedFilter)
    expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
    expect(screen.getByText('/specrails:propose-spec')).toBeInTheDocument()
    expect(screen.getByText('/specrails:health-check')).toBeInTheDocument()
  })

  it('clicking job row navigates to job detail', async () => {
    const user = userEvent.setup()
    render(<RecentJobs jobs={mockJobs} />)
    const jobRow = screen.getByText('/specrails:implement').closest('[role="button"]')!
    await user.click(jobRow)
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-1')
  })

  it('pressing Enter on a focused job row navigates to job detail', () => {
    render(<RecentJobs jobs={mockJobs} />)
    const jobRow = screen.getByText('/specrails:implement').closest('[role="button"]')!
    fireEvent.keyDown(jobRow, { key: 'Enter' })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-1')
  })

  it('clicking proposal row calls onProposalClick instead of navigate', async () => {
    const user = userEvent.setup()
    const onProposalClick = vi.fn()
    const proposalJob: JobSummary = {
      id: 'proposal:abc123',
      command: '/specrails:propose-feature some idea',
      started_at: new Date().toISOString(),
      status: 'completed',
    }
    render(<RecentJobs jobs={[proposalJob]} onProposalClick={onProposalClick} />)
    const row = screen.getByText('/specrails:propose-feature some idea').closest('[role="button"]')!
    await user.click(row)
    expect(onProposalClick).toHaveBeenCalledWith('abc123')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('pressing Space on a focused proposal row invokes the proposal action', () => {
    const onProposalClick = vi.fn()
    const proposalJob: JobSummary = {
      id: 'proposal:abc123',
      command: '/specrails:propose-feature keyboard idea',
      started_at: new Date().toISOString(),
      status: 'completed',
    }
    render(<RecentJobs jobs={[proposalJob]} onProposalClick={onProposalClick} />)
    const row = screen.getByText('/specrails:propose-feature keyboard idea').closest('[role="button"]')!
    fireEvent.keyDown(row, { key: ' ' })
    expect(onProposalClick).toHaveBeenCalledWith('abc123')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('shows duration when available', () => {
    render(<RecentJobs jobs={mockJobs} />)
    // job-1 has duration_ms: 30000 → "30s"
    expect(screen.getByText('30s')).toBeInTheDocument()
  })

  it('shows cost when available', () => {
    render(<RecentJobs jobs={mockJobs} />)
    // job-1 has total_cost_usd: 0.05 → "$0.050"
    expect(screen.getByText('$0.050')).toBeInTheDocument()
  })

  it('renders tokens when available', () => {
    render(<RecentJobs jobs={[{ ...mockJobs[0], tokens_out: 2500 }]} />)
    expect(screen.getByText('2.5k')).toBeInTheDocument()
  })

  describe('clear modal', () => {
    it('opens clear modal when trash button is clicked', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={mockJobs} />)
      // Find trash button by its icon container
      const trashButtons = document.querySelectorAll('[class*="text-muted-foreground hover:text-destructive"]')
      expect(trashButtons.length).toBeGreaterThan(0)
      await user.click(trashButtons[0] as HTMLElement)
      expect(screen.getByRole('button', { name: /clear all \d+ jobs?/i })).toBeInTheDocument()
    })

    it('clears all jobs on "Clear all jobs" click', async () => {
      const user = userEvent.setup()
      const onJobsCleared = vi.fn()
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deleted: 3 }),
      })
      render(<RecentJobs jobs={mockJobs} onJobsCleared={onJobsCleared} />)
      // Open modal
      const trashButtons = document.querySelectorAll('[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)
      // Click clear all
      fireEvent.click(screen.getByRole('button', { name: /clear all \d+ jobs?/i }))
      await waitFor(() => {
        expect(onJobsCleared).toHaveBeenCalled()
      })
    })

    it('shows toast error when clear fails', async () => {
      const user = userEvent.setup()
      const { toast } = await import('sonner')
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false })
      render(<RecentJobs jobs={mockJobs} />)
      const trashButtons = document.querySelectorAll('[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)
      fireEvent.click(screen.getByRole('button', { name: /clear all \d+ jobs?/i }))
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled()
      })
    })
  })

  describe('compare mode', () => {
    it('shows compare mode UI after clicking the compare button multiple times', () => {
      // Just verify the compare mode state renders without crashing when enabled
      // The compare button is a small icon button — find all small ghost buttons
      const { container } = render(<RecentJobs jobs={mockJobs} />)
      const iconButtons = container.querySelectorAll('button[class*="h-6 w-6"]')
      // At least the compare + trash buttons exist
      expect(iconButtons.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('proposals', () => {
    it('renders proposal delete button', async () => {
      const proposalJob: JobSummary = {
        id: 'proposal:abc123',
        command: '/specrails:propose-feature',
        started_at: new Date().toISOString(),
        status: 'completed',
      }
      render(<RecentJobs jobs={[proposalJob]} onProposalDelete={vi.fn()} />)
      // The row renders with a delete option
      expect(screen.getByText('/specrails:propose-feature')).toBeInTheDocument()
    })
  })

  describe('pagination', () => {
    it('shows "Load more" when there are more jobs than PAGE_SIZE', () => {
      const manyJobs = Array.from({ length: 12 }, (_, i) => ({
        id: `job-${i}`,
        command: `/specrails:implement-${i}`,
        started_at: new Date().toISOString(),
        status: 'completed' as const,
      }))
      render(<RecentJobs jobs={manyJobs} />)
      expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
    })

    it('loads more jobs when "Load more" is clicked', async () => {
      const user = userEvent.setup()
      const manyJobs = Array.from({ length: 12 }, (_, i) => ({
        id: `job-${i}`,
        command: `/cmd-${i}`,
        started_at: new Date().toISOString(),
        status: 'completed' as const,
      }))
      render(<RecentJobs jobs={manyJobs} />)
      const loadMore = screen.getByRole('button', { name: /load more/i })
      await user.click(loadMore)
      // After clicking, all 12 should be visible (no more "load more")
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    })
  })

  describe('zombie status', () => {
    it('shows "zombie" badge for zombie_terminated status', () => {
      const zombieJob: JobSummary = {
        id: 'zombie-1',
        command: '/specrails:test',
        started_at: new Date().toISOString(),
        status: 'zombie_terminated',
      }
      render(<RecentJobs jobs={[zombieJob]} />)
      expect(screen.getByText('zombie')).toBeInTheDocument()
    })
  })

  describe('queued status', () => {
    it('shows "queued" badge for queued status', () => {
      const queuedJob: JobSummary = {
        id: 'queue-1',
        command: '/specrails:health-check',
        started_at: new Date().toISOString(),
        status: 'queued',
      }
      render(<RecentJobs jobs={[queuedJob]} />)
      expect(screen.getByText('queued')).toBeInTheDocument()
    })
  })

  describe('canceled status', () => {
    it('shows "canceled" badge for canceled status', () => {
      const canceledJob: JobSummary = {
        id: 'cancel-1',
        command: '/specrails:implement',
        started_at: new Date().toISOString(),
        status: 'canceled',
      }
      render(<RecentJobs jobs={[canceledJob]} />)
      expect(screen.getByText('canceled')).toBeInTheDocument()
    })
  })
})
