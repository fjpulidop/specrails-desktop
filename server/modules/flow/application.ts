import {
  buildReturnBriefing,
  buildSpecRewriteText,
  failedAttempt,
  finishedEffect,
  flowJiraCreateKey,
  nextDueEffect,
  plannedSettlementEffects,
  summarizeSettlement,
  type FlowSettlementEffect,
  type FlowSettlementSummary,
  FlowConflictError,
  FlowNotFoundError,
  FlowTransitionError,
  FlowUnavailableError,
  FlowValidationError,
  isOpenFlow,
  nextFlowCoreSessionId,
  placeholderTitle,
  resolveFlowRepository,
  transition,
  withDerivedChange,
  type FlowCommand,
  type FlowEffect,
  type FlowRunFailure,
  type FlowSession,
} from './domain'
import type { FlowBoundary, FlowDiffSummary, FlowLaunchOptions, FlowPorts } from './ports'

/**
 * Flow use cases (imperative shell around the pure state machine). Start and
 * hand-off are short sagas: every step is persisted in `flow_sessions.step`
 * before the next external effect, and a failure compensates in reverse order.
 * Operations on one Flow (and starts on one conversation) are serialized, and
 * every use case is idempotent by `flowId`.
 */

const MAX_IDEA_LENGTH = 20_000
const FLOW_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** Effects whose failure must not mask the user's decision (logged, never thrown). */
const BEST_EFFORT: ReadonlySet<FlowEffect['kind']> = new Set(['stopProcesses', 'closeAgentSession', 'setTicketFlowState', 'deletePlaceholderTicket', 'reopenTicket'])

export interface StartFlowInput {
  flowId?: string
  conversationId: string
  idea: string
  title?: string | null
  /** The project repository the Flow runs in (the mission agent's triage or
   * the person's pick). Omitted ⇒ the primary when it is Git, else the only
   * Git member; several candidates are refused (`flow_repository_required`). */
  repositoryId?: string | null
}

export interface HandOffFlowInput {
  flowId: string
  railIndex: number
  options?: FlowLaunchOptions
}

export interface FlowCost {
  flowId: string
  costUsd: number
  turns: number
  unpricedTurns: number
  tokensIn: number
  tokensOut: number
}

