import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const h = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

import { BudgetCard } from '../BudgetCard'
import { WhatIfResultView } from '../WhatIfPanel'
import { resetLaunchForecastCache } from '../../../../lib/launch-forecast'
import type { WhatIfResult } from '../../lib/budget'

const period = (usd: number, byProvider: unknown[] = [{ provider: 'claude', usd, estimatedUsd: 0, invocations: 4, turns: 30 }], estimatedUsd = 0) => ({ startsAt: '2026-10-19T00:00:00.000Z', resetsAt: '2026-10-26T00:00:00.000Z', usd, estimatedUsd, byProvider })
const cap = (scope: 'project' | 'desktop', p: 'day' | 'week' | 'month', budgetUsd: number, spentUsd: number) => ({ scope, period: p, budgetUsd, spentUsd, exhausted: spentUsd >= budgetUsd, resetsAt: '2026-10-26T00:00:00.000Z' })

let project: Record<string, unknown>
let app: Record<string, unknown>
let usage: unknown
let patches: Array<{ url: string; body: unknown }>

beforeEach(() => {
  resetLaunchForecastCache()
  h.toast.success.mockClear(); h.toast.error.mockClear()
  patches = []
  usage = { providers: [{ providerId: 'claude', availability: 'unsupported-auth', plan: null, windows: [], spend: null }] }
  project = {
    spend: { day: period(2), week: period(42), month: period(120, undefined, 6) },
    projection: { estimate: true, trailingDays: 14, avgDailyUsd: 10, monthToDateUsd: 120, remainingDays: 6, projectedUsd: 180 },
    config: { day: null, week: 50, month: 150, run: 5 }, appConfig: null,
    caps: [cap('project', 'week', 50, 42), cap('project', 'month', 150, 120)],
  }
  app = { spend: { day: period(9), week: period(60), month: period(200) }, projection: null, config: { day: null, week: null, month: 500, run: null }, caps: [cap('desktop', 'month', 500, 200)] }
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input)
    if (init?.method === 'PATCH') { patches.push({ url: u, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
    if (u.endsWith('/api/subscription-usage')) return { ok: true, json: async () => usage }
    if (u.endsWith('/api/projects/p1/budget/caps')) return { ok: true, json: async () => project }
    if (u.endsWith('/api/budget/caps')) return { ok: true, json: async () => app }
    if (u.includes('/budget/what-if')) return { ok: true, json: async () => ({ days: 30, sources: [], targets: [], result: null }) }
    return { ok: false, json: async () => ({}) }
  }) as never
})
afterEach(() => vi.restoreAllMocks())

const row = (scope: string, p: string) => screen.findByTestId(`budget-row-${scope}-${p}`)

