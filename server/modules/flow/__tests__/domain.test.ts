import { describe, expect, it } from 'vitest'
import {
  FLOW_RETURN_BRIEFING_LIMIT,
  FlowTransitionError,
  buildReturnBriefing,
  flowCoreSessionId,
  nextFlowCoreSessionId,
  isOpenFlow,
  isTerminalFlow,
  placeholderTitle,
  transition,
  type FlowCommand,
  type FlowSession,
  type FlowState,
  type FlowStep,
} from '../domain'

const NOW = '2026-10-21T10:00:00.000Z'
const LATER = '2026-10-21T10:05:00.000Z'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

function flow(patch: Partial<FlowSession> = {}): FlowSession {
  return {
    id: 'flow-1', conversationId: 'conv-1', ticketId: 7, state: 'active', branch: 'feat/7-idea',
    worktreePath: '/wt/flow-1/ticket-7', baseSha: BASE, headSha: HEAD, coreSessionId: 'flow:flow-1',
    railIndex: null, deliveryId: null, step: null, createdAt: NOW, updatedAt: NOW, ...patch,
  }
}

const commands: Record<string, FlowCommand> = {
  ticketCreated: { type: 'ticket-created', ticketId: 7, now: LATER },
  worktreeReserved: { type: 'worktree-reserved', branch: 'feat/7-idea', worktreePath: '/wt/x', baseSha: BASE, headSha: HEAD, now: LATER },
  sessionOpened: { type: 'session-opened', coreSessionId: 'flow:flow-1', now: LATER },
  startFailed: { type: 'start-failed', now: LATER },
  pause: { type: 'pause', now: LATER },
  resume: { type: 'resume', now: LATER },
  discard: { type: 'discard', now: LATER },
  close: { type: 'close', now: LATER },
  beginHandOff: { type: 'begin-hand-off', railIndex: 2, now: LATER },
  frozen: { type: 'frozen', headSha: HEAD, now: LATER },
  handedOff: { type: 'handed-off', railIndex: 2, deliveryId: 'd-1', headSha: HEAD, now: LATER },
  handOffFailed: { type: 'hand-off-failed', now: LATER },
  adoptionReverted: { type: 'adoption-reverted', now: LATER },
  delivered: { type: 'delivered', deliveryId: 'd-1', now: LATER },
  returned: { type: 'returned', deliveryId: 'd-1', briefing: '[Back from Flow → Spec] fix the tests', now: LATER },
}

describe('Flow state machine — start saga', () => {
  it('starts active at the ticket step and walks the saga to a usable Flow', () => {
    const started = transition(null, { type: 'start', flowId: 'flow-1', conversationId: 'conv-1', now: NOW })
    expect(started.session).toMatchObject({ state: 'active', step: 'start:ticket', ticketId: null, createdAt: NOW })
    expect(started.effects).toEqual([{ kind: 'createPlaceholderTicket' }])
    const ticket = transition(started.session, commands.ticketCreated)
    expect(ticket.session).toMatchObject({ ticketId: 7, step: 'start:worktree', updatedAt: LATER })
    expect(ticket.effects).toEqual([{ kind: 'reserveWorktree', ticketId: 7 }])
    const reserved = transition(ticket.session, commands.worktreeReserved)
    expect(reserved.session).toMatchObject({ worktreePath: '/wt/x', branch: 'feat/7-idea', headSha: HEAD, baseSha: BASE, step: 'start:session' })
    expect(reserved.effects).toEqual([{ kind: 'openAgentSession' }])
    const opened = transition(reserved.session, commands.sessionOpened)
    expect(opened.session).toMatchObject({ state: 'active', step: null, coreSessionId: 'flow:flow-1' })
  })

  it('repeats an identical start idempotently and rejects a conflicting one', () => {
    const existing = flow()
    expect(transition(existing, { type: 'start', flowId: 'flow-1', conversationId: 'conv-1', now: LATER })).toEqual({ session: existing, effects: [] })
    expect(() => transition(existing, { type: 'start', flowId: 'flow-2', conversationId: 'conv-1', now: LATER })).toThrow(FlowTransitionError)
    expect(() => transition(null, { type: 'start', flowId: '', conversationId: 'conv-1', now: NOW })).toThrow(/needs an id/)
  })

  it.each<[FlowStep, FlowSession, string[]]>([
    ['start:ticket', flow({ step: 'start:ticket', ticketId: null, worktreePath: null, branch: null, coreSessionId: null }), []],
    ['start:worktree', flow({ step: 'start:worktree', worktreePath: null, branch: null, coreSessionId: null }), ['releaseWorktree', 'deletePlaceholderTicket']],
    ['start:session', flow({ step: 'start:session', coreSessionId: null }), ['releaseWorktree', 'deletePlaceholderTicket']],
  ])('compensates a failed start at %s in reverse order', (_step, session, kinds) => {
    const failed = transition(session, commands.startFailed)
    expect(failed.session).toMatchObject({ state: 'discarded', step: null })
    expect(failed.effects.map((effect) => effect.kind)).toEqual(kinds)
  })

  it('rejects saga commands out of order', () => {
    expect(() => transition(flow(), commands.ticketCreated)).toThrow(/cannot ticket-created/)
    expect(() => transition(flow({ step: 'start:ticket' }), commands.worktreeReserved)).toThrow(FlowTransitionError)
    expect(() => transition(flow(), commands.startFailed)).toThrow(FlowTransitionError)
    expect(() => transition(null, commands.pause)).toThrow(/from none/)
  })
})

