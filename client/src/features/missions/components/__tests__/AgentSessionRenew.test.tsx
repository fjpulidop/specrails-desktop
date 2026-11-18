import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const renew = vi.fn()
vi.mock('../../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-api')>()
  return { ...actual, renewAgentSessionWithSummary: (...args: unknown[]) => renew(...args) }
})

import { SessionRenewError, type AgentContextUsage } from '../../lib/agent-api'
import { AgentContextUsageRing } from '../AgentContextUsageRing'
import { AgentSessionSummaryCard, parseSessionSummaryRow } from '../AgentSessionSummaryCard'

const snapshot = (overrides: Partial<AgentContextUsage> = {}): AgentContextUsage => ({
  provider: 'claude', model: 'claude-sonnet-4-5', usedTokens: 18_600, windowTokens: 200_000, percent: 9,
  source: 'response', measuredAt: '2026-11-18T10:00:00.000Z', ...overrides,
})

const open = () => fireEvent.click(screen.getByTestId('agent-context-usage'))

describe('Start fresh with a summary (context ring)', () => {
  beforeEach(() => renew.mockReset())

  it('is offered once a snapshot exists and highlighted at the warning threshold', () => {
    const { rerender } = render(<AgentContextUsageRing usage={snapshot()} conversationId="c1" />)
    open()
    expect(screen.getByTestId('agent-session-renew-button')).toHaveAttribute('data-highlighted', 'false')
    expect(screen.getByTestId('agent-session-renew-button')).toHaveTextContent('Start fresh with a summary')
    rerender(<AgentContextUsageRing usage={snapshot({ percent: 80 })} conversationId="c1" />)
    expect(screen.getByTestId('agent-session-renew-button')).toHaveAttribute('data-highlighted', 'true')
  })

  it('is not offered without a mission id', () => {
    render(<AgentContextUsageRing usage={snapshot()} />)
    open()
    expect(screen.queryByTestId('agent-session-renew')).toBeNull()
  })

  it('asks for confirmation before renewing, and cancel leaves everything as it was', async () => {
    renew.mockResolvedValue({ messageId: 'm1', summary: {} })
    render(<AgentContextUsageRing usage={snapshot()} conversationId="c1" />)
    open()
    fireEvent.click(screen.getByTestId('agent-session-renew-button'))
    expect(screen.getByTestId('agent-session-renew-confirm')).toHaveTextContent('knows only that summary')
    expect(renew).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('agent-session-renew-button')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('agent-session-renew-button'))
    fireEvent.click(screen.getByTestId('agent-session-renew-confirm-button'))
    expect(screen.getByTestId('agent-session-renew-running')).toHaveTextContent('Writing the summary')
    await waitFor(() => expect(renew).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(screen.getByTestId('agent-session-renew-button')).toBeInTheDocument())
  })

  it('is disabled while a turn runs and in a mode that owns its session', () => {
    const { rerender } = render(<AgentContextUsageRing usage={snapshot()} conversationId="c1" busy />)
    open()
    expect(screen.getByTestId('agent-session-renew-button')).toBeDisabled()
    expect(screen.getByTestId('agent-session-renew-blocked')).toHaveTextContent('current turn finishes')
    rerender(<AgentContextUsageRing usage={snapshot()} conversationId="c1" modeBlocked />)
    expect(screen.getByTestId('agent-session-renew-button')).toBeDisabled()
    expect(screen.getByTestId('agent-session-renew-blocked')).toHaveTextContent('own session')
  })

  it('explains a known refusal in words and shows a provider error as sent, with retry', async () => {
    renew.mockRejectedValueOnce(new SessionRenewError('server text', 'MISSION_BUSY', 409))
    render(<AgentContextUsageRing usage={snapshot()} conversationId="c1" />)
    open()
    fireEvent.click(screen.getByTestId('agent-session-renew-button'))
    fireEvent.click(screen.getByTestId('agent-session-renew-confirm-button'))
    expect(await screen.findByTestId('agent-session-renew-error')).toHaveTextContent('Wait for the current turn to finish')
    renew.mockRejectedValueOnce(new SessionRenewError('You have hit your usage limit', 'SESSION_SUMMARY_FAILED', 502))
    fireEvent.click(screen.getByTestId('agent-session-renew-button'))
    fireEvent.click(screen.getByTestId('agent-session-renew-confirm-button'))
    expect(await screen.findByTestId('agent-session-renew-error')).toHaveTextContent('You have hit your usage limit')
    expect(screen.getByTestId('agent-session-renew-button')).toHaveTextContent('Try again')
  })
})

describe('Session renewed marker', () => {
  const row = { kind: 'session-summary', summary: '## Goal\nShip the importer.', provider: 'claude', model: 'claude-sonnet-4-5', includedMessages: 8, totalMessages: 20, at: '2026-11-18T10:00:00Z', dedupeKey: 'session-summary:x' }

  it('parses only session summary rows', () => {
    expect(parseSessionSummaryRow(JSON.stringify(row))?.summary).toContain('Ship the importer.')
    expect(parseSessionSummaryRow(JSON.stringify({ ...row, summary: ' ' }))).toBeNull()
    expect(parseSessionSummaryRow(JSON.stringify({ kind: 'flow-boundary' }))).toBeNull()
    expect(parseSessionSummaryRow('plain text')).toBeNull()
  })

  it('renders collapsed and expands to the summary', () => {
    render(<AgentSessionSummaryCard row={parseSessionSummaryRow(JSON.stringify(row))!} />)
    expect(screen.getByTestId('agent-session-summary')).toHaveTextContent('Session renewed · summary')
    expect(screen.queryByTestId('agent-session-summary-body')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-session-summary-line'))
    const body = screen.getByTestId('agent-session-summary-body')
    expect(body).toHaveTextContent('Ship the importer.')
    expect(body).toHaveTextContent('latest 8 of 20 messages')
    expect(screen.getByRole('heading', { name: 'Goal' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('agent-session-summary-line'))
    expect(screen.queryByTestId('agent-session-summary-body')).toBeNull()
  })
})

describe('Context ring without a reported window', () => {
  it('stays available for renewal as a neutral ring that says what is unknown', () => {
    render(<AgentContextUsageRing usage={snapshot({ windowTokens: null, percent: null, usedTokens: 104_236 })} conversationId="c1" />)
    expect(screen.getByTestId('agent-context-usage')).toHaveAttribute('data-level', 'unknown')
    open()
    expect(screen.getByTestId('agent-context-usage-tokens')).toHaveTextContent('104.2k tokens used')
    expect(screen.getByTestId('agent-context-usage-unknown')).toHaveTextContent('did not report the context window')
    expect(screen.getByTestId('agent-session-renew-button')).toHaveAttribute('data-highlighted', 'false')
  })
})
