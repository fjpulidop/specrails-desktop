import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentFlowReturnCard, parseFlowReturnBriefingRow } from '../AgentFlowReturnCard'
import { AgentSystemBriefing } from '../AgentRunFailureMarker'

const row = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'flow-return-briefing', flowId: 'f1', deliveryId: 'd1', dedupeKey: 'flow-return-briefing:d1',
  reason: 'review', score: 58, summary: 'Two gaps remain', issues: ['Tag the tests', 'Test the Options screen'], issuesOmitted: 0,
  failingChecks: [{ command: 'npm test', exitCode: 1 }],
  derivation: { change: 'fx', files: 9, explained: 6, unexplainedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'], unexplainedOmitted: 2 },
  ...over,
})

describe('AgentFlowReturnCard (Back to Flow)', () => {
  it('parses only its own rows', () => {
    expect(parseFlowReturnBriefingRow(row())).toMatchObject({ deliveryId: 'd1', review: { reason: 'review', score: 58 }, derivation: { files: 9, explained: 6 } })
    expect(parseFlowReturnBriefingRow(JSON.stringify({ kind: 'run-failure' }))).toBeNull()
    expect(parseFlowReturnBriefingRow('not json')).toBeNull()
    expect(parseFlowReturnBriefingRow(row({ reason: null }))!.review).toBeNull()
  })

  it('is a "Back to Flow" history line that expands to what the reviewer asked for, the failing checks and the unexplained files', () => {
    render(<AgentFlowReturnCard row={parseFlowReturnBriefingRow(row())!} />)
    const card = screen.getByTestId('agent-flow-return-card')
    const toggle = screen.getByTestId('agent-flow-return-toggle')
    expect(toggle).toHaveTextContent('Back to Flow')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('agent-flow-return-body')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(card).toHaveAttribute('aria-label', 'What the reviewer asked for')
    expect(card).toHaveTextContent('Tag the tests')
    expect(card).toHaveTextContent('score 58')
    expect(card).toHaveTextContent('npm test · exit 1')
    expect(card).toHaveTextContent('The spec explains 6 of 9 changed files')
    expect(screen.getByTestId('agent-flow-return-unexplained').children).toHaveLength(5)
    fireEvent.click(screen.getByText('Show all 7'))
    expect(screen.getByTestId('agent-flow-return-unexplained').children).toHaveLength(7)
    expect(card).toHaveTextContent('+2 more files')
    // The card-only "go back to Flow" hint is not repeated here.
    expect(card).not.toHaveTextContent('Go back to Flow to settle them')
    fireEvent.click(screen.getByTestId('agent-flow-return-toggle'))
    expect(screen.queryByTestId('agent-flow-return-body')).toBeNull()
  })

  it('without findings it still says where the work went', () => {
    render(<AgentFlowReturnCard row={parseFlowReturnBriefingRow(row({ reason: null, derivation: null }))!} />)
    fireEvent.click(screen.getByTestId('agent-flow-return-toggle'))
    expect(screen.getByTestId('agent-flow-return-card')).toHaveTextContent('your changes are back in this Flow, intact')
    expect(screen.queryByTestId('agent-flow-return-coverage')).toBeNull()
  })

  it('the automatic turn reads as an automatic Back to Flow turn, not as the failure briefing', () => {
    render(<AgentSystemBriefing content="Back to Flow: fix it" contextRefs={[{ kind: 'system-briefing', id: 'flow-return:d1', label: 'Back to Flow', token: '', metadata: { automatic: true } } as never]} />)
    expect(screen.getByTestId('agent-system-briefing')).toHaveTextContent('Automatic turn · Back to Flow')
  })
})
