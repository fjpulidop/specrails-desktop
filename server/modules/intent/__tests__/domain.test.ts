import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_SCOPE_HEADING,
  FLOW_ACCEPTED_SCOPE_LIMIT_BYTES,
  FLOW_RETURN_BRIEFING_LIMIT,
  IntentTransitionError,
  RETURN_SCOPE_CONDUCT,
  UNREQUESTED_CHANGE_PREFIX,
  acceptedScopeEntries,
  buildAcceptedScope,
  buildFlowSummary,
  buildReturnBriefing,
  isUnrequestedChange,
  provenanceTime,
  flowCoreSessionId,
  nextFlowCoreSessionId,
  isOpenFlow,
  isTerminalFlow,
  placeholderTitle,
  transition,
  type IntentCommand,
  type IntentSession,
  type IntentState,
  type IntentStep,
} from '../domain'

const NOW = '2026-10-21T10:00:00.000Z'
const LATER = '2026-10-21T10:05:00.000Z'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

function flow(patch: Partial<IntentSession> = {}): IntentSession {
  return {
    id: 'flow-1', conversationId: 'conv-1', ticketId: 7, state: 'active', branch: 'feat/7-idea',
    worktreePath: '/wt/flow-1/ticket-7', baseSha: BASE, headSha: HEAD, coreSessionId: 'flow:flow-1',
    railIndex: null, deliveryId: null, step: null, createdAt: NOW, updatedAt: NOW, ...patch,
  }
}

const commands: Record<string, IntentCommand> = {
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
  returned: { type: 'returned', deliveryId: 'd-1', briefing: '[Back from Intent → Spec] fix the tests', now: LATER },
}

describe('Intent state machine — start saga', () => {
  it('starts active at the ticket step and walks the saga to a usable Intent', () => {
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
    expect(() => transition(existing, { type: 'start', flowId: 'flow-2', conversationId: 'conv-1', now: LATER })).toThrow(IntentTransitionError)
    expect(() => transition(null, { type: 'start', flowId: '', conversationId: 'conv-1', now: NOW })).toThrow(/needs an id/)
  })

  it.each<[IntentStep, IntentSession, string[]]>([
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
    expect(() => transition(flow({ step: 'start:ticket' }), commands.worktreeReserved)).toThrow(IntentTransitionError)
    expect(() => transition(flow(), commands.startFailed)).toThrow(IntentTransitionError)
    expect(() => transition(null, commands.pause)).toThrow(/from none/)
  })
})

describe('Intent state machine — transition table', () => {
  const states: IntentState[] = ['active', 'paused', 'handed_off', 'delivered', 'discarded', 'closed', 'needs-review']
  // Legal (state, command) pairs for a settled Intent (no saga step).
  const legal: Record<string, IntentState[]> = {
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
        else expect(run).toThrow(IntentTransitionError)
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
    expect(() => transition(flow({ state: 'paused', worktreePath: null }), commands.resume)).toThrow(IntentTransitionError)
  })

  it('discard stops its apps before releasing only Intent resources and is forbidden after a hand-off', () => {
    const discarded = transition(flow(), commands.discard)
    expect(discarded.session.state).toBe('discarded')
    expect(discarded.effects).toEqual([
      { kind: 'stopProcesses' },
      { kind: 'closeAgentSession', coreSessionId: 'flow:flow-1' },
      { kind: 'releaseWorktree', ticketId: 7, worktreePath: '/wt/flow-1/ticket-7', branch: 'feat/7-idea' },
      { kind: 'deletePlaceholderTicket', ticketId: 7 },
    ])
    // A paused Intent has no session to close, but its apps are stopped again (idempotent).
    expect(transition(flow({ state: 'paused', coreSessionId: null }), commands.discard).effects[0]).toEqual({ kind: 'stopProcesses' })
    expect(() => transition(flow({ state: 'handed_off' }), commands.discard)).toThrow(/cannot discard from handed_off/)
    expect(() => transition(flow({ state: 'paused', step: 'handoff:launch' }), commands.discard)).toThrow(IntentTransitionError)
  })
})

