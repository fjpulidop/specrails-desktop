import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import JobDetailPage from '../JobDetailPage'
import type { JobSummary, EventRow } from '../../types'

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
vi.mock('../../lib/markdown-detect', () => ({
  hasMarkdownSyntax: () => false,
}))

const mockNavigate = vi.fn()

// Mock useParams + useNavigate
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ id: 'job-abc123' }),
    useNavigate: () => mockNavigate,
  }
})

// Mock useDesktop
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [],
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

// Mock useSharedWebSocket
const mockRegisterHandler = vi.fn()
const mockUnregisterHandler = vi.fn()
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: mockRegisterHandler,
    unregisterHandler: mockUnregisterHandler,
    connectionStatus: 'connected',
  }),
}))

const mockJob: JobSummary = {
  id: 'job-abc123',
  command: '/specrails:implement',
  started_at: '2024-01-15T10:00:00Z',
  finished_at: '2024-01-15T10:00:30Z',
  status: 'completed',
  total_cost_usd: 0.05,
  duration_ms: 30000,
  model: 'claude-sonnet-4-5',
}

const mockEvents: EventRow[] = [
  {
    id: 1,
    job_id: 'job-abc123',
    seq: 1,
    event_type: 'log',
    source: 'stdout',
    payload: JSON.stringify({ line: 'Starting implementation...' }),
    timestamp: '2024-01-15T10:00:01Z',
  },
]

