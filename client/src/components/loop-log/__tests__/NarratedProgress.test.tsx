import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NarratedProgress } from '../NarratedProgress'
import { JOB_LOG_MODE_KEY, loadJobLogMode, saveJobLogMode } from '../../../lib/job-log-mode'
import type { EventRow } from '../../../types'

let seq = 0
function ev(event_type: string, payload: unknown): EventRow {
  seq += 1
  return {
    id: seq, job_id: 'run-1', seq, event_type, source: null,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    timestamp: '2026-07-27T10:00:00Z',
  }
}
const step = (index: number, title: string, over: Record<string, unknown> = {}) =>
  ev('loop_step', { index, title, kind: 'ai-step', nodeId: title, iteration: 1, ...over })
const stepEnd = (index: number, over: Record<string, unknown> = {}) =>
  ev('loop_step_end', { index, nodeId: 'n', status: 'ok', exitCode: null, durationMs: 90_000, ...over })
const tool = (name: string, input: Record<string, unknown>) =>
  ev('assistant', { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

describe('NarratedProgress', () => {
  it('renders milestones in plain language', () => {
    render(<NarratedProgress
      events={[step(1, 'Implement'), tool('Read', { file_path: '/src/auth.ts' }), stepEnd(1)]}
      settled
    />)
    expect(screen.getByText('Step 1: Implement')).toBeInTheDocument()
    expect(screen.getByText('Reading auth.ts')).toBeInTheDocument()
    expect(screen.getByText('Finished step 1 in 90s')).toBeInTheDocument()
  })

  it('shows a repeat count instead of nine identical lines', () => {
    render(<NarratedProgress
      events={[step(1, 'x'), tool('Read', { file_path: '/a.ts' }), tool('Read', { file_path: '/a.ts' })]}
      settled={false}
    />)
    expect(screen.getAllByText('Reading a.ts')).toHaveLength(1)
    expect(screen.getByText('×2')).toBeInTheDocument()
  })

  it('states an interruption once the run has settled', () => {
    render(<NarratedProgress events={[step(1, 'Implement')]} settled />)
    expect(screen.getByText('Step 1 was interrupted before it finished')).toBeInTheDocument()
  })

  it('does not call a live step interrupted', () => {
    render(<NarratedProgress events={[step(1, 'Implement')]} settled={false} />)
    expect(screen.queryByText(/interrupted/i)).not.toBeInTheDocument()
  })

  it('renders the decider verdict as the structural outcome', () => {
    render(<NarratedProgress events={[step(1, 'v'), stepEnd(1, { decision: 'continue' })]} settled />)
    expect(screen.getByText('Not done yet — going round again')).toBeInTheDocument()
  })

  it('shows a measured duration band when one exists', () => {
    render(<NarratedProgress
      events={[step(1, 'x')]}
      settled={false}
      durationRange={{ p25Ms: 720_000, p75Ms: 1_860_000, medianMs: 1_200_000, sampleCount: 8 }}
    />)
    expect(screen.getByTestId('narration-range')).toHaveTextContent('12–31 min')
    expect(screen.getByTestId('narration-range')).toHaveTextContent('last 8')
  })

  it('shows NO expectation when the band is absent (never a guess)', () => {
    render(<NarratedProgress events={[step(1, 'x')]} settled={false} durationRange={null} />)
    expect(screen.queryByTestId('narration-range')).not.toBeInTheDocument()
  })

  it('shows real elapsed time from the clock', () => {
    render(<NarratedProgress events={[step(1, 'x')]} settled={false} elapsedMs={300_000} />)
    expect(screen.getByText('Running for 5 min')).toBeInTheDocument()
  })

  it('distinguishes an empty live run from an empty settled one', () => {
    const live = render(<NarratedProgress events={[]} settled={false} />)
    expect(screen.getByText('Nothing has happened yet.')).toBeInTheDocument()
    live.unmount()
    render(<NarratedProgress events={[]} settled />)
    expect(screen.getByText('No activity was recorded for this run.')).toBeInTheDocument()
  })

  it('says where the narration came from', () => {
    render(<NarratedProgress events={[step(1, 'x')]} settled={false} />)
    expect(screen.getByText(/what actually happened/i)).toBeInTheDocument()
  })

  it('renders a plain (non-loop) job from activity alone', () => {
    render(<NarratedProgress events={[tool('Bash', { command: 'npm test' })]} settled />)
    expect(screen.getByText('Running npm')).toBeInTheDocument()
  })

  it('never renders a number the stream did not carry', () => {
    const { container } = render(<NarratedProgress
      events={[
        step(1, 'Verify'),
        ev('assistant', { type: 'assistant', message: { content: [{ type: 'text', text: '68 tests passed' }] } }),
      ]}
      settled={false}
    />)
    expect(container.textContent).not.toContain('68')
  })
})

describe('job log mode preference', () => {
  it('defaults to the narrated altitude', () => {
    localStorage.clear()
    expect(loadJobLogMode()).toBe('narrated')
  })

  it('round-trips an explicit choice', () => {
    saveJobLogMode('log')
    expect(localStorage.getItem(JOB_LOG_MODE_KEY)).toBe('log')
    expect(loadJobLogMode()).toBe('log')
    saveJobLogMode('narrated')
    expect(loadJobLogMode()).toBe('narrated')
  })

  it('ignores a corrupted value', () => {
    localStorage.setItem(JOB_LOG_MODE_KEY, 'sideways')
    expect(loadJobLogMode()).toBe('narrated')
  })
})
