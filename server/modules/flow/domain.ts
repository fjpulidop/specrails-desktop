/**
 * Flow lifecycle: a pure state machine (functional core). No database, Git,
 * process or clock access: time arrives as data and every side effect is
 * returned as a description the application executes through its ports.
 *
 *            start            pause              handOff            delivered
 * (none) ──────────► active ◄──────► paused ──────────► handed_off ───────────► delivered
 *                      │   resume                         │
 *                      │ discard                          │ hand-off failed
 *                      ▼                                  ▼
 *                  discarded                            paused
 *
 * `needs-review` is reached only by startup reconciliation, when the worktree a
 * Flow owns has disappeared. Sagas (start, hand-off) record their progress in
 * `step` so a restart can complete or compensate them.
 */

export type FlowState = 'active' | 'paused' | 'handed_off' | 'delivered' | 'discarded' | 'needs-review'

/** States whose Flow still owns its conversation (at most one per conversation). */
export const OPEN_FLOW_STATES: readonly FlowState[] = Object.freeze(['active', 'paused'])

/** Saga progress. `start:*` steps run before a Flow is usable; `handoff:*` before the rail owns it. */
export type FlowStep = 'start:ticket' | 'start:worktree' | 'start:session' | 'handoff:freeze' | 'handoff:launch'

/** Ticket metadata state shown as the "In Flow" label (`delivered` hides it). */
export type FlowTicketState = 'active' | 'paused' | 'delivered'

export interface FlowSession {
  id: string
  conversationId: string
  /** Null only while the `start:ticket` step has not created the placeholder spec. */
  ticketId: number | null
  state: FlowState
  branch: string | null
  worktreePath: string | null
  /** Commit the worktree branched from (integration base at start). */
  baseSha: string | null
  /** HEAD recorded at reservation, and again when the hand-off froze the worktree. */
  headSha: string | null
  /** Core agent session id (`flow:<flowId>`), null when no session is open. */
  coreSessionId: string | null
  railIndex: number | null
  deliveryId: string | null
  step: FlowStep | null
  createdAt: string
  updatedAt: string
}

export type FlowCommand =
  | { type: 'start'; flowId: string; conversationId: string; now: string }
  | { type: 'ticket-created'; ticketId: number; now: string }
  | { type: 'worktree-reserved'; branch: string; worktreePath: string; baseSha: string | null; headSha: string | null; now: string }
  | { type: 'session-opened'; coreSessionId: string; now: string }
  | { type: 'start-failed'; now: string }
  | { type: 'pause'; now: string }
  | { type: 'resume'; now: string }
  | { type: 'discard'; now: string }
  | { type: 'begin-hand-off'; railIndex: number; now: string }
  | { type: 'frozen'; headSha: string; now: string }
  | { type: 'handed-off'; railIndex: number; deliveryId: string | null; headSha: string; now: string }
  | { type: 'hand-off-failed'; now: string }
  /** The launch rolled back after adopting the worktree: ownership returns to the Flow. */
  | { type: 'adoption-reverted'; now: string }
  | { type: 'delivered'; deliveryId: string; now: string }
  /** Startup reconciliation: sessions never survive a restart. */
  | { type: 'restart'; worktreePresent: boolean; now: string }

export type FlowEffect =
  | { kind: 'createPlaceholderTicket' }
  | { kind: 'reserveWorktree'; ticketId: number }
  | { kind: 'openAgentSession' }
  | { kind: 'closeAgentSession'; coreSessionId: string }
  /** Remove a worktree Flow created. A null path means the reservation may have
   * happened without being recorded; the adapter derives the Flow-owned path. */
  | { kind: 'releaseWorktree'; ticketId: number; worktreePath: string | null; branch: string | null }
  | { kind: 'deletePlaceholderTicket'; ticketId: number }
  | { kind: 'setTicketFlowState'; ticketId: number; state: FlowTicketState }
  | { kind: 'freezeWorktree' }
  | { kind: 'launchRail'; railIndex: number }