describe('JobDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockClear()
  })

  it('shows loading state initially', () => {
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {}))
    const { container } = render(<JobDetailPage />)
    const pulseElements = container.querySelectorAll('.animate-pulse')
    expect(pulseElements.length).toBeGreaterThan(0)
  })

  it('renders job details when job is found', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
    })
  })

  it('shows job status badge', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument()
    })
  })

  it('shows breadcrumb with job id', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByText(/Job #job-abc1/i)).toBeInTheDocument()
    })
  })

  it('shows 404 state when job not found (404 response)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByText(/Job not found/i)).toBeInTheDocument()
    })
  })

  it('shows 404 state when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByText(/Job not found/i)).toBeInTheDocument()
    })
  })

  it('shows Back to Dashboard link in 404 state', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Back to Dashboard/i })).toBeInTheDocument()
    })
  })

  it('does not show Cancel Job button for completed jobs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Cancel Job/i })).not.toBeInTheDocument()
  })

  it('shows Cancel Job button for running jobs', async () => {
    const runningJob = { ...mockJob, status: 'running' as const }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: runningJob, events: [] }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel Job/i })).toBeInTheDocument()
    })
  })

  it('Cancel button sends an explicit POST cancel request', async () => {
    const user = userEvent.setup()
    const runningJob = { ...mockJob, status: 'running' as const }
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ job: runningJob, events: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel Job/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /Cancel Job/i }))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/jobs/job-abc123/cancel',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  it('registers WebSocket handler on mount', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(mockRegisterHandler).toHaveBeenCalled()
    })
  })

  it('re-fetches job when queue message transitions job to completed', async () => {
    const runningJob = { ...mockJob, status: 'running' as const, duration_ms: null, total_cost_usd: null }
    const completedJob = { ...mockJob, status: 'completed' as const, duration_ms: 30000, total_cost_usd: 0.05 }

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ job: runningJob, events: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ job: completedJob, events: mockEvents }) })

    render(<JobDetailPage />)
    await waitFor(() => {
      expect(mockRegisterHandler).toHaveBeenCalled()
    })

    const handler = mockRegisterHandler.mock.calls[0][1]
    handler({ type: 'queue', projectId: 'proj-1', jobs: [{ id: 'job-abc123', status: 'completed' }] })

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(global.fetch).toHaveBeenLastCalledWith('/api/jobs/job-abc123')
    })
  })

  it('renders log viewer section', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      // LogViewer shows the log line
      expect(screen.getByText('Starting implementation...')).toBeInTheDocument()
    })
  })

  it('renders Dashboard link in breadcrumb', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Dashboard/i })).toBeInTheDocument()
    })
  })

  it('shows Re-execute button for completed jobs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockJob, events: mockEvents }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-execute/i })).toBeInTheDocument()
    })
  })

  it('shows Re-execute button for failed jobs', async () => {
    const failedJob = { ...mockJob, status: 'failed' as const }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: failedJob, events: [] }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-execute/i })).toBeInTheDocument()
    })
  })

  it('does not show Re-execute button for running jobs', async () => {
    const runningJob = { ...mockJob, status: 'running' as const }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: runningJob, events: [] }),
    })
    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel Job/i })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Re-execute/i })).not.toBeInTheDocument()
  })

  it('Re-execute spawns new job and navigates to new job detail', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ job: mockJob, events: mockEvents }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobId: 'new-job-id' }) })

    render(<JobDetailPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-execute/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /Re-execute/i }))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/spawn',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
          body: JSON.stringify({ command: '/specrails:implement' }),
        })
      )
      expect(mockNavigate).toHaveBeenCalledWith('/jobs/new-job-id')
    })
  })

  it('coalesces rapid Re-execute clicks into one billable spawn', async () => {
    let resolveSpawn!: (value: unknown) => void
    const pendingSpawn = new Promise((resolve) => { resolveSpawn = resolve })
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ job: mockJob, events: mockEvents }) })
      .mockImplementationOnce(() => pendingSpawn)

    render(<JobDetailPage />)
    const button = await screen.findByRole('button', { name: /Re-execute/i })
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(button).toBeDisabled()
    resolveSpawn({ ok: true, json: async () => ({ jobId: 'new-job-id' }) })
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/jobs/new-job-id'))
  })

  describe('Export diagnostic', () => {
    it('shows Export diagnostic button when hasTelemetry is true', async () => {
      const telemetryJob = { ...mockJob, hasTelemetry: true }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: telemetryJob, events: mockEvents }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Export diagnostic/i })).toBeInTheDocument()
      })
    })

    it('Export diagnostic click fetches the endpoint and triggers blob download', async () => {
      const user = userEvent.setup()
      const telemetryJob = { ...mockJob, hasTelemetry: true }
      const fakeBlob = new Blob(['zip-bytes'], { type: 'application/zip' })
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ job: telemetryJob, events: mockEvents }) })
        .mockResolvedValueOnce({ ok: true, blob: async () => fakeBlob })

      // jsdom URL.createObjectURL / revokeObjectURL shims
      const origCreate = URL.createObjectURL
      const origRevoke = URL.revokeObjectURL
      URL.createObjectURL = vi.fn(() => 'blob:mock-url')
      URL.revokeObjectURL = vi.fn()

      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Export diagnostic/i })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: /Export diagnostic/i }))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/jobs/job-abc123/diagnostic')
        expect(URL.createObjectURL).toHaveBeenCalledWith(fakeBlob)
      })
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    })

    it('does NOT show Export diagnostic when hasTelemetry is false', async () => {
      const noTelJob = { ...mockJob, hasTelemetry: false }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: noTelJob, events: mockEvents }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /Export diagnostic/i })).not.toBeInTheDocument()
    })

    it('does NOT show Export diagnostic when hasTelemetry is undefined', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: mockJob, events: mockEvents }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /Export diagnostic/i })).not.toBeInTheDocument()
    })
  })

  describe('Status panel gate', () => {
    it('renders the status panel for running jobs (no completion gate)', async () => {
      const runningJob = { ...mockJob, status: 'running' as const, finished_at: null, total_cost_usd: null }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: runningJob, events: [] }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('Job in progress')).toBeInTheDocument()
      })
    })
  })

  describe('Ticket identity card', () => {
    const baseJob = { ...mockJob, command: '/specrails:implement #24 --yes' }

    it('renders the ticket card when job has tickets', async () => {
      const jobWithTickets = {
        ...baseJob,
        tickets: [{ id: 24, title: 'Add live job status' }],
      } as JobSummary
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: jobWithTickets, events: [] }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('Add live job status')).toBeInTheDocument()
      })
      expect(screen.getByText('#24')).toBeInTheDocument()
    })

    it('falls back to legacy header when job has no tickets', async () => {
      const noTickets = { ...mockJob, tickets: [] } as JobSummary
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: noTickets, events: [] }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
      })
      expect(screen.queryByText(/(deleted)/)).not.toBeInTheDocument()
    })

    it('renders deleted ticket as muted chip without title', async () => {
      const deletedTicket = {
        ...baseJob,
        tickets: [{ id: 24, title: null }],
      } as JobSummary
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: deletedTicket, events: [] }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('#24 (deleted)')).toBeInTheDocument()
      })
    })

    it('renders compact mode with "+ N more" when 4+ tickets, expand reveals all', async () => {
      const user = userEvent.setup()
      const manyTickets = {
        ...baseJob,
        tickets: [
          { id: 1, title: 'First ticket' },
          { id: 2, title: 'Second ticket' },
          { id: 3, title: 'Third ticket' },
          { id: 4, title: 'Fourth ticket' },
          { id: 5, title: 'Fifth ticket' },
        ],
      } as JobSummary
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: manyTickets, events: [] }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('First ticket')).toBeInTheDocument()
      })
      // Initially compact: only first title visible.
      expect(screen.queryByText('Second ticket')).not.toBeInTheDocument()
      expect(screen.getByText(/\+ 4 more/i)).toBeInTheDocument()

      await user.click(screen.getByText(/\+ 4 more/i))
      expect(screen.getByText('Second ticket')).toBeInTheDocument()
      expect(screen.getByText('Fifth ticket')).toBeInTheDocument()
    })
  })

  describe('Loop-step explorer (loop jobs only)', () => {
    const loopJob: JobSummary = {
      ...mockJob,
      command: 'loop: Nightly refactor',
      status: 'running',
      finished_at: null,
      total_cost_usd: null,
      duration_ms: null,
    }
    const loopEvents: EventRow[] = [
      {
        id: 1,
        job_id: 'job-abc123',
        seq: 0,
        event_type: 'log',
        source: 'stdout',
        payload: JSON.stringify({ line: '▶ Loop "Nightly refactor" started' }),
        timestamp: '2024-01-15T10:00:01Z',
      },
      {
        id: 2,
        job_id: 'job-abc123',
        seq: 1,
        event_type: 'loop_step',
        source: 'stdout',
        payload: JSON.stringify({ index: 1, kind: 'ai-step', title: '🤖 Implement', nodeId: 'ai1', iteration: 0 }),
        timestamp: '2024-01-15T10:00:02Z',
      },
      {
        id: 3,
        job_id: 'job-abc123',
        seq: 2,
        event_type: 'log',
        source: 'stdout',
        payload: JSON.stringify({ line: 'step output line' }),
        timestamp: '2024-01-15T10:00:03Z',
      },
    ]

    it('replaces the phase-grouped LogViewer with the explorer for loop jobs', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: loopJob, events: loopEvents }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByTestId('loop-step-explorer')).toBeInTheDocument()
      })
      // The step box renders with the cleaned title (also echoed on the strip
      // chip) and the live step line
      expect(screen.getAllByTestId('loop-step-section')).toHaveLength(1)
      expect(screen.getAllByText('Implement').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('step output line')).toBeInTheDocument()
    })

    it('regression pin: non-loop jobs keep the legacy LogViewer (no explorer)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: mockJob, events: mockEvents }),
      })
      render(<JobDetailPage />)
      await waitFor(() => {
        expect(screen.getByText('Starting implementation...')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('loop-step-explorer')).not.toBeInTheDocument()
      expect(screen.queryByTestId('loop-overview-strip')).not.toBeInTheDocument()
    })
  })

  describe('Interactive freestyle session', () => {
    const interactiveJob: JobSummary = {
      ...mockJob,
      command: '/specrails:freestyle #1 --yes',
      status: 'running',
      finished_at: null,
      interactive: 1,
    }

    it('shows Finalize + composer and posts to the finalize and messages endpoints', async () => {
      const user = userEvent.setup()
      const calls: Array<{ url: string; method?: string }> = []
      global.fetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
        calls.push({ url: String(url), method: opts?.method })
        return Promise.resolve({ ok: true, json: async () => ({ job: interactiveJob, events: [] }) })
      }) as unknown as typeof fetch

      render(<JobDetailPage />)
      await waitFor(() => expect(screen.getByText('Finalize Job')).toBeInTheDocument())

      const textarea = screen.getByPlaceholderText(/Send a message to the running job/i)
      await user.type(textarea, 'add error handling')
      await user.click(screen.getByRole('button', { name: /Send/i }))
      await waitFor(() =>
        expect(calls.some((c) => c.url.endsWith('/jobs/job-abc123/messages') && c.method === 'POST')).toBe(true),
      )

      await user.click(screen.getByText('Finalize Job'))
      await waitFor(() =>
        expect(calls.some((c) => c.url.endsWith('/jobs/job-abc123/finalize') && c.method === 'POST')).toBe(true),
      )
    })

    it('does not show the composer for a non-interactive running job', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ job: { ...interactiveJob, interactive: 0 }, events: [] }),
      }) as unknown as typeof fetch
      render(<JobDetailPage />)
      await waitFor(() => expect(screen.getByText('/specrails:freestyle #1 --yes')).toBeInTheDocument())
      expect(screen.queryByText('Finalize Job')).not.toBeInTheDocument()
      expect(screen.queryByPlaceholderText(/Send a message to the running job/i)).not.toBeInTheDocument()
    })
  })

})
