import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../../../test-utils'
import { LoopCompletionSummary } from '../LoopCompletionSummary'
import { blockerCommandLine, parseLoopCompletion, type LoopCompletion } from '../completion-model'
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

describe('host blocker completion', () => {
  const blocker = { kind: 'network' as const, reason: 'the Playwright browser download cannot reach its CDN from the verification environment', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: 'ticket-1', requiredAction: 'Run `npx playwright install chromium` in ticket-1 with network access, then retry the run' }
  const blocked: LoopCompletion = { ...result, core: null, execution: 'blocked', engineVersion: 2, completion: { ok: false, verified: false, reasons: [`Host blocker (network): ${blocker.reason}`], blocker } }
  it('renders the blocked block with kind, command, cwd, required action and a copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<LoopCompletionSummary result={blocked} />)
    expect(screen.getByText('Acceptance: Blocked')).toBeInTheDocument()
    const block = screen.getByTestId('loop-completion-blocker')
    expect(block).toHaveTextContent('Blocked by the host environment')
    expect(block).toHaveTextContent('Network')
    expect(block).toHaveTextContent('npx playwright install chromium')
    expect(block).toHaveTextContent('in ticket-1')
    expect(block).toHaveTextContent(`Required action: ${blocker.requiredAction}`)
    expect(screen.queryByText(/^Host blocker \(network\)/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    await screen.findByText('Copied')
    expect(writeText).toHaveBeenCalledWith('npx playwright install chromium')
  })
  it('keeps historical completions without a blocker exactly as before and drops a malformed blocker', () => {
    render(<LoopCompletionSummary result={{ ...blocked, completion: { ok: false, verified: false, reasons: ['Automatic correction made no candidate changes.'] } }} />)
    expect(screen.queryByTestId('loop-completion-blocker')).not.toBeInTheDocument()
    expect(screen.getByText('Automatic correction made no candidate changes.')).toBeInTheDocument()
    expect(parseLoopCompletion(blocked)).toEqual(blocked)
    expect(parseLoopCompletion({ ...blocked, completion: { ...blocked.completion, blocker: { kind: 'weather' } } })?.completion).toEqual({ ok: false, verified: false, reasons: blocked.completion!.reasons })
    expect(blockerCommandLine({ ...blocker, command: '', args: [] })).toBe('')
  })
})