describe('Flow state machine — transition table', () => {
  const states: FlowState[] = ['active', 'paused', 'handed_off', 'delivered', 'discarded', 'closed', 'needs-review']
  // Legal (state, command) pairs for a settled Flow (no saga step).
  const legal: Record<string, FlowState[]> = {
    pause: ['active', 'paused'],
    resume: ['active', 'paused'],
    discard: ['active', 'paused', 'discarded'],
    close: ['needs-review', 'closed'],
    beginHandOff: ['active', 'paused', 'handed_off'], // handed_off: same rail is an idempotent repeat
    delivered: ['handed_off', 'delivered'],
    adoptionReverted: ['handed_off'],
    handOffFailed: ['handed_off'],
    returned: ['handed_off'],
  }
  for (const [name, allowed] of Object.entries(legal)) {
    for (const state of states) {
      const ok = allowed.includes(state)
      it(`${name} from ${state} is ${ok ? 'legal' : 'illegal'}`, () => {
        const session = flow({ state, ...(state === 'handed_off' ? { railIndex: 2, deliveryId: 'd-1' } : {}) })
        const run = () => transition(session, commands[name])
        if (ok) expect(run).not.toThrow()
        else expect(run).toThrow(FlowTransitionError)
      })
    }
  }

  it('pause stops its apps, closes the session and labels the spec paused; repeating it is a no-op', () => {
    const paused = transition(flow(), commands.pause)
    expect(paused.session).toMatchObject({ state: 'paused', coreSessionId: null })
    expect(paused.effects).toEqual([
      { kind: 'stopProcesses' },
      { kind: 'closeAgentSession', coreSessionId: 'flow:flow-1' },
      { kind: 'setTicketFlowState', ticketId: 7, state: 'paused' },
    ])
    expect(transition(paused.session, commands.pause)).toEqual({ session: paused.session, effects: [] })
  })

  it('resume reopens the session (state flips once it opened) and needs a worktree', () => {
    const paused = flow({ state: 'paused', coreSessionId: null })
    const resumed = transition(paused, commands.resume)
    expect(resumed.session).toBe(paused)
    expect(resumed.effects).toEqual([{ kind: 'openAgentSession' }, { kind: 'setTicketFlowState', ticketId: 7, state: 'active' }])
    expect(transition(paused, commands.sessionOpened).session).toMatchObject({ state: 'active', coreSessionId: 'flow:flow-1' })
    expect(() => transition(flow({ state: 'paused', worktreePath: null }), commands.resume)).toThrow(FlowTransitionError)
  })

  it('discard stops its apps before releasing only Flow resources and is forbidden after a hand-off', () => {
    const discarded = transition(flow(), commands.discard)
    expect(discarded.session.state).toBe('discarded')
    expect(discarded.effects).toEqual([
      { kind: 'stopProcesses' },
      { kind: 'closeAgentSession', coreSessionId: 'flow:flow-1' },
      { kind: 'releaseWorktree', ticketId: 7, worktreePath: '/wt/flow-1/ticket-7', branch: 'feat/7-idea' },
      { kind: 'deletePlaceholderTicket', ticketId: 7 },
    ])
    // A paused Flow has no session to close, but its apps are stopped again (idempotent).
    expect(transition(flow({ state: 'paused', coreSessionId: null }), commands.discard).effects[0]).toEqual({ kind: 'stopProcesses' })
    expect(() => transition(flow({ state: 'handed_off' }), commands.discard)).toThrow(/cannot discard from handed_off/)
    expect(() => transition(flow({ state: 'paused', step: 'handoff:launch' }), commands.discard)).toThrow(FlowTransitionError)
  })
})

