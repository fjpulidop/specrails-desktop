import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Toaster } from 'sonner'
import { act, render, renderHook, screen } from '../../../test-utils'
import { useContinueRemedies } from '../hooks/useContinueRemedies'
import type { FailureDiagnosis } from '../lib/failure-diagnosis'

// The real toast store and toaster: a refused Continue must reach the screen, not only a mock.
const stalled: FailureDiagnosis = { kind: 'blocked', confidence: 'high', phase: 'correction-stalled', rounds: 1, resetAt: null, detail: 'Automatic correction changed nothing.', resumablePhase: null, blocker: null, source: 'core', remedies: ['continue'] }

describe('Continue refused by the server', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'remedy_not_applicable', detail: 'The run has no step to continue from' }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
  })

  it('shows the failure, with its reason and a retry, in the window where the person clicked', async () => {
    render(<Toaster />)
    const { result } = renderHook(() => useContinueRemedies('p', 'run', stalled, { enabled: true }))
    act(() => result.current.continue!.run())
    expect(await screen.findByText('Could not continue the run')).toBeInTheDocument()
    expect(screen.getByText('The run has no step to continue from')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
