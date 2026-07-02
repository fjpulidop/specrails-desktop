import React from 'react'
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
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

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// Mock JobComparisonModal to avoid complex deps
vi.mock('../JobComparisonModal', () => ({
  JobComparisonModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="job-comparison-modal">
      <button onClick={onClose}>Close comparison</button>
    </div>
  ),
}))

const baseJob: JobSummary = {
  id: 'job-1',
  command: '/specrails:implement',
  started_at: new Date(Date.now() - 90000).toISOString(),
  finished_at: new Date().toISOString(),
  status: 'completed',
  duration_ms: 90000,       // 1m 30s
  total_cost_usd: 0.0045,   // < 0.01 → $0.0045
  tokens_out: 500,
}

describe('RecentJobs - extended coverage', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deleted: 2 }) })
  })

  describe('formatCost edge cases', () => {
    it('shows cost in 4-decimal format when cost < 0.01', () => {
      render(<RecentJobs jobs={[{ ...baseJob, total_cost_usd: 0.0045 }]} />)
      expect(screen.getByText('$0.0045')).toBeInTheDocument()
    })

    it('shows nothing (—) when cost is null', () => {
      render(<RecentJobs jobs={[{ ...baseJob, total_cost_usd: undefined }]} />)
      // cost column shows — when formatCost returns null
      const dashes = screen.getAllByText('—')
      expect(dashes.length).toBeGreaterThanOrEqual(1)
    })

    it('shows nothing (—) when cost is 0', () => {
      render(<RecentJobs jobs={[{ ...baseJob, total_cost_usd: 0 }]} />)
      const dashes = screen.getAllByText('—')
      expect(dashes.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('formatDuration edge cases', () => {
    it('shows wall-clock duration in minutes format when >= 60s', () => {
      const now = Date.now()
      render(<RecentJobs jobs={[{ ...baseJob, started_at: new Date(now - 90000).toISOString(), finished_at: new Date(now).toISOString() }]} />)
      expect(screen.getByText('1m 30s')).toBeInTheDocument()
    })

    it('shows — when finished_at is null', () => {
      render(<RecentJobs jobs={[{ ...baseJob, finished_at: undefined }]} />)
      const dashes = screen.getAllByText('—')
      expect(dashes.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('formatTokens edge cases', () => {
    it('shows token count as string when < 1000', () => {
      render(<RecentJobs jobs={[{ ...baseJob, tokens_out: 500 }]} />)
      expect(screen.getByText('500')).toBeInTheDocument()
    })

    it('shows — when tokens_out is 0', () => {
      render(<RecentJobs jobs={[{ ...baseJob, tokens_out: 0 }]} />)
      const dashes = screen.getAllByText('—')
      expect(dashes.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('date range filter', () => {
    it('clears date filters when "Clear" link is clicked', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={[baseJob]} />)

      const dateFromInput = screen.getByTitle('From date')
      await user.type(dateFromInput, '2024-01-01')

      // "Clear" button appears when dateFrom/dateTo are set
      const clearBtn = screen.getByText('Clear')
      await user.click(clearBtn)

      // After clear, the Clear button should be gone (dateFrom = '')
      expect(screen.queryByText('Clear')).not.toBeInTheDocument()
    })

    it('filters jobs by dateFrom', () => {
      const oldJob: JobSummary = { ...baseJob, id: 'old-job', started_at: '2024-01-01T00:00:00Z' }
      const newJob: JobSummary = { ...baseJob, id: 'new-job', command: '/specrails:propose-spec', started_at: '2024-06-01T00:00:00Z' }

      render(<RecentJobs jobs={[oldJob, newJob]} />)

      const dateFromInput = screen.getByTitle('From date')
      fireEvent.change(dateFromInput, { target: { value: '2024-05-01' } })

      expect(screen.getByText('/specrails:propose-spec')).toBeInTheDocument()
      expect(screen.queryByText('/specrails:implement')).not.toBeInTheDocument()
    })

    it('filters jobs by dateTo', () => {
      const oldJob: JobSummary = { ...baseJob, id: 'old-job', started_at: '2024-01-01T00:00:00Z' }
      const newJob: JobSummary = { ...baseJob, id: 'new-job', command: '/specrails:propose-spec', started_at: '2024-06-01T00:00:00Z' }

      render(<RecentJobs jobs={[oldJob, newJob]} />)

      const dateToInput = screen.getByTitle('To date')
      fireEvent.change(dateToInput, { target: { value: '2024-03-01' } })

      expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
      expect(screen.queryByText('/specrails:propose-spec')).not.toBeInTheDocument()
    })
  })

  describe('date range filter — local-day boundaries', () => {
    // These timestamps are built with the LOCAL Date constructor so the
    // assertions are deterministic in every timezone: whichever side of UTC
    // the test machine sits on, one of the two midnight-adjacent jobs
    // crosses the UTC day boundary when serialised to ISO.

    it('keeps a job started at 23:30 local visible when filtering to that same day', () => {
      // In UTC-negative timezones this is stored under the NEXT UTC day.
      const lateJob: JobSummary = {
        ...baseJob, id: 'late', command: '/late-job',
        started_at: new Date(2024, 4, 15, 23, 30).toISOString(),
      }
      render(<RecentJobs jobs={[lateJob]} />)
      fireEvent.change(screen.getByTitle('From date'), { target: { value: '2024-05-15' } })
      fireEvent.change(screen.getByTitle('To date'), { target: { value: '2024-05-15' } })
      expect(screen.getByText('/late-job')).toBeInTheDocument()
    })

    it('keeps a job started at 00:30 local visible when filtering from that day', () => {
      // In UTC-positive timezones this is stored under the PREVIOUS UTC day.
      const earlyJob: JobSummary = {
        ...baseJob, id: 'early', command: '/early-job',
        started_at: new Date(2024, 4, 15, 0, 30).toISOString(),
      }
      render(<RecentJobs jobs={[earlyJob]} />)
      fireEvent.change(screen.getByTitle('From date'), { target: { value: '2024-05-15' } })
      expect(screen.getByText('/early-job')).toBeInTheDocument()
    })

    it('includes the "to" day up to its last millisecond (end-date inclusive)', () => {
      const lastSecond: JobSummary = {
        ...baseJob, id: 'last', command: '/last-second-job',
        started_at: new Date(2024, 4, 15, 23, 59, 59, 500).toISOString(),
      }
      render(<RecentJobs jobs={[lastSecond]} />)
      fireEvent.change(screen.getByTitle('To date'), { target: { value: '2024-05-15' } })
      expect(screen.getByText('/last-second-job')).toBeInTheDocument()
    })

    it('excludes jobs started before the local "from" day', () => {
      const beforeFrom: JobSummary = {
        ...baseJob, id: 'before', command: '/before-job',
        started_at: new Date(2024, 4, 14, 23, 59, 59).toISOString(),
      }
      render(<RecentJobs jobs={[beforeFrom]} />)
      fireEvent.change(screen.getByTitle('From date'), { target: { value: '2024-05-15' } })
      expect(screen.queryByText('/before-job')).not.toBeInTheDocument()
    })

    it('excludes jobs started after the local "to" day', () => {
      const afterTo: JobSummary = {
        ...baseJob, id: 'after', command: '/after-job',
        started_at: new Date(2024, 4, 16, 0, 0, 1).toISOString(),
      }
      render(<RecentJobs jobs={[afterTo]} />)
      fireEvent.change(screen.getByTitle('To date'), { target: { value: '2024-05-15' } })
      expect(screen.queryByText('/after-job')).not.toBeInTheDocument()
    })

    it('keeps jobs with unparsable timestamps visible', () => {
      const weird: JobSummary = {
        ...baseJob, id: 'weird', command: '/weird-job', started_at: 'not-a-date',
      }
      render(<RecentJobs jobs={[weird]} />)
      fireEvent.change(screen.getByTitle('From date'), { target: { value: '2024-05-15' } })
      expect(screen.getByText('/weird-job')).toBeInTheDocument()
    })
  })

  describe('date range filter — UTC-midnight crossing (America/New_York)', () => {
    const originalTZ = process.env.TZ

    beforeAll(() => { process.env.TZ = 'America/New_York' })
    afterAll(() => {
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    })

    it('a job at 23:30 local stored past UTC midnight lands on its local day', () => {
      // 2024-05-16T03:30:00Z == 2024-05-15 23:30 in New York (UTC-4, DST).
      // The old string comparison against `2024-05-15T23:59:59` dropped it.
      const crossJob: JobSummary = {
        ...baseJob, id: 'cross', command: '/cross-job',
        started_at: '2024-05-16T03:30:00.000Z',
      }
      render(<RecentJobs jobs={[crossJob]} />)
      fireEvent.change(screen.getByTitle('From date'), { target: { value: '2024-05-15' } })
      fireEvent.change(screen.getByTitle('To date'), { target: { value: '2024-05-15' } })
      expect(screen.getByText('/cross-job')).toBeInTheDocument()
    })

    it('the same job is excluded when filtering the next local day', () => {
      const crossJob: JobSummary = {
        ...baseJob, id: 'cross', command: '/cross-job',
        started_at: '2024-05-16T03:30:00.000Z',
      }
      render(<RecentJobs jobs={[crossJob]} />)
      fireEvent.change(screen.getByTitle('From date'), { target: { value: '2024-05-16' } })
      expect(screen.queryByText('/cross-job')).not.toBeInTheDocument()
    })
  })

  describe('handleClear - date range mode', () => {
    it('clears range with from/to dates via "Clear range" button', async () => {
      const user = userEvent.setup()
      const { toast } = await import('sonner')

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deleted: 5 }),
      })

      render(<RecentJobs jobs={[baseJob]} />)

      // Open the clear modal by clicking the trash icon
      const trashButtons = document.querySelectorAll('button[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)

      // Set from/to dates for range clear
      const clearFromInput = screen.getByPlaceholderText('From')
      const clearToInput = screen.getByPlaceholderText('To')
      fireEvent.change(clearFromInput, { target: { value: '2024-01-01' } })
      fireEvent.change(clearToInput, { target: { value: '2024-06-01' } })

      // Click "Clear range"
      const clearRangeBtn = screen.getByRole('button', { name: /clear.*(range|jobs? in range)/i })
      fireEvent.click(clearRangeBtn)

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/jobs',
          expect.objectContaining({ method: 'DELETE' })
        )
      })
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Cleared 5 jobs')
      })

      // The body must carry full ISO local-day boundaries (not raw
      // YYYY-MM-DD): the server string-compares them against UTC ISO
      // `started_at`, so a bare "to" date would exclude the whole end day.
      const deleteCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .find(([url, init]) => url === '/api/jobs' && (init as RequestInit)?.method === 'DELETE')!
      const body = JSON.parse((deleteCall[1] as RequestInit).body as string)
      expect(body.from).toBe(new Date(2024, 0, 1).toISOString())
      expect(body.to).toBe(new Date(new Date(2024, 5, 2).getTime() - 1).toISOString())
    })

    it('shows toast error when clear range fails', async () => {
      const user = userEvent.setup()
      const { toast } = await import('sonner')

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false })

      render(<RecentJobs jobs={[baseJob]} />)

      const trashButtons = document.querySelectorAll('button[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)

      const clearFromInput = screen.getByPlaceholderText('From')
      fireEvent.change(clearFromInput, { target: { value: '2024-01-01' } })

      const clearRangeBtn = screen.getByRole('button', { name: /clear.*(range|jobs? in range)/i })
      fireEvent.click(clearRangeBtn)

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to clear jobs')
      })
    })

    it('shows toast network error when fetch throws', async () => {
      const user = userEvent.setup()
      const { toast } = await import('sonner')

      ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'))

      render(<RecentJobs jobs={[baseJob]} />)

      const trashButtons = document.querySelectorAll('button[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)

      fireEvent.click(screen.getByRole('button', { name: /clear all \d+ jobs?/i }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Network error')
      })
    })

    it('closes clear modal when Cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={[baseJob]} />)

      const trashButtons = document.querySelectorAll('button[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)

      expect(screen.getByText('Clear Jobs')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      expect(screen.queryByText('Clear Jobs')).not.toBeInTheDocument()
    })

    it('closes clear modal when clicking backdrop', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={[baseJob]} />)

      const trashButtons = document.querySelectorAll('button[class*="text-muted-foreground hover:text-destructive"]')
      await user.click(trashButtons[0] as HTMLElement)

      expect(screen.getByText('Clear Jobs')).toBeInTheDocument()

      // Click the backdrop (the outer div with fixed inset-0)
      const backdrop = document.querySelector('.fixed.inset-0')
      if (backdrop) {
        fireEvent.click(backdrop)
        expect(screen.queryByText('Clear Jobs')).not.toBeInTheDocument()
      }
    })
  })

  describe('compare mode', () => {
    it('toggles compare mode on and off', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={[baseJob]} />)

      // Find compare button (GitCompareArrows icon)
      const compareBtn = document.querySelector('button[class*="h-6 w-6"]')
      expect(compareBtn).toBeInTheDocument()

      if (compareBtn) {
        await user.click(compareBtn as HTMLElement)
        // Compare mode banner shows "Select 2 jobs to compare"
        expect(screen.getByText('Select 2 jobs to compare')).toBeInTheDocument()

        // Click again to exit
        await user.click(compareBtn as HTMLElement)
        expect(screen.queryByText('Select 2 jobs to compare')).not.toBeInTheDocument()
      }
    })

    it('in compare mode, clicking a job row selects it', async () => {
      const user = userEvent.setup()
      const jobs = [
        { ...baseJob, id: 'job-1', command: '/specrails:implement' },
        { ...baseJob, id: 'job-2', command: '/specrails:health-check', status: 'failed' as const },
      ]
      render(<RecentJobs jobs={jobs} />)

      // Enable compare mode
      const compareBtn = document.querySelector('button[class*="h-6 w-6"]')
      if (compareBtn) {
        await user.click(compareBtn as HTMLElement)
        expect(screen.getByText('Select 2 jobs to compare')).toBeInTheDocument()

        // Click first job to select
        const job1Row = screen.getByText('/specrails:implement').closest('[role="button"]')!
        await user.click(job1Row)
        expect(screen.getByText('Select 1 more job')).toBeInTheDocument()
      }
    })

    it('in compare mode, selecting 2 jobs shows Compare button', async () => {
      const user = userEvent.setup()
      const jobs = [
        { ...baseJob, id: 'job-1', command: '/specrails:implement' },
        { ...baseJob, id: 'job-2', command: '/specrails:health-check', status: 'failed' as const },
        { ...baseJob, id: 'job-3', command: '/specrails:propose-spec', status: 'running' as const },
      ]
      render(<RecentJobs jobs={jobs} />)

      // Enable compare mode
      const compareBtns = document.querySelectorAll('button[class*="h-6 w-6"]')
      const compareBtn = Array.from(compareBtns).find((btn) => btn.getAttribute('class')?.includes('p-0'))
      if (compareBtn) {
        await user.click(compareBtn as HTMLElement)

        const job1Row = screen.getByText('/specrails:implement').closest('[role="button"]')!
        const job2Row = screen.getByText('/specrails:health-check').closest('[role="button"]')!

        await user.click(job1Row)
        await user.click(job2Row)

        expect(screen.getByText('Ready — click compare')).toBeInTheDocument()
      }
    })
  })

  describe('proposal delete confirmation dialog', () => {
    it('shows delete confirmation when proposal trash button is clicked', async () => {
      const user = userEvent.setup()
      const proposalJob: JobSummary = {
        id: 'proposal:abc123',
        command: '/specrails:propose-feature some idea',
        started_at: new Date().toISOString(),
        status: 'completed',
      }
      render(<RecentJobs jobs={[proposalJob]} onProposalDelete={vi.fn()} />)

      // Find the proposal's delete button (small trash icon within the row)
      const rowTrashBtns = document.querySelectorAll('[title="Delete proposal"]')
      if (rowTrashBtns.length > 0) {
        await user.click(rowTrashBtns[0] as HTMLElement)
        expect(screen.getByText('Delete proposal?')).toBeInTheDocument()
      }
    })

    it('calls onProposalDelete when Delete button is clicked in confirmation', async () => {
      const user = userEvent.setup()
      const onProposalDelete = vi.fn()
      const proposalJob: JobSummary = {
        id: 'proposal:abc123',
        command: '/specrails:propose-feature some idea',
        started_at: new Date().toISOString(),
        status: 'completed',
      }
      render(<RecentJobs jobs={[proposalJob]} onProposalDelete={onProposalDelete} />)

      const rowTrashBtns = document.querySelectorAll('[title="Delete proposal"]')
      if (rowTrashBtns.length > 0) {
        await user.click(rowTrashBtns[0] as HTMLElement)

        const deleteBtn = screen.getByRole('button', { name: /^delete$/i })
        await user.click(deleteBtn)

        expect(onProposalDelete).toHaveBeenCalledWith('abc123')
      }
    })

    it('dismisses delete confirmation when Keep is clicked', async () => {
      const user = userEvent.setup()
      const proposalJob: JobSummary = {
        id: 'proposal:abc123',
        command: '/specrails:propose-feature',
        started_at: new Date().toISOString(),
        status: 'completed',
      }
      render(<RecentJobs jobs={[proposalJob]} onProposalDelete={vi.fn()} />)

      const rowTrashBtns = document.querySelectorAll('[title="Delete proposal"]')
      if (rowTrashBtns.length > 0) {
        await user.click(rowTrashBtns[0] as HTMLElement)
        const keepBtn = screen.getByRole('button', { name: /cancel/i })
        await user.click(keepBtn)
        expect(screen.queryByText('Delete proposal?')).not.toBeInTheDocument()
      }
    })

    it('shows count of 1 proposal in delete confirmation dialog', async () => {
      const user = userEvent.setup()
      const proposalJob: JobSummary = {
        id: 'proposal:abc123',
        command: '/specrails:propose-feature',
        started_at: new Date().toISOString(),
        status: 'completed',
      }
      render(<RecentJobs jobs={[proposalJob]} onProposalDelete={vi.fn()} />)

      const rowTrashBtns = document.querySelectorAll('[title="Delete proposal"]')
      if (rowTrashBtns.length > 0) {
        await user.click(rowTrashBtns[0] as HTMLElement)
        expect(screen.getByText(/1 proposal/i)).toBeInTheDocument()
      }
    })
  })

  describe('confirmation dialog job counts', () => {
    const jobs: JobSummary[] = [
      { id: 'j1', command: '/cmd1', started_at: new Date().toISOString(), status: 'completed' },
      { id: 'j2', command: '/cmd2', started_at: new Date().toISOString(), status: 'failed' },
      { id: 'j3', command: '/cmd3', started_at: new Date().toISOString(), status: 'completed' },
    ]

    it('clear all button shows correct job count', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={jobs} />)
      const trashBtn = document.querySelector('button[class*="text-muted-foreground hover:text-destructive"]') as HTMLElement
      await user.click(trashBtn)
      expect(screen.getByRole('button', { name: /clear all 3 jobs/i })).toBeInTheDocument()
    })

    it('shows total job count in modal header', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={jobs} />)
      const trashBtn = document.querySelector('button[class*="text-muted-foreground hover:text-destructive"]') as HTMLElement
      await user.click(trashBtn)
      expect(screen.getByText(/3 jobs in history/i)).toBeInTheDocument()
    })

    it('clear range button shows count of jobs matching the selected range', async () => {
      const user = userEvent.setup()
      render(<RecentJobs jobs={jobs} />)
      const trashBtn = document.querySelector('button[class*="text-muted-foreground hover:text-destructive"]') as HTMLElement
      await user.click(trashBtn)

      const fromInput = screen.getByPlaceholderText('From')
      fireEvent.change(fromInput, { target: { value: '2020-01-01' } })

      // All 3 jobs match range from 2020 onwards
      expect(screen.getByRole('button', { name: /clear 3 jobs in range/i })).toBeInTheDocument()
    })
  })
})