describe('BudgetCard', () => {
  it('shows spend against each cap with a level, tabular numbers and the reset', async () => {
    render(<BudgetCard projectId="p1" />)
    const week = await row('project', 'week')
    expect(week).toHaveAttribute('data-level', 'caution') // 42 of 50 = 84 %
    expect(within(week).getByTestId('budget-spent-project-week')).toHaveTextContent('$42.00 of $50.00')
    expect(within(week).getByTestId('budget-spent-project-week')).toHaveClass('num')
    expect(within(week).getByTestId('budget-spent-project-week')).toHaveTextContent('Nearing')
    // No cap on the day: spend only, no bar level.
    const day = await row('project', 'day')
    expect(day).toHaveAttribute('data-level', 'none')
    expect(within(day).getByTestId('budget-spent-project-day')).toHaveTextContent('$2.00 · no cap')
    expect(within(await row('project', 'month')).getByText(/about \$6.00 of it priced from the app’s price list, not reported/)).toBeInTheDocument()
    expect(await row('desktop', 'month')).toHaveAttribute('data-level', 'ok')
  })

  it('marks a reached cap with the destructive lamp', async () => {
    ;(project.caps as unknown[]).splice(0, 1, cap('project', 'week', 40, 42))
    ;(project.config as Record<string, unknown>).week = 40
    render(<BudgetCard projectId="p1" />)
    const week = await row('project', 'week')
    expect(week).toHaveAttribute('data-level', 'reached')
    expect(within(week).getByText('Reached')).toHaveClass('text-destructive')
  })

  it('labels the month-end projection as an estimate and warns when it passes the monthly cap', async () => {
    ;(project.projection as Record<string, number>).projectedUsd = 180
    render(<BudgetCard projectId="p1" />)
    const block = await screen.findByTestId('budget-projection')
    expect(within(block).getByText('Estimate')).toBeInTheDocument()
    expect(within(block).getByTestId('budget-projection-value')).toHaveTextContent('≈ $180.00')
    expect(block).toHaveTextContent('14-day average $10.00/day × 6 days left + $120.00 so far')
    expect(screen.getByTestId('budget-projection-over')).toHaveTextContent('pass the $150.00 monthly cap')
  })

  it('says there is not enough history instead of projecting from nothing', async () => {
    project.projection = null
    render(<BudgetCard projectId="p1" />)
    expect(await screen.findByText('Not enough history yet for a projection.')).toBeInTheDocument()
    expect(screen.queryByTestId('budget-projection-value')).toBeNull()
  })

  it('shows turns and plan limits, never dollars, for a plan-billed provider', async () => {
    usage = { providers: [{ providerId: 'claude', availability: 'available', plan: 'max', spend: null, windows: [{ label: '5h', usedPercent: 42 }, { label: 'weekly', usedPercent: 18 }] }] }
    render(<BudgetCard projectId="p1" />)
    const week = await row('project', 'week')
    await waitFor(() => expect(within(week).getByTestId('budget-spent-project-week')).toHaveTextContent('Turns: 30'))
    expect(within(week).getByTestId('budget-spent-project-week')).not.toHaveTextContent('$')
    expect(week).toHaveTextContent('Plan billing: no dollar cost per use')
    expect(week).toHaveTextContent('5h 42% · weekly 18%')
  })

  it('shows no dollar figure while the billing mode is still unknown', async () => {
    let release: (value: unknown) => void = () => {}
    const original = global.fetch
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/subscription-usage')) return new Promise((resolve) => { release = resolve as never })
      return (original as typeof fetch)(input, init)
    }) as never
    render(<BudgetCard projectId="p1" />)
    const week = await row('project', 'week')
    expect(within(week).getByTestId('budget-spent-project-week')).toHaveTextContent('–')
    expect(within(week).getByTestId('budget-spent-project-week')).not.toHaveTextContent('$')
    release({ ok: true, json: async () => usage })
    await waitFor(() => expect(within(week).getByTestId('budget-spent-project-week')).toHaveTextContent('$42.00 of $50.00'))
  })

  it('saves only the caps that changed, per scope, and clears with an empty field', async () => {
    render(<BudgetCard projectId="p1" />)
    const input = await screen.findByLabelText('Project monthly cap (USD)')
    expect(screen.getByTestId('budget-save-project')).toBeDisabled()
    fireEvent.change(input, { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText('Project per-run cap (USD)'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('budget-save-project'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ url: '/api/projects/p1/budget', body: { monthlyBudgetUsd: 200, runCapUsd: null } })
    expect(h.toast.success).toHaveBeenCalledWith('Budget saved')

    fireEvent.change(screen.getByLabelText('App-wide weekly cap (USD)'), { target: { value: '75.5' } })
    fireEvent.click(screen.getByTestId('budget-save-desktop'))
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1].body).toEqual({ desktopWeeklyBudgetUsd: 75.5 })
    expect(patches[1].url).toMatch(/\/api\/budget$/)
  })

  it('refuses a non-positive amount without calling the server', async () => {
    render(<BudgetCard projectId="p1" />)
    fireEvent.change(await screen.findByLabelText('Project weekly cap (USD)'), { target: { value: '-3' } })
    fireEvent.click(screen.getByTestId('budget-save-project'))
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Enter an amount above zero, or leave it empty for no cap.'))
    expect(patches).toHaveLength(0)
  })

  it('renders only the app-wide caps on the Desktop overlay', async () => {
    render(<BudgetCard projectId={null} />)
    expect(await screen.findByTestId('budget-group-desktop')).toBeInTheDocument()
    expect(screen.queryByTestId('budget-group-project')).toBeNull()
    expect(screen.queryByTestId('budget-whatif')).toBeNull()
  })

  it('offers the what-if pricer on a project and links the help topic', async () => {
    render(<BudgetCard projectId="p1" />)
    expect(await screen.findByTestId('budget-whatif')).toBeInTheDocument()
    expect(document.querySelector('[data-help-topic="dailyBudget"]')).not.toBeNull()
  })
})

describe('WhatIfResultView', () => {
  const base: WhatIfResult = {
    from: { provider: 'claude', model: 'sonnet' }, to: { provider: 'claude', model: 'haiku' }, days: 30, invocations: 20, repriced: 18, skipped: 2,
    tokens: { in: 12_000_000, out: 1_500_000, cacheRead: 0, cacheCreate: 0 }, recordedUsd: 41.2,
    estimateCurrentUsd: 40, estimateWhatIfUsd: 20, deltaUsd: -20, noPricing: null,
  }

  it('shows both estimates, the signed delta and what was left out', () => {
    render(<WhatIfResultView result={base} metered />)
    expect(screen.getByText('≈ $40.00 now → ≈ $20.00 instead')).toBeInTheDocument()
    const delta = screen.getByTestId('whatif-delta')
    expect(delta).toHaveAttribute('data-sign', 'saves')
    expect(delta).toHaveTextContent('≈ $20.00 less')
    expect(delta).toHaveTextContent('Estimate')
    expect(screen.getByText('2 runs without token usage or a price are left out.')).toBeInTheDocument()
    expect(screen.getByText('Recorded cost for these runs: $41.20.')).toBeInTheDocument()
  })

  it('words a dearer model as more, and an equal one as about the same', () => {
    const { rerender } = render(<WhatIfResultView result={{ ...base, deltaUsd: 12.5 }} metered />)
    expect(screen.getByTestId('whatif-delta')).toHaveTextContent('≈ $12.50 more')
    rerender(<WhatIfResultView result={{ ...base, deltaUsd: 0.001 }} metered />)
    expect(screen.getByTestId('whatif-delta')).toHaveAttribute('data-sign', 'same')
  })

  it('says "No pricing for <model>" instead of guessing', () => {
    render(<WhatIfResultView result={{ ...base, estimateCurrentUsd: null, estimateWhatIfUsd: null, deltaUsd: null, noPricing: { side: 'to', provider: 'local', model: 'qwen3-coder' } }} metered />)
    expect(screen.getByTestId('whatif-no-pricing')).toHaveTextContent('No pricing for qwen3-coder')
    expect(screen.queryByTestId('whatif-result')).toBeNull()
  })

  it('shows tokens, not dollars, when the current provider is on a plan', () => {
    render(<WhatIfResultView result={base} metered={false} />)
    expect(screen.getByTestId('whatif-plan')).toHaveTextContent('Tokens: 12,000,000 in · 1,500,000 out')
    expect(screen.queryByTestId('whatif-result')).toBeNull()
    expect(screen.queryByText(/\$/)).toBeNull()
  })
})
