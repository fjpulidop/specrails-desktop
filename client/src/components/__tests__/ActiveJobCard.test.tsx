import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { render } from '../../test-utils'
import { ActiveJobCard } from '../ActiveJobCard'
import type { QueueJob, PhaseMap } from '../../hooks/usePipeline'
import type { PhaseDefinition } from '../../types'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

const mockPhaseDefinitions: PhaseDefinition[] = [
  { key: 'architect', label: 'Architect', description: 'Design the solution' },
  { key: 'developer', label: 'Developer', description: 'Implement the solution' },
]

const mockActiveJob: QueueJob = {
  id: 'job-active-1',
  command: '/architect --spec SPEA-001',
  status: 'running',
  queuePosition: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  exitCode: null,
}

describe('ActiveJobCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('when there is no active job', () => {
    it('renders "No active job" message', () => {
      render(<ActiveJobCard activeJob={null} phases={{}} phaseDefinitions={[]} />)
      expect(screen.getByText('No active job')).toBeInTheDocument()
    })

    it('renders "Select a command below to start a job"', () => {
      render(<ActiveJobCard activeJob={null} phases={{}} phaseDefinitions={[]} />)
      expect(screen.getByText(/select a command/i)).toBeInTheDocument()
    })
  })

  describe('when there is an active job', () => {
    it('renders the job command', () => {
      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      expect(screen.getByText('/architect --spec SPEA-001')).toBeInTheDocument()
    })

    it('renders "running" badge', () => {
      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      expect(screen.getByText('running')).toBeInTheDocument()
    })

    it('renders phase definitions', () => {
      const phases: PhaseMap = { architect: 'running', developer: 'idle' }
      render(<ActiveJobCard activeJob={mockActiveJob} phases={phases} phaseDefinitions={mockPhaseDefinitions} />)
      expect(screen.getByText('Architect')).toBeInTheDocument()
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    it('renders Cancel button', () => {
      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })

    it('renders View Logs link', () => {
      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      expect(screen.getByRole('link', { name: /view logs/i })).toBeInTheDocument()
    })

    it('View Logs link points to the job detail page', () => {
      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      const link = screen.getByRole('link', { name: /view logs/i })
      expect(link).toHaveAttribute('href', '/jobs/job-active-1')
    })

    it('calls POST /jobs/:id/cancel when Cancel is clicked and shows toast', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true })
      const { toast } = await import('sonner')

      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/projects/proj-1/jobs/job-active-1/cancel',
          expect.objectContaining({ method: 'POST' })
        )
        expect(toast.success).toHaveBeenCalled()
      })
    })

    it('shows toast.error when cancel request fails', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Job not found' }),
      })
      const { toast } = await import('sonner')

      render(<ActiveJobCard activeJob={mockActiveJob} phases={{}} phaseDefinitions={[]} />)
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled()
      })
    })
  })

  describe('phase states', () => {
    it('renders done phase correctly', () => {
      const phases: PhaseMap = { architect: 'done', developer: 'idle' }
      render(<ActiveJobCard activeJob={mockActiveJob} phases={phases} phaseDefinitions={mockPhaseDefinitions} />)
      // No crash — phase "done" renders with checkmark
      expect(screen.getByText('Architect')).toBeInTheDocument()
    })

    it('renders error phase correctly', () => {
      const phases: PhaseMap = { architect: 'error' }
      render(
        <ActiveJobCard
          activeJob={mockActiveJob}
          phases={phases}
          phaseDefinitions={[{ key: 'architect', label: 'Architect', description: 'Design' }]}
        />
      )
      expect(screen.getByText('Architect')).toBeInTheDocument()
    })
  })
})
