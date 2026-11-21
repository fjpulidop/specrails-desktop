import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '../../../test-utils'
import { RunLineage } from '../components/RunLineage'
import { attemptRunState, lineageFacts, readAttemptChain } from '../lib/attempt-chain'

const wire = (runId: string) => ({
  runId,
  attempt: 0,
  attempts: [
    { runId: 'run-14', attempt: 1, status: 'completed', outcome: 'failed', startedAt: '2026-11-18T18:00:00Z', finishedAt: '2026-11-18T18:20:00Z', fromStep: null, continuations: [], costUsd: 1.25, costEstimated: false },
    { runId: 'fork-a', attempt: 2, status: 'completed', outcome: 'failed', startedAt: '2026-11-18T19:48:00Z', finishedAt: null, fromStep: 'developer',
      continuations: [{ remedy: 'continue', mode: 'fork', fromStep: 'developer', cause: 'incomplete_tasks', guidance: 'Specrails continued this run because these approved tasks were left unticked', automatic: true, createdAt: '' }] },
    { runId: 'fork-b', attempt: 3, status: 'completed', outcome: 'success', startedAt: '2026-11-18T20:00:00Z', finishedAt: null, fromStep: 'developer',
      continuations: [{ remedy: 'continue', mode: 'fork', fromStep: 'developer', cause: 'incomplete_tasks', guidance: null, automatic: false, createdAt: '' }], costUsd: 0.4, costEstimated: true },
  ],
})

describe('attempt chain model', () => {
  it('reads the wire chain and says where this attempt stands', () => {
    const chain = readAttemptChain(wire('fork-a'))!
    expect(chain.attempt).toBe(2)
    const facts = lineageFacts(chain)
    expect(facts.previous?.runId).toBe('run-14')
    expect(facts.origin).toMatchObject({ automatic: true, fromStep: 'developer' })
    expect(facts.supersededBy?.runId).toBe('fork-b')
    expect(lineageFacts(readAttemptChain(wire('fork-b'))!).supersededBy).toBeNull()
  })
  it('is no chain for one attempt, a foreign run or junk', () => {
    expect(readAttemptChain({ runId: 'x', attempts: [wire('run-14').attempts[0]] })).toBeNull()
    expect(readAttemptChain(wire('elsewhere'))).toBeNull()
    expect(readAttemptChain('nope')).toBeNull()
  })
  it('gives each attempt the run-state lamp', () => {
    expect(attemptRunState({ status: 'completed', outcome: 'success' })).toBe('done')
    expect(attemptRunState({ status: 'completed', outcome: 'stopped' })).toBe('stopped')
    expect(attemptRunState({ status: 'running', outcome: null })).toBe('working')
  })
})

describe('RunLineage', () => {
  it('says which attempt this is and where it continued from, and opens the others', async () => {
    const onOpenRun = vi.fn()
    render(<RunLineage chain={readAttemptChain(wire('fork-a'))} onOpenRun={onOpenRun} />)
    const line = screen.getByTestId('run-lineage')
    expect(line).toHaveTextContent('Attempt 2 of 3 · continued from the Developer step of attempt 1')
    expect(line).toHaveTextContent('attempt 3 took over')
    await userEvent.click(line)
    const attempts = await screen.findAllByTestId('run-lineage-attempt')
    expect(attempts).toHaveLength(3)
    expect(attempts[1]).toHaveTextContent('Specrails continued automatically')
    expect(attempts[2]).toHaveTextContent('Continued by you')
    expect(within(attempts[1]).getByText('Guidance sent to the agent')).toBeInTheDocument()
    // Each attempt names its own cost; an estimate keeps its estimate reading.
    expect(within(attempts[0]).getByTestId('run-lineage-cost')).toHaveTextContent('$1.25')
    expect(within(attempts[1]).queryByTestId('run-lineage-cost')).toBeNull()
    expect(within(attempts[2]).getByTestId('run-lineage-cost').textContent).toMatch(/^~\$0\.40/)
    await userEvent.click(within(attempts[2]).getByTestId('run-lineage-open'))
    expect(onOpenRun).toHaveBeenCalledWith('fork-b')
    expect(within(attempts[1]).queryByTestId('run-lineage-open')).toBeNull()
  })
  it('renders nothing without a chain', () => {
    const { container } = render(<RunLineage chain={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
