import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionTimesCard, durationParts, parseDecisionTimes } from '../DecisionTimesCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key }),
}))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/current' }))

const H = 3_600_000
const stats = (medianMs: number | null, p90Ms: number | null, measured = 0, pending = 0, unknown = 0) => ({ measured, pending, unknown, medianMs, p90Ms })
const payload = {
  period: '30d', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
  project: { deliveries: 3, toDecision: stats(2 * H, 3 * H, 2, 1, 0), toMerge: stats(null, null, 0, 2, 1) },
  byLoop: [{ loopId: 'factory:implement', loopName: 'Implement', deliveries: 3, toDecision: stats(2 * H, 3 * H, 2, 1, 0), toMerge: stats(null, null, 0, 2, 1) }],
}
const empty = {
  ...payload,
  project: { deliveries: 0, toDecision: stats(null, null), toMerge: stats(null, null) },
  byLoop: [],
}
const response = (value: unknown, ok = true) => ({ ok, json: async () => value } as Response)
afterEach(() => vi.unstubAllGlobals())

describe('DecisionTimesCard', () => {
  it('renders median/p90 tiles and the per-loop table, showing unknown instead of zero', async () => {
    const fetch = vi.fn().mockResolvedValue(response(payload)); vi.stubGlobal('fetch', fetch)
    render(<DecisionTimesCard projectId="p1" period="30d" />)
    const decision = await screen.findByTestId('decision-times-to-decision')
    expect(within(decision).getByText('decisionTimes.units.hours {"value":"2.0"}')).toBeInTheDocument()
    expect(within(decision).getByText('decisionTimes.units.hours {"value":"3.0"}')).toBeInTheDocument()
    const merge = screen.getByTestId('decision-times-to-merge')
    expect(within(merge).getAllByText('decisionTimes.unknownValue')).toHaveLength(2)
    expect(within(merge).getByText('decisionTimes.counts {"measured":0,"pending":2,"unknown":1}')).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Implement' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/current/analytics/decision-times?period=30d', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('shows an empty state with no data and passes custom ranges', async () => {
    const fetch = vi.fn().mockResolvedValue(response(empty)); vi.stubGlobal('fetch', fetch)
    render(<DecisionTimesCard projectId="p1" period="custom" from="2026-10-01" to="2026-10-07" />)
    expect(await screen.findByTestId('decision-times-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('decision-times-to-decision')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/current/analytics/decision-times?period=custom&from=2026-10-01&to=2026-10-07', expect.anything())
  })

  it.each([response({}, false), response({ ...payload, project: { ...payload.project, deliveries: -1 } })])('reports unavailable data rather than zero', async (result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result))
    render(<DecisionTimesCard projectId="p1" period="7d" />)
    expect(await screen.findByText('decisionTimes.unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('decision-times-to-decision')).not.toBeInTheDocument()
  })

  it('does not fetch an incomplete custom range', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    render(<DecisionTimesCard projectId="p1" period="custom" />)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('durationParts / parseDecisionTimes', () => {
  it('scales units', () => {
    expect(durationParts(5 * 60_000)).toEqual({ value: '5', unit: 'minutes' })
    expect(durationParts(90 * 60_000)).toEqual({ value: '1.5', unit: 'hours' })
    expect(durationParts(30 * H)).toEqual({ value: '30', unit: 'hours' })
    expect(durationParts(72 * H)).toEqual({ value: '3.0', unit: 'days' })
    expect(durationParts(15 * 24 * H)).toEqual({ value: '15', unit: 'days' })
  })
  it('rejects malformed payloads', () => {
    expect(() => parseDecisionTimes(null)).toThrow()
    expect(() => parseDecisionTimes({ ...payload, byLoop: [{ ...payload.byLoop[0], loopName: 3 }] })).toThrow()
    expect(parseDecisionTimes(payload)).toBe(payload)
  })
})
