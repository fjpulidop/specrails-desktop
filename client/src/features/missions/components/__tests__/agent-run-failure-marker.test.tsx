import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentRunFailureMarker, AgentSystemBriefing } from '../AgentRunFailureMarker'
import { FOCUS_PR_CARD_EVENT } from '../agent-run-failure'

describe('AgentRunFailureMarker', () => {
  it('is one event line in plain words that opens the run', () => {
    const spy = vi.fn()
    window.addEventListener(FOCUS_PR_CARD_EVENT, spy)
    render(<AgentRunFailureMarker row={{ kind: 'run-failure', runId: 'r1', railIndex: 2, projectId: 'p1', code: 'stalled', detail: 'idle', stepId: null, at: null, prDeliveryId: 'd1' }} />)
    const line = screen.getByTestId('agent-run-failure-marker')
    expect(line.textContent).toContain('Rail 3 failed: The run stalled')
    // The server's technical detail stays on the run card, never in the history line.
    expect(line.textContent).not.toContain('idle')
    expect(line).toHaveAccessibleName(/Show the run/)
    fireEvent.click(line)
    window.removeEventListener(FOCUS_PR_CARD_EVENT, spy)
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ prDeliveryId: 'd1', runIds: ['r1'], conversationId: null })
  })
})

describe('AgentRunFailureMarker with the run’s loop', () => {
  it('uses the extension’s words for the failing step, and the rail name', async () => {
    const { MissionExtensionsProvider } = await import('../../context/MissionExtensionsContext')
    render(
      <MissionExtensionsProvider value={{ describeRun: (_t, input) => input.loopId === 'factory:flow-spec' ? { step: null, failure: `failed at ${input.stepId}` } : null }}>
        <AgentRunFailureMarker row={{ kind: 'run-failure', runId: 'r1', railIndex: 0, projectId: 'p1', code: 'implementation_failed', detail: null, stepId: 'derive', at: null }}
          envelope={{ loopId: 'factory:flow-spec', railName: 'Checkout' }} />
      </MissionExtensionsProvider>,
    )
    expect(screen.getByTestId('agent-run-failure-marker').textContent).toContain('Checkout failed: failed at derive')
  })

  it('an unknown code reads as a generic stop', () => {
    render(<AgentRunFailureMarker row={{ kind: 'run-failure', runId: 'r1', railIndex: 0, projectId: 'p1', code: 'weird_code', detail: null, stepId: null, at: null }} />)
    expect(screen.getByTestId('agent-run-failure-marker').textContent).toContain('Rail 1 failed: Stopped with an error')
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
