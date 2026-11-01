import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '../../../test-utils'
import { IntentStripControls } from '../components/IntentStripControls'
import { getPaletteSurface, resetPaletteSurfaces } from '../../../lib/palette-bridge'
import type { IntentSession } from '../lib/intent-api'

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
