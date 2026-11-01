import {
  buildReturnBriefing,
  buildSpecRewriteText,
  buildSpecSeedBriefing,
  flowJiraUpdateKey,
  isExistingSpecFlow,
  failedAttempt,
  finishedEffect,
  flowJiraCreateKey,
  nextDueEffect,
  plannedSettlementEffects,
  summarizeSettlement,
  type IntentSettlementEffect,
  type IntentSettlementSummary,
  IntentConflictError,
  IntentNotFoundError,
  IntentTransitionError,
  IntentUnavailableError,
  IntentValidationError,
  isOpenFlow,
  nextFlowCoreSessionId,
  placeholderTitle,
  resolveFlowRepository,
  transition,
  withDerivedChange,
  type IntentCommand,
  type IntentEffect,
  type IntentRunFailure,
  type IntentSession,
} from './domain'
import type { IntentBoundary, IntentDiffSummary, IntentLaunchOptions, IntentPorts } from './ports'

/**
 * Intent use cases (imperative shell around the pure state machine). Start and
 * hand-off are short sagas: every step is persisted in `flow_sessions.step`
 * before the next external effect, and a failure compensates in reverse order.
 * Operations on one Intent (and starts on one conversation) are serialized, and
 * every use case is idempotent by `flowId`.
 */

const MAX_IDEA_LENGTH = 20_000
const FLOW_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** Effects whose failure must not mask the user's decision (logged, never thrown). */
const BEST_EFFORT: ReadonlySet<IntentEffect['kind']> = new Set(['stopProcesses', 'closeAgentSession', 'setTicketFlowState', 'deletePlaceholderTicket', 'restoreTicket', 'reopenTicket'])

export interface StartFlowInput {
  flowId?: string
  conversationId: string
  /** The free idea of a new Intent (required unless `ticketId` names a spec). */
  idea?: string
  /** Start from this EXISTING spec: no placeholder; the spec is labelled
   * "In Intent" and seeds the first turn. */
  ticketId?: number
  title?: string | null
  /** The project repository the Intent runs in (the mission agent's triage or
   * the person's pick). Omitted ⇒ the primary when it is Git, else the only
   * Git member; several candidates are refused (`flow_repository_required`). */
  repositoryId?: string | null
}

export interface HandOffFlowInput {
  flowId: string
  railIndex: number
  options?: IntentLaunchOptions
}

export interface IntentCost {
  flowId: string
  costUsd: number
  turns: number
  unpricedTurns: number
  tokensIn: number
  tokensOut: number
}

