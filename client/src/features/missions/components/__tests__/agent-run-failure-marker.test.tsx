import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentRunFailureMarker, AgentSystemBriefing } from '../AgentRunFailureMarker'
import { FOCUS_PR_CARD_EVENT } from '../agent-run-failure'

describe('AgentRunFailureMarker', () => {
  it('renders rail + code + detail and focuses the card', () => {
    const spy = vi.fn()
    window.addEventListener(FOCUS_PR_CARD_EVENT, spy)
    render(<AgentRunFailureMarker row={{ kind: 'run-failure', runId: 'r1', railIndex: 2, projectId: 'p1', code: 'stalled', detail: 'idle', stepId: null, at: null, prDeliveryId: 'd1' }} />)
    expect(screen.getByTestId('agent-run-failure-marker').textContent).toContain('Rail 3 failed: stalled')
    expect(screen.getByTestId('agent-run-failure-marker').textContent).toContain('idle')
    fireEvent.click(screen.getByTestId('agent-run-failure-open'))
    window.removeEventListener(FOCUS_PR_CARD_EVENT, spy)
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ prDeliveryId: 'd1', runIds: ['r1'] })
  })
})

describe('AgentSystemBriefing', () => {
  it('is collapsed by default and reveals the briefing text', () => {
    render(<AgentSystemBriefing content="Run r1 failed at verify" />)
    expect(screen.queryByTestId('agent-system-briefing-body')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('agent-system-briefing-body').textContent).toContain('Run r1 failed at verify')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('agent-system-briefing-body')).toBeNull()
  })
})