describe('Intent state machine — close (needs-review)', () => {
  it('ends the Intent without releasing anything: the branch stays and the spec loses its label', () => {
    const closed = transition(flow({ state: 'needs-review', coreSessionId: null }), commands.close)
    expect(closed.session).toMatchObject({ state: 'closed', branch: 'feat/7-idea', worktreePath: '/wt/flow-1/ticket-7' })
    expect(isTerminalFlow(closed.session)).toBe(true)
    expect(closed.effects).toEqual([{ kind: 'setTicketFlowState', ticketId: 7, state: 'closed' }])
    expect(closed.effects.some((effect) => effect.kind === 'releaseWorktree' || effect.kind === 'deletePlaceholderTicket')).toBe(false)
    // Repeating it is a no-op; an open Intent is discarded, never closed.
    expect(transition(closed.session, commands.close)).toEqual({ session: closed.session, effects: [] })
    expect(() => transition(flow(), commands.close)).toThrow(/cannot close from active/)
  })
})

describe('Intent state machine — hand-off', () => {
  it('freezes, launches and hands off only the frozen HEAD', () => {
    const begun = transition(flow(), commands.beginHandOff)
    expect(begun.session).toMatchObject({ state: 'paused', step: 'handoff:freeze', railIndex: 2, coreSessionId: null })
    // The apps stop before the worktree is frozen and changes owner.
    expect(begun.effects).toEqual([{ kind: 'stopProcesses' }, { kind: 'closeAgentSession', coreSessionId: 'flow:flow-1' }, { kind: 'freezeWorktree' }])
    const frozen = transition(begun.session, { type: 'frozen', headSha: 'c'.repeat(40), now: LATER })
    expect(frozen.session).toMatchObject({ step: 'handoff:launch', headSha: 'c'.repeat(40) })
    expect(frozen.effects).toEqual([{ kind: 'launchRail', railIndex: 2 }])
    expect(() => transition(frozen.session, commands.handedOff)).toThrow(expect.objectContaining({ code: 'flow_head_mismatch' }))
    const handed = transition(frozen.session, { ...commands.handedOff, headSha: 'c'.repeat(40) } as IntentCommand)
    expect(handed.session).toMatchObject({ state: 'handed_off', step: null, railIndex: 2, deliveryId: 'd-1' })
    expect(transition(handed.session, { ...commands.handedOff, headSha: 'c'.repeat(40) } as IntentCommand).effects).toEqual([])
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
    expect(() => transition(flow({ worktreePath: null }), commands.beginHandOff)).toThrow(IntentTransitionError)
    expect(() => transition(flow(), commands.frozen)).toThrow(IntentTransitionError)
  })

  it('records delivery and drops the In Intent label', () => {
    const delivered = transition(flow({ state: 'handed_off', railIndex: 2 }), commands.delivered)
    expect(delivered.session).toMatchObject({ state: 'delivered', deliveryId: 'd-1' })
    expect(delivered.effects).toEqual([{ kind: 'setTicketFlowState', ticketId: 7, state: 'delivered' }])
  })
})

describe('Intent state machine — restart reconciliation', () => {
  const restart = (session: IntentSession, worktreePresent = true) => transition(session, { type: 'restart', worktreePresent, now: LATER })

  it('pauses a live Intent (sessions never survive a restart)', () => {
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
    for (const state of ['handed_off', 'delivered', 'discarded', 'needs-review'] as IntentState[]) {
      const session = flow({ state })
      expect(restart(session, false).session).toBe(session)
    }
  })
})

