import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from '../../../../lib/i18n'
import { AgentPrCiOfferCard, parsePrCiOfferRow, type PrCiOfferRow } from '../AgentPrCiOfferCard'
import { describePrCiStep } from '../../lib/pr-ci-steps'

const row = (over: Partial<PrCiOfferRow> = {}): PrCiOfferRow => ({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd1', admissionId: null, repositoryId: null, repository: null, prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', prs: [], railIndex: 0,
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
  it('[spec:mission-pr-ci-repair/delivery-backed-ci-repair-is-preserved] offers Start and Not now, and starts exactly once on a double click', async () => {
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

  it('[spec:mission-pr-ci-repair/delivery-backed-ci-repair-is-preserved] once started it is one history line with the run log, never a second set of actions', () => {
    render(<AgentPrCiOfferCard row={row({ state: 'needs-attention', reason: 'flaky', runId: 'r1', runDeliveryId: 'd2' })} conversationId="conv-1" />)
    const line = screen.getByTestId('agent-pr-ci-offer')
    expect(line).toHaveAttribute('data-state', 'needs-attention')
    expect(line.textContent).not.toContain('flaky')
    expect(screen.queryByTestId('agent-pr-ci-start')).toBeNull()
    expect(screen.getByTestId('agent-pr-ci-open-run')).toHaveTextContent('Open the log')
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
    ['green', { state: 'green' as const, pushes: 2, rounds: 1 }, 'PR #7: all checks are green'],
    ['no-ci', { state: 'no-ci' as const }, 'PR #7 has no CI checks'],
    ['needs-attention', { state: 'needs-attention' as const, reason: 'The checks still fail after 5 fix round(s).' }, 'PR #7 is pushed; its CI is not green yet'],
  ])('renders the %s state without start controls', (_label, over, text) => {
    render(<AgentPrCiOfferCard row={row(over)} />)
    expect(screen.getByTestId('agent-pr-ci-offer').textContent).toContain(text)
    expect(screen.queryByTestId('agent-pr-ci-start')).toBeNull()
  })
})

describe('AgentPrCiOfferCard for a mission-origin PR without a delivery', () => {
  const mission = (over: Partial<PrCiOfferRow> = {}) => row({ prDeliveryId: null, railIndex: null, admissionId: 'a1', repositoryId: 'r-api', repository: 'api', prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7', ...over })

  it('[spec:mission-pr-ci-repair/mission-prepares-a-ci-repair-offer-from-a-project-pr-url] parses a mission-origin row by its admission and repository, never a delivery or rail', () => {
    const content = { kind: 'pr-ci-offer', projectId: 'p1', origin: 'mission', admissionId: 'a1', repositoryId: 'r-api', repository: 'api', prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7', state: 'offered' }
    expect(parsePrCiOfferRow(JSON.stringify(content))).toMatchObject({ prDeliveryId: null, railIndex: null, admissionId: 'a1', repositoryId: 'r-api', repository: 'api' })
    expect(parsePrCiOfferRow(JSON.stringify({ ...content, repositoryId: undefined }))).toBeNull()
    expect(parsePrCiOfferRow(JSON.stringify({ ...content, admissionId: undefined }))).toBeNull()
  })

  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] names the repository and PR, and starts through the admission with only its id', async () => {
    let resolve!: (value: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>(r => { resolve = r }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentPrCiOfferCard row={mission()} conversationId="conv-1" />)
    expect(screen.getByTestId('agent-pr-ci-offer').textContent).toContain('Watch and fix the CI of PR api #7')
    fireEvent.click(screen.getByTestId('agent-pr-ci-start'))
    fireEvent.click(screen.getByTestId('agent-pr-ci-start'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/projects\/p1\/rails\/pr-ci\/admissions\/a1\/start$/)
    expect(init.body).toBeUndefined()
    resolve(new Response(JSON.stringify({ runId: 'r1', loopRunIds: ['r1'] }), { status: 202 }))
    await waitFor(() => expect(screen.getByTestId('agent-pr-ci-offer').getAttribute('data-state')).toBe('started'))
  })

  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] dismisses through the admission', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentPrCiOfferCard row={mission()} />)
    fireEvent.click(screen.getByTestId('agent-pr-ci-dismiss'))
    await waitFor(() => expect(screen.getByTestId('agent-pr-ci-offer').getAttribute('data-state')).toBe('dismissed'))
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/\/rails\/pr-ci\/admissions\/a1\/dismiss$/)
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] shows a started repair as in progress, not as completed, with its log', () => {
    render(<AgentPrCiOfferCard row={mission({ state: 'started', runId: 'r1' })} />)
    const card = screen.getByTestId('agent-pr-ci-offer')
    expect(card.textContent).toContain('repair started')
    expect(card.textContent).not.toMatch(/green|no CI checks/)
    expect(screen.getByTestId('agent-pr-ci-open-run')).toHaveTextContent('Open the log')
  })

  it.each([
    ['green', { state: 'green' as const, pushes: 1, rounds: 1, runId: 'r1' }, 'PR api #7: all checks are green'],
    ['no-ci', { state: 'no-ci' as const, runId: 'r1' }, 'PR api #7 has no CI checks'],
    ['needs-attention', { state: 'needs-attention' as const, reason: 'Round budget exhausted', runId: 'r1' }, 'stopped before the checks turned green'],
  ])('keeps the %s result, its reason and log on the mission card itself', (_label, over, text) => {
    render(<AgentPrCiOfferCard row={mission(over)} />)
    const card = screen.getByTestId('agent-pr-ci-offer')
    expect(card.textContent).toContain(text)
    if (over.state === 'needs-attention') expect(card.textContent).toContain('Round budget exhausted')
    expect(screen.getByTestId('agent-pr-ci-open-run')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-pr-ci-start')).toBeNull()
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] shows the server\'s reason when the start is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'pr_fork_unsupported', detail: 'fork branches are not writable' }), { status: 409 })))
    render(<AgentPrCiOfferCard row={mission()} />)
    fireEvent.click(screen.getByTestId('agent-pr-ci-start'))
    expect((await screen.findByTestId('agent-pr-ci-offer-error')).textContent).toContain('fork branches are not writable')
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
