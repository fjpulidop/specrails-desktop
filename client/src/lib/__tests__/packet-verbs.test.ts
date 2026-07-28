import { describe, it, expect } from 'vitest'
import { derivePrDeliveryPresentation, type PrDeliverySemanticInput } from '../pr-delivery'
import { packetVerbAction, resolvePacketVerbs, type PacketVerbInput } from '../packet-verbs'
import type { RailPrDecision } from '../../types'

function resolve(
  decision: RailPrDecision,
  semantic: Partial<PrDeliverySemanticInput> = {},
  over: Partial<Omit<PacketVerbInput, 'decision' | 'presentation'>> = {},
) {
  const presentation = derivePrDeliveryPresentation({
    decision,
    ticketIds: [1],
    prState: 'none',
    implementationOutcome: 'succeeded',
    deliveryOutcome: 'ready',
    statusCode: null,
    ...semantic,
  } as PrDeliverySemanticInput)
  return resolvePacketVerbs({
    decision,
    presentation,
    prUrl: null,
    canCreatePr: true,
    ...over,
  })
}

describe('resolvePacketVerbs — happy path', () => {
  it('on_review with GitHub available offers all three verbs, Accept = create a PR', () => {
    const r = resolve('on_review')
    expect(r.verbs).toEqual(['accept', 'request-changes', 'discard'])
    expect(r.acceptMeaning).toBe('create-pr')
    expect(r.requiresIrreversibleConfirm).toBe(false)
    expect(r.fineControlOnly).toBe(false)
  })

  it('on_review without GitHub makes Accept mean writing into the checkout, confirm-gated', () => {
    const r = resolve('on_review', {}, { canCreatePr: false })
    expect(r.acceptMeaning).toBe('merge-local')
    expect(r.requiresIrreversibleConfirm).toBe(true)
  })

  it('a real draft PR offers Accept = publish for team review', () => {
    const r = resolve('pr_draft', { prState: 'pr-created' }, { prUrl: 'https://gh/pr/1' })
    expect(r.verbs).toEqual(['accept', 'request-changes', 'discard'])
    expect(r.acceptMeaning).toBe('publish')
    expect(r.requiresIrreversibleConfirm).toBe(false)
  })

  it('pr_ready drops Accept because GitHub owns the merge from there', () => {
    const r = resolve('pr_ready', { prState: 'pr-created' }, { prUrl: 'https://gh/pr/1' })
    expect(r.verbs).toEqual(['request-changes', 'discard'])
    expect(r.acceptMeaning).toBeNull()
  })
})

describe('resolvePacketVerbs — nothing-to-change', () => {
  it('offers acknowledge + revise, never discard', () => {
    const r = resolve('no_changes', { deliveryOutcome: 'no_changes', statusCode: 'no_changes' })
    expect(r.verbs).toEqual(['accept', 'request-changes'])
    expect(r.acceptMeaning).toBe('mark-done')
    expect(r.verbs).not.toContain('discard')
  })

  it('treats a `completed` truthful-no-change row the same way', () => {
    expect(resolve('completed').verbs).toEqual(['accept', 'request-changes'])
  })
})

