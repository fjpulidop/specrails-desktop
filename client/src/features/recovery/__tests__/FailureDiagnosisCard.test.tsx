import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { FailureDiagnosisCard } from '../components/FailureDiagnosisCard'
import type { FailureDiagnosis, RemedyHandlers } from '../lib/failure-diagnosis'

const diagnosis = (over: Partial<FailureDiagnosis> = {}): FailureDiagnosis => ({
  kind: 'tests_failed', confidence: 'high', phase: 'reviewer', rounds: 4, resetAt: null, detail: null, resumablePhase: 'fixer', blocker: null, source: 'core',
  remedies: ['continue', 'edit-spec', 'open-logs', 'retry'], ...over,
})
const handlers = () => ({
  continue: { run: vi.fn() }, retry: { run: vi.fn() }, 'edit-spec': { run: vi.fn() }, 'open-logs': { run: vi.fn() },
}) satisfies RemedyHandlers

describe('FailureDiagnosisCard', () => {
  it('says what failed in plain words, in an accessible labelled region that does not announce itself', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={handlers()} />)
    const region = screen.getByRole('region', { name: 'Tests failed in the Reviewer phase after 4 fix rounds' })
    expect(region).toHaveAttribute('data-kind', 'tests_failed')
    // Opening a historical failed job must not read the failure aloud again: the labelled region is enough.
    expect(within(region).queryByRole('status')).toBeNull()
    expect(region.querySelector('[aria-live]')).toBeNull()
    expect(within(region).getByTestId('failure-headline')).toHaveTextContent('Tests failed in the Reviewer phase after 4 fix rounds')
    expect(within(region).getByRole('group', { name: 'Ways to recover' })).toBeInTheDocument()
  })

  it('offers at most three ranked remedies, the first as the primary action, each with its consequence, and runs the real handlers', async () => {
    const h = handlers()
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={h} />)
    const group = screen.getByRole('group', { name: 'Ways to recover' })
    const buttons = within(group).getAllByRole('button').filter((b) => b.dataset.testid?.startsWith('failure-remedy-') && b.dataset.testid !== 'failure-remedy-more')
    expect(buttons.map((b) => b.textContent)).toEqual(['Continue from Fixer', 'Edit spec and relaunch', 'Open logs at the failure'])
    expect(buttons[0]).toHaveAttribute('data-primary')
    expect(buttons[0]).toHaveAccessibleDescription('Keeps everything and goes on from the step that failed.')
    expect(screen.getByTestId('failure-remedy-consequence-open-logs')).toHaveTextContent('Scrolls to the failed step in the log.')
    await userEvent.click(buttons[0]); await userEvent.click(buttons[1]); await userEvent.click(buttons[2])
    expect(h.continue.run).toHaveBeenCalledTimes(1)
    expect(h['edit-spec'].run).toHaveBeenCalledTimes(1)
    expect(h['open-logs'].run).toHaveBeenCalledTimes(1)
    expect(h.retry.run).not.toHaveBeenCalled()
  })

  it('keeps Start over apart, in the menu, with its warning', async () => {
    const h = handlers()
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={h} />)
    expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull()
    await userEvent.click(screen.getByTestId('failure-remedy-more'))
    const item = await screen.findByTestId('failure-remedy-retry')
    expect(item).toHaveTextContent('Start over')
    expect(item).toHaveTextContent("A fresh run from the base. This attempt's work is not carried over; it stays in the old worktree.")
    await userEvent.click(item)
    expect(h.retry.run).toHaveBeenCalledTimes(1)
  })

  it('reads the older remedy ids as Continue', () => {
    const h = handlers()
    render(<FailureDiagnosisCard diagnosis={diagnosis({ remedies: ['resume', 'retry-with-browser', 'open-logs'] as never })} handlers={h} />)
    expect(screen.getByTestId('failure-remedy-continue')).toHaveTextContent('Continue from Fixer')
    expect(screen.getAllByTestId(/^failure-remedy-continue$/)).toHaveLength(1)
  })

  it('does not offer a remedy the surface cannot run', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={{ 'open-logs': { run: vi.fn() } }} />)
    expect(screen.queryByTestId('failure-remedy-continue')).toBeNull()
    expect(screen.queryByTestId('failure-remedy-more')).toBeNull()
    expect(screen.getByTestId('failure-remedy-open-logs')).toBeInTheDocument()
  })

  it('disables a busy remedy', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={{ continue: { run: vi.fn(), busy: true } }} />)
    expect(screen.getByTestId('failure-remedy-continue')).toBeDisabled()
    expect(screen.getByTestId('failure-remedy-continue')).toHaveAttribute('aria-busy', 'true')
  })

  it('explains a provider limit with the reset time', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'provider_limit', phase: null, rounds: null, resetAt: '3am (Europe/Madrid)', remedies: ['continue', 'open-logs', 'retry'] })} handlers={handlers()} />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent("The AI provider's usage limit was reached")
    expect(screen.getByTestId('failure-why')).toHaveTextContent('It resets 3am (Europe/Madrid). Continue then, or run it on another provider.')
    expect(screen.getByTestId('failure-remedy-consequence-continue')).toHaveTextContent('goes on once the provider accepts requests again')
  })

  it('says nothing about a reset it does not know', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'provider_limit', phase: null, rounds: null, remedies: ['retry'] })} handlers={handlers()} />)
    expect(screen.getByTestId('failure-why')).toHaveTextContent('Wait for the limit to reset, then continue, or run it on another provider.')
  })

  it('shows what the host must do for an environment failure, without running anything', async () => {
    const h = handlers()
    const blocker = { kind: 'network', reason: 'The Playwright browser download cannot reach its CDN', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: 'ticket-1', requiredAction: 'Run it with network access, then retry' }
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'environment', phase: 'verify', rounds: null, blocker, remedies: ['continue', 'fix-environment', 'open-logs', 'retry'] })} handlers={h} />)
    const fix = screen.getByTestId('failure-remedy-fix-environment')
    expect(fix).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(fix)
    expect(fix).toHaveAttribute('aria-expanded', 'true')
    const panel = screen.getByTestId('failure-environment')
    expect(panel).toHaveTextContent('The Playwright browser download cannot reach its CDN')
    expect(panel).toHaveTextContent('npx playwright install chromium')
    expect(panel).toHaveTextContent('Required action: Run it with network access, then retry')
    expect(h.continue.run).not.toHaveBeenCalled()
  })

  it('claims no cause when it is unknown: says so and shows the raw log tail', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'unknown', confidence: 'low', phase: null, rounds: null, resumablePhase: null, remedies: ['open-logs', 'retry'] })} handlers={handlers()} logTail={['npm ERR! something', 'exit 1']} />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent('Unknown cause')
    expect(screen.getByText("The run's own records don't name the cause. An AI reading of the log usually finds it.")).toBeInTheDocument()
    expect(screen.getByTestId('failure-log-tail')).toHaveTextContent('npm ERR! something exit 1')
    expect(screen.queryByTestId('failure-detail')).toBeNull()
    expect(screen.getByTestId('failure-diagnosis-card')).toHaveAttribute('data-confidence', 'low')
  })

  it('keeps the raw tail out of a known cause', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={handlers()} logTail={['noise']} />)
    expect(screen.queryByTestId('failure-log-tail')).toBeNull()
  })

  it.each([
    ['blocked', 'The run is blocked in the Reviewer phase'],
    ['timeout', 'The Reviewer phase ran out of time'],
    ['tool_inactivity', 'The agent went quiet in the Reviewer phase'],
    ['crash', 'The agent stopped unexpectedly in the Reviewer phase'],
  ] as const)('has a plain headline for %s', (kind, headline) => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind, rounds: null })} handlers={handlers()} />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent(headline)
  })
})

