import { describe, expect, it, vi } from 'vitest'

vi.mock('react-markdown', () => ({ default: () => null }))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))

import type { EventRow } from '../../../../types'
import { lastFailedStep } from '../failed-step'

let id = 1
const ev = (event_type: string, payload: unknown): EventRow => ({ id: id++, job_id: 'run-1', seq: id, event_type, source: 'stdout', payload: JSON.stringify(payload), timestamp: '2026-11-12T10:00:00Z' })
const step = (index: number, nodeId: string, title: string, attemptId: string) => ev('loop_step', { index, kind: 'core', title, nodeId, nodePath: nodeId, scopeId: 'root', attemptId, visit: 1, iteration: 1 })
const end = (index: number, nodeId: string, status: 'ok' | 'failed', attemptId: string) => ev('loop_step_end', { index, nodeId, nodePath: nodeId, status, attemptId, exitCode: status === 'ok' ? 0 : 1 })

describe('lastFailedStep', () => {
  it('finds the step a failed run stopped at, with the cut a repeat needs', () => {
    const found = lastFailedStep([step(1, 'architect', 'architect', 'a1'), end(1, 'architect', 'ok', 'a1'), step(2, 'developer', 'developer', 'd1'), end(2, 'developer', 'failed', 'd1')])
    expect(found?.segment.meta).toMatchObject({ nodePath: 'developer', scopeId: 'root', iteration: 1 })
    expect(found?.title).toBe('developer')
  })

  it('offers nothing when no step failed or the failed step cannot be cut', () => {
    expect(lastFailedStep([step(1, 'architect', 'architect', 'a1'), end(1, 'architect', 'ok', 'a1')])).toBeNull()
    expect(lastFailedStep([ev('loop_step', { index: 1, kind: 'core', title: 'legacy' }), ev('loop_step_end', { index: 1, status: 'failed' })])).toBeNull()
  })
})