describe('Flow state machine — close (needs-review)', () => {
  it('ends the Flow without releasing anything: the branch stays and the spec loses its label', () => {
    const closed = transition(flow({ state: 'needs-review', coreSessionId: null }), commands.close)
    expect(closed.session).toMatchObject({ state: 'closed', branch: 'feat/7-idea', worktreePath: '/wt/flow-1/ticket-7' })
    expect(isTerminalFlow(closed.session)).toBe(true)
    expect(closed.effects).toEqual([{ kind: 'setTicketFlowState', ticketId: 7, state: 'closed' }])
    expect(closed.effects.some((effect) => effect.kind === 'releaseWorktree' || effect.kind === 'deletePlaceholderTicket')).toBe(false)
    // Repeating it is a no-op; an open Flow is discarded, never closed.
    expect(transition(closed.session, commands.close)).toEqual({ session: closed.session, effects: [] })
    expect(() => transition(flow(), commands.close)).toThrow(/cannot close from active/)
  })
})

describe('Flow state machine — hand-off', () => {
  it('freezes, launches and hands off only the frozen HEAD', () => {
    const begun = transition(flow(), commands.beginHandOff)
    expect(begun.session).toMatchObject({ state: 'paused', step: 'handoff:freeze', railIndex: 2, coreSessionId: null })
    // The apps stop before the worktree is frozen and changes owner.
    expect(begun.effects).toEqual([{ kind: 'stopProcesses' }, { kind: 'closeAgentSession', coreSessionId: 'flow:flow-1' }, { kind: 'freezeWorktree' }])
    const frozen = transition(begun.session, { type: 'frozen', headSha: 'c'.repeat(40), now: LATER })
    expect(frozen.session).toMatchObject({ step: 'handoff:launch', headSha: 'c'.repeat(40) })
    expect(frozen.effects).toEqual([{ kind: 'launchRail', railIndex: 2 }])
    expect(() => transition(frozen.session, commands.handedOff)).toThrow(expect.objectContaining({ code: 'flow_head_mismatch' }))
    const handed = transition(frozen.session, { ...commands.handedOff, headSha: 'c'.repeat(40) } as FlowCommand)
    expect(handed.session).toMatchObject({ state: 'handed_off', step: null, railIndex: 2, deliveryId: 'd-1' })
    expect(transition(handed.session, { ...commands.handedOff, headSha: 'c'.repeat(40) } as FlowCommand).effects).toEqual([])
  })

  it('rolls back to paused on a failed launch and returns an adopted worktree', () => {
    const launching = flow({ state: 'paused', step: 'handoff:launch', railIndex: 2, coreSessionId: null })
    expect(transition(launching, commands.handOffFailed).session).toMatchObject({ state: 'paused', step: null, railIndex: null })
    const handed = flow({ state: 'handed_off', railIndex: 2, deliveryId: 'd-1' })
    const reverted = transition(handed, commands.adoptionReverted).session
    expect(reverted).toMatchObject({ state: 'paused', step: 'handoff:launch', deliveryId: null })
    expect(transition(reverted, commands.adoptionReverted).session).toBe(reverted)
    expect(transition(handed, commands.handOffFailed).session).toBe(handed)
  })

  it('rejects an invalid rail index and a hand-off without a worktree', () => {
    expect(() => transition(flow(), { type: 'begin-hand-off', railIndex: -1, now: LATER })).toThrow(/railIndex/)
    expect(() => transition(flow({ worktreePath: null }), commands.beginHandOff)).toThrow(FlowTransitionError)
    expect(() => transition(flow(), commands.frozen)).toThrow(FlowTransitionError)
  })

  it('records delivery and drops the In Flow label', () => {
    const delivered = transition(flow({ state: 'handed_off', railIndex: 2 }), commands.delivered)
    expect(delivered.session).toMatchObject({ state: 'delivered', deliveryId: 'd-1' })
    expect(delivered.effects).toEqual([{ kind: 'setTicketFlowState', ticketId: 7, state: 'delivered' }])
  })
})

