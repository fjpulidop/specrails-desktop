import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../../test-utils'
import { FailureAnalysisPanel } from '../components/FailureAnalysisPanel'
import { FailureDiagnosisCard } from '../components/FailureDiagnosisCard'
import { recordedStepError } from '../lib/failure-diagnosis'

const ready = {
  status: 'ready', provider: 'codex', model: 'gpt-6.1-sol', createdAt: '', stale: false,
  analysis: { headline: 'Usage limit reached', cause: 'Codex hit the session limit.', category: 'provider_limit', failedStep: 'developer', evidence: ['You have hit your usage limit'], nextSteps: ['Wait for the reset'] },
}
const reply = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body } as Response)

afterEach(() => { vi.restoreAllMocks() })

describe('FailureAnalysisPanel', () => {
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
})