describe('resolvePacketVerbs — failure', () => {
  it('a total failure only offers discard', () => {
    const r = resolve('implementation_failed', {
      implementationOutcome: 'failed',
      deliveryOutcome: 'not_started',
      statusCode: 'implementation_failed',
    })
    expect(r.verbs).toEqual(['discard'])
    expect(r.fineControlOnly).toBe(false)
  })

  it('a partial failure with usable work also offers request-changes', () => {
    const r = resolve('implementation_failed', {
      implementationOutcome: 'failed',
      statusCode: 'implementation_failed',
      ticketIds: [1, 2],
      units: [
        { ticketId: 1, branch: 'b1', succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', initialSha: null, finalSha: null, failureCode: null, worktreePath: null },
        { ticketId: 2, branch: 'b2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null, failureCode: null, worktreePath: null },
      ],
    })
    expect(r.verbs).toEqual(['request-changes', 'discard'])
  })
})

describe('resolvePacketVerbs — states with no honest reduction', () => {
  const fineControl: Array<[string, ReturnType<typeof resolve>]> = [
    ['degraded draft (pushed, no PR)', resolve('pr_draft', { prState: 'pushed', deliveryOutcome: 'ready' })],
    ['local-only draft', resolve('pr_draft', { prState: 'local-only' })],
    ['closed PR', resolve('pr_closed', { prState: 'pr-created' })],
    ['retryable push failure', resolve('pr_failed', { deliveryOutcome: 'retryable_failure', statusCode: 'push_failed' })],
    ['blocked commit', resolve('pr_failed', { deliveryOutcome: 'blocked', statusCode: 'commit_failed' })],
    ['interrupted settlement', resolve('pr_failed', {
      deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted', isContinuation: true,
      prUrl: 'https://gh/pr/1', branch: 'b', deliverySha: 'sha', runIds: ['r1'],
      units: [{ ticketId: 1, branch: 'b', succeeded: true, runId: 'r1', implementationOutcome: 'succeeded', deliveryOutcome: 'ready', initialSha: null, finalSha: null, failureCode: null, worktreePath: '/wt' }],
    })],
  ]

  for (const [label, r] of fineControl) {
    it(`defers to fine controls: ${label}`, () => {
      expect(r.fineControlOnly).toBe(true)
      expect(r.verbs).toEqual([])
      expect(r.acceptMeaning).toBeNull()
    })
  }
})

describe('resolvePacketVerbs — no decision possible', () => {
  it('building is in-flight, not decidable', () => {
    const r = resolve('building', { implementationOutcome: 'running', deliveryOutcome: 'pending' })
    expect(r).toMatchObject({ inFlight: true, terminal: false, verbs: [], fineControlOnly: false })
  })

  it('merged and discarded are terminal', () => {
    expect(resolve('merged', { statusCode: 'merged' })).toMatchObject({ terminal: true, verbs: [] })
    expect(resolve('discarded', { statusCode: 'discarded' })).toMatchObject({ terminal: true, verbs: [] })
  })

  it('superseded is terminal (a newer generation owns the rail)', () => {
    expect(resolve('superseded', { statusCode: 'superseded' })).toMatchObject({ terminal: true, verbs: [] })
  })
})

describe('resolvePacketVerbs — totality', () => {
  const ALL_DECISIONS: RailPrDecision[] = [
    'building', 'on_review', 'no_changes', 'pr_draft', 'pr_ready', 'pr_closed',
    'completed', 'merged', 'discarded', 'superseded', 'implementation_failed', 'pr_failed',
  ]

  it('every decision resolves without throwing and never returns a verb it cannot execute', () => {
    for (const decision of ALL_DECISIONS) {
      const r = resolve(decision)
      // A state either offers verbs, is in flight, is terminal, or defers.
      expect(r.verbs.length > 0 || r.inFlight || r.terminal || r.fineControlOnly).toBe(true)
      // Accept is never offered without saying what it physically does.
      if (r.verbs.includes('accept')) expect(r.acceptMeaning).not.toBeNull()
      // fineControlOnly and verbs are mutually exclusive.
      if (r.fineControlOnly) expect(r.verbs).toEqual([])
    }
  })

  it('never marks a non-merge-local accept as irreversible', () => {
    for (const decision of ALL_DECISIONS) {
      const r = resolve(decision)
      if (r.requiresIrreversibleConfirm) expect(r.acceptMeaning).toBe('merge-local')
    }
  })
})

describe('packetVerbAction', () => {
  it('maps accept to the decision action its meaning implies', () => {
    const cases: Array<[Parameters<typeof resolve>[0], Partial<PrDeliverySemanticInput>, Partial<PacketVerbInput>, string]> = [
      ['on_review', {}, {}, 'create-pr'],
      ['on_review', {}, { canCreatePr: false }, 'merge-local'],
      ['pr_draft', { prState: 'pr-created' }, { prUrl: 'https://gh/pr/1' }, 'publish'],
      ['no_changes', { deliveryOutcome: 'no_changes', statusCode: 'no_changes' }, {}, 'acknowledge-no-changes'],
    ]
    for (const [decision, semantic, over, expected] of cases) {
      const r = resolve(decision, semantic, over)
      expect(packetVerbAction('accept', r)).toBe(expected)
    }
  })

  it('maps discard to the discard action everywhere it is offered', () => {
    const r = resolve('on_review')
    expect(packetVerbAction('discard', r)).toBe('discard')
  })

  it('returns null for request-changes (the revision flow owns it)', () => {
    expect(packetVerbAction('request-changes', resolve('on_review'))).toBeNull()
  })

  it('returns null for accept when no meaning was resolved', () => {
    expect(packetVerbAction('accept', resolve('pr_ready', { prState: 'pr-created' }, { prUrl: 'u' }))).toBeNull()
  })
})