export interface FlowTransition {
  session: FlowSession
  effects: FlowEffect[]
}

export type FlowErrorCode = 'illegal_transition' | 'flow_head_mismatch' | 'invalid_command'

export class FlowTransitionError extends Error {
  constructor(readonly code: FlowErrorCode, message: string) {
    super(message)
    this.name = 'FlowTransitionError'
  }
}

/** The loop a hand-off launches unless the caller chooses one (registered by the flow-spec-loop change). */
export const FLOW_SPEC_LOOP_ID = 'factory:flow-spec'

/** Core session id for a Flow: a session distinct from the mission's own, because cwd is fixed at open. */
export function flowCoreSessionId(flowId: string): string {
  return `flow:${flowId}`
}

export function isOpenFlow(session: Pick<FlowSession, 'state'>): boolean {
  return OPEN_FLOW_STATES.includes(session.state)
}

export function isTerminalFlow(session: Pick<FlowSession, 'state'>): boolean {
  return session.state === 'delivered' || session.state === 'discarded' || session.state === 'needs-review'
}

/** Title of the placeholder spec, from the free idea that started the Flow. */
export function placeholderTitle(idea: string, explicit?: string | null): string {
  const chosen = (explicit ?? '').replace(/\s+/g, ' ').trim()
  if (chosen) return chosen.slice(0, 120)
  const firstLine = idea.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const clean = firstLine.replace(/\s+/g, ' ')
  if (!clean) return 'Flow session'
  if (clean.length <= 120) return clean
  const head = clean.slice(0, 120)
  const space = head.lastIndexOf(' ')
  return `${(space > 40 ? head.slice(0, space) : head).trim()}…`
}

function illegal(session: FlowSession | null, command: FlowCommand): never {
  const from = session ? `${session.state}${session.step ? ` (${session.step})` : ''}` : 'none'
  throw new FlowTransitionError('illegal_transition', `Flow cannot ${command.type} from ${from}`)
}

function next(session: FlowSession, patch: Partial<FlowSession>, now: string): FlowSession {
  return { ...session, ...patch, updatedAt: now }
}

/** Compensation for an unfinished start, in reverse order of the saga steps. */
function startCompensation(session: FlowSession): FlowEffect[] {
  const effects: FlowEffect[] = []
  if (session.coreSessionId) effects.push({ kind: 'closeAgentSession', coreSessionId: session.coreSessionId })
  if (session.ticketId !== null && (session.worktreePath || session.step === 'start:worktree')) {
    effects.push({ kind: 'releaseWorktree', ticketId: session.ticketId, worktreePath: session.worktreePath, branch: session.branch })
  }
  if (session.ticketId !== null) effects.push({ kind: 'deletePlaceholderTicket', ticketId: session.ticketId })
  return effects
}

/**
 * Apply one command. Returns the next session and the effects the application
 * must execute. Repeating a command whose target state already holds is a
 * no-op (idempotent), never an error.
 */