describe('FailureDiagnosisCard: environment plan remedy', () => {
  it('offers the pinned-Python venv the host detected and saves it to the project settings', async () => {
    const { setActiveProjectId } = await import('../../../lib/api')
    setActiveProjectId('p1')
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/agent-runtime/environment-plan')) return new Response(JSON.stringify({ plans: [{ repositoryId: 'repo', name: 'deckdex', version: '3.11', reason: 'backend/Dockerfile', applied: false }] }), { status: 200 })
      if (url.endsWith('/agent-runtime/environment-plan/apply') && init?.method === 'POST') return new Response(JSON.stringify({ applied: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={handlers()} />)
      const offer = await screen.findByTestId('failure-environment-plan')
      expect(offer).toHaveTextContent('deckdex pins Python 3.11')
      await userEvent.click(within(offer).getByTestId('failure-environment-plan-apply'))
      expect(await within(offer).findByRole('status')).toHaveTextContent('Saved to the project settings')
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/projects/p1/agent-runtime/environment-plan/apply'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ repositoryId: 'repo' }) }))
    } finally { vi.unstubAllGlobals(); setActiveProjectId(null) }
  })

  it('offers nothing when the plan is already in the settings', async () => {
    const { setActiveProjectId } = await import('../../../lib/api')
    setActiveProjectId('p1')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plans: [{ repositoryId: 'repo', name: 'deckdex', version: '3.11', reason: '', applied: true }] }), { status: 200 })))
    try {
      render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'environment' })} handlers={handlers()} />)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.queryByTestId('failure-environment-plan')).toBeNull()
    } finally { vi.unstubAllGlobals(); setActiveProjectId(null) }
  })

  it('says when a usage limit resets in the person\'s clock, and no longer asks to relaunch', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'provider_limit', phase: null, rounds: null, resetAt: '3am (Europe/Madrid)', resetsAt: '2026-11-18T14:00:00.000Z', remedies: ['continue', 'open-logs', 'retry'] })} handlers={handlers()} />)
    const why = screen.getByTestId('failure-why')
    const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-11-18T14:00:00.000Z'))
    expect(why).toHaveTextContent(`It resets at`)
    expect(why.textContent).toContain(time)
    expect(why).toHaveTextContent('run it on another provider')
    expect(why.textContent).not.toMatch(/relaunch/i)
  })
})