export function createFlowService(ports: FlowPorts, log: Pick<Console, 'warn'> = console) {
  const queues = new Map<string, Promise<unknown>>()
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    const tail = run.catch(() => undefined)
    queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return run
  }

  function commit(session: FlowSession): FlowSession {
    ports.repository.save(session)
    ports.notifier.changed(session)
    return session
  }

  /** One history boundary of Flow mode (best effort: never fails the transition). */
  function boundary(session: FlowSession, event: FlowBoundary['event'], reason: FlowBoundary['reason']): void {
    try {
      ports.conversation?.postBoundary?.({ conversationId: session.conversationId, flowId: session.id, event, reason, branch: session.branch })
    } catch (error) {
      log.warn(`[flow] boundary row not posted for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function load(flowId: string): FlowSession {
    const session = ports.repository.get(flowId)
    if (!session) throw new FlowNotFoundError(flowId)
    return session
  }

  function apply(session: FlowSession, command: FlowCommand): FlowSession {
    return commit(transition(session, command).session)
  }

  /** Execute effects that only release or annotate (compensations, labels). */
  async function settle(session: FlowSession, effects: FlowEffect[]): Promise<void> {
    for (const effect of effects) {
      try {
        await execute(session, effect)
      } catch (error) {
        if (!BEST_EFFORT.has(effect.kind)) throw error
        log.warn(`[flow] ${effect.kind} failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async function execute(session: FlowSession, effect: FlowEffect): Promise<void> {
    switch (effect.kind) {
      case 'stopProcesses':
        await ports.processes.stop({ flowId: session.id, conversationId: session.conversationId })
        return
      case 'closeAgentSession':
        await ports.agent.close({ flowId: session.id, conversationId: session.conversationId, coreSessionId: effect.coreSessionId })
        return
      case 'releaseWorktree':
        await ports.worktrees.release({ flowId: session.id, ticketId: effect.ticketId, worktreePath: effect.worktreePath, branch: effect.branch, ...repositoryOf(session) })
        return
      case 'deletePlaceholderTicket':
        ports.tickets.deletePlaceholder(effect.ticketId)
        return
      case 'setTicketFlowState':
        ports.tickets.setFlowState(effect.ticketId, effect.state)
        return
      case 'reopenTicket':
        ports.tickets.reopen(effect.ticketId)
        return
      default:
        // Forward saga effects are driven explicitly by their use case.
        throw new FlowTransitionError('invalid_command', `Effect ${effect.kind} is not a settlement effect`)
    }
  }

  /** The repository argument of a worktree/launch call (nothing for the primary). */
  function repositoryOf(session: FlowSession): { repositoryId?: string } {
    return session.repositoryId ? { repositoryId: session.repositoryId } : {}
  }

  async function assertAvailable(): Promise<void> {
    const availability = await ports.availability()
    if (!availability.available) throw new FlowUnavailableError(availability.reason, availability.missing)
  }

  async function startFlow(input: StartFlowInput): Promise<FlowSession> {
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : ''
    if (!conversationId) throw new FlowValidationError('conversation_required', 'conversationId is required')
    const idea = typeof input.idea === 'string' ? input.idea.trim() : ''
    if (!idea) throw new FlowValidationError('idea_required', 'Describe the idea to explore')
    if (idea.length > MAX_IDEA_LENGTH) throw new FlowValidationError('idea_too_long', `The idea must be at most ${MAX_IDEA_LENGTH} characters`)
    if (input.flowId !== undefined && !FLOW_ID_RE.test(input.flowId)) throw new FlowValidationError('invalid_flow_id', 'flowId must be 1-64 characters of [A-Za-z0-9-]')

    return serialized(`conversation:${conversationId}`, async () => {
      // Idempotent retry of the same start: return the Flow it created.
      if (input.flowId) {
        const existing = ports.repository.get(input.flowId)
        if (existing) {
          if (existing.conversationId !== conversationId) throw new FlowConflictError('flow_id_conflict', 'This flowId belongs to another conversation', existing.id)
          return existing
        }
      }
      const open = ports.repository.findOpenByConversation(conversationId)
      if (open) throw new FlowConflictError('flow_already_open', 'This conversation already has a Flow; resume or discard it first', open.id)
      // Target triage before any effect: an unusable choice leaves nothing behind.
      const repositoryId = resolveFlowRepository(ports.repositories?.list() ?? [], input.repositoryId)
      await assertAvailable()
      await ports.agent.assertReady({ conversationId })

      const flowId = input.flowId ?? ports.ids()
      let session = transition(null, { type: 'start', flowId, conversationId, repositoryId, now: ports.clock.now() }).session
      ports.repository.insert(session)
      ports.notifier.changed(session)
      try {
        const ticketId = ports.tickets.createPlaceholder({
          flowId, conversationId, title: placeholderTitle(idea, input.title), description: idea, startedAt: session.createdAt,
          ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
        })
        session = apply(session, { type: 'ticket-created', ticketId, now: ports.clock.now() })
        const reserved = await ports.worktrees.reserve({ flowId, conversationId, ticketId, ...repositoryOf(session) })
        session = apply(session, { type: 'worktree-reserved', ...reserved, now: ports.clock.now() })
        const opened = await ports.agent.open({ flowId, conversationId, worktreePath: reserved.worktreePath })
        const started = apply(session, { type: 'session-opened', coreSessionId: opened.coreSessionId, now: ports.clock.now() })
        boundary(started, 'entered', 'started')
        return started
      } catch (error) {
        const latest = ports.repository.get(flowId) ?? session
        const failed = transition(latest, { type: 'start-failed', now: ports.clock.now() })
        try {
          await settle(latest, failed.effects)
        } catch (compensationError) {
          // The worktree could not be removed: keep the spec and the row for review.
          log.warn(`[flow] start compensation incomplete for ${flowId}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`)
          commit({ ...failed.session, state: 'needs-review' })
          throw error
        }
        commit(failed.session)
        throw error
      }
    })
  }

  function pauseFlow(flowId: string): Promise<FlowSession> {
    return serialized(`flow:${flowId}`, async () => {
      const session = load(flowId)
      const result = transition(session, { type: 'pause', now: ports.clock.now() })
      if (result.session === session) return session
      const paused = commit(result.session)
      await settle(session, result.effects)
      return paused
    })
  }

  /** Open the agent session of a paused Flow (caller holds the Flow's serialization). */
  async function resumeSession(flowId: string): Promise<FlowSession> {
    const session = load(flowId)
    const result = transition(session, { type: 'resume', now: ports.clock.now() })
    if (result.effects.length === 0) return session
    await assertAvailable()
    await ports.agent.assertReady({ conversationId: session.conversationId })
    if (!session.worktreePath || !ports.worktrees.exists(session.worktreePath)) {
      throw new FlowConflictError('flow_worktree_missing', 'The Flow worktree no longer exists; review it before continuing', flowId)
    }
    // Pause, hand-off and restart closed the previous Core session: resuming
    // (also after Back to Flow) always opens a new one.
    const opened = await ports.agent.open({ flowId, conversationId: session.conversationId, worktreePath: session.worktreePath, renew: true })
    const resumed = apply(session, { type: 'session-opened', coreSessionId: opened.coreSessionId, now: ports.clock.now() })
    await settle(resumed, result.effects.filter((effect) => effect.kind !== 'openAgentSession'))
    return resumed
  }

  function resumeFlow(flowId: string): Promise<FlowSession> {
    return serialized(`flow:${flowId}`, () => resumeSession(flowId))
  }

  function discardFlow(flowId: string): Promise<FlowSession> {
    return serialized(`flow:${flowId}`, async () => {
      const session = load(flowId)
      const result = transition(session, { type: 'discard', now: ports.clock.now() })
      if (result.session === session) return session
      try {
        await settle(session, result.effects)
      } catch (error) {
        // The worktree survived: the Flow stays open (without a session) so the user can retry.
        if (session.state === 'active') commit({ ...session, state: 'paused', coreSessionId: null, updatedAt: ports.clock.now() })
        throw error
      }
      const discarded = commit(result.session)
      if ((isOpenFlow(session) || session.state === 'needs-review') && discarded.state === 'discarded') boundary(discarded, 'left', 'discarded')
      return discarded
    })
  }

  /** Close a needs-review Flow, keeping its branch (and any worktree left
   * behind): the conversation leaves Flow and the spec loses its label. */
  function closeFlow(flowId: string): Promise<FlowSession> {
    return serialized(`flow:${flowId}`, async () => {
      const session = load(flowId)
      const result = transition(session, { type: 'close', now: ports.clock.now() })
      if (result.session === session) return session
      await settle(session, result.effects)
      const closed = commit(result.session)
      boundary(closed, 'left', 'closed')
      return closed
    })
  }

  /**
   * Freeze HEAD, close the agent session and launch the rail with the Flow
   * worktree. The rail launch adopts the worktree and marks this Flow
   * `handed_off` in the same SQLite transaction; any failure before that
   * commit reverts the Flow to `paused` with its worktree and spec intact.
   */
  function handOffFlow(input: HandOffFlowInput): Promise<{ flow: FlowSession; loopRunIds: string[]; deliveryId: string | null }> {
    return serialized(`flow:${input.flowId}`, () => handOff(input))
  }

  /** The hand-off saga (caller holds the Flow's serialization). */
  async function handOff(input: HandOffFlowInput): Promise<{ flow: FlowSession; loopRunIds: string[]; deliveryId: string | null }> {
    let session = load(input.flowId)
    if (session.state === 'handed_off') {
      if (session.railIndex === input.railIndex) return { flow: session, loopRunIds: [], deliveryId: session.deliveryId }
      throw new FlowConflictError('flow_already_handed_off', `This Flow was handed off to rail ${session.railIndex}`, session.id)
    }
    if (!Number.isSafeInteger(input.railIndex) || input.railIndex < 0) throw new FlowValidationError('invalid_rail_index', 'railIndex must be a non-negative integer')
    await assertAvailable()
    const begun = transition(session, { type: 'begin-hand-off', railIndex: input.railIndex, now: ports.clock.now() })
    // The change this Flow's earlier Flow → Spec run derived (recorded at the
    // return, or read from the returned delivery's evidence for Flows returned
    // before it was recorded): the freeze allows it, the run re-derives it.
    const derivedChanges = withDerivedChange(begun.session, returnedDeliveryChange(begun.session))
    session = commit(derivedChanges.length ? { ...begun.session, derivedChanges } : begun.session)
    try {
      await settle(session, begun.effects.filter((effect) => effect.kind === 'stopProcesses' || effect.kind === 'closeAgentSession'))
      const frozen = await ports.worktrees.freeze({ flowId: session.id, conversationId: session.conversationId, ticketId: session.ticketId!, worktreePath: session.worktreePath!, baseSha: session.baseSha, allowedChanges: session.derivedChanges ?? [], ...repositoryOf(session) })
      // A change the Flow's own earlier run left under another name is the
      // Flow's: the next run re-derives it instead of being blocked by it.
      if (frozen.adoptedChange) session = commit({ ...session, derivedChanges: withDerivedChange(session, frozen.adoptedChange) })
      session = apply(session, { type: 'frozen', headSha: frozen.headSha, now: ports.clock.now() })
      const launched = await ports.rails.launch({
        flowId: session.id, conversationId: session.conversationId, ticketId: session.ticketId!, railIndex: input.railIndex, options: input.options ?? {},
        ...repositoryOf(session),
      })
      const after = load(session.id)
      if (after.state !== 'handed_off') {
        throw new FlowConflictError('flow_handoff_not_adopted', 'The rail launched without adopting the Flow worktree', session.id)
      }
      ports.notifier.changed(after)
      boundary(after, 'left', 'handed_off')
      return { flow: after, loopRunIds: launched.loopRunIds, deliveryId: launched.deliveryId ?? after.deliveryId }
    } catch (error) {
      const latest = ports.repository.get(session.id) ?? session
      // A launch that committed the ownership transfer is not rolled back.
      if (latest.state !== 'handed_off') commit(transition(latest, { type: 'hand-off-failed', now: ports.clock.now() }).session)
      throw error
    }
  }

  /**
   * A relaunch runs on what the person uses in the Flow NOW (the conversation's
   * provider/model/effort, as the hand-off card defaults to); the stopped run's
   * engine only when that provider cannot run the loop. The loop is kept.
   */
  function relaunchOptions(conversationId: string, previous: FlowLaunchOptions): FlowLaunchOptions {
    let engine: ReturnType<NonNullable<FlowPorts['agent']['launchEngine']>> = null
    try { engine = ports.agent.launchEngine?.(conversationId) ?? null } catch { engine = null }
    if (!engine?.aiEngine) return previous
    return { ...(previous.loopId ? { loopId: previous.loopId } : {}), ...engine }
  }

  /** The change the Flow's returned delivery derived (null when none, or unreadable). */
  function returnedDeliveryChange(session: FlowSession): string | null {
    if (!session.deliveryId) return null
    try {
      return ports.rails.stoppedDelivery(session.deliveryId)?.derivation?.change ?? null
    } catch {
      return null
    }
  }

  /**
   * Why a stopped delivery failed when it has no review findings: the delivery
   * codes plus the failing step and the runtime's own error. Null for a review
   * outcome (requested changes). Never throws.
   */
  async function failureOf(deliveryId: string, stopped: ReturnType<FlowPorts['rails']['stoppedDelivery']>): Promise<FlowRunFailure | null> {
    if (stopped?.findings) return null
    let runtime: Awaited<ReturnType<NonNullable<FlowPorts['rails']['runFailure']>>> = null
    try { runtime = await ports.rails.runFailure?.(deliveryId) ?? null } catch { runtime = null }
    const base = stopped?.failure ?? null
    if (!base && !runtime) return stopped ? { stepId: null, cause: null, statusCode: null, failureCode: null, statusDetail: null } : null
    return {
      stepId: runtime?.stepId ?? base?.stepId ?? null,
      cause: runtime?.cause ?? base?.cause ?? null,
      statusCode: base?.statusCode ?? null,
      failureCode: base?.failureCode ?? null,
      statusDetail: base?.statusDetail ?? null,
    }
  }

  /** Give the stopped delivery's worktree back to its Flow (caller holds the Flow's serialization). */
  async function returnWorktree(session: FlowSession, deliveryId: string): Promise<{ session: FlowSession; railIndex: number | null; options: FlowLaunchOptions; failure?: FlowRunFailure | null }> {
    if (isOpenFlow(session) && session.deliveryId === deliveryId && session.step === null) return { session, railIndex: null, options: {} }
    if (session.state !== 'handed_off' || session.deliveryId !== deliveryId) {
      throw new FlowConflictError('flow_not_handed_off', 'This Flow is not waiting on that delivery', session.id)
    }
    if (!session.worktreePath || !ports.worktrees.exists(session.worktreePath)) {
      throw new FlowConflictError('flow_worktree_missing', 'The Flow worktree no longer exists; it cannot go back to the Flow', session.id)
    }
    const stopped = ports.rails.stoppedDelivery(deliveryId)
    // Read before the return closes the delivery (its codes are replaced by `returned_to_flow`).
    const failure = await failureOf(deliveryId, stopped)
    const result = transition(session, { type: 'returned', deliveryId, briefing: buildReturnBriefing(stopped?.findings ?? null, stopped?.derivation ?? null, failure), derivedChange: stopped?.derivation?.change ?? null, now: ports.clock.now() })
    // Delivery owns the transaction: its ledger row disappears and this Flow
    // becomes the owner again, or neither happens.
    ports.rails.returnWorktree({
      deliveryId,
      worktreePath: session.worktreePath,
      detail: failure
        ? 'Returned to Flow: the run failed; the worktree is back in its Flow with the error.'
        : 'Returned to Flow: the worktree is back in its Flow for the requested changes.',
      commit: () => ports.repository.save(result.session),
    })
    ports.notifier.changed(result.session)
    boundary(result.session, 'entered', 'returned')
    await settle(result.session, result.effects)
    return { session: result.session, railIndex: stopped?.railIndex ?? null, options: stopped?.options ?? {}, failure }
  }

  function flowOfDelivery(deliveryId: string): FlowSession {
    const session = typeof deliveryId === 'string' && deliveryId ? ports.repository.findByDelivery(deliveryId) : null
    if (!session) throw new FlowNotFoundError(deliveryId)
    return session
  }

  /**
   * Back to Flow: the Flow → Spec run stopped with requested changes. The
   * worktree (intact, with the run's changes) returns from the rail ledger to
   * the Flow, the spec is "In Flow" again and the agent session reopens; the
   * agent receives the review on its next turn. Idempotent by delivery. A
   * session that cannot open (provider, Core) leaves the Flow paused: the
   * ownership already moved and the Flow bar resumes it.
   */
  async function returnToFlow(input: { deliveryId: string }): Promise<FlowSession> {
    const session = flowOfDelivery(input.deliveryId)
    let failure: FlowRunFailure | null | undefined
    const result = await serialized(`flow:${session.id}`, async () => {
      const returned = await returnWorktree(load(session.id), input.deliveryId)
      failure = returned.failure
      if (returned.session.state !== 'paused') return returned.session
      try {
        return await resumeSession(session.id)
      } catch (error) {
        log.warn(`[flow] ${session.id} returned paused; its session did not open: ${error instanceof Error ? error.message : String(error)}`)
        return load(session.id)
      }
    })
    await announceReturn(result, input.deliveryId, failure)
    return result
  }

  /**
   * Back to Flow, visibly: the card with what the reviewer asked for (or why
   * the run failed), then ONE automatic Flow turn that starts on it (only
   * while the Flow is active — a paused Flow keeps the briefing for the
   * person's next turn). Both are idempotent by delivery; a failure never
   * undoes the return. `failure` undefined ⇒ read again (a repeated return).
   */
  async function announceReturn(session: FlowSession, deliveryId: string, failure?: FlowRunFailure | null): Promise<void> {
    const conversation = ports.conversation
    if (!conversation || session.deliveryId !== deliveryId) return
    try {
      const stopped = ports.rails.stoppedDelivery(deliveryId)
      const known = failure === undefined ? await failureOf(deliveryId, stopped) : failure
      conversation.postReturnCard({ conversationId: session.conversationId, flowId: session.id, deliveryId, findings: stopped?.findings ?? null, derivation: stopped?.derivation ?? null, ...(known ? { failure: known } : {}) })
      if (session.state === 'active' && session.returnBriefing) {
        await conversation.startReturnTurn({ conversationId: session.conversationId, flowId: session.id, deliveryId, ...(known ? { failure: known } : {}) })
      }
    } catch (error) {
      log.warn(`[flow] ${session.id} return briefing not announced: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Deliveries whose automatic return is in flight (observer bursts, startup replay). */
  const autoReturning = new Set<string>()

  /**
   * A Flow → Spec run that failed outright (no review verdict) goes back to
   * its Flow on its own — the same Back to Flow, idempotent by delivery — and
   * the Flow agent receives the failure. A refusal (worktree gone, delivery
   * busy) only logs: the card still offers Back to Flow by hand.
   */
  async function autoReturn(deliveryId: string): Promise<FlowSession | null> {
    if (autoReturning.has(deliveryId)) return null
    autoReturning.add(deliveryId)
    try {
      return await returnToFlow({ deliveryId })
    } catch (error) {
      log.warn(`[flow] automatic return of delivery ${deliveryId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      autoReturning.delete(deliveryId)
    }
  }

  /**
   * Relaunch: run Flow → Spec again on the SAME worktree — the delivery gives
   * it back, then the ordinary hand-off freezes it and launches the same rail
   * with the same launch choices. The new run re-derives the existing change.
   */
  async function relaunchFlow(input: { deliveryId: string }): Promise<{ flow: FlowSession; loopRunIds: string[]; deliveryId: string | null }> {
    const session = flowOfDelivery(input.deliveryId)
    return serialized(`flow:${session.id}`, async () => {
      const current = load(session.id)
      if (current.state === 'handed_off' && current.deliveryId !== input.deliveryId) {
        // Already relaunched: the Flow is on its new delivery.
        return { flow: current, loopRunIds: [], deliveryId: current.deliveryId }
      }
      const stopped = ports.rails.stoppedDelivery(input.deliveryId)
      const returned = await returnWorktree(current, input.deliveryId)
      const railIndex = returned.railIndex ?? stopped?.railIndex ?? null
      if (railIndex === null) throw new FlowConflictError('flow_rail_unknown', 'The rail of the stopped run is unknown; hand off from the Flow bar', session.id)
      return handOff({ flowId: session.id, railIndex, options: relaunchOptions(session.conversationId, { ...(stopped?.options ?? {}), ...returned.options }) })
    })
  }

  /**
   * The active Flow's Core session cannot serve the next turn (Core closed it,
   * or the conversation switched provider): commit a new session id. The caller
   * (the turn) closes the old session itself without aborting the turn and
   * seeds the new one with the conversation. Null when the Flow is not active.
   */
  function renewSession(flowId: string): Promise<FlowSession | null> {
    return serialized(`flow:${flowId}`, async () => {
      const session = ports.repository.get(flowId)
      if (!session || session.state !== 'active' || session.step !== null) return null
      const coreSessionId = nextFlowCoreSessionId(session.id, Date.parse(ports.clock.now()) || Date.now(), session.coreSessionId)
      return apply(session, { type: 'session-renewed', coreSessionId, now: ports.clock.now() })
    })
  }

  /** A Flow turn carried the return briefing to the agent: clear it. Never throws for an unknown Flow. */
  function briefingDelivered(flowId: string): Promise<FlowSession | null> {
    return serialized(`flow:${flowId}`, async () => {
      const session = ports.repository.get(flowId)
      if (!session) return null
      const result = transition(session, { type: 'briefing-delivered', now: ports.clock.now() })
      return result.session === session ? session : commit(result.session)
    })
  }

  /**
   * Delivery settled (reached review): record `delivered`, label the spec
   * delivered and enqueue the durable settlement effects (arch 4.6). The
   * effects then run in the background, in order; their failure never
   * reverts the delivery. Idempotent by flowId.
   */
  async function onFlowDelivered(input: { flowId: string; deliveryId?: string | null }): Promise<FlowSession> {
    const delivered = await serialized(`flow:${input.flowId}`, async () => {
      const session = load(input.flowId)
      const deliveryId = session.deliveryId ?? input.deliveryId ?? null
      if (!deliveryId) throw new FlowValidationError('delivery_required', 'A delivered Flow needs its delivery id')
      const result = transition(session, { type: 'delivered', deliveryId, now: ports.clock.now() })
      let current = session
      if (result.session !== session) {
        current = commit(result.session)
        await settle(current, result.effects)
      }
      if (current.state === 'delivered') ports.effects.enqueue(plannedSettlementEffects(current.id, ports.clock.now()))
      return current
    })
    void runSettlement(delivered.id).catch((error) => log.warn(`[flow] settlement of ${delivered.id} failed: ${error instanceof Error ? error.message : String(error)}`))
    return delivered
  }

  /** A `rail.pr_state` change: settle the Flow whose delivery reached review,
   * or take back the worktree of a run that failed outright. Only a Flow still
   * handed off to THIS delivery reacts (a returned, relaunched, delivered or
   * discarded Flow never does), so repeated broadcasts are no-ops. */
  async function observeDelivery(deliveryId: string): Promise<FlowSession | null> {
    const session = ports.repository.findByDelivery(deliveryId)
    if (!session || session.state !== 'handed_off' || session.deliveryId !== deliveryId) return null
    const state = ports.publication.deliveryState(deliveryId)
    if (state?.delivered) return onFlowDelivered({ flowId: session.id, deliveryId })
    if (state?.crashed) return autoReturn(deliveryId)
    return null
  }

  /** A Flow rail completed without a PR delivery row (PR delivery off): the
   * run itself is the delivery reference. */
  async function onRailRunCompleted(input: { flowId: string; runId: string }): Promise<FlowSession | null> {
    const session = ports.repository.get(input.flowId)
    if (!session || session.state !== 'handed_off' || session.deliveryId) return null
    return onFlowDelivered({ flowId: session.id, deliveryId: input.runId })
  }

  async function executeEffect(session: FlowSession, effect: FlowSettlementEffect, all: readonly FlowSettlementEffect[]): Promise<FlowSettlementEffect> {
    const now = ports.clock.now()
    const ticketId = session.ticketId
    if (ticketId === null) return finishedEffect(effect, 'skipped', now, 'ticket_missing')
    switch (effect.kind) {
      case 'rewrite-spec': {
        let derived
        try {
          derived = await ports.publication.derivedChange({ flowId: session.id, deliveryId: session.deliveryId, ticketId, branch: session.branch, baseSha: session.baseSha, ...repositoryOf(session) })
        } catch (error) {
          // Label and change name never wait for Git: the delivery is real.
          ports.tickets.markDelivered(ticketId, { openspecChangeName: null })
          return failedAttempt(effect, error instanceof Error ? error.message : String(error), now, 'derived_change_unreadable')
        }
        ports.tickets.markDelivered(ticketId, { openspecChangeName: derived.changeName })
        if (!derived.proposal?.trim() && !derived.design?.trim()) return failedAttempt(effect, 'The derived OpenSpec change was not found on the delivered branch', now, 'derived_change_missing')
        const ticket = ports.tickets.read(ticketId)
        if (!ticket) return finishedEffect(effect, 'skipped', now, 'ticket_missing')
        const summary = ports.publication.conversationSummary({ conversationId: session.conversationId, ticketId, from: session.createdAt, to: null })
        const result = await ports.publication.rewriteSpec({ ticketId, text: buildSpecRewriteText({ title: ticket.title, derived, summary }) })
        return result.ok ? finishedEffect(effect, 'done', now) : failedAttempt(effect, result.error, now, 'rewrite_failed')
      }
      case 'jira-create': {
        if (!ports.publication.jira.connected()) return finishedEffect(effect, 'skipped', now, 'jira_not_connected')
        const outcome = ports.publication.jira.enqueueCreate(ticketId, flowJiraCreateKey(session.id))
        if (outcome === 'enqueued' || outcome === 'already_linked') return finishedEffect(effect, 'done', now, outcome)
        if (outcome === 'inactive') return finishedEffect(effect, 'skipped', now, 'jira_not_connected')
        return failedAttempt(effect, 'The Jira create could not be enqueued', now, 'enqueue_failed')
      }
      case 'jira-review': {
        const create = all.find((candidate) => candidate.kind === 'jira-create')
        if (create && create.status !== 'done') return finishedEffect(effect, 'skipped', now, 'no_jira_issue')
        if (!ports.publication.jira.linked(ticketId)) return failedAttempt(effect, 'Waiting for the Jira issue to be created', now, 'awaiting_issue')
        ports.publication.jira.enqueueReview(ticketId, session.deliveryId ?? session.id)
        return finishedEffect(effect, 'done', now)
      }
    }
  }

  /** Run the due settlement effects of one Flow, in order. Serialized per Flow;
   * a pending effect that is not due yet stops the walk (order is kept). */
  function runSettlement(flowId: string): Promise<FlowSettlementSummary> {
    return serialized(`settle:${flowId}`, async () => {
      const session = load(flowId)
      for (let guard = 0; guard < 16; guard++) {
        const effects = ports.effects.list(flowId)
        const effect = nextDueEffect(effects, ports.clock.now())
        if (!effect) break
        let next: FlowSettlementEffect
        try {
          next = await executeEffect(session, effect, effects)
        } catch (error) {
          next = failedAttempt(effect, error instanceof Error ? error.message : String(error), ports.clock.now())
        }
        ports.effects.save(next)
        if (next.status !== 'pending') ports.notifier.changed(load(flowId))
      }
      const summary = summarizeSettlement(ports.effects.list(flowId))
      announceDelivered(session, summary)
      return summary
    })
  }

  /**
   * The Flow's closing summary in its conversation, once the spec rewrite and
   * the Jira create settled (done, skipped or failed for good). The Jira
   * review transition may still wait for the issue link: it never holds the
   * summary back. Idempotent by Flow (the conversation dedupes); never throws.
   */
  function announceDelivered(session: FlowSession, summary: FlowSettlementSummary): void {
    const conversation = ports.conversation
    if (!conversation?.postDeliveredSummary || session.state !== 'delivered' || session.ticketId === null) return
    const settled = (status: FlowSettlementSummary['specRewrite']) => status !== null && status !== 'pending'
    if (!settled(summary.specRewrite) || !settled(summary.jiraCreate)) return
    try {
      conversation.postDeliveredSummary({ conversationId: session.conversationId, flowId: session.id, deliveryId: session.deliveryId, ticketId: session.ticketId, settlement: summary })
    } catch (error) {
      log.warn(`[flow] ${session.id} closing summary not posted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Startup replay: settle Flows whose delivery reached review while the app
   * was down, return the ones whose run failed outright, then resume every
   * pending effect. Never throws. */
  async function replaySettlement(): Promise<number> {
    let resumed = 0
    for (const session of ports.repository.listHandedOff()) {
      try {
        const state = session.deliveryId ? ports.publication.deliveryState(session.deliveryId) : null
        if (session.deliveryId && state?.delivered) {
          await onFlowDelivered({ flowId: session.id, deliveryId: session.deliveryId })
          resumed++
        } else if (session.deliveryId && state?.crashed) {
          // A run that failed while the app was down (or before its automatic
          // return completed) goes back to its Flow now.
          if (await autoReturn(session.deliveryId)) resumed++
        }
      } catch (error) {
        log.warn(`[flow] settlement replay failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return resumed + await runDueSettlements()
  }

  /** Retry tick: run every Flow with pending effects (due ones execute). */
  async function runDueSettlements(): Promise<number> {
    let ran = 0
    for (const flowId of ports.effects.pendingFlowIds()) {
      try { await runSettlement(flowId); ran++ } catch (error) {
        log.warn(`[flow] settlement retry failed for ${flowId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return ran
  }

  /** Packet view: settlement progress of the Flow a delivery belongs to. */
  function settlementForDelivery(deliveryId: string): FlowSettlementSummary | null {
    const session = ports.repository.findByDelivery(deliveryId)
    if (!session) return null
    const effects = ports.effects.list(session.id)
    return effects.length ? summarizeSettlement(effects) : { specRewrite: 'pending', jiraCreate: 'pending', jiraReview: 'pending' }
  }

  /** Startup reconciliation (arch 4.7): never leaves a Flow mid-saga or `active` without a session. */
  async function reconcile(): Promise<FlowSession[]> {
    const changed: FlowSession[] = []
    for (const session of ports.repository.listUnsettled()) {
      try {
        const worktreePresent = session.worktreePath ? ports.worktrees.exists(session.worktreePath) : false
        const result = transition(session, { type: 'restart', worktreePresent, now: ports.clock.now() })
        if (result.session === session) continue
        try {
          await settle(session, result.effects)
        } catch (error) {
          log.warn(`[flow] reconciliation could not compensate ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
          changed.push(commit({ ...result.session, state: 'needs-review' }))
          continue
        }
        changed.push(commit(result.session))
      } catch (error) {
        log.warn(`[flow] reconciliation failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return changed
  }

  function getFlow(flowId: string): FlowSession {
    return load(flowId)
  }

  /** The conversation's open Flow, else its latest one (null when it never had a Flow). */
  /** Conversations currently in Flow mode (open, paused or needing review) — the mission list's mark. */
  function listOpen(): FlowSession[] {
    return ports.repository.listUnsettled().filter((session) => session.state === 'active' || session.state === 'paused' || session.state === 'needs-review')
  }

  function getByConversation(conversationId: string): FlowSession | null {
    return ports.repository.findOpenByConversation(conversationId) ?? ports.repository.latestByConversation(conversationId)
  }

  async function diffSummary(flowId: string): Promise<FlowDiffSummary> {
    const session = load(flowId)
    // Measured against the Flow's base (the reservation SHA): committed (frozen
    // at hand-off) and uncommitted work alike. A handed-off Flow still owns the
    // same changes, so the bar never flashes "0 files" around Back to Flow.
    // A needs-review Flow whose worktree survived still shows what it holds.
    if (!session.worktreePath || !(isOpenFlow(session) || session.state === 'handed_off' || session.state === 'needs-review') || !ports.worktrees.exists(session.worktreePath)) {
      return { branch: session.branch, baseSha: session.baseSha, headSha: session.headSha, files: [], totals: { files: 0, additions: 0, deletions: 0 } }
    }
    return ports.worktrees.diff({ worktreePath: session.worktreePath, baseSha: session.baseSha, branch: session.branch, ...repositoryOf(session) })
  }

  function costSoFar(flowId: string): FlowCost {
    const session = load(flowId)
    const to = isOpenFlow(session) ? null : session.updatedAt
    return { flowId, ...ports.usage.costSoFar({ conversationId: session.conversationId, from: session.createdAt, to }) }
  }

  return {
    startFlow,
    pauseFlow,
    resumeFlow,
    discardFlow,
    closeFlow,
    handOffFlow,
    returnToFlow,
    relaunchFlow,
    briefingDelivered,
    renewSession,
    onFlowDelivered,
    observeDelivery,
    onRailRunCompleted,
    runSettlement,
    replaySettlement,
    runDueSettlements,
    settlementForDelivery,
    reconcile,
    getFlow,
    getByConversation,
    listOpen,
    diffSummary,
    costSoFar,
    availability: () => ports.availability(),
  }
}

export type FlowService = ReturnType<typeof createFlowService>