export function transition(session: FlowSession | null, command: FlowCommand): FlowTransition {
  const { now } = command
  if (command.type === 'start') {
    if (session) {
      if (session.id === command.flowId && session.conversationId === command.conversationId) return { session, effects: [] }
      illegal(session, command)
    }
    if (!command.flowId || !command.conversationId) throw new FlowTransitionError('invalid_command', 'A Flow needs an id and a conversation')
    return {
      session: {
        id: command.flowId,
        conversationId: command.conversationId,
        ticketId: null,
        state: 'active',
        branch: null,
        worktreePath: null,
        baseSha: null,
        headSha: null,
        coreSessionId: null,
        railIndex: null,
        deliveryId: null,
        step: 'start:ticket',
        createdAt: now,
        updatedAt: now,
      },
      effects: [{ kind: 'createPlaceholderTicket' }],
    }
  }
  if (!session) illegal(null, command)

  switch (command.type) {
    case 'ticket-created':
      if (session.step !== 'start:ticket') illegal(session, command)
      return {
        session: next(session, { ticketId: command.ticketId, step: 'start:worktree' }, now),
        effects: [{ kind: 'reserveWorktree', ticketId: command.ticketId }],
      }
    case 'worktree-reserved':
      if (session.step !== 'start:worktree') illegal(session, command)
      return {
        session: next(session, {
          branch: command.branch, worktreePath: command.worktreePath,
          baseSha: command.baseSha, headSha: command.headSha, step: 'start:session',
        }, now),
        effects: [{ kind: 'openAgentSession' }],
      }
    case 'session-opened':
      if (session.step !== 'start:session' && !(session.state === 'paused' && session.step === null)) illegal(session, command)
      return { session: next(session, { coreSessionId: command.coreSessionId, step: null, state: 'active' }, now), effects: [] }
    case 'start-failed':
      if (!session.step?.startsWith('start:')) illegal(session, command)
      return { session: next(session, { state: 'discarded', step: null, coreSessionId: null }, now), effects: startCompensation(session) }
    case 'pause': {
      if (session.state === 'paused' && session.step === null) return { session, effects: [] }
      if (session.state !== 'active' || session.step !== null) illegal(session, command)
      const effects: FlowEffect[] = []
      if (session.coreSessionId) effects.push({ kind: 'closeAgentSession', coreSessionId: session.coreSessionId })
      if (session.ticketId !== null) effects.push({ kind: 'setTicketFlowState', ticketId: session.ticketId, state: 'paused' })
      return { session: next(session, { state: 'paused', coreSessionId: null }, now), effects }
    }
    case 'resume': {
      if (session.state === 'active' && session.step === null) return { session, effects: [] }
      if (session.state !== 'paused' || session.step !== null || !session.worktreePath) illegal(session, command)
      const effects: FlowEffect[] = [{ kind: 'openAgentSession' }]
      if (session.ticketId !== null) effects.push({ kind: 'setTicketFlowState', ticketId: session.ticketId, state: 'active' })
      // State becomes active once the session opens (`session-opened`).
      return { session, effects }
    }
    case 'discard': {
      if (session.state === 'discarded') return { session, effects: [] }
      // The rail owns the worktree after a hand-off: discarding the delivery is the rail's decision.
      if (!isOpenFlow(session) || session.step !== null) illegal(session, command)
      const effects: FlowEffect[] = []
      if (session.coreSessionId) effects.push({ kind: 'closeAgentSession', coreSessionId: session.coreSessionId })
      if (session.ticketId !== null) {
        effects.push({ kind: 'releaseWorktree', ticketId: session.ticketId, worktreePath: session.worktreePath, branch: session.branch })
        effects.push({ kind: 'deletePlaceholderTicket', ticketId: session.ticketId })
      }
      return { session: next(session, { state: 'discarded', coreSessionId: null }, now), effects }
    }
    case 'begin-hand-off': {
      if (session.state === 'handed_off' && session.railIndex === command.railIndex) return { session, effects: [] }
      if (!isOpenFlow(session) || session.step !== null || !session.worktreePath || session.ticketId === null) illegal(session, command)
      if (!Number.isSafeInteger(command.railIndex) || command.railIndex < 0) throw new FlowTransitionError('invalid_command', 'railIndex must be a non-negative integer')
      const effects: FlowEffect[] = []
      if (session.coreSessionId) effects.push({ kind: 'closeAgentSession', coreSessionId: session.coreSessionId })
      effects.push({ kind: 'freezeWorktree' })
      return {
        session: next(session, { state: 'paused', coreSessionId: null, railIndex: command.railIndex, step: 'handoff:freeze' }, now),
        effects,
      }
    }
    case 'frozen':
      if (session.step !== 'handoff:freeze') illegal(session, command)
      return {
        session: next(session, { headSha: command.headSha, step: 'handoff:launch' }, now),
        effects: [{ kind: 'launchRail', railIndex: session.railIndex ?? 0 }],
      }
    case 'handed-off':
      if (session.state === 'handed_off' && session.railIndex === command.railIndex) return { session, effects: [] }
      if (session.step !== 'handoff:launch') illegal(session, command)
      // Invariant: the rail adopts exactly the commit Flow froze.
      if (!session.headSha || session.headSha !== command.headSha) {
        throw new FlowTransitionError('flow_head_mismatch', `The worktree HEAD ${command.headSha} does not match the frozen Flow HEAD ${session.headSha ?? 'none'}`)
      }
      return { session: next(session, { state: 'handed_off', step: null, railIndex: command.railIndex, deliveryId: command.deliveryId }, now), effects: [] }
    case 'adoption-reverted':
      if (session.step === 'handoff:launch') return { session, effects: [] }
      if (session.state !== 'handed_off') illegal(session, command)
      return { session: next(session, { state: 'paused', step: 'handoff:launch', deliveryId: null }, now), effects: [] }
    case 'hand-off-failed':
      if (session.state === 'handed_off') return { session, effects: [] }
      if (!session.step?.startsWith('handoff:')) illegal(session, command)
      return { session: next(session, { state: 'paused', step: null, railIndex: null }, now), effects: [] }
    case 'delivered':
      if (session.state === 'delivered') return { session, effects: [] }
      if (session.state !== 'handed_off') illegal(session, command)
      return {
        session: next(session, { state: 'delivered', deliveryId: command.deliveryId }, now),
        effects: session.ticketId !== null ? [{ kind: 'setTicketFlowState', ticketId: session.ticketId, state: 'delivered' }] : [],
      }
    case 'restart':
      return restart(session, command.worktreePresent, now)
  }
  return illegal(session, command)
}

