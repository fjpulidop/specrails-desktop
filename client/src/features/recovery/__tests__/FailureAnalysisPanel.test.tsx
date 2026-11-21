import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../../test-utils'
import { FailureAnalysisPanel } from '../components/FailureAnalysisPanel'
import { FailureDiagnosisCard } from '../components/FailureDiagnosisCard'
import { recordedStepError } from '../lib/failure-diagnosis'

const ready = {
  status: 'ready', provider: 'codex', model: 'gpt-6.1-sol', createdAt: '', stale: false,
  analysis: { headline: 'Usage limit reached', cause: 'Codex hit the session limit.', category: 'provider_limit', failedStep: 'developer', evidence: ['You have hit your usage limit'], nextSteps: ['Wait for the reset'] },
}
const reply = (body: unknown, ok = true) => Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 500 }))

afterEach(() => { vi.restoreAllMocks() })

describe('FailureAnalysisPanel', () => {
  it('turns a next step that names a remedy this surface has into its button, and keeps the rest as advice', () => {
    const state = { ...ready, analysis: { ...ready.analysis, category: 'incomplete_tasks', nextSteps: ['Continue from the developer step', 'Run the developer on a stronger model', 'Read the README'],
      nextStepActions: [{ kind: 'continue', step: 'developer' }, { kind: 'change-model', role: 'developer' }, null] } }
    const run = vi.fn()
    render(<FailureAnalysisPanel jobId="j1" auto={false} controller={{ state, run: vi.fn() } as never} actions={{ continue: { run } }} />)
    fireEvent.click(screen.getByTestId('failure-analysis-action-continue'))
    expect(run).toHaveBeenCalledTimes(1)
    // No handler for a model change here, and the third step is plain advice.
    expect(screen.queryByTestId('failure-analysis-action-change-model')).toBeNull()
    expect(screen.getByText('Read the README')).toBeInTheDocument()
  })

  it('reads the steps as one plan that Continue carries out, never as options to pick', () => {
    const state = { ...ready, analysis: { ...ready.analysis, category: 'blocked', nextSteps: ['Keep the draft on a failed save', 'Extend the test', 'Resume from verification'] } }
    render(<FailureAnalysisPanel jobId="j1" auto={false} controller={{ state, run: vi.fn() } as never} continueCarriesPlan />)
    expect(screen.getByText('The plan to fix it')).toBeInTheDocument()
    expect(screen.getByTestId('failure-analysis-continue-plan')).toHaveTextContent("You don't need to pick one: Continue (above)")
    // No second Continue inside the analysis: the card's primary button is the only one.
    expect(screen.queryByTestId('failure-analysis-action-continue')).not.toBeInTheDocument()
  })
  it('asks for an analysis when none is saved and shows it as an AI reading', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => init?.method === 'POST' ? reply(ready) : reply({ status: 'none' }))
    render(<FailureAnalysisPanel projectId="p1" jobId="j1" auto />)
    expect(await screen.findByTestId('failure-analysis-headline')).toHaveTextContent('Usage limit reached')
    expect(screen.getByTestId('failure-analysis')).toHaveAttribute('data-category', 'provider_limit')
    expect(screen.getByText('Quota or usage limit')).toBeInTheDocument()
    expect(screen.getByTestId('failure-analysis-evidence')).toHaveTextContent('You have hit your usage limit')
    expect(screen.getByText(/AI analysis by codex\/gpt-6\.1-sol/)).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/jobs/j1/failure-analysis', expect.objectContaining({ method: 'POST', body: JSON.stringify({ language: 'en' }) }))
  })

  it('waits for the person when not automatic, and offers a retry after an error', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => init?.method === 'POST' ? reply({ error: 'analysis_failed', detail: 'model not supported' }, false) : reply({ status: 'none' }))
    render(<FailureAnalysisPanel projectId="p1" jobId="j1" auto={false} />)
    fireEvent.click(await screen.findByTestId('failure-analysis-run'))
    expect(await screen.findByText(/model not supported/)).toBeInTheDocument()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2))
  })
})

describe('recorded step error', () => {
  it('reads the runtime record of the failed step', () => {
    expect(recordedStepError(['[runtime] step_started: developer', '[runtime] step_failed: developer — OpenSpec change metadata is missing; the architect must create it']))
      .toEqual({ step: 'developer', reason: 'OpenSpec change metadata is missing; the architect must create it' })
    expect(recordedStepError(['plain output'])).toBeNull()
  })

  it('turns an unknown cause with a recorded step failure into a named failure', () => {
    render(<FailureDiagnosisCard
      diagnosis={{ kind: 'unknown', confidence: 'low', source: 'exit', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, remedies: ['open-logs'] }}
      handlers={{}}
      logTail={['[runtime] step_failed: developer — OpenSpec change metadata is missing']}
    />)
    expect(screen.getByTestId('failure-headline')).toHaveTextContent('The Developer step failed')
    expect(screen.getByTestId('failure-recorded-error')).toHaveTextContent('OpenSpec change metadata is missing')
    expect(screen.queryByText(/won't guess/)).not.toBeInTheDocument()
  })

  it('treats a recorded step failure as a failure: destructive tone, open log tail and a facts row', () => {
    render(<FailureDiagnosisCard
      diagnosis={{ kind: 'unknown', confidence: 'low', source: 'exit', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, remedies: ['open-logs'] }}
      handlers={{}}
      logTail={['[runtime] step_failed: developer — OpenSpec change metadata is missing']}
      facts={{ step: 'developer', attempt: 2, iteration: null, at: '2026-11-18T10:00:00Z' }}
    />)
    expect(screen.getByTestId('failure-diagnosis-card')).toHaveAttribute('data-tone', 'failed')
    expect(screen.getByTestId('failure-log-tail').closest('details')).toHaveAttribute('open')
    const facts = screen.getByTestId('failure-facts')
    expect(facts.tagName).toBe('DL')
    expect(facts).toHaveTextContent('StepDeveloper')
    expect(facts).toHaveTextContent('Attempt2')
    expect(facts).not.toHaveTextContent('Iteration')
    expect(facts).toHaveTextContent('Time')
  })
})

describe('FailureAnalysisPanel leads with the cause', () => {
  it('drops an AI headline that only repeats the recorded error and shows a skeleton while loading', async () => {
    const same = { ...ready, analysis: { ...ready.analysis, headline: 'OpenSpec change metadata is missing', cause: 'The architect never created the change.', category: 'missing_artifact' } }
    let resolve!: (value: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(r => { resolve = r }))
    render(<FailureAnalysisPanel projectId="p1" jobId="j1" auto={false} known={['OpenSpec change metadata is missing']} />)
    expect(screen.getByTestId('failure-analysis')).toHaveAttribute('data-state', 'loading')
    resolve(new Response(JSON.stringify(same)))
    expect(await screen.findByTestId('failure-analysis-cause')).toHaveTextContent('The architect never created the change.')
    expect(screen.queryByTestId('failure-analysis-headline')).not.toBeInTheDocument()
    expect(screen.getByText('The plan to fix it')).toBeInTheDocument()
  })
})