describe('Flow state machine — restart reconciliation', () => {
  const restart = (session: FlowSession, worktreePresent = true) => transition(session, { type: 'restart', worktreePresent, now: LATER })

  it('pauses a live Flow (sessions never survive a restart)', () => {
    const result = restart(flow())
    expect(result.session).toMatchObject({ state: 'paused', coreSessionId: null, step: null })
    expect(result.effects).toEqual([{ kind: 'setTicketFlowState', ticketId: 7, state: 'paused' }])
  })

  it('compensates an unfinished early start and completes a start whose resources exist', () => {
    expect(restart(flow({ step: 'start:worktree', worktreePath: null })).session.state).toBe('discarded')
    expect(restart(flow({ step: 'start:worktree', worktreePath: null })).effects.map((effect) => effect.kind)).toEqual(['closeAgentSession', 'releaseWorktree', 'deletePlaceholderTicket'])
    expect(restart(flow({ step: 'start:session', coreSessionId: null })).session).toMatchObject({ state: 'paused', step: null })
  })

  it('rolls back an interrupted hand-off and never deletes a missing worktree', () => {
    expect(restart(flow({ state: 'paused', step: 'handoff:launch', railIndex: 3 })).session).toMatchObject({ state: 'paused', step: null, railIndex: null })
    const missing = restart(flow(), false)
    expect(missing.session.state).toBe('needs-review')
    expect(missing.effects).toEqual([])
  })

  it('leaves handed-off and terminal Flows alone', () => {
    for (const state of ['handed_off', 'delivered', 'discarded', 'needs-review'] as FlowState[]) {
      const session = flow({ state })
      expect(restart(session, false).session).toBe(session)
    }
  })
})

