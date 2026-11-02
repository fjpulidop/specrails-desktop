import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentFlowDeliveredCard, parseFlowDeliveredRow } from '../AgentFlowDeliveredCard'
import { composerDrafts } from '../../lib/agent-composer-drafts'

const openTicketDetail = vi.fn()
const openTicketDetailInProject = vi.fn()
vi.mock('../../../specs/context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail, openTicketDetailInProject, closeTicketDetail: vi.fn() }),
}))

const row = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'flow-delivered', flowId: 'f1', deliveryId: 'd1', ticketId: 12, dedupeKey: 'flow-delivered:f1',
  specTitle: 'Controles a tu medida', branch: 'feat/12-controles-a-tu-medida',
  integration: { kind: 'pr', prUrl: 'https://github.com/o/r/pull/812', prNumber: 812, merged: false, baseBranch: 'main', sha: 'c'.repeat(40) },
  prUrl: 'https://github.com/o/r/pull/812', prNumber: 812,
  changeName: 'custom-controls', changeArchived: true,
  specRewrite: 'done', jiraCreate: 'skipped', jiraKey: null,
  diff: { files: 7, additions: 120, deletions: 8 }, cost: { costUsd: 1.25, turns: 3, unpricedTurns: 0 }, durationMs: 1_920_000, openQuestionsAnswered: 2,
  settled: true, at: 't',
  ...over,
})