describe('FailureDiagnosisCard: unfinished tasks and causes only an AI reading names', () => {
  const unknown = () => diagnosis({ kind: 'unknown', confidence: 'low', phase: 'implementation-stalled', rounds: null, resumablePhase: null, source: 'desktop', remedies: ['open-logs', 'retry'] })
  const ready = { status: 'ready' as const, provider: 'claude', model: 'sonnet', createdAt: '2026-11-18T18:10:00Z', stale: false,
    analysis: { headline: 'Task 4.1 needed a browser check the developer could not run', cause: 'The developer left the README task unticked.', category: 'incomplete_tasks' as const, failedStep: 'tasks', evidence: [], nextSteps: [] } }

  it('names unfinished tasks, lists them and leads with Continue, which finishes them', async () => {
    const run = { continue: { run: vi.fn() }, 'continue-to-review': { run: vi.fn() }, 'open-logs': { run: vi.fn() } } satisfies RemedyHandlers
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'incomplete_tasks', phase: 'implementation-stalled', rounds: null, resumablePhase: null, incompleteTasks: ['4.1 [human] Confirm the live charge'], remedies: ['continue', 'continue-to-review', 'open-logs', 'retry'] })} handlers={run} />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent('Some approved tasks were left unfinished')
    expect(screen.getByTestId('failure-incomplete-tasks')).toHaveTextContent('4.1 [human] Confirm the live charge')
    const buttons = within(screen.getByRole('group', { name: 'Ways to recover' })).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Continue', 'Continue to review', 'Open logs at the failure'])
    expect(buttons[0]).toHaveAttribute('data-primary')
    expect(buttons[0]).toHaveAccessibleDescription('Keeps everything and redoes only what was missing, with the browser and install guidance.')
    expect(buttons[1]).toHaveAccessibleDescription('Sends it to review now, with what is left listed as checks by hand.')
    await userEvent.click(buttons[0])
    expect(run.continue.run).toHaveBeenCalledTimes(1)
  })

  it('leads with the AI cause, labelled as such, instead of an unknown cause', () => {
    render(<FailureDiagnosisCard diagnosis={unknown()} handlers={handlers()} ai={{ state: ready, run: vi.fn() }} />)
    expect(screen.getByTestId('failure-ai-label')).toHaveTextContent('From AI analysis')
    expect(screen.getByTestId('failure-headline')).toHaveTextContent('Task 4.1 needed a browser check the developer could not run')
    expect(screen.getByTestId('failure-ai-cause')).toHaveTextContent('The developer left the README task unticked.')
    expect(screen.queryByText('Unknown cause')).toBeNull()
  })

  it('when nothing names the cause, says how to find it and makes the AI reading the primary action', async () => {
    const ai = { state: { status: 'idle' as const }, run: vi.fn() }
    render(<FailureDiagnosisCard diagnosis={unknown()} handlers={handlers()} ai={ai} />)
    expect(screen.getByTestId('failure-unknown-why')).toHaveTextContent("The run's own records don't name the cause")
    expect(screen.queryByText(/won't guess/)).toBeNull()
    const analyze = screen.getByTestId('failure-remedy-analyze')
    expect(analyze).toHaveAttribute('data-primary')
    expect(screen.getByTestId('failure-remedy-open-logs')).not.toHaveAttribute('data-primary')
    await userEvent.click(analyze)
    expect(ai.run).toHaveBeenCalledTimes(1)
  })

  it('shows the reading in progress without a second button', () => {
    render(<FailureDiagnosisCard diagnosis={unknown()} handlers={handlers()} ai={{ state: { status: 'running' }, run: vi.fn() }} />)
    expect(screen.getByTestId('failure-ai-running')).toBeInTheDocument()
    expect(screen.getByTestId('failure-remedy-analyze')).toBeDisabled()
  })
})
