import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../../../test-utils'
import { JobComparisonModal } from '../JobComparisonModal'

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api',
}))

const mockCompareResponse = {
  jobs: [
    {
      id: 'job-aaa111',
      command: '/specrails:implement --spec SPEA-001',
      status: 'completed',
      startedAt: '2024-03-21T10:00:00Z',
      finishedAt: '2024-03-21T10:01:02Z',
      durationMs: 62000,
      totalCostUsd: 0.0234,
      tokensIn: 5000,
      tokensOut: 3000,
      tokensCacheRead: 0,
      model: 'claude-opus-4',
      phasesCompleted: ['architect', 'developer', 'reviewer'],
    },
    {
      id: 'job-bbb222',
      command: '/specrails:implement --spec SPEA-002',
      status: 'failed',
      startedAt: '2024-03-21T11:00:00Z',
      finishedAt: '2024-03-21T11:00:30Z',
      durationMs: 30000,
      totalCostUsd: 0.0123,
      tokensIn: 3000,
      tokensOut: 1500,
      tokensCacheRead: 0,
      model: 'claude-opus-4',
      phasesCompleted: ['architect'],
    },
  ],
}

describe('JobComparisonModal', () => {
  const onClose = vi.fn()
  const jobIds: [string, string] = ['job-aaa111', 'job-bbb222']

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockCompareResponse,
    })
  })

  it('renders "Job Comparison" heading', () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    expect(screen.getByText('Job Comparison')).toBeInTheDocument()
  })

  it('shows loading skeleton while fetching', () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    // ui/dialog portals the content to document.body.
    const skeleton = document.body.querySelector('[aria-busy="true"]')
    expect(skeleton).toBeInTheDocument()
  })

  it('renders job commands after successful fetch', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
      expect(screen.getByText('/specrails:implement --spec SPEA-002')).toBeInTheDocument()
    })
  })

  it('renders "Job 1" and "Job 2" column headers', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Job 1')).toBeInTheDocument()
      expect(screen.getByText('Job 2')).toBeInTheDocument()
    })
  })

  it('renders Duration metric row', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Duration')).toBeInTheDocument()
    })
  })

  it('renders formatted duration values', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      // 62000ms → 1m 2s
      expect(screen.getByText('1m 2s')).toBeInTheDocument()
      // 30000ms → 30s
      expect(screen.getByText('30s')).toBeInTheDocument()
    })
  })

  it('renders Cost metric row', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Cost')).toBeInTheDocument()
    })
  })

  it('renders formatted cost values', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('$0.02')).toBeInTheDocument()
      expect(screen.getByText('$0.01')).toBeInTheDocument()
    })
    // Both billed → the cheaper side is highlighted.
    expect(screen.getByText('$0.01').closest('.text-accent-success')).not.toBeNull()
  })

  it('marks an estimated cost with ~ and skips the cheaper-cost highlight', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} estimatedCost={[true, false]} />)
    await waitFor(() => {
      expect(screen.getByText('$0.01')).toBeInTheDocument()
    })
    const estimated = screen.getByText('$0.02', { exact: false })
    expect(estimated.textContent).toContain('~')
    expect(estimated.textContent).toContain('estimated')
    expect(screen.getByText('$0.01').closest('.text-accent-success')).toBeNull()
  })

  it('renders Tokens out row', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Tokens out')).toBeInTheDocument()
    })
  })

  it('renders formatted token values', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      // job-a tokensOut: 3000 and job-b tokensIn: 3000 → "3.0k" appears multiple times
      const threeK = screen.getAllByText('3K')
      expect(threeK.length).toBeGreaterThanOrEqual(1)
      // 1500 tokens → 1.5k
      expect(screen.getByText('1.5K')).toBeInTheDocument()
    })
  })

  it('shows error message when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText(/Failed to load comparison/)).toBeInTheDocument()
    })
  })

  it('is a labelled dialog and calls onClose on Escape', () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Job Comparison' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when the named close button is clicked', () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders job id prefix (first 8 chars)', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('job-aaa1')).toBeInTheDocument()
      expect(screen.getByText('job-bbb2')).toBeInTheDocument()
    })
  })

  it('renders status label for each job', async () => {
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Completed')).toBeInTheDocument()
      expect(screen.getByText('Failed')).toBeInTheDocument()
    })
  })

  it('renders "—" for null duration', async () => {
    const responseWithNulls = {
      jobs: [
        { ...mockCompareResponse.jobs[0], durationMs: null, tokensOut: null, totalCostUsd: null },
        { ...mockCompareResponse.jobs[1], durationMs: null, tokensOut: null, totalCostUsd: null },
      ],
    }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => responseWithNulls,
    })
    render(<JobComparisonModal jobIds={jobIds} onClose={onClose} />)
    await waitFor(() => {
      const dashes = screen.getAllByText('—')
      expect(dashes.length).toBeGreaterThanOrEqual(1)
    })
  })
})
