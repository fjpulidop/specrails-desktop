import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../test-utils'
import { LaunchForecast } from '../LaunchForecast'
import { resetLaunchForecastCache } from '../../lib/launch-forecast'
import { OPEN_APP_SETTINGS_EVENT, OPEN_PROJECT_SETTINGS_EVENT } from '../../lib/app-settings-events'

const time = { p25Ms: 360_000, medianMs: 450_000, p75Ms: 540_000, sampleCount: 7 }
const cost = { lowUsd: 2, highUsd: 4, sampleCount: 7 }

const planUsage = { providers: [{ providerId: 'claude', availability: 'available', plan: 'max', windows: [{ usedPercent: 10 }], spend: null }] }
const apiKeyUsage = { providers: [{ providerId: 'claude', availability: 'unsupported-auth', plan: null, windows: [], spend: null }] }

function mockApi(forecast: unknown, usage: unknown = apiKeyUsage) {
  global.fetch = vi.fn().mockImplementation(async (url: string) => {
    const u = String(url)
    if (u.includes('/launch-forecast')) return forecast === 'fail' ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => forecast }
    if (u.includes('/api/subscription-usage')) return { ok: true, json: async () => usage }
    return { ok: false, json: async () => ({}) }
  }) as typeof fetch
}

const view = (props: Partial<React.ComponentProps<typeof LaunchForecast>> = {}) =>
  render(<LaunchForecast projectId="p1" loopId="factory:implement" provider="claude" {...props} />)

beforeEach(() => resetLaunchForecastCache())
afterEach(() => vi.restoreAllMocks())

