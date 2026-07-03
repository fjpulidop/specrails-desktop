import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { JobStatusPanel } from '../JobStatusPanel'
import type { JobSummary, EventRow, PhaseDefinition } from '../../types'

const completedJob: JobSummary = {
  id: 'job-1',
  command: '/specrails:implement --spec SPEA-001',
  started_at: '2024-03-21T10:00:00Z',
  finished_at: '2024-03-21T10:01:02Z', // 62s wall-clock
  status: 'completed',
  duration_ms: 62000,
  total_cost_usd: 0.0234,
  tokens_in: 5000,
  tokens_out: 3000,
  num_turns: 8,
}

const failedJob: JobSummary = {
  id: 'job-2',
  command: '/specrails:health-check',
  started_at: '2024-03-21T11:00:00Z',
  finished_at: null,
  status: 'failed',
  duration_ms: null,
  total_cost_usd: null,
  tokens_in: null,
  tokens_out: null,
  num_turns: null,
}

const eventsWithFiles: EventRow[] = [
  { id: 1, job_id: 'job-1', seq: 1, event_type: 'log', payload: JSON.stringify({ line: 'Writing file: src/components/MyComponent.tsx' }), timestamp: '2024-03-21T10:01:00Z' },
  { id: 2, job_id: 'job-1', seq: 2, event_type: 'log', payload: JSON.stringify({ line: 'Editing src/hooks/useHook.ts' }), timestamp: '2024-03-21T10:02:00Z' },
  { id: 3, job_id: 'job-1', seq: 3, event_type: 'log', payload: '{ invalid json }', timestamp: '2024-03-21T10:03:00Z' },
  { id: 4, job_id: 'job-1', seq: 4, event_type: 'phase', payload: JSON.stringify({ phase: 'developer' }), timestamp: '2024-03-21T10:04:00Z' },
]

