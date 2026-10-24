import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '../../../test-utils'
import { FlowStripControls } from '../components/FlowStripControls'
import { getPaletteSurface, resetPaletteSurfaces } from '../../../lib/palette-bridge'
import type { Flow } from '../lib/flow-api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1', conversationId: 'c1', ticketId: 7, state: 'active', branch: 'flow/x', worktreePath: '/w', baseSha: 'a', headSha: 'b',
  railIndex: null, deliveryId: null, step: null, ...over,
})

describe('Flow strip controls -> ⌘K surface', () => {
  beforeEach(() => resetPaletteSurfaces())

  it('publishes Pause and Hand off while active, Resume while paused', () => {
    const { rerender } = render(<FlowStripControls projectId="p1" flow={flow()} inline />)
    expect(getPaletteSurface('flow')!.controls().map((c) => [c.id, c.disabled])).toEqual([['pause', false], ['hand-off', false]])
    rerender(<FlowStripControls projectId="p1" flow={flow({ state: 'paused' })} inline />)
    expect(getPaletteSurface('flow')!.controls().map((c) => c.id)).toEqual(['resume', 'hand-off'])
  })

  it('reports the same disabled state as the buttons (settling, no spec)', () => {
    render(<FlowStripControls projectId="p1" flow={flow({ ticketId: null })} inline />)
    expect(getPaletteSurface('flow')!.controls().find((c) => c.id === 'hand-off')!.disabled).toBe(true)
    render(<FlowStripControls projectId="p1" flow={flow({ step: 'review' as Flow['step'] })} inline />)
    expect(getPaletteSurface('flow')!.controls().every((c) => c.disabled)).toBe(true)
  })

  it('publishes nothing when the Flow needs review, nor after unmount', () => {
    const { unmount } = render(<FlowStripControls projectId="p1" flow={flow({ state: 'needs-review' })} inline />)
    expect(getPaletteSurface('flow')).toBeNull()
    unmount()
    const second = render(<FlowStripControls projectId="p1" flow={flow()} inline />)
    expect(getPaletteSurface('flow')).not.toBeNull()
    second.unmount()
    expect(getPaletteSurface('flow')).toBeNull()
  })
})
