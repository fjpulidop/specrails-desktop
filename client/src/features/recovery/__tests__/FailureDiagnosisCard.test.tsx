import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { FailureDiagnosisCard } from '../components/FailureDiagnosisCard'
import type { FailureDiagnosis, RemedyHandlers } from '../lib/failure-diagnosis'

const diagnosis = (over: Partial<FailureDiagnosis> = {}): FailureDiagnosis => ({
  kind: 'tests_failed', confidence: 'high', phase: 'reviewer', rounds: 4, resetAt: null, detail: null, resumablePhase: 'fixer', blocker: null, source: 'core',
  remedies: ['resume', 'edit-spec', 'open-logs', 'retry'], ...over,
})
const handlers = () => ({
  resume: { run: vi.fn() }, retry: { run: vi.fn() }, 'edit-spec': { run: vi.fn() }, 'open-logs': { run: vi.fn() },
}) satisfies RemedyHandlers

describe('FailureDiagnosisCard', () => {
  it('says what failed in plain words, in an accessible labelled region with a live status', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={handlers()} />)
    const region = screen.getByRole('region', { name: 'Tests failed in the Reviewer phase after 4 fix rounds' })
    expect(region).toHaveAttribute('data-kind', 'tests_failed')
    expect(within(region).getByRole('status')).toHaveTextContent('Tests failed in the Reviewer phase after 4 fix rounds')
    expect(within(region).getByRole('group', { name: 'Ways to recover' })).toBeInTheDocument()
  })

  it('offers at most three ranked remedies, the first as the primary action, and runs the real handlers', async () => {
    const h = handlers()
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={h} />)
    const buttons = within(screen.getByRole('group', { name: 'Ways to recover' })).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Resume from Fixer', 'Edit spec and relaunch', 'Open logs at the failure'])
    expect(buttons[0]).toHaveAttribute('data-primary')
    await userEvent.click(buttons[0]); await userEvent.click(buttons[1]); await userEvent.click(buttons[2])
    expect(h.resume.run).toHaveBeenCalledTimes(1)
    expect(h['edit-spec'].run).toHaveBeenCalledTimes(1)
    expect(h['open-logs'].run).toHaveBeenCalledTimes(1)
    expect(h.retry.run).not.toHaveBeenCalled()
  })

  it('does not offer a remedy the surface cannot run', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={{ 'open-logs': { run: vi.fn() } }} />)
    expect(screen.queryByTestId('failure-remedy-resume')).toBeNull()
    expect(screen.getByTestId('failure-remedy-open-logs')).toBeInTheDocument()
  })

  it('disables a busy remedy', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis()} handlers={{ resume: { run: vi.fn(), busy: true } }} />)
    expect(screen.getByTestId('failure-remedy-resume')).toBeDisabled()
    expect(screen.getByTestId('failure-remedy-resume')).toHaveAttribute('aria-busy', 'true')
  })

  it('explains a provider limit with the reset time', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'provider_limit', phase: null, rounds: null, resetAt: '3am (Europe/Madrid)', remedies: ['resume', 'retry', 'open-logs'] })} handlers={handlers()} />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent("The AI provider's usage limit was reached")
    expect(screen.getByTestId('failure-why')).toHaveTextContent('It resets 3am (Europe/Madrid). Resume once it has.')
  })

  it('says nothing about a reset it does not know', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'provider_limit', phase: null, rounds: null, remedies: ['retry'] })} handlers={handlers()} />)
    expect(screen.getByTestId('failure-why')).toHaveTextContent('Wait for the limit to reset, then resume.')
  })

  it('shows what the host must do for an environment failure, without running anything', async () => {
    const h = handlers()
    const blocker = { kind: 'network', reason: 'The Playwright browser download cannot reach its CDN', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: 'ticket-1', requiredAction: 'Run it with network access, then retry' }
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'environment', phase: 'verify', rounds: null, blocker, remedies: ['fix-environment', 'resume', 'open-logs', 'retry'] })} handlers={h} />)
    const fix = screen.getByTestId('failure-remedy-fix-environment')
    expect(fix).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(fix)
    expect(fix).toHaveAttribute('aria-expanded', 'true')
    const panel = screen.getByTestId('failure-environment')
    expect(panel).toHaveTextContent('The Playwright browser download cannot reach its CDN')
    expect(panel).toHaveTextContent('npx playwright install chromium')
    expect(panel).toHaveTextContent('Required action: Run it with network access, then retry')
    expect(h.resume.run).not.toHaveBeenCalled()
  })

  it('claims no cause when it is unknown: says so and shows the raw log tail', () => {
    render(<FailureDiagnosisCard diagnosis={diagnosis({ kind: 'unknown', confidence: 'low', phase: null, rounds: null, resumablePhase: null, remedies: ['open-logs', 'retry'] })} handlers={handlers()} logTail={['npm ERR! something', 'exit 1']} />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent('Unknown cause')
    expect(screen.getByText("The app can't tell why it stopped, so it won't guess.")).toBeInTheDocument()
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