/** Startup reconciliation (arch section 4.7): complete or compensate unfinished sagas. */
function restart(session: FlowSession, worktreePresent: boolean, now: string): FlowTransition {
  if (isTerminalFlow(session) || session.state === 'handed_off') return { session, effects: [] }
  if (session.step === 'start:ticket' || session.step === 'start:worktree') {
    return { session: next(session, { state: 'discarded', step: null, coreSessionId: null }, now), effects: startCompensation(session) }
  }
  if (!worktreePresent) {
    // Never delete what cannot be proven Flow's: keep the spec and ask the user.
    return { session: next(session, { state: 'needs-review', step: null, coreSessionId: null }, now), effects: [] }
  }
  if (session.state === 'paused' && session.step === null && session.coreSessionId === null) return { session, effects: [] }
  // `start:session`, `handoff:*` or a live session: the agent session never
  // survives a restart and the rail never adopted the worktree (that commit
  // would have left the Flow handed_off). Everything Flow owns is intact.
  const effects: FlowEffect[] = session.ticketId !== null && session.state === 'active'
    ? [{ kind: 'setTicketFlowState', ticketId: session.ticketId, state: 'paused' }]
    : []
  return { session: next(session, { state: 'paused', step: null, coreSessionId: null, ...(session.step?.startsWith('handoff:') ? { railIndex: null } : {}) }, now), effects }
}

/** The conversation already has an open Flow, or the operation conflicts with the Flow's state. */
export class FlowConflictError extends Error {
  constructor(readonly code: string, message: string, readonly flowId: string | null = null) {
    super(message)
    this.name = 'FlowConflictError'
  }
}

export class FlowNotFoundError extends Error {
  readonly code = 'flow_not_found'
  constructor(flowId: string) {
    super(`Flow ${flowId} was not found`)
    this.name = 'FlowNotFoundError'
  }
}

/** The selected Core (or the conversation's provider) cannot run Flow. */
export class FlowUnavailableError extends Error {
  readonly code = 'feature_unavailable'
  constructor(message: string, readonly missing: string[] = []) {
    super(message)
    this.name = 'FlowUnavailableError'
  }
}

export class FlowValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FlowValidationError'
  }
}

/** The rail launch authority refused the hand-off (its status and code are kept). */
export class FlowLaunchRejectedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'FlowLaunchRejectedError'
  }
}