describe('Intent helpers', () => {
  it('derives ids, openness and the placeholder title', () => {
    expect(flowCoreSessionId('abc')).toBe('flow:abc')
    expect(isOpenFlow(flow({ state: 'paused' }))).toBe(true)
    expect(isOpenFlow(flow({ state: 'handed_off' }))).toBe(false)
    expect(isTerminalFlow(flow({ state: 'needs-review' }))).toBe(true)
    expect(placeholderTitle('  Build a\nsecond line')).toBe('Build a')
    expect(placeholderTitle('idea', ' Explicit  title ')).toBe('Explicit title')
    expect(placeholderTitle('   ')).toBe('Intent session')
    const long = placeholderTitle(`${'word '.repeat(40)}`)
    expect(long.length).toBeLessThanOrEqual(121)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('Intent state machine — Back to Intent', () => {
  const handedOff = () => flow({ state: 'handed_off', coreSessionId: null, railIndex: 2, deliveryId: 'd-1', headSha: HEAD })

  it('returns the worktree to a paused Intent that remembers the delivery and the review, and reopens the spec', () => {
    const returned = transition(handedOff(), commands.returned)
    expect(returned.session).toMatchObject({ state: 'paused', step: null, coreSessionId: null, railIndex: null, deliveryId: 'd-1', worktreePath: '/wt/flow-1/ticket-7', returnBriefing: '[Back from Intent → Spec] fix the tests', updatedAt: LATER })
    expect(returned.effects).toEqual([{ kind: 'reopenTicket', ticketId: 7 }])
    // Idempotent: the same delivery already gave it back (paused or resumed).
    expect(transition(returned.session, commands.returned)).toEqual({ session: returned.session, effects: [] })
    const resumed = { ...returned.session, state: 'active' as const, coreSessionId: 'flow:flow-1' }
    expect(transition(resumed, commands.returned)).toEqual({ session: resumed, effects: [] })
  })

  it('refuses another delivery, an Intent session mid-saga and an Intent session without a worktree', () => {
    expect(() => transition(handedOff(), { ...commands.returned, deliveryId: 'd-2' } as IntentCommand)).toThrow(IntentTransitionError)
    expect(() => transition({ ...handedOff(), step: 'handoff:launch' }, commands.returned)).toThrow(IntentTransitionError)
    expect(() => transition({ ...handedOff(), worktreePath: null }, commands.returned)).toThrow(IntentTransitionError)
    expect(() => transition(flow({ state: 'delivered', deliveryId: 'd-1' }), commands.returned)).toThrow(IntentTransitionError)
  })

  it('clears the briefing once delivered and when the Intent is handed off again', () => {
    const returned = transition(handedOff(), commands.returned).session
    const delivered = transition(returned, { type: 'briefing-delivered', now: LATER })
    expect(delivered.session.returnBriefing).toBeNull()
    expect(transition(delivered.session, { type: 'briefing-delivered', now: LATER })).toEqual({ session: delivered.session, effects: [] })
    expect(transition(returned, commands.beginHandOff).session.returnBriefing).toBeNull()
  })
})

describe('Back to Intent briefing', () => {
  it('quotes the review, the issues and the failing checks with the conduct', () => {
    const text = buildReturnBriefing({ reason: 'review', summary: 'Two gaps', issues: ['Tag the tests', 'Test the Options\nscreen'], issuesOmitted: 3, score: 58, failingChecks: [{ command: 'npm test', exitCode: 1 }] })
    expect(text.split('\n')[0]).toBe('[Back from Intent → Spec — automatic context, not typed by the user]')
    expect(text).toContain('the reviewer requested changes (score 58)')
    expect(text).toContain('Reviewer summary: Two gaps')
    expect(text).toContain('1. Tag the tests')
    expect(text).toContain('2. Test the Options screen')
    expect(text).toContain('(+3 more')
    expect(text).toContain('Failing checks: npm test (exit 1)')
    expect(text).toContain('[spec:<capability>/<requirement-slug>]')
    expect(text).toContain('hand off to Intent → Spec again')
  })

  it('explains failing checks, an unknown outcome, and stays bounded', () => {
    expect(buildReturnBriefing({ reason: 'check', summary: null, issues: [], issuesOmitted: 0, score: null, failingChecks: [{ command: 'npm test', exitCode: null }] })).toContain('the host checks still fail')
    expect(buildReturnBriefing(null)).toContain('Ask the person how to proceed')
    const long = buildReturnBriefing({ reason: 'review', summary: 'x'.repeat(5000), issues: Array.from({ length: 40 }, () => 'y'.repeat(600)), issuesOmitted: 0, score: 1, failingChecks: [] })
    expect(long.length).toBeLessThanOrEqual(FLOW_RETURN_BRIEFING_LIMIT)
  })
})

// The generala-dorada Intent, reduced: a layout intent whose constraint
// forbids rule changes, then the person explicitly asks for other rules.
const GENERALA = [
  { role: 'user', content: 'quiero la pantalla de juego más horizontal', at: '2026-11-21 20:37:13' },
  { role: 'assistant', content: 'Decision: el tablero tendrá dos bloques, «Números» y «Combinaciones».', at: '2026-11-22 09:10:21' },
  { role: 'user', content: 'tienes acceso a las reglas de la generala de 51 worldwide games de switch, quiero las mismas reglas aquí (con el libre, solo con una generala, el combo etc)', at: '2026-11-22 09:10:21' },
  { role: 'assistant', content: 'Hecho.\n\nDecision: cada jugador tendrá doce casillas. «Libre» suma los cinco dados y el bono añade 35 al alcanzar 63 en Números.', at: '2026-11-22 09:23:02' },
  { role: 'user', content: '[Specrails run-failure briefing — automatic, not typed by the user]', at: '2026-11-22 14:28:34', automated: true },
  { role: 'assistant', content: 'Decision: el tablero tendrá dos bloques, «Números» y «Combinaciones».', at: '2026-11-22 15:00:00' },
]

describe('Accepted scope (what the person decided during the Intent)', () => {
  it('lists every request and decision in order with provenance, after the intent constraints they may supersede', () => {
    const text = buildAcceptedScope({ constraints: ['No cambiar reglas ni lógica de juego'], messages: GENERALA })
    expect(text.startsWith(ACCEPTED_SCOPE_HEADING)).toBe(true)
    expect(text).toContain('A later one supersedes an earlier one, and any constraint of the intent, that it contradicts')
    expect(text).toContain('Intent constraints (each holds only where no later entry below contradicts it):\n- No cambiar reglas ni lógica de juego')
    expect(text).toContain('1. 2026-11-21 20:37 UTC — Person asked: "quiero la pantalla de juego más horizontal"')
    expect(text).toContain('2. 2026-11-22 09:10 UTC — Decision recorded: "el tablero tendrá dos bloques')
    expect(text).toContain('3. 2026-11-22 09:10 UTC — Person asked: "tienes acceso a las reglas de la generala de 51 worldwide games')
    expect(text).toContain('4. 2026-11-22 09:23 UTC — Decision recorded: "cada jugador tendrá doce casillas')
    // Automated briefings are not the person; a repeated decision is listed once.
    expect(text).not.toContain('run-failure briefing')
    expect(text).not.toContain('5. ')
    // What each step does with it.
    expect(text).toContain('- Derive: describe these entries as requirements (ADDED or MODIFIED), never as out-of-scope change. A superseded constraint is not a Non-Goal')
    expect(text).toContain('- Review: never ask to revert, remove or restore behaviour an entry supports')
    expect(text).toContain(`as an issue starting with "${UNREQUESTED_CHANGE_PREFIX}"`)
    expect(text).toContain('- Fix: never revert behaviour an entry supports, and never revert an unrequested change yourself')
  })

  it('is empty without requests or decisions, and keeps quotes inside the quoted text', () => {
    expect(buildAcceptedScope({ constraints: ['x'], messages: [] })).toBe('')
    expect(buildAcceptedScope({ messages: [{ role: 'user', content: '[briefing]', automated: true }] })).toBe('')
    const text = buildAcceptedScope({ messages: [{ role: 'user', content: 'say "hi"\nthen leave' }] })
    expect(text).toContain('1. Person asked: "say \'hi\' then leave"')
    expect(text).not.toContain('Intent constraints')
    // Step prompts are interpolated by Core: a template in the person's words stays inert.
    expect(buildAcceptedScope({ constraints: ['keep {{run.x}}'], messages: [{ role: 'user', content: 'use {{outputs.check}}' }] })).not.toMatch(/\{\{|\}\}/)
  })

  it('stays bounded: the oldest requests give way first, the decisions stay', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ role: 'user', content: `request ${index} ${'z'.repeat(300)}`, at: '2026-11-22 09:00:00' }))
    const text = buildAcceptedScope({ constraints: ['c'], messages: [...many, { role: 'assistant', content: 'Decision: keep the rules of Switch' }] })
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(FLOW_ACCEPTED_SCOPE_LIMIT_BYTES)
    expect(text).toContain('keep the rules of Switch')
    expect(text).toContain('request 199')
    expect(text).not.toContain('request 0 ')
    expect(text).toMatch(/\(\d+ earlier request\(s\) omitted here; the conversation summary keeps them\)/)
    expect(text).toContain('- Fix:')
  })

  it('reads provenance from SQLite and ISO times', () => {
    expect(provenanceTime('2026-11-22 09:10:21')).toBe('2026-11-22 09:10 UTC')
    expect(provenanceTime('2026-11-22T09:10:21.500Z')).toBe('2026-11-22 09:10 UTC')
    expect(provenanceTime('soon')).toBeNull()
    expect(provenanceTime(null)).toBeNull()
    expect(acceptedScopeEntries(GENERALA).map((entry) => entry.kind)).toEqual(['request', 'decision', 'request', 'decision'])
  })

  it('the derive input states the precedence and stamps each message and decision', () => {
    const summary = buildFlowSummary({ idea: null, messages: GENERALA, intent: '## Intent (source of truth for why and for the outcome, never for how)\n\n### Constraints\n\n- No cambiar reglas ni lógica de juego' })
    expect(summary.indexOf('No cambiar reglas')).toBeLessThan(summary.indexOf('## Accepted scope'))
    expect(summary).toContain('A later one supersedes an earlier one, and any constraint of the intent, that it contradicts')
    expect(summary).toContain('describe them as requirements, never as out-of-scope change')
    expect(summary).toContain('2. [2026-11-22 09:10 UTC] tienes acceso a las reglas de la generala')
    expect(summary).toContain('- [2026-11-22 09:23 UTC] cada jugador tendrá doce casillas')
    expect(buildFlowSummary({ idea: 'x', messages: [] })).not.toContain('## Accepted scope')
  })
})

