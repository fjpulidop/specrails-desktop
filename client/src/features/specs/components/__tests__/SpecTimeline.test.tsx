import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../../../test-utils'
import { SpecTimeline } from '../SpecTimeline'
import type { TimelineEntry, TimelinePage } from '../../lib/spec-timeline'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'p1', projects: [] }) }))
vi.mock('../../../../lib/launch-forecast', async (orig) => ({
  ...(await orig<typeof import('../../../../lib/launch-forecast')>()),
  fetchUsageSnapshot: () => ({ fresh: { providers: [{ providerId: 'codex', availability: 'available', plan: 'pro', windows: [] }] }, load: async () => null }),
}))

const localNoon = (day: number) => new Date(2026, 9, day, 12, 0, 0).toISOString()
function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return { id: 'e', at: localNoon(20), kind: 'job', event: 'job.run', params: {}, title: 'Implement', summary: null, actor: null, tone: 'neutral', provider: 'claude', link: null, ...over }
}
const counts = { spec_edit: 1, addendum: 0, mission_turn: 1, job: 2, phase: 1, audit: 0, pr_event: 0, review: 1 }

let requests: string[]
function mockTimeline(pages: Record<string, Partial<TimelinePage>>) {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    const u = new URL(url, 'http://x')
    const key = `${u.searchParams.get('kinds') ?? ''}|${u.searchParams.get('cursor') ?? ''}`
    const page = pages[key] ?? pages['|'] ?? { entries: [] }
    return { ok: true, json: async () => ({ ticketId: 7, nextCursor: null, counts, total: 6, entries: [], ...page }) } as Response
  }))
}

const baseProps = { ticketId: 7, uiMode: 'kanban' as const, currentSearch: '?spec=7' }

