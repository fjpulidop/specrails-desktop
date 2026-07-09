import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cancelJob, cancelKindForJob } from '../cancel-job'

vi.mock('../api', () => ({
  getApiBase: () => '/api/projects/active-project',
}))

describe('cancelKindForJob', () => {
  it('classifies loop runs by the loop: command prefix', () => {
    expect(cancelKindForJob({ command: 'loop: Nightly refactor' })).toBe('loop-run')
    // A loop run that is ALSO interactive is still a loop run (the loop engine
    // owns it — Stop, not Discard).
    expect(cancelKindForJob({ command: 'loop: X', interactive: 1 })).toBe('loop-run')
  })

  it('classifies interactive sessions', () => {
    expect(cancelKindForJob({ command: '/specrails:freestyle #1', interactive: 1 })).toBe('interactive')
    expect(cancelKindForJob({ command: '/x', interactive: true })).toBe('interactive')
  })

  it('defaults to a plain queue job', () => {
    expect(cancelKindForJob({ command: '/specrails:implement #1' })).toBe('job')
    expect(cancelKindForJob({ command: '/x', interactive: 0 })).toBe('job')
    expect(cancelKindForJob({ command: '/x', interactive: null })).toBe('job')
  })
})

describe('cancelJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs to the cancel action on the EXPLICIT project path when projectId is given', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 'canceling' }) })
    const outcome = await cancelJob({ projectId: 'proj-x', jobId: 'j1' })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/proj-x/jobs/j1/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(outcome).toEqual({ ok: true, status: 'canceling' })
  })

  it('falls back to getApiBase() when projectId is null (board mode)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 'canceled' }) })
    const outcome = await cancelJob({ projectId: null, jobId: 'j2' })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/active-project/jobs/j2/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(outcome).toEqual({ ok: true, status: 'canceled' })
  })

  it('passes the idempotent already-terminal status through', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 'already_terminal' }) })
    expect(await cancelJob({ jobId: 'j3' , projectId: 'p' })).toEqual({ ok: true, status: 'already_terminal' })
  })

  it('a malformed success body never turns success into failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json') } })
    expect(await cancelJob({ projectId: 'p', jobId: 'j' })).toEqual({ ok: true, status: 'canceled' })
  })

  it('shapes an HTTP failure with the server error AND status code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Job not found' }),
    })
    expect(await cancelJob({ projectId: 'p', jobId: 'j' })).toEqual({
      ok: false,
      error: 'Job not found (HTTP 404)',
      httpStatus: 404,
    })
  })

  it('surfaces a non-JSON error body as a raw snippet', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '<html>Bad Gateway</html>',
    })
    expect(await cancelJob({ projectId: 'p', jobId: 'j' })).toEqual({
      ok: false,
      error: '<html>Bad Gateway</html> (HTTP 502)',
      httpStatus: 502,
    })
  })

  it('falls back to HTTP status + statusText when there is no body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => '',
    })
    expect(await cancelJob({ projectId: 'p', jobId: 'j' })).toEqual({
      ok: false,
      error: 'HTTP 500 Internal Server Error',
      httpStatus: 500,
    })
  })

  it('NEVER throws on a network failure — shapes it with httpStatus null', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('socket hang up'))
    expect(await cancelJob({ projectId: 'p', jobId: 'j' })).toEqual({
      ok: false,
      error: 'socket hang up',
      httpStatus: null,
    })
  })

  it('maps an abort/timeout rejection to a readable timeout message', async () => {
    const err = new Error('The operation was aborted')
    err.name = 'TimeoutError'
    global.fetch = vi.fn().mockRejectedValue(err)
    expect(await cancelJob({ projectId: 'p', jobId: 'j', timeoutMs: 5000 })).toEqual({
      ok: false,
      error: 'Request timed out after 5s',
      httpStatus: null,
    })
  })

  it('bounds the request with an AbortSignal timeout', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    await cancelJob({ projectId: 'p', jobId: 'j' })
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    // Node ≥17.3 / jsdom provide AbortSignal.timeout — the signal must ride.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })
})
