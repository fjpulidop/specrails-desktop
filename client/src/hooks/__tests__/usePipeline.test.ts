import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePipeline } from '../usePipeline'

// ─── Mock useSharedWebSocket ───────────────────────────────────────────────────

let wsHandler: ((msg: unknown) => void) | null = null

vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn((_id: string, fn: (msg: unknown) => void) => { wsHandler = fn }),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected' as const,
  }),
}))

// ─── Mock lib/api ──────────────────────────────────────────────────────────────

let mockProjectId = 'proj-pipeline'

vi.mock('../../lib/api', () => ({
  getApiBase: () => `/api/projects/${mockProjectId}`,
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('usePipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsHandler = null
    mockProjectId = 'proj-pipeline'
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
    })
  })

  it('initial state: empty phases, no logs, no jobs', () => {
    const { result } = renderHook(() => usePipeline('proj-pipeline'))
    expect(result.current.phases).toEqual({})
    expect(result.current.phaseDefinitions).toEqual([])
    expect(result.current.logLines).toEqual([])
    expect(result.current.recentJobs).toEqual([])
    expect(result.current.projectName).toBe('')
  })

  it('reloads recovered project state while preserving existing log lines', async () => {
    const { result } = renderHook(() => usePipeline('proj-pipeline'))
    await act(async () => {})
    act(() => { wsHandler?.({ type: 'log', projectId: 'proj-pipeline', line: 'retained log', source: 'stdout' }) })
    const fetchMock = vi.mocked(global.fetch)
    const calls = fetchMock.mock.calls.length
    act(() => { wsHandler?.({ type: 'desktop.project_recovered', projectId: 'other-project' }) })
    expect(fetchMock).toHaveBeenCalledTimes(calls)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ projectName: 'Recovered project', recentJobs: [{ id: 'recovered-job' }] }) } as Response)
    act(() => { wsHandler?.({ type: 'desktop.project_recovered', projectId: 'proj-pipeline' }) })
    await waitFor(() => expect(result.current.projectName).toBe('Recovered project'))
    expect(result.current.recentJobs[0].id).toBe('recovered-job')
    expect(result.current.logLines[0].line).toBe('retained log')
  })

  it('WS init message: sets phaseDefinitions, phases, projectName, recentJobs, queueState', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false })

    const { result } = renderHook(() => usePipeline('proj-pipeline'))

    act(() => {
      wsHandler?.({
        type: 'init',
        projectId: 'proj-pipeline',
        projectName: 'My Project',
        phaseDefinitions: [
          { key: 'architect', label: 'Architect', description: 'Design phase' },
          { key: 'developer', label: 'Developer', description: 'Dev phase' },
        ],
        phases: { architect: 'done', developer: 'running' },
        recentJobs: [{ id: 'job1', command: 'npm test', status: 'completed', started_at: '' }],
        queue: { jobs: [], activeJobId: null, paused: false },
        logBuffer: [],
      })
    })

    expect(result.current.projectName).toBe('My Project')
    expect(result.current.phaseDefinitions).toHaveLength(2)
    expect(result.current.phases).toEqual({ architect: 'done', developer: 'running' })
    expect(result.current.recentJobs).toHaveLength(1)
    expect(result.current.queueState.paused).toBe(false)
  })

  it('WS phase message: updates specific phase state', async () => {
    const { result } = renderHook(() => usePipeline('proj-pipeline'))

    act(() => {
      wsHandler?.({
        type: 'init',
        projectId: 'proj-pipeline',
        projectName: 'Test',
        phaseDefinitions: [{ key: 'architect', label: 'A', description: '' }],
        phases: { architect: 'idle' },
        recentJobs: [],
        queue: { jobs: [], activeJobId: null, paused: false },
        logBuffer: [],
      })
    })

    act(() => {
      wsHandler?.({ type: 'phase', projectId: 'proj-pipeline', phase: 'architect', state: 'running' })
    })

    expect(result.current.phases.architect).toBe('running')
  })

  it('WS log message: appends to logLines', async () => {
    const { result } = renderHook(() => usePipeline('proj-pipeline'))

    act(() => {
      wsHandler?.({
        type: 'log',
        projectId: 'proj-pipeline',
        source: 'stdout',
        line: 'Hello log',
        timestamp: '2024-01-01T00:00:00Z',
        processId: 'proc-1',
      })
    })

    expect(result.current.logLines).toHaveLength(1)
    expect(result.current.logLines[0].line).toBe('Hello log')
    expect(result.current.logLines[0].source).toBe('stdout')
  })

  it('WS queue message: updates queueState', async () => {
    const { result } = renderHook(() => usePipeline('proj-pipeline'))

    act(() => {
      wsHandler?.({
        type: 'queue',
        projectId: 'proj-pipeline',
        jobs: [{ id: 'j1', command: 'cmd', status: 'queued', queuePosition: 1, startedAt: null, finishedAt: null, exitCode: null }],
        activeJobId: null,
        paused: true,
      })
    })

    expect(result.current.queueState.paused).toBe(true)
    expect(result.current.queueState.jobs).toHaveLength(1)
  })

  it('filters messages by activeProjectId (ignores other project messages)', async () => {
    const { result } = renderHook(() => usePipeline('proj-pipeline'))

    act(() => {
      wsHandler?.({
        type: 'log',
        projectId: 'other-project',
        source: 'stdout',
        line: 'Should be ignored',
        timestamp: '2024-01-01T00:00:00Z',
        processId: 'proc-1',
      })
    })

    expect(result.current.logLines).toHaveLength(0)
  })

  it('project switch: clears logs', async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => usePipeline(pid),
      { initialProps: { pid: 'proj-pipeline' } }
    )

    act(() => {
      wsHandler?.({
        type: 'log',
        projectId: 'proj-pipeline',
        source: 'stdout',
        line: 'some log',
        timestamp: '',
        processId: 'p1',
      })
    })
    expect(result.current.logLines).toHaveLength(1)

    rerender({ pid: 'proj-other' })

    expect(result.current.logLines).toHaveLength(0)
  })

  it('REST fetch on mount: fetches /state endpoint', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        projectName: 'Fetched Project',
        phaseDefinitions: [{ key: 'dev', label: 'Dev', description: '' }],
        phases: { dev: 'idle' },
        recentJobs: [],
        queue: { jobs: [], activeJobId: null, paused: false },
      }),
    })

    const { result } = renderHook(() => usePipeline('proj-pipeline'))

    await waitFor(() => expect(result.current.projectName).toBe('Fetched Project'))
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/state'))
  })

  it('project switch: caches outgoing state via init message, restores on return', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false })

    const { result, rerender } = renderHook(
      ({ pid }: { pid: string | null }) => usePipeline(pid),
      { initialProps: { pid: 'proj-a' as string | null } }
    )

    // Simulate init message for proj-a (which caches the state)
    act(() => {
      wsHandler?.({
        type: 'init',
        projectId: 'proj-a',
        projectName: 'Project A',
        phaseDefinitions: [{ key: 'build', label: 'Build', description: '' }],
        phases: { build: 'done' },
        recentJobs: [],
        queue: { jobs: [], activeJobId: null, paused: false },
        logBuffer: [],
      })
    })
    expect(result.current.projectName).toBe('Project A')

    // Switch to proj-b
    rerender({ pid: 'proj-b' })
    expect(result.current.projectName).toBe('')

    // Switch back to proj-a — should restore from cache
    rerender({ pid: 'proj-a' })
    expect(result.current.projectName).toBe('Project A')
    expect(result.current.phases.build).toBe('done')
  })
})