export function createFlowService(ports: IntentPorts, log: Pick<Console, 'warn'> = console) {
  const queues = new Map<string, Promise<unknown>>()
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    const tail = run.catch(() => undefined)
    queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return run
  }

  function commit(session: IntentSession): IntentSession {
    ports.repository.save(session)
    ports.notifier.changed(session)
    return session
  }

  /** One history boundary of Intent mode (best effort: never fails the transition). */
  function boundary(session: IntentSession, event: IntentBoundary['event'], reason: IntentBoundary['reason']): void {
    try {
      ports.conversation?.postBoundary?.({ conversationId: session.conversationId, flowId: session.id, event, reason, branch: session.branch })
    } catch (error) {
      log.warn(`[flow] boundary row not posted for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function load(flowId: string): IntentSession {
    const session = ports.repository.get(flowId)
    if (!session) throw new IntentNotFoundError(flowId)
    return session
  }

  function apply(session: IntentSession, command: IntentCommand): IntentSession {
    return commit(transition(session, command).session)
  }

  /** Execute effects that only release or annotate (compensations, labels). */
  async function settle(session: IntentSession, effects: IntentEffect[]): Promise<void> {
    for (const effect of effects) {
      try {
        await execute(session, effect)
      } catch (error) {
        if (!BEST_EFFORT.has(effect.kind)) throw error
        log.warn(`[flow] ${effect.kind} failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async function execute(session: IntentSession, effect: IntentEffect): Promise<void> {
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
      case 'restoreTicket':
        ports.tickets.restoreExisting(effect.ticketId, session.id)
        return
      case 'setTicketFlowState':
        ports.tickets.setFlowState(effect.ticketId, effect.state)
        return
      case 'reopenTicket':
        ports.tickets.reopen(effect.ticketId)
        return
      default:
        // Forward saga effects are driven explicitly by their use case.
        throw new IntentTransitionError('invalid_command', `Effect ${effect.kind} is not a settlement effect`)
    }
  }

  /** The repository argument of a worktree/launch call (nothing for the primary). */
  function repositoryOf(session: IntentSession): { repositoryId?: string } {
    return session.repositoryId ? { repositoryId: session.repositoryId } : {}
  }

  async function assertAvailable(): Promise<void> {
    const availability = await ports.availability()
    if (!availability.available) throw new IntentUnavailableError(availability.reason, availability.missing)
  }

  async function startFlow(input: StartFlowInput): Promise<IntentSession> {
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : ''
    if (!conversationId) throw new IntentValidationError('conversation_required', 'conversationId is required')
    const idea = typeof input.idea === 'string' ? input.idea.trim() : ''
    const fromSpec = input.ticketId !== undefined && input.ticketId !== null
    if (fromSpec && (typeof input.ticketId !== 'number' || !Number.isSafeInteger(input.ticketId) || input.ticketId <= 0)) {
      throw new IntentValidationError('invalid_ticket_id', 'ticketId must be a positive integer')
    }
    if (!idea && !fromSpec) throw new IntentValidationError('idea_required', 'Describe the idea to explore')
    if (idea.length > MAX_IDEA_LENGTH) throw new IntentValidationError('idea_too_long', `The idea must be at most ${MAX_IDEA_LENGTH} characters`)
    if (input.flowId !== undefined && !FLOW_ID_RE.test(input.flowId)) throw new IntentValidationError('invalid_flow_id', 'flowId must be 1-64 characters of [A-Za-z0-9-]')

    return serialized(`conversation:${conversationId}`, async () => {
      // Idempotent retry of the same start: return the Intent it created.
      if (input.flowId) {
        const existing = ports.repository.get(input.flowId)
        if (existing) {
          if (existing.conversationId !== conversationId) throw new IntentConflictError('flow_id_conflict', 'This flowId belongs to another conversation', existing.id)
          return existing
        }
      }
      const open = ports.repository.findOpenByConversation(conversationId)
      if (open) throw new IntentConflictError('flow_already_open', 'This conversation already has an Intent session; resume or discard it first', open.id)
      // An existing spec must be free to work on (not done, not in another
      // Intent, not on a rail) BEFORE anything is written.
      const existingTicketId = fromSpec ? input.ticketId as number : null
      const inspected = existingTicketId !== null ? ports.tickets.inspectExisting(existingTicketId) : null
      if (inspected?.blocker) {
        if (inspected.blocker.code === 'spec_not_found') throw new IntentValidationError(inspected.blocker.code, inspected.blocker.message)
        throw new IntentConflictError(inspected.blocker.code, inspected.blocker.message)
      }
      // Target triage before any effect: an unusable choice leaves nothing
      // behind. A spec that targets exactly one repository runs there.
      const specRepositories = inspected?.spec?.repositoryIds ?? []
      const requestedRepository = input.repositoryId ?? (specRepositories.length === 1 ? specRepositories[0] : null)
      const repositoryId = resolveFlowRepository(ports.repositories?.list() ?? [], requestedRepository)
      await assertAvailable()
      await ports.agent.assertReady({ conversationId })

      const flowId = input.flowId ?? ports.ids()
      let session = transition(null, { type: 'start', flowId, conversationId, repositoryId, ticketId: existingTicketId, now: ports.clock.now() }).session
      ports.repository.insert(session)
      ports.notifier.changed(session)
      try {
        if (existingTicketId !== null) {
          // The existing spec is labelled "In Intent" and seeds the first turn.
          const spec = ports.tickets.adoptExisting({ ticketId: existingTicketId, flowId, conversationId, startedAt: session.createdAt })
          session = apply(session, { type: 'ticket-created', ticketId: existingTicketId, briefing: buildSpecSeedBriefing(spec), now: ports.clock.now() })
        } else {
          const ticketId = ports.tickets.createPlaceholder({
            flowId, conversationId, title: placeholderTitle(idea, input.title), description: idea, startedAt: session.createdAt,
            ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
          })
          session = apply(session, { type: 'ticket-created', ticketId, now: ports.clock.now() })
        }
        const reserved = await ports.worktrees.reserve({ flowId, conversationId, ticketId: session.ticketId!, ...repositoryOf(session) })
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

  function pauseFlow(flowId: string): Promise<IntentSession> {
    return serialized(`flow:${flowId}`, async () => {
      const session = load(flowId)
      const result = transition(session, { type: 'pause', now: ports.clock.now() })
      if (result.session === session) return session
      const paused = commit(result.session)
      await settle(session, result.effects)
      return paused
    })
  }

  /** Open the agent session of a paused Intent (caller holds the Intent's serialization). */
  async function resumeSession(flowId: string): Promise<IntentSession> {
    const session = load(flowId)
    const result = transition(session, { type: 'resume', now: ports.clock.now() })
    if (result.effects.length === 0) return session
    await assertAvailable()
    await ports.agent.assertReady({ conversationId: session.conversationId })
    if (!session.worktreePath || !ports.worktrees.exists(session.worktreePath)) {
      throw new IntentConflictError('flow_worktree_missing', 'The Intent worktree no longer exists; review it before continuing', flowId)
    }
    // Pause, hand-off and restart closed the previous Core session: resuming
    // (also after Back to Intent) always opens a new one.
    const opened = await ports.agent.open({ flowId, conversationId: session.conversationId, worktreePath: session.worktreePath, renew: true })
    const resumed = apply(session, { type: 'session-opened', coreSessionId: opened.coreSessionId, now: ports.clock.now() })
    await settle(resumed, result.effects.filter((effect) => effect.kind !== 'openAgentSession'))
    return resumed
  }

  function resumeFlow(flowId: string): Promise<IntentSession> {
    return serialized(`flow:${flowId}`, () => resumeSession(flowId))
  }

  function discardFlow(flowId: string): Promise<IntentSession> {
    return serialized(`flow:${flowId}`, async () => {
      const session = load(flowId)
      const result = transition(session, { type: 'discard', now: ports.clock.now() })
      if (result.session === session) return session
      try {
        await settle(session, result.effects)
      } catch (error) {
        // The worktree survived: the Intent stays open (without a session) so the user can retry.
        if (session.state === 'active') commit({ ...session, state: 'paused', coreSessionId: null, updatedAt: ports.clock.now() })
        throw error
      }
      const discarded = commit(result.session)
      if ((isOpenFlow(session) || session.state === 'needs-review') && discarded.state === 'discarded') boundary(discarded, 'left', 'discarded')
      return discarded
    })
  }

  /** Close a needs-review Intent, keeping its branch (and any worktree left
   * behind): the conversation leaves Intent and the spec loses its label. */
  function closeFlow(flowId: string): Promise<IntentSession> {
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
   * Freeze HEAD, close the agent session and launch the rail with the Intent
   * worktree. The rail launch adopts the worktree and marks this Intent
   * `handed_off` in the same SQLite transaction; any failure before that
   * commit reverts the Intent to `paused` with its worktree and spec intact.
   */
  function handOffFlow(input: HandOffFlowInput): Promise<{ flow: IntentSession; loopRunIds: string[]; deliveryId: string | null }> {
    return serialized(`flow:${input.flowId}`, () => handOff(input))
  }

  /** The hand-off saga (caller holds the Intent's serialization). */
  async function handOff(input: HandOffFlowInput): Promise<{ flow: IntentSession; loopRunIds: string[]; deliveryId: string | null }> {
    let session = load(input.flowId)
    if (session.state === 'handed_off') {
      if (session.railIndex === input.railIndex) return { flow: session, loopRunIds: [], deliveryId: session.deliveryId }
      throw new IntentConflictError('flow_already_handed_off', `This Intent was handed off to rail ${session.railIndex}`, session.id)
    }
    if (!Number.isSafeInteger(input.railIndex) || input.railIndex < 0) throw new IntentValidationError('invalid_rail_index', 'railIndex must be a non-negative integer')
    await assertAvailable()
    const begun = transition(session, { type: 'begin-hand-off', railIndex: input.railIndex, now: ports.clock.now() })
    // The change this Intent's earlier Intent → Spec run derived (recorded at the
    // return, or read from the returned delivery's evidence for Flows returned
    // before it was recorded): the freeze allows it, the run re-derives it.
    const derivedChanges = withDerivedChange(begun.session, returnedDeliveryChange(begun.session))
    session = commit(derivedChanges.length ? { ...begun.session, derivedChanges } : begun.session)
    try {
      await settle(session, begun.effects.filter((effect) => effect.kind === 'stopProcesses' || effect.kind === 'closeAgentSession'))
      const frozen = await ports.worktrees.freeze({ flowId: session.id, conversationId: session.conversationId, ticketId: session.ticketId!, worktreePath: session.worktreePath!, baseSha: session.baseSha, allowedChanges: session.derivedChanges ?? [], ...repositoryOf(session) })
      // A change the Intent's own earlier run left under another name is the
      // Intent's: the next run re-derives it instead of being blocked by it.
      if (frozen.adoptedChange) session = commit({ ...session, derivedChanges: withDerivedChange(session, frozen.adoptedChange) })
      session = apply(session, { type: 'frozen', headSha: frozen.headSha, now: ports.clock.now() })
      const launched = await ports.rails.launch({
        flowId: session.id, conversationId: session.conversationId, ticketId: session.ticketId!, railIndex: input.railIndex, options: input.options ?? {},
        ...repositoryOf(session),
      })
      const after = load(session.id)
      if (after.state !== 'handed_off') {
        throw new IntentConflictError('flow_handoff_not_adopted', 'The rail launched without adopting the Intent worktree', session.id)
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
   * A relaunch runs on what the person uses in the Intent NOW (the conversation's
   * provider/model/effort, as the hand-off card defaults to); the stopped run's
   * engine only when that provider cannot run the loop. The loop is kept.
   */
  function relaunchOptions(conversationId: string, previous: IntentLaunchOptions): IntentLaunchOptions {
    let engine: ReturnType<NonNullable<IntentPorts['agent']['launchEngine']>> = null
    try { engine = ports.agent.launchEngine?.(conversationId) ?? null } catch { engine = null }
    if (!engine?.aiEngine) return previous
    return { ...(previous.loopId ? { loopId: previous.loopId } : {}), ...engine }
  }

  /** The change the Intent's returned delivery derived (null when none, or unreadable). */
  function returnedDeliveryChange(session: IntentSession): string | null {
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
  async function failureOf(deliveryId: string, stopped: ReturnType<IntentPorts['rails']['stoppedDelivery']>): Promise<IntentRunFailure | null> {
    if (stopped?.findings) return null
    let runtime: Awaited<ReturnType<NonNullable<IntentPorts['rails']['runFailure']>>> = null
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

  /** Give the stopped delivery's worktree back to its Intent (caller holds the Intent's serialization). */
  async function returnWorktree(session: IntentSession, deliveryId: string): Promise<{ session: IntentSession; railIndex: number | null; options: IntentLaunchOptions; failure?: IntentRunFailure | null }> {
    if (isOpenFlow(session) && session.deliveryId === deliveryId && session.step === null) return { session, railIndex: null, options: {} }
    if (session.state !== 'handed_off' || session.deliveryId !== deliveryId) {
      throw new IntentConflictError('flow_not_handed_off', 'This Intent is not waiting on that delivery', session.id)
    }
    if (!session.worktreePath || !ports.worktrees.exists(session.worktreePath)) {
      throw new IntentConflictError('flow_worktree_missing', 'The Intent worktree no longer exists; it cannot go back to the Intent', session.id)
    }
    const stopped = ports.rails.stoppedDelivery(deliveryId)
    // Read before the return closes the delivery (its codes are replaced by `returned_to_flow`).
    const failure = await failureOf(deliveryId, stopped)
    const result = transition(session, { type: 'returned', deliveryId, briefing: buildReturnBriefing(stopped?.findings ?? null, stopped?.derivation ?? null, failure), derivedChange: stopped?.derivation?.change ?? null, now: ports.clock.now() })
    // Delivery owns the transaction: its ledger row disappears and this Intent
    // becomes the owner again, or neither happens.
    ports.rails.returnWorktree({
      deliveryId,
      worktreePath: session.worktreePath,
      detail: failure
        ? 'Returned to Intent: the run failed; the worktree is back in its Intent with the error.'
        : 'Returned to Intent: the worktree is back in its Intent for the requested changes.',
      commit: () => ports.repository.save(result.session),
    })
    ports.notifier.changed(result.session)
    boundary(result.session, 'entered', 'returned')
    await settle(result.session, result.effects)
    return { session: result.session, railIndex: stopped?.railIndex ?? null, options: stopped?.options ?? {}, failure }
  }

  function flowOfDelivery(deliveryId: string): IntentSession {
    const session = typeof deliveryId === 'string' && deliveryId ? ports.repository.findByDelivery(deliveryId) : null
    if (!session) throw new IntentNotFoundError(deliveryId)
    return session
  }

  /**
   * Back to Intent: the Intent → Spec run stopped with requested changes. The
   * worktree (intact, with the run's changes) returns from the rail ledger to
   * the Intent, the spec is "In Intent" again and the agent session reopens; the
   * agent receives the review on its next turn. Idempotent by delivery. A
   * session that cannot open (provider, Core) leaves the Intent paused: the
   * ownership already moved and the Intent bar resumes it.
   */
  async function returnToFlow(input: { deliveryId: string }): Promise<IntentSession> {
    const session = flowOfDelivery(input.deliveryId)
    let failure: IntentRunFailure | null | undefined
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
   * Back to Intent, visibly: the card with what the reviewer asked for (or why
   * the run failed), then ONE automatic Intent turn that starts on it (only
   * while the Intent is active — a paused Intent keeps the briefing for the
   * person's next turn). Both are idempotent by delivery; a failure never
   * undoes the return. `failure` undefined ⇒ read again (a repeated return).
   */
  async function announceReturn(session: IntentSession, deliveryId: string, failure?: IntentRunFailure | null): Promise<void> {
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
   * An Intent session → Spec run that failed outright (no review verdict) goes back to
   * its Intent on its own — the same Back to Intent, idempotent by delivery — and
   * the Intent agent receives the failure. A refusal (worktree gone, delivery
   * busy) only logs: the card still offers Back to Intent by hand.
   */
  async function autoReturn(deliveryId: string): Promise<IntentSession | null> {
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
   * Relaunch: run Intent → Spec again on the SAME worktree — the delivery gives
   * it back, then the ordinary hand-off freezes it and launches the same rail
   * with the same launch choices. The new run re-derives the existing change.
   */
  async function relaunchFlow(input: { deliveryId: string }): Promise<{ flow: IntentSession; loopRunIds: string[]; deliveryId: string | null }> {
    const session = flowOfDelivery(input.deliveryId)
    return serialized(`flow:${session.id}`, async () => {
      const current = load(session.id)
      if (current.state === 'handed_off' && current.deliveryId !== input.deliveryId) {
        // Already relaunched: the Intent is on its new delivery.
        return { flow: current, loopRunIds: [], deliveryId: current.deliveryId }
      }
      const stopped = ports.rails.stoppedDelivery(input.deliveryId)
      const returned = await returnWorktree(current, input.deliveryId)
      const railIndex = returned.railIndex ?? stopped?.railIndex ?? null
      if (railIndex === null) throw new IntentConflictError('flow_rail_unknown', 'The rail of the stopped run is unknown; hand off from the Intent bar', session.id)
      return handOff({ flowId: session.id, railIndex, options: relaunchOptions(session.conversationId, { ...(stopped?.options ?? {}), ...returned.options }) })
    })
  }

  /**
   * The active Intent's Core session cannot serve the next turn (Core closed it,
   * or the conversation switched provider): commit a new session id. The caller
   * (the turn) closes the old session itself without aborting the turn and
   * seeds the new one with the conversation. Null when the Intent is not active.
   */
  function renewSession(flowId: string): Promise<IntentSession | null> {
    return serialized(`flow:${flowId}`, async () => {
      const session = ports.repository.get(flowId)
      if (!session || session.state !== 'active' || session.step !== null) return null
      const coreSessionId = nextFlowCoreSessionId(session.id, Date.parse(ports.clock.now()) || Date.now(), session.coreSessionId)
      return apply(session, { type: 'session-renewed', coreSessionId, now: ports.clock.now() })
    })
  }

  /** An Intent session turn carried the return briefing to the agent: clear it. Never throws for an unknown Intent. */
  function briefingDelivered(flowId: string): Promise<IntentSession | null> {
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
  async function onFlowDelivered(input: { flowId: string; deliveryId?: string | null }): Promise<IntentSession> {
    const delivered = await serialized(`flow:${input.flowId}`, async () => {
      const session = load(input.flowId)
      const deliveryId = session.deliveryId ?? input.deliveryId ?? null
      if (!deliveryId) throw new IntentValidationError('delivery_required', 'A delivered Intent needs its delivery id')
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

  /** A `rail.pr_state` change: settle the Intent whose delivery reached review,
   * or take back the worktree of a run that failed outright. Only an Intent session still
   * handed off to THIS delivery reacts (a returned, relaunched, delivered or
   * discarded Intent never does), so repeated broadcasts are no-ops. */
  async function observeDelivery(deliveryId: string): Promise<IntentSession | null> {
    const session = ports.repository.findByDelivery(deliveryId)
    if (!session || session.state !== 'handed_off' || session.deliveryId !== deliveryId) return null
    const state = ports.publication.deliveryState(deliveryId)
    if (state?.delivered) return onFlowDelivered({ flowId: session.id, deliveryId })
    if (state?.crashed) return autoReturn(deliveryId)
    return null
  }

  /** An Intent session rail completed without a PR delivery row (PR delivery off): the
   * run itself is the delivery reference. */
  async function onRailRunCompleted(input: { flowId: string; runId: string }): Promise<IntentSession | null> {
    const session = ports.repository.get(input.flowId)
    if (!session || session.state !== 'handed_off' || session.deliveryId) return null
    return onFlowDelivered({ flowId: session.id, deliveryId: input.runId })
  }

  async function executeEffect(session: IntentSession, effect: IntentSettlementEffect, all: readonly IntentSettlementEffect[]): Promise<IntentSettlementEffect> {
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
        // An Intent session from an existing spec rewrites it ENTIRELY from what was built,
        // but first keeps its current content as a comment: nothing is lost.
        const existingSpec = isExistingSpecFlow(session)
        if (existingSpec) ports.tickets.preserveOriginal(ticketId, session.id)
        const summary = ports.publication.conversationSummary({ conversationId: session.conversationId, ticketId, from: session.createdAt, to: null })
        const result = await ports.publication.rewriteSpec({
          ticketId,
          text: buildSpecRewriteText({ title: ticket.title, derived, summary, ...(existingSpec ? { original: { title: ticket.title, description: ticket.description } } : {}) }),
        })
        if (!result.ok) return failedAttempt(effect, result.error, now, 'rewrite_failed')
        // The rewritten spec now describes the work the Intent did for its addenda
        // (shown to the Intent agent at start): they are applied, like a rail run's.
        ports.tickets.applyAddenda(ticketId, session.id, session.deliveryId ?? session.id)
        return finishedEffect(effect, 'done', now)
      }
      case 'jira-create': {
        if (!ports.publication.jira.connected()) return finishedEffect(effect, 'skipped', now, 'jira_not_connected')
        // A spec that already had its Jira issue before the Intent: update THAT
        // issue (rewritten summary and description), never create a second one.
        if (isExistingSpecFlow(session) && ports.publication.jira.linked(ticketId)) {
          const updated = ports.publication.jira.enqueueUpdate(ticketId, flowJiraUpdateKey(session.id))
          if (updated === 'enqueued') return finishedEffect(effect, 'done', now, 'updated')
          if (updated === 'inactive') return finishedEffect(effect, 'skipped', now, 'jira_not_connected')
          if (updated === 'failed') return failedAttempt(effect, 'The Jira update could not be enqueued', now, 'enqueue_failed')
          // not_linked: the link went away meanwhile — create as for any unlinked spec.
        }
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

  /** Run the due settlement effects of one Intent, in order. Serialized per Intent;
   * a pending effect that is not due yet stops the walk (order is kept). */
  function runSettlement(flowId: string): Promise<IntentSettlementSummary> {
    return serialized(`settle:${flowId}`, async () => {
      const session = load(flowId)
      for (let guard = 0; guard < 16; guard++) {
        const effects = ports.effects.list(flowId)
        const effect = nextDueEffect(effects, ports.clock.now())
        if (!effect) break
        let next: IntentSettlementEffect
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
   * The Intent's closing summary in its conversation, once the spec rewrite and
   * the Jira create settled (done, skipped or failed for good). The Jira
   * review transition may still wait for the issue link: it never holds the
   * summary back. Idempotent by Intent (the conversation dedupes); never throws.
   */
  function announceDelivered(session: IntentSession, summary: IntentSettlementSummary): void {
    const conversation = ports.conversation
    if (!conversation?.postDeliveredSummary || session.state !== 'delivered' || session.ticketId === null) return
    const settled = (status: IntentSettlementSummary['specRewrite']) => status !== null && status !== 'pending'
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
          // return completed) goes back to its Intent now.
          if (await autoReturn(session.deliveryId)) resumed++
        }
      } catch (error) {
        log.warn(`[flow] settlement replay failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return resumed + await runDueSettlements()
  }

  /** Retry tick: run every Intent with pending effects (due ones execute). */
  async function runDueSettlements(): Promise<number> {
    let ran = 0
    for (const flowId of ports.effects.pendingFlowIds()) {
      try { await runSettlement(flowId); ran++ } catch (error) {
        log.warn(`[flow] settlement retry failed for ${flowId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return ran
  }

  /** Packet view: settlement progress of the Intent a delivery belongs to. */
  function settlementForDelivery(deliveryId: string): IntentSettlementSummary | null {
    const session = ports.repository.findByDelivery(deliveryId)
    if (!session) return null
    const effects = ports.effects.list(session.id)
    return effects.length ? summarizeSettlement(effects) : { specRewrite: 'pending', jiraCreate: 'pending', jiraReview: 'pending' }
  }

  /** Startup reconciliation (arch 4.7): never leaves an Intent session mid-saga or `active` without a session. */
  async function reconcile(): Promise<IntentSession[]> {
    const changed: IntentSession[] = []
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

  function getFlow(flowId: string): IntentSession {
    return load(flowId)
  }

  /** The conversation's open Intent, else its latest one (null when it never had an Intent session). */
  /** Conversations currently in Intent mode (open, paused or needing review) — the mission list's mark. */
  function listOpen(): IntentSession[] {
    return ports.repository.listUnsettled().filter((session) => session.state === 'active' || session.state === 'paused' || session.state === 'needs-review')
  }

  function getByConversation(conversationId: string): IntentSession | null {
    return ports.repository.findOpenByConversation(conversationId) ?? ports.repository.latestByConversation(conversationId)
  }

  async function diffSummary(flowId: string): Promise<IntentDiffSummary> {
    const session = load(flowId)
    // Measured against the Intent's base (the reservation SHA): committed (frozen
    // at hand-off) and uncommitted work alike. A handed-off Intent still owns the
    // same changes, so the bar never flashes "0 files" around Back to Intent.
    // A needs-review Intent whose worktree survived still shows what it holds.
    if (!session.worktreePath || !(isOpenFlow(session) || session.state === 'handed_off' || session.state === 'needs-review') || !ports.worktrees.exists(session.worktreePath)) {
      return { branch: session.branch, baseSha: session.baseSha, headSha: session.headSha, files: [], totals: { files: 0, additions: 0, deletions: 0 } }
    }
    return ports.worktrees.diff({ worktreePath: session.worktreePath, baseSha: session.baseSha, branch: session.branch, ...repositoryOf(session) })
  }

  function costSoFar(flowId: string): IntentCost {
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

export type IntentService = ReturnType<typeof createFlowService>
