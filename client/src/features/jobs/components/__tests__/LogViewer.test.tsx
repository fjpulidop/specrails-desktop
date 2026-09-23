import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { LogViewer } from '../LogViewer'
import type { EventRow } from '../../../../types'

// Mock react-markdown and remark-gfm
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Mock the markdown-detect module so all lines are treated as plain by default
let mockHasMarkdownSyntax = vi.fn(() => false)
vi.mock('../../../../lib/markdown-detect', () => ({
  hasMarkdownSyntax: (...args: unknown[]) => mockHasMarkdownSyntax(...args),
}))

function makeLogEvent(line: string, id = 1, source = 'stdout'): EventRow {
  return {
    id,
    job_id: 'job-1',
    seq: id,
    event_type: 'log',
    source,
    payload: JSON.stringify({ line }),
    timestamp: new Date().toISOString(),
  }
}

function makeResultEvent(payload: object, id = 99): EventRow {
  return {
    id,
    job_id: 'job-1',
    seq: id,
    event_type: 'result',
    source: 'stdout',
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
  }
}

describe('LogViewer', () => {
  beforeEach(() => {
    mockHasMarkdownSyntax.mockReturnValue(false)
  })
  it('shows "No log output yet" when events produce no lines', () => {
    render(<LogViewer events={[]} />)
    expect(screen.getByText(/No log output yet/i)).toBeInTheDocument()
  })

  it('shows "Loading logs..." when isLoading is true', () => {
    render(<LogViewer events={[]} isLoading={true} />)
    expect(screen.getByText(/Loading logs.../i)).toBeInTheDocument()
  })

  it('renders log lines from events', () => {
    const events = [
      makeLogEvent('First log line', 1),
      makeLogEvent('Second log line', 2),
    ]
    render(<LogViewer events={events} />)
    expect(screen.getByText('First log line')).toBeInTheDocument()
    expect(screen.getByText('Second log line')).toBeInTheDocument()
  })

  it('renders filter input when there are log lines', () => {
    const events = [makeLogEvent('some output', 1)]
    render(<LogViewer events={events} />)
    expect(screen.getByPlaceholderText(/Filter logs.../i)).toBeInTheDocument()
  })

  it('shows total line count', () => {
    const events = [
      makeLogEvent('line one', 1),
      makeLogEvent('line two', 2),
      makeLogEvent('line three', 3),
    ]
    render(<LogViewer events={events} />)
    // Count shows "3 / 3 lines"
    expect(screen.getByText(/3 \/ 3 lines/i)).toBeInTheDocument()
  })

  it('filter input filters displayed log lines', async () => {
    const user = userEvent.setup()
    const events = [
      makeLogEvent('error: something went wrong', 1),
      makeLogEvent('info: all good', 2),
    ]
    render(<LogViewer events={events} />)
    const filterInput = screen.getByPlaceholderText(/Filter logs.../i)
    await user.type(filterInput, 'error')
    expect(screen.getByText('error: something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('info: all good')).not.toBeInTheDocument()
  })

  it('shows filtered / total count after filtering', async () => {
    const user = userEvent.setup()
    const events = [
      makeLogEvent('error: something went wrong', 1),
      makeLogEvent('info: all good', 2),
      makeLogEvent('error: another error', 3),
    ]
    render(<LogViewer events={events} />)
    const filterInput = screen.getByPlaceholderText(/Filter logs.../i)
    await user.type(filterInput, 'error')
    // 2 matching out of 3 total
    expect(screen.getByText(/2 \/ 3 lines/i)).toBeInTheDocument()
  })

  it('skips empty log lines', () => {
    const events = [
      makeLogEvent('', 1),
      makeLogEvent('  ', 2),
      makeLogEvent('real line', 3),
    ]
    render(<LogViewer events={events} />)
    expect(screen.getByText('real line')).toBeInTheDocument()
    expect(screen.getByText(/1 \/ 1 lines/i)).toBeInTheDocument()
  })

  it('does not render filter bar when loading', () => {
    render(<LogViewer events={[]} isLoading={true} />)
    expect(screen.queryByPlaceholderText(/Filter logs.../i)).not.toBeInTheDocument()
  })

  describe('phase grouping', () => {
    it('renders phase header line (starting with ▸) as a phase section', () => {
      const events = [
        makeLogEvent('▸ architect phase', 1),
        makeLogEvent('Some output', 2),
      ]
      render(<LogViewer events={events} />)
      expect(screen.getByText('▸ architect phase')).toBeInTheDocument()
    })

    it('renders phase header by phase name prefix', () => {
      const events = [
        makeLogEvent('architect: starting', 1),
        makeLogEvent('doing work', 2),
      ]
      render(<LogViewer events={events} />)
      expect(screen.getByText('architect: starting')).toBeInTheDocument()
    })

    it('collapses a phase when header is clicked', async () => {
      const user = userEvent.setup()
      const events = [
        makeLogEvent('▸ build phase', 1),
        makeLogEvent('build output', 2),
      ]
      render(<LogViewer events={events} />)
      // Initially expanded — output should be visible
      expect(screen.getByText('build output')).toBeInTheDocument()
      // Click the phase header to collapse
      const phaseHeader = screen.getByText('▸ build phase')
      await user.click(phaseHeader)
      // Output should now be hidden
      expect(screen.queryByText('build output')).toBeNull()
    })

    it('shows "No output" when phase has no lines', () => {
      const events = [
        makeLogEvent('▸ empty phase', 1),
        makeLogEvent('▸ second phase', 2),
        makeLogEvent('second output', 3),
      ]
      render(<LogViewer events={events} />)
      expect(screen.getByText('No output')).toBeInTheDocument()
    })

    it('shows "No matching lines" when phase has lines but none match filter', async () => {
      const user = userEvent.setup()
      const events = [
        makeLogEvent('▸ my phase', 1),
        makeLogEvent('some output here', 2),
      ]
      render(<LogViewer events={events} />)
      const filterInput = screen.getByPlaceholderText(/Filter logs.../i)
      await user.type(filterInput, 'zzznomatch')
      expect(screen.getByText('No matching lines')).toBeInTheDocument()
    })
  })

  describe('stderr handling', () => {
    it('renders stderr events', () => {
      const events = [makeLogEvent('stderr warning message', 1, 'stderr')]
      render(<LogViewer events={events} />)
      expect(screen.getByText('stderr warning message')).toBeInTheDocument()
    })
  })

  describe('result event type', () => {
    it('renders result event as "Completed" summary line', () => {
      const events = [makeResultEvent({ total_cost_usd: 0.0123, num_turns: 5, duration_ms: 3000 })]
      render(<LogViewer events={events} />)
      expect(screen.getByText(/completed/i)).toBeInTheDocument()
    })

    it('renders result event without cost when cost is 0', () => {
      const events = [makeResultEvent({ total_cost_usd: 0, num_turns: 3, duration_ms: 1000 })]
      render(<LogViewer events={events} />)
      expect(screen.getByText(/completed/i)).toBeInTheDocument()
    })

    it('skips non-log, non-result events', () => {
      const assistantEvent: EventRow = {
        id: 1,
        job_id: 'job-1',
        seq: 1,
        event_type: 'assistant',
        source: 'stdout',
        payload: JSON.stringify({ text: 'should not appear' }),
        timestamp: new Date().toISOString(),
      }
      render(<LogViewer events={[assistantEvent]} />)
      expect(screen.getByText(/no log output yet/i)).toBeInTheDocument()
    })
  })

  describe('diff detection', () => {
    it('renders diff add/remove/meta lines from a diff block', () => {
      const events = [
        makeLogEvent('--- a/src/file.ts', 1),
        makeLogEvent('+++ b/src/file.ts', 2),
        makeLogEvent('@@ -1,5 +1,6 @@', 3),
        makeLogEvent('+added line', 4),
        makeLogEvent('-removed line', 5),
      ]
      render(<LogViewer events={events} />)
      expect(screen.getByText('+added line')).toBeInTheDocument()
      expect(screen.getByText('-removed line')).toBeInTheDocument()
    })
  })

  describe('markdown rendering', () => {
    it('renders markdown content when hasMarkdownSyntax returns true', () => {
      mockHasMarkdownSyntax.mockReturnValue(true)
      const events = [makeLogEvent('# Heading with **bold**', 1)]
      render(<LogViewer events={events} />)
      // Mocked ReactMarkdown renders children as-is
      expect(screen.getByText('# Heading with **bold**')).toBeInTheDocument()
    })
  })

  describe('copy button', () => {
    it('copies log text to clipboard when copy button is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      })
      const events = [makeLogEvent('line one', 1), makeLogEvent('line two', 2)]
      const { container } = render(<LogViewer events={events} />)
      // The copy button contains the Copy icon (lucide-copy)
      const copyBtn = container.querySelector('.lucide-copy')!.closest('button')!
      fireEvent.click(copyBtn)
      expect(writeText).toHaveBeenCalled()
    })
  })

  describe('malformed event payloads', () => {
    it('skips events with invalid JSON payload', () => {
      const badEvent: EventRow = {
        id: 1,
        job_id: 'job-1',
        seq: 1,
        event_type: 'log',
        source: 'stdout',
        payload: 'not valid json {{{',
        timestamp: new Date().toISOString(),
      }
      render(<LogViewer events={[badEvent]} />)
      expect(screen.getByText(/no log output yet/i)).toBeInTheDocument()
    })

    it('skips result events with invalid JSON', () => {
      const badResult: EventRow = {
        id: 1,
        job_id: 'job-1',
        seq: 1,
        event_type: 'result',
        source: 'stdout',
        payload: 'bad json',
        timestamp: new Date().toISOString(),
      }
      render(<LogViewer events={[badResult]} />)
      expect(screen.getByText(/no log output yet/i)).toBeInTheDocument()
    })
  })
})