describe('SpecTimeline', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows product names for agent roles instead of internal slugs', async () => {
    mockTimeline({ '|': { entries: [
      entry({ id: 'review:d1', kind: 'review', event: 'review.verdict', title: 'Review', actor: { type: 'agent', label: 'reviewer', provider: null } }),
      entry({ id: 'ai:1', kind: 'spec_edit', event: 'spec.ai.quick-spec', title: 'AI quick-spec', actor: { type: 'agent', label: 'quick-spec', provider: null } }),
      entry({ id: 'job:r1', actor: { type: 'agent', label: 'custom-role', provider: null } }),
    ] } })
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    const rows = await screen.findAllByTestId('spec-timeline-entry')
    expect(rows[0]).toHaveTextContent('Reviewer')
    expect(rows[0]).not.toHaveTextContent('reviewer')
    expect(rows[1]).toHaveTextContent('Quick spec')
    expect(rows[2]).toHaveTextContent('custom-role')
  })

  it('groups entries by day with the lamp tone, source title, cost and a link to the place', async () => {
    mockTimeline({ '|': { entries: [
      entry({ id: 'job:r2', at: localNoon(22), title: 'Implement', tone: 'failure', summary: 'Tests failed', costUsd: 1.2, costKind: 'billed', link: { place: 'job', id: 'r2' } }),
      entry({ id: 'review:d1', at: localNoon(22), kind: 'review', event: 'review.verdict', params: { verdict: 'changes_requested', findings: 2 }, title: 'Review', tone: 'review', link: { place: 'review', id: 'd1' }, items: [{ at: null, label: 'Missing null check', detail: 'src/a.ts:3' }], count: 2 }),
      entry({ id: 'job:r1', at: localNoon(20), costUsd: 0.5, costKind: 'estimated', link: { place: 'job', id: 'r1' } }),
    ] } })
    const onNavigate = vi.fn()
    render(<SpecTimeline {...baseProps} onNavigate={onNavigate} />)
    const days = await screen.findAllByTestId('spec-timeline-day')
    expect(days).toHaveLength(2)
    const failed = within(days[0]!).getAllByTestId('spec-timeline-entry')[0]!
    expect(failed).toHaveAttribute('data-tone', 'failure')
    expect(failed).toHaveTextContent('Failed: Implement')
    expect(failed).toHaveTextContent('Tests failed')
    expect(failed).toHaveTextContent('$1.20')
    expect(within(days[1]!).getByTestId('spec-timeline-entry')).toHaveTextContent('~$0.50 est.')
    const review = within(days[0]!).getAllByTestId('spec-timeline-entry')[1]!
    expect(review).toHaveAttribute('data-tone', 'review')
    expect(review).toHaveTextContent('Reviewer requested changes')
    expect(review).toHaveTextContent('2 findings')

    fireEvent.click(within(failed).getByTestId('spec-timeline-link'))
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/jobs/r2', place: 'job' }))
  })

  it('expands a collapsed group in place', async () => {
    mockTimeline({ '|': { entries: [entry({ id: 'phases:r1', kind: 'phase', event: 'phase.group', params: { count: 3, failed: 1 }, title: '3 phases', count: 3, tone: 'failure', items: [{ at: localNoon(20), label: 'review', detail: 'failed', tone: 'failure' }] })] } })
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    const row = await screen.findByTestId('spec-timeline-entry')
    expect(row).toHaveTextContent('3 phases')
    expect(row).toHaveTextContent('1 failed')
    expect(screen.queryByTestId('spec-timeline-details')).not.toBeInTheDocument()
    const toggle = within(row).getByTestId('spec-timeline-expand')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('spec-timeline-details')).toHaveTextContent('review')
    expect(screen.getByTestId('spec-timeline-details')).toHaveTextContent('+2')
  })

  it('shows turns, not dollars, for a provider billed through a plan', async () => {
    mockTimeline({ '|': { entries: [entry({ id: 'job:r1', provider: 'codex', costUsd: 9.99, costKind: 'billed', turns: 6 })] } })
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    const row = await screen.findByTestId('spec-timeline-entry')
    await waitFor(() => expect(row).toHaveTextContent('6 turns'))
    expect(row).not.toHaveTextContent('9.99')
  })

  it('filters by kind through the chips (server-side) and keeps the other kinds countable', async () => {
    mockTimeline({
      '|': { entries: [entry({ id: 'a' }), entry({ id: 'm', kind: 'mission_turn', event: 'mission.turns', params: { turns: 2 }, title: 'Mission', count: 2 })] },
      'job|': { entries: [entry({ id: 'a' })] },
    })
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    await screen.findAllByTestId('spec-timeline-entry')
    expect(screen.getAllByTestId('spec-timeline-entry')).toHaveLength(2)
    const chip = screen.getByTestId('spec-timeline-filter-job')
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip).toHaveTextContent('2')
    fireEvent.click(chip)
    await waitFor(() => expect(screen.getAllByTestId('spec-timeline-entry')).toHaveLength(1))
    expect(screen.getByTestId('spec-timeline-filter-job')).toHaveAttribute('aria-pressed', 'true')
    expect(requests.some((r) => r.includes('kinds=job'))).toBe(true)
    expect(screen.getByTestId('spec-timeline-filter-mission_turn')).toHaveTextContent('1')
  })

  it('pages older entries with the cursor', async () => {
    mockTimeline({
      '|': { entries: [entry({ id: 'a', at: localNoon(22) })], nextCursor: 'CUR' },
      '|CUR': { entries: [entry({ id: 'b', at: localNoon(20) })], nextCursor: null },
    })
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    await screen.findByTestId('spec-timeline-more')
    fireEvent.click(screen.getByTestId('spec-timeline-more'))
    await waitFor(() => expect(screen.getAllByTestId('spec-timeline-entry')).toHaveLength(2))
    expect(screen.queryByTestId('spec-timeline-more')).not.toBeInTheDocument()
  })

  it('shows the empty state with a help hint and a refresh action', async () => {
    mockTimeline({ '|': { entries: [], counts: { spec_edit: 0, addendum: 0, mission_turn: 0, job: 0, phase: 0, audit: 0, pr_event: 0, review: 0 }, total: 0 } })
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    const empty = await screen.findByTestId('spec-timeline-empty')
    expect(empty).toHaveTextContent('Nothing has happened to this spec yet')
    expect(within(empty).getByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(within(empty).getByRole('button', { name: /Learn more about the spec timeline and hand-off/i })).toBeInTheDocument()
  })

  it('reports a failed load and retries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue({ ok: true, json: async () => ({ ticketId: 7, entries: [entry({ id: 'a' })], nextCursor: null, counts, total: 1 }) } as Response)
    vi.stubGlobal('fetch', fetchMock)
    render(<SpecTimeline {...baseProps} onNavigate={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the timeline.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('spec-timeline-entry')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
