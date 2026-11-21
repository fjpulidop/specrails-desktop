import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '../../../../test-utils'
import { RailControls } from '../RailControls'

const wsHandlers = new Map<string, (msg: unknown) => void>()
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (msg: unknown) => void) => { wsHandlers.set(id, fn) },
    unregisterHandler: (id: string) => { wsHandlers.delete(id) },
  }),
}))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

/** The server's pause control for job-1, and the Pause/Resume calls the rail makes. */
let serverControl: string | null = null
const calls: string[] = []
function stubPauseServer() {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/pause-control')) return { ok: true, json: async () => ({ loopRunId: 'job-1', pauseControl: serverControl }) }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => mockNavigate }
})

const defaultProps = {
  mode: 'implement' as const,
  status: 'idle' as const,
  ticketCount: 2,
  onModeChange: vi.fn(),
  onToggle: vi.fn(),
}

describe('RailControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serverControl = null
    calls.length = 0
    stubPauseServer()
  })

  it('offers Pause next to Stop for a running run whose Core can pause, then Pausing…, then Paused by you + Resume', async () => {
    serverControl = 'pause'
    render(<RailControls {...defaultProps} status="running" activeJobId="job-1" projectId="p2" />)
    const pause = await screen.findByTestId('rail-pause')
    expect(pause).toHaveAccessibleName('Pause')
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
    expect(calls.some((call) => call.startsWith('GET ') && call.endsWith('/api/projects/p2/loop-runs/job-1/pause-control'))).toBe(true)
    await act(async () => { fireEvent.click(pause) })
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/api/projects/p2/loop-runs/job-1/pause'))).toBe(true)
    // Accepted: Pausing… until Core parks the run at the next step boundary.
    expect(await screen.findByTestId('rail-pausing')).toBeDisabled()
    serverControl = 'resume'
    act(() => { for (const handler of wsHandlers.values()) handler({ type: 'loop.run_paused', loopRunId: 'job-1', pauseKind: 'user_paused' }) })
    expect(await screen.findByTestId('rail-paused-by-you')).toHaveTextContent('Paused by you')
    await act(async () => { fireEvent.click(screen.getByTestId('rail-resume')) })
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/loop-runs/job-1/resume'))).toBe(true)
  })

  it('shows no Pause for a run that cannot pause (legacy engine, older Core, held on something else), nor while idle', async () => {
    serverControl = null
    const { rerender } = render(<RailControls {...defaultProps} status="running" activeJobId="job-1" />)
    await waitFor(() => expect(calls.some((call) => call.endsWith('/pause-control'))).toBe(true))
    expect(screen.queryByTestId('rail-pause')).not.toBeInTheDocument()
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
    // Core answered that it can pause: the rail re-reads its control.
    serverControl = 'pause'
    act(() => { for (const handler of wsHandlers.values()) handler({ type: 'loop.pause_support', loopRunId: 'job-1', supported: true }) })
    expect(await screen.findByTestId('rail-pause')).toBeInTheDocument()
    // Another run's frames are not this rail's.
    calls.length = 0
    act(() => { for (const handler of wsHandlers.values()) handler({ type: 'loop.pause_support', loopRunId: 'job-2', supported: true }) })
    expect(calls).toEqual([])
    rerender(<RailControls {...defaultProps} status="idle" />)
    expect(screen.queryByTestId('rail-pause')).not.toBeInTheDocument()
  })

  it('renders the play button (mode selection moved to the rail Loop picker)', () => {
    render(<RailControls {...defaultProps} />)
    expect(screen.getByTitle('Play')).toBeInTheDocument()
    // The old mode segmented control is gone — RailControls no longer renders it.
    expect(screen.queryByText('Implement')).not.toBeInTheDocument()
    expect(screen.queryByText('Batch')).not.toBeInTheDocument()
  })

  it('calls onToggle when play button clicked', () => {
    render(<RailControls {...defaultProps} />)
    fireEvent.click(screen.getByTitle('Play'))
    expect(defaultProps.onToggle).toHaveBeenCalled()
  })

  it('shows Stop button while running', () => {
    render(<RailControls {...defaultProps} status="running" activeJobId="job-1" />)
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
  })

  it('shows View Log button while running with activeJobId', () => {
    render(<RailControls {...defaultProps} status="running" activeJobId="job-42" />)
    expect(screen.getByTitle('View job log')).toBeInTheDocument()
  })

  it('navigates to job log when View Log clicked', () => {
    render(<RailControls {...defaultProps} status="running" activeJobId="job-42" />)
    fireEvent.click(screen.getByTitle('View job log'))
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-42')
  })

  it('does not show View Log button when idle', () => {
    render(<RailControls {...defaultProps} status="idle" activeJobId="job-42" />)
    expect(screen.queryByTitle('View job log')).not.toBeInTheDocument()
  })

  it('does not show View Log button when running but no activeJobId', () => {
    render(<RailControls {...defaultProps} status="running" />)
    expect(screen.queryByTitle('View job log')).not.toBeInTheDocument()
  })

  it('shows failed state with retry title', () => {
    render(<RailControls {...defaultProps} status="failed" />)
    expect(screen.getByTitle('Job failed — click to retry')).toBeInTheDocument()
  })

  it('disables play button when no tickets', () => {
    render(<RailControls {...defaultProps} ticketCount={0} />)
    expect(screen.getByTitle('Add specs to this rail first')).toBeInTheDocument()
  })

  describe('Interactive toggle (removed)', () => {
    it('never renders a switch, even for loop rails', () => {
      render(<RailControls {...defaultProps} mode="loop" />)
      expect(screen.queryByRole('switch')).toBeNull()
    })
  })
})