describe('LaunchForecast', () => {
  it('shows "Usually 6–9 min · $2–$4 for runs like this" labelled as an estimate', async () => {
    mockApi({ time, cost, minSamples: 5, budget: null })
    view()
    expect(await screen.findByText('Usually 6–9 min · $2–$4 for runs like this')).toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('launch-forecast-line'))
    expect((await screen.findAllByText('Estimate from 7 past runs — not billed cost')).length).toBeGreaterThan(0)
  })

  it('asks for the right target: project, loop and the engine that will run it', async () => {
    mockApi({ time, cost, minSamples: 5, budget: null })
    view({ projectId: 'proj-9', loopId: 'factory:freestyle', provider: 'codex' })
    await screen.findByTestId('launch-forecast')
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((u) => u.includes('/launch-forecast'))!
    expect(call).toMatch(/\/api\/projects\/proj-9\/launch-forecast\?loopId=factory%3Afreestyle&provider=codex$/)
  })

  it('says "Not enough history yet" instead of guessing, and explains the floor', async () => {
    mockApi({ time: null, cost: null, minSamples: 5, budget: null })
    view()
    expect(await screen.findByText('Not enough history yet')).toBeInTheDocument()
    expect(screen.queryByText(/Usually/)).toBeNull()
    expect(screen.queryByText(/\$/)).toBeNull()
    await userEvent.hover(screen.getByTestId('launch-forecast-line'))
    expect((await screen.findAllByText('Needs at least 5 finished runs like this in this project and engine.')).length).toBeGreaterThan(0)
  })

  it('shows time only when there is no provider-reported cost band (estimates are never mixed in)', async () => {
    mockApi({ time, cost: null, minSamples: 5, budget: null })
    view()
    expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('hides the dollar figure for a subscription plan (time only), once the plan is known', async () => {
    mockApi({ time, cost, minSamples: 5, budget: null }, planUsage)
    view()
    expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/\$/)).toBeNull())
  })

  it('never flashes the dollar figure before the billing mode is known', async () => {
    let release!: (v: unknown) => void
    const usage = new Promise((resolve) => { release = resolve })
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.includes('/launch-forecast')) return { ok: true, json: async () => ({ time, cost, minSamples: 5, budget: null }) }
      return { ok: true, json: async () => usage }
    }) as typeof fetch
    view()
    expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
    await act(async () => { release(planUsage); await usage })
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  describe('unknown billing mode shows time only', () => {
    const stuckUsage = (forecast: unknown) => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        const u = String(url)
        if (u.includes('/launch-forecast')) return { ok: true, json: async () => forecast }
        return new Promise(() => {}) // the usage snapshot never answers
      }) as typeof fetch
    }

    it('shows no dollar figure while the snapshot has not loaded', async () => {
      stuckUsage({ time, cost, minSamples: 5, budget: null })
      view()
      expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
      expect(screen.queryByText(/\$/)).toBeNull()
    })

    it.each([
      ['an unreadable snapshot', 'fail'],
      ['a snapshot without this provider', { providers: [{ providerId: 'codex', availability: 'available', plan: 'plus', windows: [], spend: null }] }],
      ['a signed-out provider', { providers: [{ providerId: 'claude', availability: 'signed-out', plan: null, windows: [], spend: null }] }],
      ['an unavailable provider', { providers: [{ providerId: 'claude', availability: 'unavailable', plan: null, windows: [], spend: null }] }],
    ])('shows time only for %s', async (_name, usage) => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        const u = String(url)
        if (u.includes('/launch-forecast')) return { ok: true, json: async () => ({ time, cost, minSamples: 5, budget: null }) }
        if (usage === 'fail') return { ok: false, json: async () => ({}) }
        return { ok: true, json: async () => usage }
      }) as typeof fetch
      view()
      expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/subscription-usage')))
      await act(async () => { await Promise.resolve() })
      expect(screen.queryByText(/\$/)).toBeNull()
    })

    it('adds the dollar figure once the snapshot confirms API-key billing, and for on-demand enterprise spend', async () => {
      let release!: (v: unknown) => void
      const usage = new Promise((resolve) => { release = resolve })
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        const u = String(url)
        if (u.includes('/launch-forecast')) return { ok: true, json: async () => ({ time, cost, minSamples: 5, budget: null }) }
        return { ok: true, json: async () => usage }
      }) as typeof fetch
      view()
      expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
      await act(async () => { release(apiKeyUsage); await usage })
      expect(await screen.findByText('Usually 6–9 min · $2–$4 for runs like this')).toBeInTheDocument()
    })

    it('shows the cost for enterprise on-demand spend', async () => {
      mockApi({ time, cost, minSamples: 5, budget: null }, { providers: [{ providerId: 'claude', availability: 'available', plan: 'enterprise', windows: [], spend: { kind: 'enterprise-on-demand' } }] })
      view()
      expect(await screen.findByText('Usually 6–9 min · $2–$4 for runs like this')).toBeInTheDocument()
    })
  })

  it('labels the band "per spec" for a target holding several specs, and uses tabular numerals', async () => {
    mockApi({ time, cost: null, minSamples: 5, budget: null })
    view({ perSpec: true })
    const line = await screen.findByTestId('launch-forecast-line')
    expect(line).toHaveTextContent('Usually 6–9 min for runs like this(per spec)')
    expect(screen.getByTestId('launch-forecast').className).toContain('tabular-nums')
  })

  it('does not say "per spec" when there is no band to qualify', async () => {
    mockApi({ time: null, cost: null, minSamples: 5, budget: null })
    view({ perSpec: true })
    expect(await screen.findByText('Not enough history yet')).toBeInTheDocument()
    expect(screen.queryByText('(per spec)')).toBeNull()
  })

  it('hideWhenInsufficient renders nothing without a band, but still warns about a reached budget', async () => {
    mockApi({ time: null, cost: null, minSamples: 5, budget: null })
    const quiet = view({ hideWhenInsufficient: true })
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(quiet.container).toBeEmptyDOMElement()
    quiet.unmount()
    resetLaunchForecastCache()
    mockApi({ time: null, cost: null, minSamples: 5, budget: { scope: 'project', budgetUsd: 10, spentUsd: 10, exhausted: false, resetsAt: null } })
    view({ hideWhenInsufficient: true })
    expect(await screen.findByRole('button', { name: 'Daily budget reached' })).toBeInTheDocument()
  })

  it('renders nothing when the endpoint is unavailable, without a target, or for the hybrid roles engine', async () => {
    mockApi('fail')
    const first = view()
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(first.container).toBeEmptyDOMElement()
    first.unmount()
    mockApi({ time, cost, minSamples: 5, budget: null })
    const second = view({ provider: null })
    expect(second.container).toBeEmptyDOMElement()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  describe('daily budget caution', () => {
    const budget = (spentUsd: number, scope: 'project' | 'desktop' = 'project', exhausted = false) => ({ scope, budgetUsd: 10, spentUsd, exhausted, resetsAt: null })

    it('adds "May pause at budget" when today\'s spend plus the top of the band reaches the budget, linking to the project budget', async () => {
      mockApi({ time, cost, minSamples: 5, budget: budget(6.5) })
      const opened: string[] = []
      const onOpen = (e: Event) => opened.push((e as CustomEvent<{ section: string }>).detail.section)
      window.addEventListener(OPEN_PROJECT_SETTINGS_EVENT, onOpen)
      try {
        view()
        const caution = await screen.findByRole('button', { name: 'May pause at budget' })
        await userEvent.click(caution)
        expect(opened).toEqual(['budget'])
      } finally { window.removeEventListener(OPEN_PROJECT_SETTINGS_EVENT, onOpen) }
    })

    it('opens the app-wide budget for an app-wide budget', async () => {
      mockApi({ time, cost, minSamples: 5, budget: budget(8, 'desktop') })
      const opened: string[] = []
      const onOpen = (e: Event) => opened.push((e as CustomEvent<{ section: string }>).detail.section)
      window.addEventListener(OPEN_APP_SETTINGS_EVENT, onOpen)
      try {
        view()
        await userEvent.click(await screen.findByRole('button', { name: 'May pause at budget' }))
        expect(opened).toEqual(['advanced'])
      } finally { window.removeEventListener(OPEN_APP_SETTINGS_EVENT, onOpen) }
    })

    it('stays quiet while there is room, and with no budget at all', async () => {
      mockApi({ time, cost, minSamples: 5, budget: budget(1) })
      view()
      await screen.findByText(/Usually/)
      expect(screen.queryByTestId('launch-forecast-budget')).toBeNull()
    })

    it('says the budget is reached when it already is, even without enough history', async () => {
      mockApi({ time: null, cost: null, minSamples: 5, budget: budget(10) })
      view()
      expect(await screen.findByRole('button', { name: 'Daily budget reached' })).toBeInTheDocument()
      expect(screen.getByText('Not enough history yet')).toBeInTheDocument()
    })

    it('can warn on a plan provider without showing any dollar figure', async () => {
      mockApi({ time, cost, minSamples: 5, budget: budget(6.5) }, planUsage)
      view()
      expect(await screen.findByRole('button', { name: 'May pause at budget' })).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByText(/\$/)).toBeNull())
    })
  })
})
