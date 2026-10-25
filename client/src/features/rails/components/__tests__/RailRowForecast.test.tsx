import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { render } from '../../../../test-utils'
import { RailRow } from '../RailRow'
import { resetLaunchForecastCache } from '../../../../lib/launch-forecast'
import { OPEN_BUDGET_PANEL_EVENT } from '../../../../lib/app-settings-events'
import type { LocalTicket } from '../../../../types'

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'p1', projects: [], setActiveProjectId: vi.fn() }),
}))

const ticket = { id: 7, title: 'Add login', status: 'todo', priority: 'medium', labels: [] } as unknown as LocalTicket
const props = {
  id: 'rail-1', label: 'Rail 1', tickets: [ticket], mode: 'implement' as const, status: 'idle' as const, jiggleMode: false,
  onModeChange: vi.fn(), onToggle: vi.fn(), onTicketClick: vi.fn(), onDelete: vi.fn(), onLongPress: vi.fn(), onRename: vi.fn(),
}
const body = { time: { p25Ms: 360_000, medianMs: 450_000, p75Ms: 540_000, sampleCount: 6 }, cost: null, minSamples: 5, budget: null }

function mockApi(forecast: unknown = body) {
  global.fetch = vi.fn().mockImplementation(async (url: string) =>
    String(url).includes('/launch-forecast') ? { ok: true, json: async () => forecast } : { ok: true, json: async () => ({}) }) as typeof fetch
}
const renderRow = (over: Partial<typeof props> & Record<string, unknown> = {}) =>
  render(<DndContext><RailRow {...props} {...over} /></DndContext>)

beforeEach(() => { resetLaunchForecastCache(); mockApi() })

describe('RailRow launch forecast', () => {
  it.each(['normal', 'compact'] as const)('shows the forecast of the selected loop on an idle rail with specs (%s)', async (density) => {
    renderRow({ density })
    expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((u) => u.includes('/launch-forecast'))!
    expect(call).toContain('loopId=factory%3Aimplement')
    expect(call).toContain('provider=claude')
  })

  it('shows nothing while the rail runs, with no specs, or on the hybrid roles engine', async () => {
    renderRow({ status: 'running' as const })
    renderRow({ tickets: [] })
    renderRow({ aiEngine: 'roles', providers: ['claude', 'codex'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await waitFor(() => expect(screen.queryByTestId('launch-forecast')).toBeNull())
    const forecastCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('/launch-forecast'))
    expect(forecastCalls).toHaveLength(0)
  })
})

describe('RailRow launch forecast noise', () => {
  it('stays silent on an idle rail with no history yet, instead of repeating "Not enough history yet"', async () => {
    mockApi({ time: null, cost: null, minSamples: 5, budget: null })
    const view = renderRow()
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByText('Not enough history yet')).toBeNull()
    expect(view.container.querySelector('[data-testid="launch-forecast"]')).toBeNull()
  })

  it('labels the band per spec when the rail holds several specs', async () => {
    renderRow({ tickets: [ticket, { ...ticket, id: 8 } as unknown as LocalTicket] })
    expect(await screen.findByText('(per spec)')).toBeInTheDocument()
  })
})

describe('RailRow play with the daily budget reached', () => {
  const reached = { ...body, budget: { scope: 'project', budgetUsd: 10, spentUsd: 10, exhausted: false, resetsAt: null } }
  const play = () => screen.getByTitle('Play')

  it.each(['normal', 'compact'] as const)('refuses to launch and offers Raise limit instead of Launch anyway (%s)', async (density) => {
    mockApi(reached)
    const onToggle = vi.fn()
    renderRow({ density, onToggle })
    await screen.findByRole('button', { name: 'Daily budget reached' })
    fireEvent.click(play())
    const dialog = await screen.findByTestId('launch-over-budget-dialog')
    expect(dialog).toHaveTextContent('This limit is used up, so the launch would be refused. Raise the limit or wait for the reset.')
    expect(within(dialog).queryByRole('button', { name: 'Launch anyway' })).toBeNull()
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Raise limit' }))
      expect(opened).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened) }
    expect(onToggle).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('launch-over-budget-dialog')).toBeNull())
  })

  it('Cancel keeps the rail idle', async () => {
    mockApi(reached)
    const onToggle = vi.fn()
    renderRow({ onToggle })
    await screen.findByRole('button', { name: 'Daily budget reached' })
    fireEvent.click(play())
    fireEvent.click(within(await screen.findByTestId('launch-over-budget-dialog')).getByRole('button', { name: 'Cancel' }))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('launches at once when there is room in the budget, and Stop is never gated', async () => {
    mockApi({ ...body, budget: { scope: 'project', budgetUsd: 10, spentUsd: 1, exhausted: false, resetsAt: null } })
    const onToggle = vi.fn()
    renderRow({ onToggle })
    await screen.findByText('Usually 6–9 min for runs like this')
    fireEvent.click(play())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('launch-over-budget-dialog')).toBeNull()
  })

  it('does not gate Stop on a running rail', async () => {
    mockApi(reached)
    const onToggle = vi.fn()
    renderRow({ onToggle, status: 'running' as const })
    fireEvent.click(screen.getByTitle('Stop'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
