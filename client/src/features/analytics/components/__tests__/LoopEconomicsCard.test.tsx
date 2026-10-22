import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopEconomicsCard, parseLoopEconomics, type LoopEconomicsGroup } from '../LoopEconomicsCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key }),
}))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/current' }))

const H = 3_600_000
const stats = (medianMs: number | null, p90Ms: number | null) => ({ measured: medianMs === null ? 0 : 1, pending: 0, unknown: 0, medianMs, p90Ms })
const group = (over: Partial<LoopEconomicsGroup> = {}): LoopEconomicsGroup => ({
  hasData: true, delivered: 4, merged: 2, discarded: 1, superseded: 0, onReview: 1, discardRate: 0.25,
  cost: { pricedDeliveries: 3, unpricedDeliveries: 1, incompleteDeliveries: 0, totalUsd: 6, authoritativeUsd: 4.5, estimatedUsd: 1.5, avgCostUsd: 2, estimatedShare: 0.25 },
  decisionTimes: { deliveries: 4, toDecision: stats(2 * H, 3 * H), toMerge: stats(null, null) },
  rounds: { measuredDeliveries: 2, reviewRounds: 3, fixerRounds: 1, reviewPerDelivery: 1.5, fixerPerDelivery: 0.5 },
  escapedDefects: 1, requirementsDemonstrated: null, triageAccuracy: null,
  ...over,
})
const noData = group({
  hasData: false, delivered: 0, merged: 0, discarded: 0, onReview: 0, discardRate: null,
  cost: { pricedDeliveries: 0, unpricedDeliveries: 0, incompleteDeliveries: 0, totalUsd: null, authoritativeUsd: null, estimatedUsd: null, avgCostUsd: null, estimatedShare: null },
  decisionTimes: { deliveries: 0, toDecision: stats(null, null), toMerge: stats(null, null) },
  rounds: { measuredDeliveries: 0, reviewRounds: 0, fixerRounds: 0, reviewPerDelivery: null, fixerPerDelivery: null },
  escapedDefects: null,
})
const payload = {
  period: '30d', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
  sources: { escapedDefects: 'tracked', requirementsDemonstrated: 'unavailable', triageAccuracy: 'unavailable' },
  project: group(),
  byLoop: [
    { loopId: 'factory:implement', loopName: 'Implement', ...group() },
    { loopId: 'factory:sdd-quick', loopName: 'SDD Quick', ...group({ cost: { ...group().cost, avgCostUsd: null, estimatedShare: null, pricedDeliveries: 0 }, rounds: { ...group().rounds, reviewPerDelivery: null, fixerPerDelivery: null } }) },
    { loopId: 'factory:freestyle', loopName: 'Freestyle', ...noData },
  ],
}
const response = (value: unknown, ok = true) => ({ ok, json: async () => value } as Response)
afterEach(() => vi.unstubAllGlobals())

describe('LoopEconomicsCard', () => {
  it('renders per-loop columns with estimated share, unknown dashes and no-data rows', async () => {
    const fetch = vi.fn().mockResolvedValue(response(payload)); vi.stubGlobal('fetch', fetch)
    render(<LoopEconomicsCard projectId="p1" period="30d" />)
    const rows = await screen.findAllByTestId('loop-economics-row')
    expect(rows).toHaveLength(3)
    const implement = within(rows[0])
    expect(implement.getByRole('rowheader', { name: 'Implement' })).toBeInTheDocument()
    expect(implement.getByText('$2.00')).toBeInTheDocument()
    expect(implement.getByText('loopEconomics.estimatedShare {"share":"25%"}')).toBeInTheDocument()
    expect(implement.getByText('loopEconomics.unpriced {"count":1}')).toBeInTheDocument()
    expect(implement.getByText('1.5')).toBeInTheDocument()
    // Placeholders are "no data", never zero.
    expect(implement.getAllByText('loopEconomics.noData')).toHaveLength(2)
    const quick = within(rows[1])
    expect(quick.getAllByText('loopEconomics.unknownValue').length).toBeGreaterThanOrEqual(3)
    expect(quick.queryByText('$0.00')).not.toBeInTheDocument()
    const freestyle = within(rows[2])
    expect(freestyle.getByText('loopEconomics.noData')).toBeInTheDocument()
    expect(freestyle.queryByText('0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('loop-economics-untracked')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/current/analytics/loop-economics?period=30d', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('explains untracked escaped defects and shows an empty state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...payload, sources: { ...payload.sources, escapedDefects: 'untracked' } })))
    const { unmount } = render(<LoopEconomicsCard projectId="p1" period="30d" />)
    expect(await screen.findByTestId('loop-economics-untracked')).toBeInTheDocument()
    unmount()
    const fetch = vi.fn().mockResolvedValue(response({ ...payload, project: noData, byLoop: [] })); vi.stubGlobal('fetch', fetch)
    render(<LoopEconomicsCard projectId="p1" period="custom" from="2026-10-01" to="2026-10-07" />)
    expect(await screen.findByTestId('loop-economics-empty')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/current/analytics/loop-economics?period=custom&from=2026-10-01&to=2026-10-07', expect.anything())
  })

  it.each([response({}, false), response({ ...payload, project: { ...payload.project, delivered: -1 } })])('reports unavailable data rather than zero', async (result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result))
    render(<LoopEconomicsCard projectId="p1" period="7d" />)
    expect(await screen.findByText('loopEconomics.unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('loop-economics-row')).not.toBeInTheDocument()
  })

  it('does not fetch an incomplete custom range', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    render(<LoopEconomicsCard projectId="p1" period="custom" />)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed loops', () => {
    expect(() => parseLoopEconomics({ ...payload, byLoop: [{ ...group(), loopName: 3 }] })).toThrow()
    expect(parseLoopEconomics(payload).byLoop).toHaveLength(3)
  })
})

describe('LoopEconomicsCard — requirements demonstrated', () => {
  it('shows X/Y with the percentage once spec traces exist', async () => {
    const traced = { ...payload, sources: { ...payload.sources, requirementsDemonstrated: 'measured' }, byLoop: [{ loopId: 'factory:implement', loopName: 'Implement', ...group({ requirementsDemonstrated: { demonstrated: 3, total: 4, deliveries: 2 } }) }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(traced)))
    render(<LoopEconomicsCard projectId="p1" period="30d" />)
    const [row] = await screen.findAllByTestId('loop-economics-row')
    expect(row.textContent).toContain('3/4')
    expect(row.textContent).toContain('75%')
  })
})
