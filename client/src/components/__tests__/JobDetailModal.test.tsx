import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '../../test-utils'

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

// Capture the modal's WS handler so tests can feed live frames through it.
let wsHandler: ((data: unknown) => void) | null = null
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn((_url: string, handler: (d: unknown) => void) => {
    wsHandler = handler
    return { connectionStatus: 'connected' }
  }),
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

vi.mock('../loop-log/LoopStepExplorer', () => ({
  LoopStepExplorer: ({ events }: { events: unknown[] }) => (
    <div data-testid="loop-step-explorer">{events.length} loop events</div>
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
    wsHandler = null
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
    // Default path: active-project base from getApiBase() (mocked to '/api').
    expect(global.fetch).toHaveBeenCalledWith('/api/jobs/job-abc123')
  })

  it('an explicit projectId scopes every fetch to THAT project (agent-chat refs)', async () => {
    // Agent-chat ref chips open jobs from the mission's PINNED project, which
    // may differ from the active one — the modal must not call getApiBase().
    render(<JobDetailModal jobId="job-abc123" projectId="proj-x" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj-x/jobs/job-abc123')
  })

  it('PORTALS to document.body above the floating agent panel (board-mode job refs)', async () => {
    // Regression: agent-chat job-ref chips mount this modal from INSIDE the
    // floating AgentChatPanel (z-[60], backdrop-filter + transform + overflow-
    // hidden). Without a portal, the panel becomes the containing block for
    // the fixed overlay and clips it — the modal "never appears". The overlay
    // must escape to document.body and stack ABOVE the panel (z-[65] > z-[60]).
    const { render: bareRender, waitFor: bareWaitFor, screen: bareScreen } = await import('@testing-library/react')
    const { container } = bareRender(
      <div data-testid="floating-agent-panel" style={{ transform: 'translateY(0px)', overflow: 'hidden' }}>
        <JobDetailModal jobId="job-abc123" projectId="proj-x" onClose={onClose} />
      </div>,
    )
    await bareWaitFor(() => {
      expect(bareScreen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })
    const overlay = document.body.querySelector('div.fixed.inset-0')
    expect(overlay).not.toBeNull()
    expect(overlay!.classList.contains('z-[65]')).toBe(true)
    // Escaped the panel subtree: the overlay is NOT inside the render container.
    expect(container.contains(overlay)).toBe(false)
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

  it('renders the cancel-confirm IN-PORTAL inside the z-[65] modal (never a body-portalled Radix dialog behind it)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: mockRunningJob, events: [], phaseDefinitions: [] }),
    })
    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    const confirm = await screen.findByTestId('job-cancel-confirm')
    // The confirm lives WITHIN the modal's own z-[65] portal container — so it
    // shares that stacking context and sits above the panel, instead of a
    // Radix Dialog portalled to <body> at z-50 (which rendered BEHIND the modal).
    const modalRoot = document.querySelector('.fixed.inset-0.z-\\[65\\]')
    expect(modalRoot).not.toBeNull()
    expect(modalRoot!.contains(confirm)).toBe(true)
    // Escape dismisses the confirm first, NOT the whole modal.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('job-cancel-confirm')).not.toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('"Cancel job" button in dialog calls DELETE endpoint and refetches on success', async () => {
    const { toast } = await import('sonner')
    // First fetch = load job, second fetch = DELETE cancel, then the
    // success-path refetch (reconciliation without waiting for WS).
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          job: mockRunningJob,
          events: [],
          phaseDefinitions: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, status: 'canceling' }) })
      .mockResolvedValue({ ok: true, json: async () => ({ job: mockRunningJob }) })

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
    // Own-success reconciliation: a plain GET refetch follows the DELETE.
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(3)
    })
    expect(calls[2][0]).toBe('/api/jobs/job-running')
    expect(calls[2][1]).toBeUndefined()
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

  it('shows error toast WITH DETAIL on network error during cancel', async () => {
    // Regression (quota incident): a transport-level failure used to surface a
    // bare "Network error" toast with zero detail — the underlying message must
    // now ride along so the user knows WHY the cancel didn't land.
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
      .mockRejectedValueOnce(new Error('socket hang up'))

    render(<JobDetailModal jobId="job-running" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to cancel',
        expect.objectContaining({ description: 'socket hang up' })
      )
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

  it('does NOT render the open-in-new-tab anchor (removed — it never worked in the desktop webview)', async () => {
    render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })
    expect(document.querySelector('a[href="/jobs/job-abc123"]')).toBeNull()
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

  // ── Live log frames (mission mode) ──────────────────────────────────────────
  // Regression pin: the WS handler used to append ONLY stderr `log` frames, so
  // live stdout never grew the modal. It now appends both, matching
  // JobDetailPage's handler semantics.
  describe('live log frames', () => {
    it('appends live STDOUT log frames (stdout-fix pin)', async () => {
      const { act } = await import('@testing-library/react')
      render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
      await waitFor(() => expect(screen.getByTestId('log-viewer')).toHaveTextContent('0 events'))

      act(() => {
        wsHandler?.({
          type: 'log',
          processId: 'job-abc123',
          source: 'stdout',
          line: 'hello from stdout',
          timestamp: new Date().toISOString(),
        })
      })
      await waitFor(() => expect(screen.getByTestId('log-viewer')).toHaveTextContent('1 events'))
    })

    it('still appends stderr frames', async () => {
      const { act } = await import('@testing-library/react')
      render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
      await waitFor(() => expect(screen.getByTestId('log-viewer')).toHaveTextContent('0 events'))

      act(() => {
        wsHandler?.({
          type: 'log',
          processId: 'job-abc123',
          source: 'stderr',
          line: 'warning line',
          timestamp: new Date().toISOString(),
        })
      })
      await waitFor(() => expect(screen.getByTestId('log-viewer')).toHaveTextContent('1 events'))
    })

    it('ignores log frames addressed to OTHER processes', async () => {
      const { act } = await import('@testing-library/react')
      render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
      await waitFor(() => expect(screen.getByTestId('log-viewer')).toHaveTextContent('0 events'))

      act(() => {
        wsHandler?.({
          type: 'log',
          processId: 'someone-else',
          source: 'stdout',
          line: 'not for us',
          timestamp: new Date().toISOString(),
        })
      })
      // Give a rAF tick a chance, then assert nothing changed.
      await new Promise((r) => setTimeout(r, 50))
      expect(screen.getByTestId('log-viewer')).toHaveTextContent('0 events')
    })
  })

  // ── Loop jobs (mission mode) ────────────────────────────────────────────────
  describe('loop jobs', () => {
    it('mounts the LoopStepExplorer instead of LogViewer for loop: jobs', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          job: { ...mockRunningJob, command: 'loop: Nightly refactor' },
          events: [],
          phaseDefinitions: [],
        }),
      })
      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByTestId('loop-step-explorer')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('log-viewer')).not.toBeInTheDocument()
    })

    it('keeps the legacy LogViewer for non-loop jobs (regression pin)', async () => {
      render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByTestId('log-viewer')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('loop-step-explorer')).not.toBeInTheDocument()
    })
  })

  // ── Mission-mode interactive composer ──────────────────────────────────────
  // The Agent-Mode jobs pane opens this modal — the SAME InteractiveJobComposer
  // the board's Job Detail page uses mounts below the log for running
  // interactive jobs, so a mission user steers without leaving the workspace.
  describe('interactive composer (mission mode)', () => {
    it("mounts the composer for a running interactive job ('auto' → wrap-up, no Finalize)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          job: { ...mockRunningJob, interactive: 1, interactiveSettleMode: 'auto', interactiveAcceptingTurns: true },
          events: [],
          phaseDefinitions: [],
        }),
      })
      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByTestId('interactive-job-composer')).toBeInTheDocument()
      })
      expect(screen.getByPlaceholderText(/Send a message to the running job/i)).toBeInTheDocument()
      expect(screen.getByText('Wrap up now')).toBeInTheDocument()
      expect(screen.queryByText('Finalize Job')).not.toBeInTheDocument()
    })

    it("keeps Finalize semantics for a 'finalize' (ultracode) session", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          job: { ...mockRunningJob, interactive: 1, interactiveSettleMode: 'finalize', interactiveAcceptingTurns: true },
          events: [],
          phaseDefinitions: [],
        }),
      })
      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByText('Finalize Job')).toBeInTheDocument()
      })
    })

    it('does NOT mount the composer for a non-interactive running job', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          job: { ...mockRunningJob, interactive: 0 },
          events: [],
          phaseDefinitions: [],
        }),
      })
      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByText('running')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('interactive-job-composer')).not.toBeInTheDocument()
      // Regression: `job.interactive` is a SQLite 0/1 number, so the composer
      // guard must coerce to boolean. `{0 && …}` would leak a stray "0" text
      // node below the log panel — assert it never renders.
      expect(screen.queryByText('0')).not.toBeInTheDocument()
    })

    it('does NOT mount the composer for a finished interactive job', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          job: { ...mockJob, interactive: 1 },
          events: [],
          phaseDefinitions: [],
        }),
      })
      render(<JobDetailModal jobId="job-abc123" onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByText('completed')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('interactive-job-composer')).not.toBeInTheDocument()
    })
  })

  // ── Manager-aware cancel / stop (mission-mode bug: "el botón cancelar debe
  //    cancelar 100%") ─────────────────────────────────────────────────────────
  describe('cancel / stop (manager-aware)', () => {
    const mockLoopJob = {
      ...mockRunningJob,
      command: 'loop: Nightly refactor',
    }

    it('loop run: Stop button + confirm sends DELETE and toasts stop copy', async () => {
      const { toast } = await import('sonner')
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockLoopJob, events: [], phaseDefinitions: [] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, status: 'canceling' }) })
        .mockResolvedValue({ ok: true, json: async () => ({ job: mockLoopJob }) })

      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /^stop$/i }))

      await waitFor(() => expect(screen.getByText('Stop this run?')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /^stop run$/i }))

      await waitFor(() => {
        // Same manager-aware DELETE endpoint — the server routes a loop run
        // (railLoopRuns) to LoopRunManager.cancel.
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/jobs/job-running',
          expect.objectContaining({ method: 'DELETE' })
        )
        expect(toast.success).toHaveBeenCalledWith(
          'Stop signal sent',
          expect.objectContaining({ description: expect.stringContaining('step boundary') })
        )
      })
    })

    it('cancels against the EXPLICIT projectId (mission mode, cross-project pin)', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockRunningJob, events: [], phaseDefinitions: [] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, status: 'canceling' }) })
        .mockResolvedValue({ ok: true, json: async () => ({ job: mockRunningJob }) })

      render(<JobDetailModal jobId="job-running" projectId="proj-x" onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

      await waitFor(() => {
        // NEVER the active-project base — the pinned project's explicit path.
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/projects/proj-x/jobs/job-running',
          expect.objectContaining({ method: 'DELETE' })
        )
      })
    })

    it('interactive job: button and confirm use Discard semantics', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          job: { ...mockRunningJob, interactive: 1, interactiveSettleMode: 'auto', interactiveAcceptingTurns: true },
          events: [],
          phaseDefinitions: [],
        }),
      })
      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole('button', { name: /^discard$/i })).toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))
      await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
      // The in-portal confirm's destructive action ALSO reads "Discard" (same as
      // the header button, which is still in the DOM behind the confirm backdrop);
      // scope the click to the confirm container to disambiguate. Confirming
      // fires the same manager-aware DELETE.
      const confirm = screen.getByTestId('job-cancel-confirm')
      fireEvent.click(within(confirm).getByRole('button', { name: /^discard$/i }))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/jobs/job-running',
          expect.objectContaining({ method: 'DELETE' })
        )
      })
    })

    it('surfaces server detail + HTTP status on cancel failure (quota-incident pin)', async () => {
      const { toast } = await import('sonner')
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockRunningJob, events: [], phaseDefinitions: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: async () => ({ error: 'AI quota exceeded' }),
        })

      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Failed to cancel',
          expect.objectContaining({ description: 'AI quota exceeded (HTTP 429)' })
        )
      })
    })

    it('disables the button with a spinner while the cancel request is in flight', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockRunningJob, events: [], phaseDefinitions: [] }),
        })
        // DELETE hangs (the quota incident's failure mode) — the button must
        // visibly acknowledge the click instead of appearing dead.
        .mockReturnValueOnce(new Promise(() => {}))

      render(<JobDetailModal jobId="job-running" onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => expect(screen.getByText('Cancel job?')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
      })
      expect(document.querySelector('svg.animate-spin')).not.toBeNull()
    })
  })
})
