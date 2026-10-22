import {
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
  placeholderTitle,
  transition,
  type FlowCommand,
  type FlowEffect,
  type FlowSession,
} from './domain'
import type { FlowDiffSummary, FlowLaunchOptions, FlowPorts } from './ports'

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
const BEST_EFFORT: ReadonlySet<FlowEffect['kind']> = new Set(['closeAgentSession', 'setTicketFlowState', 'deletePlaceholderTicket'])

export interface StartFlowInput {
  flowId?: string
  conversationId: string
  idea: string
  title?: string | null
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
      case 'closeAgentSession':
        await ports.agent.close({ flowId: session.id, conversationId: session.conversationId, coreSessionId: effect.coreSessionId })
        return
      case 'releaseWorktree':
        await ports.worktrees.release({ flowId: session.id, ticketId: effect.ticketId, worktreePath: effect.worktreePath, branch: effect.branch })
        return
      case 'deletePlaceholderTicket':
        ports.tickets.deletePlaceholder(effect.ticketId)
        return
      case 'setTicketFlowState':
        ports.tickets.setFlowState(effect.ticketId, effect.state)
        return
      default:
        // Forward saga effects are driven explicitly by their use case.
        throw new FlowTransitionError('invalid_command', `Effect ${effect.kind} is not a settlement effect`)
    }
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
      await assertAvailable()
      await ports.agent.assertReady({ conversationId })

      const flowId = input.flowId ?? ports.ids()
      let session = transition(null, { type: 'start', flowId, conversationId, now: ports.clock.now() }).session
      ports.repository.insert(session)
      ports.notifier.changed(session)
      try {
        const ticketId = ports.tickets.createPlaceholder({
          flowId, conversationId, title: placeholderTitle(idea, input.title), description: idea, startedAt: session.createdAt,
        })
        session = apply(session, { type: 'ticket-created', ticketId, now: ports.clock.now() })
        const reserved = await ports.worktrees.reserve({ flowId, conversationId, ticketId })
        session = apply(session, { type: 'worktree-reserved', ...reserved, now: ports.clock.now() })
        const opened = await ports.agent.open({ flowId, conversationId, worktreePath: reserved.worktreePath })
        return apply(session, { type: 'session-opened', coreSessionId: opened.coreSessionId, now: ports.clock.now() })
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

  function resumeFlow(flowId: string): Promise<FlowSession> {
    return serialized(`flow:${flowId}`, async () => {
      const session = load(flowId)
      const result = transition(session, { type: 'resume', now: ports.clock.now() })
      if (result.effects.length === 0) return session
      await assertAvailable()
      await ports.agent.assertReady({ conversationId: session.conversationId })
      if (!session.worktreePath || !ports.worktrees.exists(session.worktreePath)) {
        throw new FlowConflictError('flow_worktree_missing', 'The Flow worktree no longer exists; review it before continuing', flowId)
      }
      const opened = await ports.agent.open({ flowId, conversationId: session.conversationId, worktreePath: session.worktreePath })
      const resumed = apply(session, { type: 'session-opened', coreSessionId: opened.coreSessionId, now: ports.clock.now() })
      await settle(resumed, result.effects.filter((effect) => effect.kind !== 'openAgentSession'))
      return resumed
    })
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
      return commit(result.session)
    })
  }

  /**
   * Freeze HEAD, close the agent session and launch the rail with the Flow
   * worktree. The rail launch adopts the worktree and marks this Flow
   * `handed_off` in the same SQLite transaction; any failure before that
   * commit reverts the Flow to `paused` with its worktree and spec intact.
   */
  function handOffFlow(input: HandOffFlowInput): Promise<{ flow: FlowSession; loopRunIds: string[]; deliveryId: string | null }> {
    return serialized(`flow:${input.flowId}`, async () => {
      let session = load(input.flowId)
      if (session.state === 'handed_off') {
        if (session.railIndex === input.railIndex) return { flow: session, loopRunIds: [], deliveryId: session.deliveryId }
        throw new FlowConflictError('flow_already_handed_off', `This Flow was handed off to rail ${session.railIndex}`, session.id)
      }
      if (!Number.isSafeInteger(input.railIndex) || input.railIndex < 0) throw new FlowValidationError('invalid_rail_index', 'railIndex must be a non-negative integer')
      await assertAvailable()
      const begun = transition(session, { type: 'begin-hand-off', railIndex: input.railIndex, now: ports.clock.now() })
      session = commit(begun.session)
      try {
        await settle(session, begun.effects.filter((effect) => effect.kind === 'closeAgentSession'))
        const frozen = await ports.worktrees.freeze({ flowId: session.id, conversationId: session.conversationId, ticketId: session.ticketId!, worktreePath: session.worktreePath!, baseSha: session.baseSha })
        session = apply(session, { type: 'frozen', headSha: frozen.headSha, now: ports.clock.now() })
        const launched = await ports.rails.launch({
          flowId: session.id, conversationId: session.conversationId, ticketId: session.ticketId!, railIndex: input.railIndex, options: input.options ?? {},
        })
        const after = load(session.id)
        if (after.state !== 'handed_off') {
          throw new FlowConflictError('flow_handoff_not_adopted', 'The rail launched without adopting the Flow worktree', session.id)
        }
        ports.notifier.changed(after)
        return { flow: after, loopRunIds: launched.loopRunIds, deliveryId: launched.deliveryId ?? after.deliveryId }
      } catch (error) {
        const latest = ports.repository.get(session.id) ?? session
        // A launch that committed the ownership transfer is not rolled back.
        if (latest.state !== 'handed_off') commit(transition(latest, { type: 'hand-off-failed', now: ports.clock.now() }).session)
        throw error
      }
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

  /** A `rail.pr_state` change: settle the Flow whose delivery reached review. */
  async function observeDelivery(deliveryId: string): Promise<FlowSession | null> {
    const session = ports.repository.findByDelivery(deliveryId)
    if (!session || session.state !== 'handed_off') return null
    if (!ports.publication.deliveryState(deliveryId)?.delivered) return null
    return onFlowDelivered({ flowId: session.id, deliveryId })
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
          derived = await ports.publication.derivedChange({ flowId: session.id, deliveryId: session.deliveryId, ticketId, branch: session.branch, baseSha: session.baseSha })
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
      return summarizeSettlement(ports.effects.list(flowId))
    })
  }

  /** Startup replay: settle Flows whose delivery reached review while the app
   * was down, then resume every pending effect. Never throws. */
  async function replaySettlement(): Promise<number> {
    let resumed = 0
    for (const session of ports.repository.listHandedOff()) {
      try {
        if (session.deliveryId && ports.publication.deliveryState(session.deliveryId)?.delivered) {
          await onFlowDelivered({ flowId: session.id, deliveryId: session.deliveryId })
          resumed++
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
  function getByConversation(conversationId: string): FlowSession | null {
    return ports.repository.findOpenByConversation(conversationId) ?? ports.repository.latestByConversation(conversationId)
  }

  async function diffSummary(flowId: string): Promise<FlowDiffSummary> {
    const session = load(flowId)
    if (!session.worktreePath || !isOpenFlow(session) || !ports.worktrees.exists(session.worktreePath)) {
      return { branch: session.branch, baseSha: session.baseSha, headSha: session.headSha, files: [], totals: { files: 0, additions: 0, deletions: 0 } }
    }
    return ports.worktrees.diff({ worktreePath: session.worktreePath, baseSha: session.baseSha, branch: session.branch })
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
    handOffFlow,
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
    diffSummary,
    costSoFar,
    availability: () => ports.availability(),
  }
}

export type FlowService = ReturnType<typeof createFlowService>