describe('JobStatusPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Terminal (completed / failed) ──────────────────────────────────────────

  it('renders "Job completed" with the Final summary zone', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    expect(screen.getByText('Job completed')).toBeInTheDocument()
    expect(screen.getByText('Final summary')).toBeInTheDocument()
  })

  it('renders "Job failed" for failed status', () => {
    render(<JobStatusPanel job={failedJob} events={[]} />)
    expect(screen.getByText('Job failed')).toBeInTheDocument()
  })

  it('renders duration chip + card for completed job', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    // Wall-clock 10:00:00 → 10:01:02 = 62s → "1m 2s" (header chip + metric card)
    expect(screen.getAllByText('1m 2s').length).toBeGreaterThanOrEqual(1)
  })

  it('renders cost chip in header for completed job', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    expect(screen.getAllByText('$0.0234').length).toBeGreaterThanOrEqual(1)
  })

  it('prefixes ~ for an estimated (codex) cost', () => {
    render(<JobStatusPanel job={{ ...completedJob, total_cost_usd_estimated: 1 }} events={[]} />)
    expect(screen.getAllByText('~$0.0234').length).toBeGreaterThanOrEqual(1)
  })

  it('renders the four metric labels in the terminal grid', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    expect(screen.getByText('Duration')).toBeInTheDocument()
    expect(screen.getByText('Cost')).toBeInTheDocument()
    expect(screen.getByText('Turns')).toBeInTheDocument()
    expect(screen.getByText('Tokens')).toBeInTheDocument()
  })

  it('renders turns value', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('renders tokens value in k format', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    // 5000 + 3000 = 8000 → 8.0k
    expect(screen.getByText('8.0k')).toBeInTheDocument()
  })

  it('includes cache tokens in the authoritative Tokens total', () => {
    const cacheHeavy: JobSummary = {
      ...completedJob,
      tokens_in: 5000,
      tokens_out: 3000,
      tokens_cache_read: 90_000,
      tokens_cache_create: 2_000,
    }
    render(<JobStatusPanel job={cacheHeavy} events={[]} />)
    expect(screen.getByText('100.0k')).toBeInTheDocument()
    expect(screen.queryByText('8.0k')).not.toBeInTheDocument()
  })

  it('shows em-dash + "Not available" for null terminal metrics', () => {
    render(<JobStatusPanel job={failedJob} events={[]} />)
    // duration —, cost —, turns —, tokens — = 4 em-dashes
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4)
    // cost/turns/tokens each carry a "Not available" caption (duration does not)
    expect(screen.getAllByText('Not available').length).toBe(3)
  })

  it('does not render a cost chip when total_cost_usd is null', () => {
    render(<JobStatusPanel job={failedJob} events={[]} />)
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  // ── Expand / collapse ───────────────────────────────────────────────────────

  it('collapses content when defaultOpen=false', () => {
    render(<JobStatusPanel job={completedJob} events={[]} defaultOpen={false} />)
    expect(screen.queryByText('Final summary')).not.toBeInTheDocument()
  })

  it('toggles open/closed when the header button is clicked', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    expect(screen.getByText('Duration')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('Duration')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Duration')).toBeInTheDocument()
  })

  // ── Modified files (terminal) ───────────────────────────────────────────────

  it('extracts modified files from log events', () => {
    render(<JobStatusPanel job={completedJob} events={eventsWithFiles} />)
    expect(screen.getByText('src/components/MyComponent.tsx')).toBeInTheDocument()
    expect(screen.getByText('src/hooks/useHook.ts')).toBeInTheDocument()
  })

  it('shows files count chip when files are extracted', () => {
    render(<JobStatusPanel job={completedJob} events={eventsWithFiles} />)
    expect(screen.getByText('2 files')).toBeInTheDocument()
  })

  it('does not show files section when no files extracted', () => {
    render(<JobStatusPanel job={completedJob} events={[]} />)
    expect(screen.queryByText('Files modified')).not.toBeInTheDocument()
  })

  it('skips non-log events and invalid JSON when extracting files', () => {
    const badEvents: EventRow[] = [
      { id: 1, job_id: 'job-1', seq: 1, event_type: 'phase', payload: JSON.stringify({ line: 'Writing fake.ts' }), timestamp: '' },
      { id: 2, job_id: 'job-1', seq: 2, event_type: 'log', payload: 'not valid json', timestamp: '' },
    ]
    render(<JobStatusPanel job={completedJob} events={badEvents} />)
    expect(screen.queryByText('Files modified')).not.toBeInTheDocument()
  })

  // ── Pipeline totals ─────────────────────────────────────────────────────────

  it('renders the pipeline total block when provided', () => {
    render(
      <JobStatusPanel
        job={completedJob}
        events={[]}
        pipelineTotals={{
          totalCostUsd: 1.2,
          totalTokensIn: 100_000,
          totalTokensOut: 50_000,
          totalTokensCacheRead: 800_000,
          totalTokensCacheCreate: 50_000,
          jobCount: 3,
        }}
      />,
    )
    expect(screen.getByText('Pipeline total (3 phases)')).toBeInTheDocument()
    expect(screen.getByText('$1.2000')).toBeInTheDocument()
    // 1,000,000 tokens → 1000.0k
    expect(screen.getByText('1000.0k')).toBeInTheDocument()
  })

  it('HIGH-10: shows a ≥ lower-bound prefix + partial hint when a phase cost is null', () => {
    render(
      <JobStatusPanel
        job={completedJob}
        events={[]}
        pipelineTotals={{
          totalCostUsd: 28,
          hasNullCost: true,
          costEstimated: false,
          nullCostCount: 1,
          totalTokensIn: 1000,
          totalTokensOut: 500,
          totalTokensCacheRead: 0,
          totalTokensCacheCreate: 0,
          jobCount: 3,
        }}
      />,
    )
    // Lower-bound prefix present; the total is NOT rendered as a precise $28.0000.
    expect(screen.getByText('≥$28.0000')).toBeInTheDocument()
    expect(screen.queryByText('$28.0000')).not.toBeInTheDocument()
    expect(screen.getByTestId('pipeline-partial-hint')).toBeInTheDocument()
  })

  it('HIGH-10: keeps the ~ estimated marker together with ≥ when a phase is both estimated and null', () => {
    render(
      <JobStatusPanel
        job={completedJob}
        events={[]}
        pipelineTotals={{
          totalCostUsd: 12.5,
          hasNullCost: true,
          costEstimated: true,
          nullCostCount: 2,
          totalTokensIn: 0,
          totalTokensOut: 0,
          totalTokensCacheRead: 0,
          totalTokensCacheCreate: 0,
          jobCount: 4,
        }}
      />,
    )
    expect(screen.getByText('~≥$12.5000')).toBeInTheDocument()
  })

  it('HIGH-10: renders a clean total with no indicator when every phase cost is present', () => {
    render(
      <JobStatusPanel
        job={completedJob}
        events={[]}
        pipelineTotals={{
          totalCostUsd: 40,
          hasNullCost: false,
          costEstimated: false,
          nullCostCount: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          totalTokensCacheRead: 0,
          totalTokensCacheCreate: 0,
          jobCount: 3,
        }}
      />,
    )
    expect(screen.getByText('$40.0000')).toBeInTheDocument()
    expect(screen.queryByTestId('pipeline-partial-hint')).not.toBeInTheDocument()
  })

  // ── Running (HONEST live state) ─────────────────────────────────────────────

  describe('running', () => {
    const runningJob: JobSummary = {
      id: 'job-running',
      command: '/specrails:implement #24',
      started_at: new Date(Date.now() - 65_000).toISOString(),
      finished_at: null,
      status: 'running',
      duration_ms: null,
      total_cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      num_turns: null,
    }

    function assistantTool(seq: number, name: string, input: Record<string, unknown>): EventRow {
      return { id: seq, job_id: 'job-running', seq, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } }), timestamp: '' }
    }
    function assistantText(seq: number): EventRow {
      return { id: seq, job_id: 'job-running', seq, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'text', text: 'hello' }] } }), timestamp: '' }
    }
    function codexItem(seq: number, item: Record<string, unknown>): EventRow {
      return { id: seq, job_id: 'job-running', seq, event_type: 'item.completed', payload: JSON.stringify({ item }), timestamp: '' }
    }

    it('renders "Job in progress" with the In progress + pending zones', () => {
      render(<JobStatusPanel job={runningJob} events={[]} />)
      expect(screen.getByText('Job in progress')).toBeInTheDocument()
      expect(screen.getByText('In progress')).toBeInTheDocument()
      expect(screen.getByText('Final summary — calculated when finished')).toBeInTheDocument()
    })

    it('NEVER shows a live/approximate cost, turns or tokens number while running', () => {
      const events = [assistantTool(1, 'Edit', { file_path: 'a.ts' }), assistantTool(2, 'Write', { file_path: 'b.ts' })]
      render(<JobStatusPanel job={runningJob} events={events} />)
      // Pending cards hold em-dashes, never numbers, and carry the honest caption.
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
      expect(screen.getAllByText('Calculated when finished').length).toBe(3)
      // No tilde-prefixed approximate numbers anywhere.
      expect(screen.queryByText(/^~/)).not.toBeInTheDocument()
      // No cost chip in the running header.
      expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
    })

    it('shows the connecting state before any frame arrives', () => {
      render(<JobStatusPanel job={runningJob} events={[]} />)
      expect(screen.getByText('Connecting to the agent…')).toBeInTheDocument()
    })

    it('counts steps and labels the current claude tool action', () => {
      const events = [
        assistantTool(1, 'Read', { file_path: 'src/x.ts' }),
        assistantTool(2, 'Edit', { file_path: 'src/queue-manager.ts' }),
      ]
      render(<JobStatusPanel job={runningJob} events={events} />)
      expect(screen.getByText('Editing queue-manager.ts')).toBeInTheDocument()
      expect(screen.getByText('2 steps')).toBeInTheDocument()
    })

    it('shows the steps chip (singular) in the running header', () => {
      render(<JobStatusPanel job={runningJob} events={[assistantText(1)]} />)
      expect(screen.getByText('1 step')).toBeInTheDocument()
    })

    it('labels a bare assistant text frame as Thinking', () => {
      render(<JobStatusPanel job={runningJob} events={[assistantText(1)]} />)
      expect(screen.getByText('Thinking…')).toBeInTheDocument()
    })

    it('maps Bash to a Running action with the first command token', () => {
      render(<JobStatusPanel job={runningJob} events={[assistantTool(1, 'Bash', { command: 'npm test --silent' })]} />)
      expect(screen.getByText('Running: npm')).toBeInTheDocument()
    })

    it('maps Grep to a Searching action', () => {
      render(<JobStatusPanel job={runningJob} events={[assistantTool(1, 'Grep', { pattern: 'TODO' })]} />)
      expect(screen.getByText('Searching “TODO”')).toBeInTheDocument()
    })

    it('falls back to Working for an unknown tool', () => {
      render(<JobStatusPanel job={runningJob} events={[assistantTool(1, 'SomeMcpTool', {})]} />)
      expect(screen.getByText('Working…')).toBeInTheDocument()
    })

    // ── Audit regression fixes ────────────────────────────────────────────────

    it('does not throw on a bare `null` / primitive JSON payload (null-deref guard)', () => {
      const events: EventRow[] = [
        { id: 1, job_id: 'job-running', seq: 1, event_type: 'assistant', payload: 'null', timestamp: '' },
        { id: 2, job_id: 'job-running', seq: 2, event_type: 'item.completed', payload: '42', timestamp: '' },
        { id: 3, job_id: 'job-running', seq: 3, event_type: 'tool_use', payload: '"a string"', timestamp: '' },
      ]
      // Must not throw; each non-skipped frame still counts as a step.
      render(<JobStatusPanel job={runningJob} events={events} />)
      expect(screen.getByText('Job in progress')).toBeInTheDocument()
    })

    it('counts every parallel tool_use block in one assistant frame as a step', () => {
      const multi: EventRow = {
        id: 1, job_id: 'job-running', seq: 1, event_type: 'assistant',
        payload: JSON.stringify({ message: { content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'c.ts' } },
        ] } }),
        timestamp: '',
      }
      render(<JobStatusPanel job={runningJob} events={[multi]} />)
      expect(screen.getByText('3 steps')).toBeInTheDocument()
      expect(screen.getByText('Reading c.ts')).toBeInTheDocument()
    })

    it('falls back to Working (no dangling arg) when a tool command is empty', () => {
      render(<JobStatusPanel job={runningJob} events={[assistantTool(1, 'Bash', { command: '' })]} />)
      expect(screen.getByText('Working…')).toBeInTheDocument()
      expect(screen.queryByText(/Running:\s*$/)).not.toBeInTheDocument()
    })

    it('surfaces the codex function_call command from item.arguments', () => {
      const events = [
        codexItem(1, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['cargo', 'test'] }) }),
      ]
      render(<JobStatusPanel job={runningJob} events={events} />)
      expect(screen.getByText('Running: cargo')).toBeInTheDocument()
    })

    it('does not freeze the steps counter after the events array is front-truncated', () => {
      // Simulate JobDetailPage's 10000→8000 slice: the array shrinks, then grows.
      const { rerender } = render(<JobStatusPanel job={runningJob} events={[assistantText(1), assistantText(2), assistantText(3)]} />)
      expect(screen.getByText('3 steps')).toBeInTheDocument()
      // Front-truncate (drop the oldest) — reducer must re-anchor, not freeze.
      rerender(<JobStatusPanel job={runningJob} events={[assistantText(2), assistantText(3)]} />)
      // Grow again with a new frame: counting must resume (would stay "3 steps" if frozen).
      rerender(<JobStatusPanel job={runningJob} events={[assistantText(2), assistantText(3), assistantText(4)]} />)
      expect(screen.getByText('4 steps')).toBeInTheDocument()
    })

    it('derives activity from codex item.completed frames', () => {
      const events = [
        codexItem(1, { type: 'agent_reasoning' }),
        codexItem(2, { type: 'local_shell_call', command: 'cargo test' }),
      ]
      render(<JobStatusPanel job={runningJob} events={events} />)
      expect(screen.getByText('Running: cargo')).toBeInTheDocument()
      expect(screen.getByText('2 steps')).toBeInTheDocument()
    })

    it('labels a codex agent_message as Thinking and counts unknown items as steps', () => {
      const events = [
        codexItem(1, { type: 'agent_message', text: 'hi' }),
        codexItem(2, { type: 'something_else' }),
      ]
      render(<JobStatusPanel job={runningJob} events={events} />)
      expect(screen.getByText('Thinking…')).toBeInTheDocument()
      expect(screen.getByText('2 steps')).toBeInTheDocument()
    })

    it('tolerates unparseable frames without throwing', () => {
      const events: EventRow[] = [
        { id: 1, job_id: 'job-running', seq: 1, event_type: 'assistant', payload: '{ not json', timestamp: '' },
        { id: 2, job_id: 'job-running', seq: 2, event_type: 'result', payload: '{}', timestamp: '' },
      ]
      render(<JobStatusPanel job={runningJob} events={events} />)
      // The assistant frame still counts as a step; result does not.
      expect(screen.getByText('1 step')).toBeInTheDocument()
    })

    it('shows the phase pill from the running phase definition', () => {
      const phaseDefinitions: PhaseDefinition[] = [
        { key: 'arch', label: 'Architect', description: '' },
        { key: 'dev', label: 'Developer', description: '' },
      ]
      render(
        <JobStatusPanel
          job={runningJob}
          events={[assistantText(1)]}
          phases={{ arch: 'done', dev: 'running' }}
          phaseDefinitions={phaseDefinitions}
        />,
      )
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    it('shows the Starting pill when no phase is running and no frames yet', () => {
      render(
        <JobStatusPanel
          job={runningJob}
          events={[]}
          phases={{ dev: 'idle' }}
          phaseDefinitions={[{ key: 'dev', label: 'Developer', description: '' }]}
        />,
      )
      expect(screen.getByText('Starting…')).toBeInTheDocument()
    })

    it('renders the auto-hiding explainer line', () => {
      render(<JobStatusPanel job={runningJob} events={[]} />)
      expect(screen.getByText(/the provider's real figures and appear when the job finishes/i)).toBeInTheDocument()
    })

    it('resets the step accumulator when the job id changes', () => {
      const { rerender } = render(<JobStatusPanel job={runningJob} events={[assistantText(1), assistantText(2)]} />)
      expect(screen.getByText('2 steps')).toBeInTheDocument()
      const otherJob = { ...runningJob, id: 'job-other' }
      rerender(<JobStatusPanel job={otherJob} events={[assistantText(1)]} />)
      expect(screen.getByText('1 step')).toBeInTheDocument()
    })

    it('reveals authoritative metrics on running → completed without remount', () => {
      const startedAt = new Date(Date.now() - 5000).toISOString()
      const events = [assistantTool(1, 'Edit', { file_path: 'a.ts' })]
      const { rerender } = render(<JobStatusPanel job={{ ...runningJob, started_at: startedAt }} events={events} />)
      expect(screen.getByText('Job in progress')).toBeInTheDocument()
      // While running there is no real cost shown.
      expect(screen.queryByText('$0.4200')).not.toBeInTheDocument()

      const completed: JobSummary = {
        ...runningJob,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: 'completed',
        total_cost_usd: 0.42,
        tokens_in: 100,
        tokens_out: 50,
        num_turns: 1,
      }
      rerender(<JobStatusPanel job={completed} events={events} />)
      expect(screen.getByText('Job completed')).toBeInTheDocument()
      // The real numbers resolve at exit (header chip + grid card).
      expect(screen.getAllByText('$0.4200').length).toBeGreaterThan(0)
      expect(screen.getByText('Final summary')).toBeInTheDocument()
    })
  })
})
