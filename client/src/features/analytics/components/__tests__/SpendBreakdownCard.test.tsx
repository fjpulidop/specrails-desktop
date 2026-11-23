import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { resetLaunchForecastCache } from '../../../../lib/launch-forecast'
import { SpendBreakdownCard } from '../SpendBreakdownCard'
import type { CategoryBreakdownEntry, SpendingResponse } from '../../types/spending'

function category(overrides: Partial<CategoryBreakdownEntry> & Pick<CategoryBreakdownEntry, 'category'>): CategoryBreakdownEntry {
  return { costUsd: 0, estimatedCostUsd: 0, count: 0, tokens: 0, unpricedCount: 0, surfaces: [], ...overrides }
}

const baseData: SpendingResponse = {
  summary: {
    totalCostUsd: 10, totalEstimatedCostUsd: 2, totalTokens: 5000, totalRuns: 9, pricedRuns: 8, unpricedRuns: 1,
    failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null,
  },
  bySurface: [],
  byCategory: [
    category({
      category: 'missions', costUsd: 6, estimatedCostUsd: 2, count: 5, tokens: 4000, unpricedCount: 1,
      surfaces: [
        { surface: 'mission', costUsd: 4, count: 3, tokens: 3000 },
        { surface: 'intent', costUsd: 2, count: 2, tokens: 1000 },
      ],
    }),
    category({ category: 'implementation', costUsd: 4, count: 4, tokens: 1000, surfaces: [{ surface: 'job', costUsd: 4, count: 4, tokens: 1000 }] }),
    category({ category: 'specs' }),
    category({ category: 'code' }),
    category({ category: 'support' }),
  ],
  byModel: [], byMode: [], byProvider: [{ provider: 'claude', count: 9, costUsd: 8, estimatedCostUsd: 2 }],
  dailyTimeline: [], scatter: [], scatterTotal: 0, scatterTruncated: false, topTickets: [],
  trackingStartedAt: null, rangeFrom: '', rangeTo: '',
  agentMissions: {
    summary: { totalCostUsd: 6, estimatedCostUsd: 2, prevTotalCostUsd: 0, turns: 5, tokensIn: 0, tokensOut: 0 },
    topConversations: [
      { conversationId: 'c1', title: 'Refactor billing', costUsd: 5, estimatedCostUsd: 0, turns: 4, lastAt: null },
      { conversationId: 'c2', title: null, costUsd: 1, estimatedCostUsd: 1, turns: 1, lastAt: null },
    ],
  },
}

describe('SpendBreakdownCard', () => {
  beforeEach(() => {
    resetLaunchForecastCache()
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as never
  })

  it('renders a skeleton while loading without data', () => {
    const { container } = render(<SpendBreakdownCard data={null} loading />)
    expect(container.querySelector('[data-skeleton]')).toBeTruthy()
  })

  it('shows the empty state when the window has no activity', () => {
    const empty: SpendingResponse = {
      ...baseData,
      summary: { ...baseData.summary, totalCostUsd: 0, totalRuns: 0 },
      byCategory: baseData.byCategory!.map((c) => ({ ...c, costUsd: 0, count: 0, surfaces: [] })),
    }
    render(<SpendBreakdownCard data={empty} loading={false} />)
    expect(screen.getByTestId('breakdown-empty')).toHaveTextContent('No AI activity in this period.')
  })

  it('lists active categories with cost, share, calls, tokens and the why', () => {
    render(<SpendBreakdownCard data={baseData} loading={false} />)
    const missions = screen.getByTestId('breakdown-row-missions')
    expect(missions).toHaveTextContent('Missions')
    expect(missions).toHaveTextContent('Talking to the agent and Intent mode')
    // Share right-aligned beside a bar in the category colour.
    expect(screen.getByTestId('breakdown-share-missions')).toHaveTextContent('60%')
    expect(screen.getByTestId('breakdown-bar-missions').firstElementChild).toHaveAttribute('style', expect.stringContaining('background'))
    expect(missions).toHaveTextContent('5 calls')
    expect(missions).toHaveTextContent('4K tokens')
    // Missing cost data is a caution hint, not a sentence.
    const unpriced = screen.getByTestId('breakdown-unpriced-missions')
    expect(unpriced).toHaveAttribute('data-tone', 'caution')
    expect(unpriced).toHaveTextContent('1 without cost data')
    // Estimated part is marked like the hero (~ + sr-only "estimated").
    expect(screen.getByTestId('breakdown-cost-missions')).toHaveTextContent('~')
    expect(screen.getByTestId('breakdown-cost-implementation')).not.toHaveTextContent('~')
    expect(screen.getByTestId('breakdown-row-implementation')).toHaveTextContent('Building specs with rails, loops and jobs')
    // Categories without activity are summarised, not rendered as rows.
    expect(screen.queryByTestId('breakdown-row-code')).not.toBeInTheDocument()
    expect(screen.getByTestId('breakdown-idle')).toHaveTextContent('No activity: Specs · Code · Support')
  })

  it('expands a category into its surfaces (clickable filters) and the top conversations', async () => {
    const user = userEvent.setup()
    const onSelectSurface = vi.fn()
    render(<SpendBreakdownCard data={baseData} loading={false} activeSurfaces={['intent']} onSelectSurface={onSelectSurface} />)
    const toggle = screen.getByTestId('breakdown-toggle-missions')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('breakdown-surface-intent')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('breakdown-surface-mission')).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByTestId('breakdown-surface-mission'))
    expect(onSelectSurface).toHaveBeenCalledWith('mission')
    const conversations = screen.getByTestId('breakdown-conversations')
    expect(conversations).toHaveTextContent('Refactor billing')
    expect(conversations).toHaveTextContent('4 turns')
    expect(conversations).toHaveTextContent('Untitled mission')
    // Only missions carries conversations.
    await user.click(screen.getByTestId('breakdown-toggle-implementation'))
    expect(screen.getByTestId('breakdown-surface-job')).toBeInTheDocument()
    expect(screen.queryByTestId('breakdown-conversations')).not.toBeInTheDocument()
  })

  it('shows cost unavailable (never $0) for a category whose calls were all unpriced', () => {
    const data: SpendingResponse = {
      ...baseData,
      byCategory: [category({ category: 'code', count: 2, unpricedCount: 2, surfaces: [{ surface: 'file-summary', costUsd: 0, count: 2, tokens: 0 }] })],
    }
    render(<SpendBreakdownCard data={data} loading={false} />)
    expect(screen.getByTestId('breakdown-cost-code')).toHaveTextContent('cost unavailable')
    expect(screen.getByTestId('breakdown-row-code')).not.toHaveTextContent('% of spend')
  })

  it('labels plan-billed spend as an API-equivalent estimate like the hero', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ providers: [{ providerId: 'claude', availability: 'available', plan: 'max', windows: [], spend: null }] }) })) as never
    render(<SpendBreakdownCard data={baseData} loading={false} />)
    expect(await screen.findByTestId('breakdown-api-equivalent')).toHaveTextContent('API-equivalent estimate')
  })

  it('stays quiet when the billing snapshot is unavailable', async () => {
    render(<SpendBreakdownCard data={baseData} loading={false} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('breakdown-api-equivalent')).not.toBeInTheDocument()
  })
})