describe('Back to Intent never plans a revert of what the person asked for', () => {
  // The generala-dorada review, reduced.
  const findings = {
    reason: 'review' as const, summary: 'Layout works; tests missing', score: 55, issuesOmitted: 0, failingChecks: [],
    issues: [
      'src/renderer/shell/shell.css:525: Keep a visible focus indicator when a roll gates candidate buttons.',
      `${UNREQUESTED_CHANGE_PREFIX} src/renderer/menu/Credits.tsx: a credits screen; no request or decision supports it`,
    ],
  }

  it('keeps person-requested work, lists unrequested changes apart and asks the person about them', () => {
    const text = buildReturnBriefing(findings)
    expect(text).toContain('Issues to address:\n1. src/renderer/shell/shell.css:525')
    expect(text).toContain('Changes the reviewer could not trace to any request or decision of this Intent (the person decides each one; never revert it on your own):\n1. src/renderer/menu/Credits.tsx: a credits screen')
    expect(text).not.toContain(`2. ${UNREQUESTED_CHANGE_PREFIX}`)
    expect(text).toContain(RETURN_SCOPE_CONDUCT)
    expect(RETURN_SCOPE_CONDUCT).toContain('Never revert, remove or restore anything the person asked for or decided in this Intent')
    expect(RETURN_SCOPE_CONDUCT).toContain('even when a finding asks for it or the original intent\'s constraints say otherwise')
    expect(RETURN_SCOPE_CONDUCT).toContain('offer the choice as an `options` block BEFORE editing (keep it and record it as a requirement, or revert it)')
    expect(text).not.toContain('is removed or explicitly confirmed by them')
  })

  it('recognises the unrequested-change prefix in any case', () => {
    expect(isUnrequestedChange('  unrequested change: x')).toBe(true)
    expect(isUnrequestedChange('Revert the rules')).toBe(false)
  })
})

