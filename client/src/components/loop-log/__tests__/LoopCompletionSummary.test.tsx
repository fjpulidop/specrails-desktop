import { describe, expect, it } from 'vitest'
import { render, screen } from '../../../test-utils'
import { LoopCompletionSummary } from '../LoopCompletionSummary'
import { parseLoopCompletion, type LoopCompletion } from '../completion-model'
const result: LoopCompletion = {
  version: 1, execution: 'success', steps: 1, deciderEvaluations: 0, turns: 50, costUsd: 18.95, costUncertain: false,
  core: { change: 'visuals', recordedAt: '2026-09-09T10:00:00Z',
    completion: { implementation: 'complete', validation: 'with-exceptions', archive: 'done', delivery: 'pending-host', reasons: [] },
    exceptions: [{ requirement: 'Hold HUD', reason: 'No hold mechanic', impact: 'Next preview', acceptedBy: 'user', approvalEvidence: 'Ticket decision' }],
    checks: [{ name: 'Browser timing', status: 'unavailable', required: false, scope: 'Real browser frames', limitations: 'Node does not measure GPU', evidence: ['browser.log'] }],
    findings: ['Peak HUD inspected'], phases: [{ name: 'reviewer', status: 'done', durationMs: 1200, attempts: 1 }],
  },
}
describe('completion summary', () => {
  it('shows exceptions and pending host delivery alongside successful execution', () => {
    render(<LoopCompletionSummary result={result} />)
    expect(screen.getByText('Verified with exceptions')).toBeInTheDocument()
    expect(screen.getByText('Pending host delivery')).toBeInTheDocument()
    expect(screen.queryByText(/Decider evaluations:/)).not.toBeInTheDocument()
    expect(screen.getByText(/Node does not measure GPU/)).toBeInTheDocument()
    expect(screen.getByText(/Ticket decision/)).toBeInTheDocument()
  })
  it('does not manufacture acceptance when runtime evidence is unavailable', () => {
    render(<LoopCompletionSummary result={{ ...result, core: null }} />)
    expect(screen.getByText(/Execution success alone does not confirm ticket completion/)).toBeInTheDocument()
    expect(screen.queryByText('Verified')).not.toBeInTheDocument()
  })
  it('rejects malformed persisted evidence without crashing history rendering', () => {
    expect(parseLoopCompletion(result)).toEqual(result)
    expect(parseLoopCompletion({ ...result, core: { ...result.core, checks: [null] } })).toBeNull()
    expect(parseLoopCompletion({ ...result, steps: -1 })).toBeNull()
    expect(parseLoopCompletion({ ...result, turns: undefined })).toBeNull()
  })
})
