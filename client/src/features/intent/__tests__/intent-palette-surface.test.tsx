import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen } from '../../../test-utils'
import { IntentStripControls, publishFlowDiff } from '../components/IntentStripControls'
import { RUN_STRIP_PRIMARY } from '../../missions/components/AgentRunStrip'
import { getPaletteSurface, resetPaletteSurfaces } from '../../../lib/palette-bridge'
import type { IntentDiff, IntentSession } from '../lib/intent-api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const flow = (over: Partial<IntentSession> = {}): IntentSession => ({
  id: 'f1', conversationId: 'c1', ticketId: 7, state: 'active', branch: 'flow/x', worktreePath: '/w', baseSha: 'a', headSha: 'b',
  railIndex: null, deliveryId: null, step: null, ...over,
})

describe('Intent strip controls -> ⌘K surface', () => {
  beforeEach(() => resetPaletteSurfaces())

  it('publishes Pause and Hand off while active, Resume while paused', () => {
    const { rerender } = render(<IntentStripControls projectId="p1" flow={flow()} inline />)
    expect(getPaletteSurface('flow')!.controls().map((c) => [c.id, c.disabled])).toEqual([['pause', false], ['hand-off', false]])
    rerender(<IntentStripControls projectId="p1" flow={flow({ state: 'paused' })} inline />)
    expect(getPaletteSurface('flow')!.controls().map((c) => c.id)).toEqual(['resume', 'hand-off'])
  })

  it('reports the same disabled state as the buttons (settling, no spec)', () => {
    render(<IntentStripControls projectId="p1" flow={flow({ ticketId: null })} inline />)
    expect(getPaletteSurface('flow')!.controls().find((c) => c.id === 'hand-off')!.disabled).toBe(true)
    render(<IntentStripControls projectId="p1" flow={flow({ step: 'review' as IntentSession['step'] })} inline />)
    expect(getPaletteSurface('flow')!.controls().every((c) => c.disabled)).toBe(true)
  })

  it('Hand off waits (secondary, disabled, with the reason) until a file changed', () => {
    const totals = (files: number) => ({ files, additions: files, deletions: 0 })
    render(<IntentStripControls projectId="p1" flow={flow()} inline />)
    const handOff = () => screen.getByTestId('flow-bar-hand-off')
    // Unknown totals: the door stays open, but it is not the filled primary yet.
    expect(handOff()).toBeEnabled()
    expect(handOff().className).not.toContain(RUN_STRIP_PRIMARY)
    // No file changed: still open (the spec can come from the conversation), still secondary.
    act(() => publishFlowDiff('f1', { files: [], totals: totals(0) } as unknown as IntentDiff))
    expect(handOff()).toBeEnabled()
    expect(handOff().className).not.toContain(RUN_STRIP_PRIMARY)
    expect(screen.queryByTestId('flow-bar-hand-off-reason')).not.toBeInTheDocument()
    expect(getPaletteSurface('flow')!.controls().find((c) => c.id === 'hand-off')!.disabled).toBe(false)
    act(() => publishFlowDiff('f1', { files: [], totals: totals(3) } as unknown as IntentDiff))
    expect(handOff()).toBeEnabled()
    expect(handOff().className).toContain(RUN_STRIP_PRIMARY)
    expect(screen.queryByTestId('flow-bar-hand-off-reason')).not.toBeInTheDocument()
  })

  it('reads "Pause" / "Resume" on the row (the strip already says Intent) while keeping the full accessible name', () => {
    const { rerender } = render(<IntentStripControls projectId="p1" flow={flow()} inline />)
    expect(screen.getByTestId('flow-bar-pause')).toHaveTextContent(/^Pause$/)
    expect(screen.getByTestId('flow-bar-pause')).toHaveAttribute('aria-label', 'Pause Intent')
    rerender(<IntentStripControls projectId="p1" flow={flow({ state: 'paused' })} inline />)
    expect(screen.getByTestId('flow-bar-resume')).toHaveTextContent(/^Resume$/)
    expect(screen.getByTestId('flow-bar-resume')).toHaveAttribute('aria-label', 'Resume Intent')
  })

  it('publishes nothing when the Intent needs review, nor after unmount', () => {
    const { unmount } = render(<IntentStripControls projectId="p1" flow={flow({ state: 'needs-review' })} inline />)
    expect(getPaletteSurface('flow')).toBeNull()
    unmount()
    const second = render(<IntentStripControls projectId="p1" flow={flow()} inline />)
    expect(getPaletteSurface('flow')).not.toBeNull()
    second.unmount()
    expect(getPaletteSurface('flow')).toBeNull()
  })
})
