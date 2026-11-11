import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from '../../../../lib/i18n'
import { AgentPrCiOfferCard, parsePrCiOfferRow, type PrCiOfferRow } from '../AgentPrCiOfferCard'
import { describePrCiStep } from '../../lib/pr-ci-steps'

const row = (over: Partial<PrCiOfferRow> = {}): PrCiOfferRow => ({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd1', prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', prs: [], railIndex: 0,
  state: 'offered', runId: null, runDeliveryId: null, reason: null, pushes: null, rounds: null, ...over })
afterEach(() => { vi.unstubAllGlobals() })

describe('pr-ci-offer rows', () => {
  it('parses only well-formed offer rows', () => {
    expect(parsePrCiOfferRow(JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd1', prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', railIndex: 0, state: 'green', pushes: 2, rounds: 1 })))
      .toMatchObject({ state: 'green', pushes: 2, rounds: 1, runId: null })
    expect(parsePrCiOfferRow(JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd1', prUrl: 'javascript:alert(1)', railIndex: 0, state: 'offered' }))).toBeNull()
    expect(parsePrCiOfferRow(JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd1', prUrl: 'https://x/pull/1', railIndex: 0, state: 'weird' }))).toBeNull()
    expect(parsePrCiOfferRow('not json')).toBeNull()
  })
})

describe('AgentPrCiOfferCard', () => {
  it('offers Start and Not now, and starts exactly once on a double click', async () => {
    let resolve!: (value: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>(r => { resolve = r }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentPrCiOfferCard row={row()} conversationId="conv-1" />)
    expect(screen.getByTestId('agent-pr-ci-offer').textContent).toContain('Watch and fix the CI of PR #7')
    fireEvent.click(screen.getByTestId('agent-pr-ci-start'))
    fireEvent.click(screen.getByTestId('agent-pr-ci-start'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/projects\/p1\/rails\/0\/pr-ci$/)
    expect(JSON.parse(String(init.body))).toEqual({ prDeliveryId: 'd1', originConversationId: 'conv-1', originSurface: 'agent-chat' })
    resolve(new Response(JSON.stringify({ loopRunIds: ['r1'] }), { status: 202 }))
    await waitFor(() => expect(screen.getByTestId('agent-pr-ci-offer').getAttribute('data-state')).toBe('started'))
  })

  it('after a stop, runs the loop again on the generation the last run left', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ loopRunIds: ['r2'] }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentPrCiOfferCard row={row({ state: 'needs-attention', reason: 'flaky', runId: 'r1', runDeliveryId: 'd2' })} conversationId="conv-1" />)
    fireEvent.click(screen.getByTestId('agent-pr-ci-retry'))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ prDeliveryId: 'd2' })
    await waitFor(() => expect(screen.getByTestId('agent-pr-ci-offer').getAttribute('data-state')).toBe('started'))
  })

  it('shows a 409 inline and lets the person retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'pr_not_open', detail: 'The pull request is merged.' }), { status: 409 })))
    render(<AgentPrCiOfferCard row={row()} />)
    fireEvent.click(screen.getByTestId('agent-pr-ci-start'))
    expect((await screen.findByTestId('agent-pr-ci-offer-error')).textContent).toContain('The pull request is merged.')
    expect(screen.getByTestId('agent-pr-ci-start')).not.toBeDisabled()
  })

  it('persists Not now and collapses to a quiet line', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentPrCiOfferCard row={row()} />)
    fireEvent.click(screen.getByTestId('agent-pr-ci-dismiss'))
    await waitFor(() => expect(screen.getByTestId('agent-pr-ci-offer').getAttribute('data-state')).toBe('dismissed'))
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/\/rails\/pr-ci-offer\/dismiss$/)
  })

  it.each([
    ['started', { state: 'started' as const, runId: 'r1' }, 'Watching the CI of PR #7 on Rail 1'],
    ['green', { state: 'green' as const, pushes: 2, rounds: 1 }, '2 fixes pushed to the PR after 1 failing round(s).'],
    ['no-ci', { state: 'no-ci' as const }, 'PR #7 has no CI checks'],
    ['needs-attention', { state: 'needs-attention' as const, reason: 'The checks still fail after 5 fix round(s).' }, 'The checks still fail after 5 fix round(s).'],
  ])('renders the %s state without start controls', (_label, over, text) => {
    render(<AgentPrCiOfferCard row={row(over)} />)
    expect(screen.getByTestId('agent-pr-ci-offer').textContent).toContain(text)
    expect(screen.queryByTestId('agent-pr-ci-start')).toBeNull()
  })
})

describe('AgentPrCiOfferCard for a multi-repository delivery', () => {
  const prs = [{ repository: 'app', prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7' }, { repository: 'lib', prNumber: 3, prUrl: 'https://github.com/acme/lib/pull/3' }]
  it('names every PR and links each one', () => {
    render(<AgentPrCiOfferCard row={row({ prs })} />)
    expect(screen.getByTestId('agent-pr-ci-offer').textContent).toContain('Watch and fix the CI of PRs app #7, lib #3')
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(prs.map((pr) => pr.prUrl))
  })
  it('parses the PR list and drops unsafe links', () => {
    expect(parsePrCiOfferRow(JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd1', prUrl: prs[0].prUrl, railIndex: 0, state: 'green', prs: [...prs, { repository: 'x', prUrl: 'javascript:alert(1)' }] }))?.prs).toEqual(prs)
  })
})

describe('PR CI run strip steps', () => {
  it('describes every step of factory:pr-ci in plain words, and nothing else', () => {
    const t = i18n.getFixedT('en', 'agent')
    expect(describePrCiStep(t, 'factory:pr-ci', 'checks')).toBe('Waiting for CI')
    expect(describePrCiStep(t, 'factory:pr-ci', 'fixer')).toBe('Fixing the failing checks')
    expect(describePrCiStep(t, 'factory:pr-ci', 'resolver')).toBe('Resolving conflicts with the base branch')
    expect(describePrCiStep(t, 'factory:pr-ci', 'push')).toBe('Pushing the fix to the PR')
    expect(describePrCiStep(t, 'factory:implement', 'checks')).toBeNull()
    expect(describePrCiStep(t, 'factory:pr-ci', 'unknown')).toBeNull()
  })
})