describe('Intent Core session generations', () => {
  it('a new generation is strictly newer than the previous one, even within the same millisecond', () => {
    const first = nextFlowCoreSessionId('f1', 1_000_000)
    expect(first).toBe(`flow:f1:${(1_000_000).toString(36)}`)
    const second = nextFlowCoreSessionId('f1', 1_000_000, first)
    expect(second).toBe(`flow:f1:${(1_000_001).toString(36)}`)
    expect(nextFlowCoreSessionId('f1', 2_000_000, second)).toBe(`flow:f1:${(2_000_000).toString(36)}`)
    expect(nextFlowCoreSessionId('f1', 5, flowCoreSessionId('f1'))).toBe('flow:f1:5')
  })
})


describe('Intent state machine — Intent from an existing spec', () => {
  const startFrom = (ticketId: number) => transition(null, { type: 'start', flowId: 'flow-1', conversationId: 'conv-1', ticketId, now: NOW })

  it('starts holding the spec and labels it instead of creating a placeholder', () => {
    const started = startFrom(12)
    expect(started.session).toMatchObject({ ticketId: 12, specOrigin: 'existing', step: 'start:ticket', state: 'active' })
    expect(started.effects).toEqual([{ kind: 'adoptTicket', ticketId: 12 }])
    const labelled = transition(started.session, { type: 'ticket-created', ticketId: 12, briefing: '  [Intent started from spec #12] …  ', now: LATER })
    expect(labelled.session).toMatchObject({ step: 'start:worktree', returnBriefing: '[Intent started from spec #12] …' })
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
    // A placeholder Intent keeps deleting its own spec.
    expect(transition(flow(), commands.discard).effects).toContainEqual({ kind: 'deletePlaceholderTicket', ticketId: 7 })
  })
})