describe('Flow helpers', () => {
  it('derives ids, openness and the placeholder title', () => {
    expect(flowCoreSessionId('abc')).toBe('flow:abc')
    expect(isOpenFlow(flow({ state: 'paused' }))).toBe(true)
    expect(isOpenFlow(flow({ state: 'handed_off' }))).toBe(false)
    expect(isTerminalFlow(flow({ state: 'needs-review' }))).toBe(true)
    expect(placeholderTitle('  Build a\nsecond line')).toBe('Build a')
    expect(placeholderTitle('idea', ' Explicit  title ')).toBe('Explicit title')
    expect(placeholderTitle('   ')).toBe('Flow session')
    const long = placeholderTitle(`${'word '.repeat(40)}`)
    expect(long.length).toBeLessThanOrEqual(121)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('Flow state machine — Back to Flow', () => {
  const handedOff = () => flow({ state: 'handed_off', coreSessionId: null, railIndex: 2, deliveryId: 'd-1', headSha: HEAD })

  it('returns the worktree to a paused Flow that remembers the delivery and the review, and reopens the spec', () => {
    const returned = transition(handedOff(), commands.returned)
    expect(returned.session).toMatchObject({ state: 'paused', step: null, coreSessionId: null, railIndex: null, deliveryId: 'd-1', worktreePath: '/wt/flow-1/ticket-7', returnBriefing: '[Back from Flow → Spec] fix the tests', updatedAt: LATER })
    expect(returned.effects).toEqual([{ kind: 'reopenTicket', ticketId: 7 }])
    // Idempotent: the same delivery already gave it back (paused or resumed).
    expect(transition(returned.session, commands.returned)).toEqual({ session: returned.session, effects: [] })
    const resumed = { ...returned.session, state: 'active' as const, coreSessionId: 'flow:flow-1' }
    expect(transition(resumed, commands.returned)).toEqual({ session: resumed, effects: [] })
  })

  it('refuses another delivery, a Flow mid-saga and a Flow without a worktree', () => {
    expect(() => transition(handedOff(), { ...commands.returned, deliveryId: 'd-2' } as FlowCommand)).toThrow(FlowTransitionError)
    expect(() => transition({ ...handedOff(), step: 'handoff:launch' }, commands.returned)).toThrow(FlowTransitionError)
    expect(() => transition({ ...handedOff(), worktreePath: null }, commands.returned)).toThrow(FlowTransitionError)
    expect(() => transition(flow({ state: 'delivered', deliveryId: 'd-1' }), commands.returned)).toThrow(FlowTransitionError)
  })

  it('clears the briefing once delivered and when the Flow is handed off again', () => {
    const returned = transition(handedOff(), commands.returned).session
    const delivered = transition(returned, { type: 'briefing-delivered', now: LATER })
    expect(delivered.session.returnBriefing).toBeNull()
    expect(transition(delivered.session, { type: 'briefing-delivered', now: LATER })).toEqual({ session: delivered.session, effects: [] })
    expect(transition(returned, commands.beginHandOff).session.returnBriefing).toBeNull()
  })
})

describe('Back to Flow briefing', () => {
  it('quotes the review, the issues and the failing checks with the conduct', () => {
    const text = buildReturnBriefing({ reason: 'review', summary: 'Two gaps', issues: ['Tag the tests', 'Test the Options\nscreen'], issuesOmitted: 3, score: 58, failingChecks: [{ command: 'npm test', exitCode: 1 }] })
    expect(text.split('\n')[0]).toBe('[Back from Flow → Spec — automatic context, not typed by the user]')
    expect(text).toContain('the reviewer requested changes (score 58)')
    expect(text).toContain('Reviewer summary: Two gaps')
    expect(text).toContain('1. Tag the tests')
    expect(text).toContain('2. Test the Options screen')
    expect(text).toContain('(+3 more')
    expect(text).toContain('Failing checks: npm test (exit 1)')
    expect(text).toContain('[spec:<capability>/<requirement-slug>]')
    expect(text).toContain('hand off to Flow → Spec again')
  })

  it('explains failing checks, an unknown outcome, and stays bounded', () => {
    expect(buildReturnBriefing({ reason: 'check', summary: null, issues: [], issuesOmitted: 0, score: null, failingChecks: [{ command: 'npm test', exitCode: null }] })).toContain('the host checks still fail')
    expect(buildReturnBriefing(null)).toContain('Ask the person how to proceed')
    const long = buildReturnBriefing({ reason: 'review', summary: 'x'.repeat(5000), issues: Array.from({ length: 40 }, () => 'y'.repeat(600)), issuesOmitted: 0, score: 1, failingChecks: [] })
    expect(long.length).toBeLessThanOrEqual(FLOW_RETURN_BRIEFING_LIMIT)
  })
})

describe('Flow Core session generations', () => {
  it('a new generation is strictly newer than the previous one, even within the same millisecond', () => {
    const first = nextFlowCoreSessionId('f1', 1_000_000)
    expect(first).toBe(`flow:f1:${(1_000_000).toString(36)}`)
    const second = nextFlowCoreSessionId('f1', 1_000_000, first)
    expect(second).toBe(`flow:f1:${(1_000_001).toString(36)}`)
    expect(nextFlowCoreSessionId('f1', 2_000_000, second)).toBe(`flow:f1:${(2_000_000).toString(36)}`)
    expect(nextFlowCoreSessionId('f1', 5, flowCoreSessionId('f1'))).toBe('flow:f1:5')
  })
})


describe('Flow state machine — Flow from an existing spec', () => {
  const startFrom = (ticketId: number) => transition(null, { type: 'start', flowId: 'flow-1', conversationId: 'conv-1', ticketId, now: NOW })

  it('starts holding the spec and labels it instead of creating a placeholder', () => {
    const started = startFrom(12)
    expect(started.session).toMatchObject({ ticketId: 12, specOrigin: 'existing', step: 'start:ticket', state: 'active' })
    expect(started.effects).toEqual([{ kind: 'adoptTicket', ticketId: 12 }])
    const labelled = transition(started.session, { type: 'ticket-created', ticketId: 12, briefing: '  [Flow started from spec #12] …  ', now: LATER })
    expect(labelled.session).toMatchObject({ step: 'start:worktree', returnBriefing: '[Flow started from spec #12] …' })
    expect(labelled.effects).toEqual([{ kind: 'reserveWorktree', ticketId: 12 }])
    expect(() => transition(started.session, { type: 'ticket-created', ticketId: 13, now: LATER })).toThrow(/belongs to spec #12/)
    expect(() => startFrom(0)).toThrow(/positive integer/)
  })

  it('restores (never deletes) the spec on discard, failed start and restart compensation', () => {
    const open = flow({ ticketId: 12, specOrigin: 'existing' })
    expect(transition(open, commands.discard).effects).toContainEqual({ kind: 'restoreTicket', ticketId: 12 })
    expect(transition(open, commands.discard).effects.some((effect) => effect.kind === 'deletePlaceholderTicket')).toBe(false)
    const midStart = flow({ ticketId: 12, specOrigin: 'existing', step: 'start:ticket', worktreePath: null, coreSessionId: null })
    expect(transition(midStart, commands.startFailed).effects).toEqual([{ kind: 'restoreTicket', ticketId: 12 }])
    expect(transition(midStart, { type: 'restart', worktreePresent: false, now: LATER }).effects).toEqual([{ kind: 'restoreTicket', ticketId: 12 }])
    // A placeholder Flow keeps deleting its own spec.
    expect(transition(flow(), commands.discard).effects).toContainEqual({ kind: 'deletePlaceholderTicket', ticketId: 7 })
  })
})
