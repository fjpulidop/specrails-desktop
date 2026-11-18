import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

const getStalls = vi.hoisted(() => vi.fn())
vi.mock('../../lib/diagnostics-api', () => ({ getStalls }))

import { ServerResponsiveness } from '../ServerResponsiveness'

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
afterEach(() => { vi.clearAllMocks() })

describe('ServerResponsiveness', () => {
  it('reads nothing while the popover is closed', async () => {
    render(<ServerResponsiveness active={false} />)
    await flush()
    expect(getStalls).not.toHaveBeenCalled()
    expect(screen.queryByTestId('server-responsiveness')).toBeNull()
  })

  it('says when there were no stalls', async () => {
    getStalls.mockResolvedValue({ thresholdMs: 200, sampling: false, sinceMs: 0, total: 0, longestMs: 0, recent: [] })
    render(<ServerResponsiveness active />)
    await flush()
    expect(screen.getByTestId('server-responsiveness')).toHaveTextContent('No stalls since')
  })

  it('summarises stalls and names the operation of the last one', async () => {
    getStalls.mockResolvedValue({ thresholdMs: 200, sampling: true, sinceMs: 0, total: 2, longestMs: 1500, recent: [
      { atMs: 10, durationMs: 640, operation: 'GET /api/projects/:id/jobs', utilization: 1 },
      { atMs: 5, durationMs: 1500, operation: null, utilization: 1 },
    ] })
    render(<ServerResponsiveness active />)
    await flush()
    const panel = screen.getByTestId('server-responsiveness')
    expect(panel).toHaveTextContent('2 stalls · longest 1.5 sec')
    expect(panel).toHaveTextContent('640 ms during GET /api/projects/:id/jobs')
  })
})