describe('AgentFlowDeliveredCard (Intent delivered)', () => {
  it('parses only its own rows, and the legacy PR-only shape', () => {
    expect(parseFlowDeliveredRow(row())).toMatchObject({ ticketId: 12, specTitle: 'Controles a tu medida', integration: { kind: 'pr', prNumber: 812 }, diff: { files: 7 }, cost: { costUsd: 1.25 }, durationMs: 1_920_000, openQuestionsAnswered: 2 })
    expect(parseFlowDeliveredRow(JSON.stringify({ kind: 'flow-boundary', flowId: 'f1' }))).toBeNull()
    expect(parseFlowDeliveredRow('not json')).toBeNull()
    const legacy = parseFlowDeliveredRow(JSON.stringify({ kind: 'flow-delivered', flowId: 'f1', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, specRewrite: 'done' }))!
    expect(legacy.integration).toEqual({ kind: 'pr', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, merged: false, baseBranch: null, sha: null })
    expect(legacy.diff).toBeNull(); expect(legacy.cost).toBeNull(); expect(legacy.openQuestionsAnswered).toBe(0)
    expect(parseFlowDeliveredRow(row({ prUrl: 'javascript:alert(1)', integration: null }))!.integration).toBeNull()
  })

  it('is a success card: title, warm subtitle, stats, the whole story with lamps and the next steps', () => {
    render(<AgentFlowDeliveredCard row={parseFlowDeliveredRow(row())!} projectId="p1" conversationId="c1" />)
    const card = screen.getByTestId('agent-flow-delivered-card')
    expect(card).toHaveAttribute('data-settled', 'true')
    expect(card).toHaveAttribute('aria-label', 'Intent delivered')
    expect(screen.getByTestId('agent-flow-delivered-spec-title')).toHaveTextContent('Controles a tu medida')
    expect(card).toHaveTextContent('Built together, reviewed and integrated. Nice work.')
    expect(screen.getByTestId('agent-flow-delivered-files')).toHaveTextContent('7 files +120 −8')
    expect(screen.getByTestId('agent-flow-delivered-cost')).toHaveTextContent('$1.25')
    expect(screen.queryByTestId('agent-flow-delivered-cost-partial')).toBeNull()
    expect(screen.getByTestId('agent-flow-delivered-duration')).toHaveTextContent('32m 0s')
    expect(screen.getByTestId('agent-flow-delivered-branch')).toHaveTextContent('feat/12-controles-a-tu-medida')
    const integration = screen.getByTestId('agent-flow-delivered-integration')
    expect(integration).toHaveTextContent('Integrated: pull request Pull request #812')
    expect(integration.querySelector('a')).toHaveAttribute('href', 'https://github.com/o/r/pull/812')
    const spec = screen.getByTestId('agent-flow-delivered-spec')
    expect(spec).toHaveAttribute('data-lamp', 'done')
    expect(spec).toHaveTextContent('Spec #12 rewritten from what you built')
    fireEvent.click(spec.querySelector('button')!)
    expect(openTicketDetailInProject).toHaveBeenCalledWith('p1', 12)
    expect(screen.getByTestId('agent-flow-delivered-change')).toHaveTextContent('Spec change custom-controls archived')
    expect(screen.queryByTestId('agent-flow-delivered-jira')).toBeNull()
    expect(screen.getByTestId('agent-flow-delivered-questions')).toHaveTextContent('2 open questions answered')
    // Next steps.
    expect(screen.getByTestId('agent-flow-delivered-view-pr')).toHaveAttribute('href', 'https://github.com/o/r/pull/812')
    fireEvent.click(screen.getByTestId('agent-flow-delivered-another'))
    expect(composerDrafts.get('c1')).toBe('I want to solve this problem: ')
    expect(card.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  })

  it('shows at once with pending lines that breathe, then fills in on the updated row', () => {
    const pending = parseFlowDeliveredRow(row({ specRewrite: 'pending', jiraCreate: 'pending', changeName: null, diff: null, cost: { costUsd: 0, turns: 2, unpricedTurns: 2 }, openQuestionsAnswered: 0, settled: false }))!
    const { rerender } = render(<AgentFlowDeliveredCard row={pending} projectId="p1" conversationId="c1" />)
    const card = screen.getByTestId('agent-flow-delivered-card')
    expect(card).toHaveAttribute('data-settled', 'false')
    const spec = screen.getByTestId('agent-flow-delivered-spec')
    expect(spec).toHaveAttribute('data-lamp', 'pending')
    expect(spec).toHaveTextContent('Rewriting the spec from what you built…')
    expect(spec.className).toContain('animate-pulse')
    expect(spec.querySelector('button')).toBeNull()
    expect(screen.getByTestId('agent-flow-delivered-jira')).toHaveAttribute('data-lamp', 'pending')
    // Nothing priced yet: a dash, never an estimate, with the unpriced turns said.
    expect(screen.getByTestId('agent-flow-delivered-cost')).toHaveTextContent('—')
    expect(screen.getByTestId('agent-flow-delivered-cost-partial')).toHaveTextContent('2 turns have no provider-reported cost')
    expect(screen.queryByTestId('agent-flow-delivered-files')).toBeNull()
    expect(screen.queryByTestId('agent-flow-delivered-questions')).toBeNull()

    rerender(<AgentFlowDeliveredCard row={parseFlowDeliveredRow(row({ jiraCreate: 'done', jiraKey: 'SR-7', cost: { costUsd: 2.5, turns: 3, unpricedTurns: 1 } }))!} projectId="p1" conversationId="c1" />)
    expect(card).toHaveAttribute('data-settled', 'true')
    expect(screen.getByTestId('agent-flow-delivered-spec')).toHaveAttribute('data-lamp', 'done')
    expect(screen.getByTestId('agent-flow-delivered-jira')).toHaveTextContent('Jira issue SR-7')
    expect(screen.getByTestId('agent-flow-delivered-cost')).toHaveTextContent('$2.50*')
    expect(screen.getByTestId('agent-flow-delivered-cost-partial')).toHaveTextContent('1 turn has no provider-reported cost')
  })

  it('a local merge reads as integrated locally with the delivered commit, and keeps no PR chip', () => {
    render(<AgentFlowDeliveredCard row={parseFlowDeliveredRow(row({ integration: { kind: 'local', prUrl: null, prNumber: null, merged: true, baseBranch: 'main', sha: 'abcdef0123456789' }, prUrl: null, prNumber: null }))!} conversationId="c1" />)
    expect(screen.getByTestId('agent-flow-delivered-integration')).toHaveTextContent('Integrated locally into main · abcdef0')
    expect(screen.queryByTestId('agent-flow-delivered-view-pr')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-flow-delivered-open-spec'))
    expect(openTicketDetail).toHaveBeenCalledWith(12)
  })

  it('a failed rewrite is told plainly, without a spec link, and the card still offers the next steps', () => {
    render(<AgentFlowDeliveredCard row={parseFlowDeliveredRow(row({ specRewrite: 'failed', ticketId: null, specTitle: null }))!} />)
    expect(screen.getByTestId('agent-flow-delivered-spec-title')).toHaveTextContent('Your Intent')
    const spec = screen.getByTestId('agent-flow-delivered-spec')
    expect(spec).toHaveAttribute('data-lamp', 'muted')
    expect(spec).toHaveTextContent('The spec rewrite did not complete; its draft is kept')
    expect(screen.queryByTestId('agent-flow-delivered-open-spec')).toBeNull()
    expect(screen.queryByTestId('agent-flow-delivered-another')).toBeNull()
    expect(screen.getByTestId('agent-flow-delivered-view-pr')).toBeInTheDocument()
  })
})
