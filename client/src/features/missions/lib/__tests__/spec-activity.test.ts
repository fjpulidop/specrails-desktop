import { describe, expect, it } from 'vitest'
import type { LocalTicket, RailPrDecision, RailPrStateSnapshot } from '../../../../types'
import { deriveSpecActivity } from '../spec-activity'

function delivery(over: Partial<RailPrStateSnapshot> & { decision: RailPrDecision; ticketIds: number[] }): RailPrStateSnapshot {
  return {
    prDeliveryId: `d-${over.railIndex ?? 0}`, railIndex: 0, railKey: 'r', baseBranch: 'main', branch: null, prUrl: null,
    prNumber: null, prState: 'none', runIds: ['run-1'], originConversationId: 'mission-a', ...over,
  } as RailPrStateSnapshot
}

function ticket(id: number, flow?: NonNullable<LocalTicket['metadata']>['flow']): Pick<LocalTicket, 'id' | 'metadata'> {
  return { id, metadata: flow ? { flow } : {} }
}

describe('deriveSpecActivity', () => {
  it('maps a building rail delivery to a running Implement on that rail and mission', () => {
    const map = deriveSpecActivity([ticket(15)], [delivery({ decision: 'building', ticketIds: [15, 16], railIndex: 4 })])
    expect(map.get(15)?.shown).toMatchObject({ kind: 'implement', phase: 'running', railIndex: 4, conversationId: 'mission-a', runIds: ['run-1'] })
    expect(map.get(15)?.link).toBe(map.get(15)?.shown)
    expect(map.get(16)?.shown.phase).toBe('running')
  })

  it('maps review and failure decisions, and ignores terminal ones', () => {
    const map = deriveSpecActivity([], [
      delivery({ decision: 'pr_ready', ticketIds: [1], railIndex: 0 }),
      delivery({ decision: 'implementation_failed', ticketIds: [2], railIndex: 1 }),
      delivery({ decision: 'merged', ticketIds: [3], railIndex: 2 }),
    ])
    expect(map.get(1)?.shown.phase).toBe('waiting')
    expect(map.get(2)?.shown.phase).toBe('failed')
    expect(map.has(3)).toBe(false)
  })

  it('shows a live Intent before any rail, and its pause', () => {
    const map = deriveSpecActivity([
      ticket(7, { state: 'active', conversationId: 'mission-b', startedAt: '2026-11-15T10:00:00Z' }),
      ticket(8, { state: 'paused', conversationId: 'mission-c' }),
      ticket(9, { state: 'delivered', conversationId: 'mission-d' }),
    ], [])
    expect(map.get(7)?.shown).toMatchObject({ kind: 'intent', phase: 'running', railIndex: null, conversationId: 'mission-b' })
    expect(map.get(8)?.shown.phase).toBe('paused')
    expect(map.has(9)).toBe(false)
  })

  it('shows the most urgent run, then a rail over the Intent label, then the newest', () => {
    const urgent = deriveSpecActivity([], [
      delivery({ decision: 'building', ticketIds: [1], railIndex: 0, originConversationId: 'old' }),
      delivery({ decision: 'on_review', ticketIds: [1], railIndex: 1, originConversationId: 'needs-you' }),
    ])
    expect(urgent.get(1)?.shown.conversationId).toBe('needs-you')

    const handedOff = deriveSpecActivity(
      [ticket(2, { state: 'active', conversationId: 'intent-mission' })],
      [delivery({ decision: 'building', ticketIds: [2], railIndex: 3, originConversationId: 'intent-mission' })],
    )
    expect(handedOff.get(2)?.shown).toMatchObject({ kind: 'intent', railIndex: 3 })
    expect(handedOff.get(2)?.link).toMatchObject({ railIndex: 3 })

    const newest = deriveSpecActivity([], [
      delivery({ decision: 'building', ticketIds: [3], railIndex: 0, originConversationId: 'older', updatedAt: '2026-11-15T10:00:00Z' }),
      delivery({ decision: 'building', ticketIds: [3], railIndex: 1, originConversationId: 'newer', updatedAt: '2026-11-15T11:00:00Z' }),
    ])
    expect(newest.get(3)?.shown.conversationId).toBe('newer')
  })

  it('links to the most recently created mission when several missions have the spec', () => {
    const created: Record<string, number> = { 'mission-old': 1_000, 'mission-new': 2_000 }
    const map = deriveSpecActivity(
      [ticket(5, { state: 'paused', conversationId: 'mission-new' })],
      [delivery({ decision: 'on_review', ticketIds: [5], railIndex: 0, originConversationId: 'mission-old', updatedAt: '2026-11-15T12:00:00Z' })],
      (id) => ({ createdAt: created[id] ?? null, archived: false }),
    )
    // The row still shows the run that needs the person…
    expect(map.get(5)?.shown).toMatchObject({ phase: 'waiting', conversationId: 'mission-old' })
    // …but the shortcut opens the newest mission.
    expect(map.get(5)?.link).toMatchObject({ phase: 'paused', conversationId: 'mission-new' })
  })

  it('skips archived missions for the link unless only archived missions have the spec', () => {
    const facts: Record<string, { createdAt: number; archived: boolean }> = {
      'active-old': { createdAt: 1_000, archived: false },
      'archived-new': { createdAt: 3_000, archived: true },
      'archived-newer': { createdAt: 4_000, archived: true },
    }
    const lookup = (id: string) => facts[id] ?? { createdAt: null, archived: false }
    const mixed = deriveSpecActivity([], [
      delivery({ decision: 'building', ticketIds: [6], railIndex: 0, originConversationId: 'archived-new' }),
      delivery({ decision: 'building', ticketIds: [6], railIndex: 1, originConversationId: 'active-old' }),
      delivery({ decision: 'building', ticketIds: [6], railIndex: 2, originConversationId: 'archived-newer' }),
    ], lookup)
    expect(mixed.get(6)?.link.conversationId).toBe('active-old')

    const onlyArchived = deriveSpecActivity([], [
      delivery({ decision: 'building', ticketIds: [7], railIndex: 0, originConversationId: 'archived-new' }),
      delivery({ decision: 'building', ticketIds: [7], railIndex: 1, originConversationId: 'archived-newer' }),
    ], lookup)
    expect(onlyArchived.get(7)?.link.conversationId).toBe('archived-newer')
  })

  it('keeps a dashboard launch without a mission, and prefers any mission over it for the link', () => {
    const alone = deriveSpecActivity([], [delivery({ decision: 'building', ticketIds: [4], originConversationId: null })])
    expect(alone.get(4)?.link.conversationId).toBeNull()

    const mixed = deriveSpecActivity([], [
      delivery({ decision: 'on_review', ticketIds: [4], railIndex: 0, originConversationId: null }),
      delivery({ decision: 'building', ticketIds: [4], railIndex: 1, originConversationId: 'mission-x' }),
    ])
    expect(mixed.get(4)?.shown.conversationId).toBeNull()
    expect(mixed.get(4)?.link.conversationId).toBe('mission-x')
  })
})
