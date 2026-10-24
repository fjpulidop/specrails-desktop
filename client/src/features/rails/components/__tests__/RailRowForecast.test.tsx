import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { render } from '../../../../test-utils'
import { RailRow } from '../RailRow'
import { resetLaunchForecastCache } from '../../../../lib/launch-forecast'
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

function mockApi() {
  global.fetch = vi.fn().mockImplementation(async (url: string) =>
    String(url).includes('/launch-forecast') ? { ok: true, json: async () => body } : { ok: true, json: async () => ({}) }) as typeof fetch
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
