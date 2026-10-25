import { randomUUID } from 'node:crypto'

import {
  isSessionRequestError,
  type McpServerSpec,
  type SessionEventEnvelope,
  type SessionHostClient,
  type SessionPolicyInput,
  type Usage,
} from '../../agent-sessions'
import type { InvocationResult } from '../../execution/runtime/spawn-lifecycle'
import type { LiveInputSink, LiveSessionHooks } from '../../../providers/live-session-types'
import type { AdapterEvent, NormalisedResult } from '../../../providers/types'

/** Stop/close for a turn that runs inside a resident Core session (no child process). */
export interface TurnHandle {
  interrupt(): Promise<void>
}

export interface CoreSessionTurnContext {
  /** Core session id; missions use the conversation id (one session per conversation). */
  sessionId: string
  /** Host client for the conversation's scope (already initialized). */
  client: SessionHostClient
  /** Core driver id (the provider id; Core lists it in `initialize`). */
  driver: string
  policy: SessionPolicyInput
  mcpServers: McpServerSpec[]
  /** Provider session to continue when the Core session does not exist yet (pre-Core missions). */
  legacyProviderSessionRef?: string | null
  /** A new session generation (provider switch / closed session): the turn must seed it with the conversation history. */
  freshSession?: boolean
  metadata?: Record<string, unknown>
  /** Appended to the system prompt (e.g. how to delegate sub-agents in this mission). */
  systemPromptAddendum?: string
  /** How mid-turn user input reaches the running turn. `interrupt` (Flow, Core
   * flowSessions) cuts the turn and runs the input next; the runner follows the
   * new turn and reports the summed usage of every turn it covered. */
  inputDelivery?: 'steer' | 'interrupt'
  onHandle?: (handle: TurnHandle | null) => void
}

/** The Core session cannot take this turn: opened by another driver, or closed. Nothing was sent. */
export class SessionDriverMismatchError extends Error {
  readonly code: 'session_driver_mismatch' | 'session_closed'
  constructor(sessionId: string, actual: string | null, expected: string) {
    super(actual ? `Core session ${sessionId} runs on ${actual}, not ${expected}` : `Session ${sessionId} is closed`)
    this.name = 'SessionDriverMismatchError'
    this.code = actual ? 'session_driver_mismatch' : 'session_closed'
  }
}

/** The complete session policy sent to Core (`session.update` replaces policy as a whole). */
export function sessionPolicyFor(context: Pick<CoreSessionTurnContext, 'policy' | 'mcpServers'>): SessionPolicyInput {
  return { ...context.policy, mcp: { servers: context.mcpServers, inheritUserScope: context.policy.mcp?.inheritUserScope ?? false } }
}

/** InvocationResult plus Core's normalized per-turn usage (already a delta). */
export interface CoreInvocationResult extends InvocationResult {
  usage?: NormalisedResult
  /** The Core session turn that settled this user turn (anchors its sub-agents). */
  coreTurnId?: string
  /** A Core error a host can explain to the user (e.g. `policy_unenforceable`). */
  errorCode?: string
}

/** Sum per-turn usage deltas; null stays null only when every side is unknown. */
export function addUsage(a: Usage | null, b: Usage | null | undefined): Usage | null {
  if (!b) return a
  if (!a) return b
  const sum = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0))
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    costUsd: sum(a.costUsd, b.costUsd),
    // One estimated part makes the total an estimate.
    costEstimated: a.costEstimated || b.costEstimated,
    model: b.model ?? a.model,
  }
}

function toNormalised(usage: Usage | null | undefined): NormalisedResult | undefined {
  if (!usage) return undefined
  const result: NormalisedResult = {}
  if (usage.inputTokens !== null) result.tokens_in = usage.inputTokens
  if (usage.outputTokens !== null) result.tokens_out = usage.outputTokens
  if (usage.cacheReadTokens !== null) result.tokens_cache_read = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== null) result.tokens_cache_create = usage.cacheWriteTokens
  // Only billed cost is "native"; Core estimates are re-derived by Desktop's rate cards.
  if (usage.costUsd !== null && !usage.costEstimated) result.total_cost_usd = usage.costUsd
  if (usage.model) result.model = usage.model
  return result
}

/**
 * Runs one mission user turn inside the conversation's resident Core session,
 * honouring the existing live-session runner contract (Liskov substitution for
 * nativeLiveSessionRunner / runAiCliInvocation): the mission manager's queue,
 * steering, receipts, checkpoints and settlement work unchanged. The turn ends
 * when Core completes THIS turn; the session, its sub-agents and the provider
 * process stay alive in Core. Background activity is projected elsewhere.
 */
export function createCoreSessionRunner(context: CoreSessionTurnContext): (hooks: LiveSessionHooks) => Promise<CoreInvocationResult> {
  return async (hooks) => {
    const { client, sessionId } = context
    const opts = hooks.buildOpts
    const events: AdapterEvent[] = []
    const emit = (event: AdapterEvent) => { events.push(event); hooks.onEvent?.(event) }
    const inputId = `in_${randomUUID()}`
    let turnId: string | null = null
    let streamed = ''
    let providerRef: string | null = null
    let initialAccepted = false
    let settled = false
    let lastSeq = 0
    // Interrupt delivery: inputs sent to cut the running turn, and whether the
    // cut turn ended so the runner now follows the correction's turn.
    const pendingInterrupts = new Set<string>()
    let awaitingCorrection = false
    let carriedUsage: Usage | null = null
    const unsubscribers: Array<() => void> = []
    let resolveDone!: (value: CoreInvocationResult) => void
    const done = new Promise<CoreInvocationResult>((resolve) => { resolveDone = resolve })
    const finish = (code: number | null, extra: { error?: string; errorCode?: string; usage?: Usage } = {}) => {
      if (settled) return
      settled = true
      context.onHandle?.(null)
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      if (extra.error) emit({ kind: 'error', message: extra.error })
      const usage = toNormalised(addUsage(carriedUsage, extra.usage))
      resolveDone({ code, timedOut: false, spawnFailed: false, events, lastResultEvent: null, sessionId: providerRef ?? opts?.sessionId ?? null, stderrTail: '', child: null, ...(usage ? { usage } : {}), ...(turnId ? { coreTurnId: turnId } : {}), ...(extra.errorCode ? { errorCode: extra.errorCode } : {}) })
    }

    const apply = (envelope: SessionEventEnvelope) => {
      if (envelope.sessionId !== sessionId || envelope.seq <= lastSeq) return
      lastSeq = envelope.seq
      const event = envelope.event
      switch (event.type) {
        case 'session.provider-ref':
          providerRef = event.providerSessionRef
          emit({ kind: 'session-started', sessionId: event.providerSessionRef })
          return
        case 'input.state':
          if (pendingInterrupts.has(event.inputId)) {
            if (event.state !== 'rejected' && event.state !== 'interrupted') return
            pendingInterrupts.delete(event.inputId)
            if (awaitingCorrection && pendingInterrupts.size === 0) finish(1, { error: `The agent did not take the correction (${event.reason ?? event.state}).` })
            return
          }
          if (event.inputId !== inputId) return
          if ((event.state === 'queued' || event.state === 'started') && !initialAccepted) {
            initialAccepted = true
            hooks.onInitialInputAccepted?.()
          }
          if ((event.state === 'rejected' || event.state === 'interrupted') && !turnId) finish(1, { error: `The agent did not start this turn (${event.reason ?? event.state}).` })
          return
        case 'turn.started':
          if (event.inputIds.includes(inputId)) turnId = event.turnId
          else if (awaitingCorrection && event.inputIds.some((id) => pendingInterrupts.has(id))) {
            // Follow the correction's turn: its output continues this user turn.
            for (const id of event.inputIds) pendingInterrupts.delete(id)
            awaitingCorrection = false
            turnId = event.turnId
            streamed = ''
          }
          return
        case 'turn.output':
          if (event.turnId !== turnId || event.channel !== 'text') return
          streamed += event.delta
          emit({ kind: 'text-delta', text: event.delta })
          return
        case 'turn.tool':
          if (event.turnId !== turnId) return
          if (event.phase === 'started') emit({ kind: 'tool-use', name: event.name, toolUseId: event.toolUseId, inputPreview: event.input === undefined ? '' : JSON.stringify(event.input).slice(0, 1000) })
          else emit({ kind: 'tool-result', toolUseId: event.toolUseId, outputPreview: (event.output ?? '').slice(0, 4000), ...(event.isError ? { isError: true } : {}) })
          return
        case 'turn.completed': {
          if (event.turnId !== turnId) return
          if (pendingInterrupts.size > 0) {
            // Cut by (or finished before) a correction: keep its usage and wait for the correction's turn.
            if (event.status === 'completed' && event.text.startsWith(streamed) && event.text.length > streamed.length) emit({ kind: 'text-delta', text: event.text.slice(streamed.length) })
            carriedUsage = addUsage(carriedUsage, event.usage)
            turnId = null
            awaitingCorrection = true
            return
          }
          // Core's text is authoritative; emit whatever live deltas missed (e.g. after a lag).
          if (event.text.startsWith(streamed) && event.text.length > streamed.length) emit({ kind: 'text-delta', text: event.text.slice(streamed.length) })
          if (event.status === 'completed') finish(0, { usage: event.usage })
          else if (event.status === 'stopped') finish(null, { usage: event.usage })
          else finish(1, { usage: event.usage, error: event.error ?? `The agent turn ${event.status}.` })
          return
        }
        default:
          return
      }
    }

    /** Fill gaps from the journal so the turn's completion is never missed. */
    let catchingUp: Promise<void> | null = null
    const catchUp = async () => {
      if (catchingUp) return catchingUp
      catchingUp = (async () => {
        for (;;) {
          const page = await client.request<{ events: SessionEventEnvelope[]; hasMore: boolean }>('session.events', { sessionId, afterSeq: lastSeq, limit: 500 })
          page.events.forEach(apply)
          if (!page.hasMore || settled) return
        }
      })().finally(() => { catchingUp = null })
      return catchingUp
    }
    unsubscribers.push(
      client.onEvent((envelope) => {
        if (envelope.sessionId !== sessionId || settled) return
        if (envelope.seq > lastSeq + 1 && lastSeq > 0) void catchUp().catch(() => undefined)
        else apply(envelope)
      }),
      client.onLagged((id) => { if (id === sessionId) void catchUp().catch(() => undefined) }),
    )
    // Registered last: a closed client calls back synchronously.
    unsubscribers.push(client.onClose((reason) => finish(1, { error: `The session host stopped: ${reason}` })))

    try {
      // Open or resume the conversation's Core session, then align its configuration.
      const config = { model: opts?.model, ...(opts?.reasoning_effort ? { effort: String(opts.reasoning_effort) } : {}), ...(opts?.systemPrompt || context.systemPromptAddendum ? { systemPrompt: [opts?.systemPrompt, context.systemPromptAddendum].filter(Boolean).join('\n\n') } : {}), policy: sessionPolicyFor(context) }
      let snapshot: { lastSeq?: number; driver?: string; status?: string }
      try {
        snapshot = (await client.request<{ snapshot: { lastSeq: number; driver?: string; status?: string } }>('session.open', { resume: { sessionId } })).snapshot
        // A Core session keeps the driver it was opened with: never send this
        // turn (and this provider's model) to another provider's session.
        if (snapshot?.driver && snapshot.driver !== context.driver) {
          throw new SessionDriverMismatchError(sessionId, snapshot.driver, context.driver)
        }
        if (snapshot?.status === 'closed') throw new SessionDriverMismatchError(sessionId, null, context.driver)
        await client.request('session.update', { sessionId, ...config })
      } catch (error) {
        if (error instanceof SessionDriverMismatchError) throw error
        if (!isSessionRequestError(error, 'session_not_found')) throw error
        snapshot = (await client.request<{ snapshot: { lastSeq: number } }>('session.open', {
          sessionId,
          driver: context.driver,
          cwd: hooks.cwd,
          ...config,
          ...(context.legacyProviderSessionRef ? { providerSessionRef: context.legacyProviderSessionRef } : {}),
          ...(context.metadata ? { metadata: context.metadata } : {}),
        })).snapshot
      }
      lastSeq = snapshot.lastSeq ?? 0

      context.onHandle?.({ interrupt: async () => { await client.request('session.interrupt', { sessionId }).catch(() => undefined) } })
      hooks.onInputReady?.(createSteerSink(client, sessionId, () => !settled && (turnId !== null || awaitingCorrection), context.inputDelivery ?? 'steer', pendingInterrupts))
      await client.request('session.send', {
        sessionId,
        input: {
          inputId,
          text: opts?.prompt ?? '',
          delivery: 'queue',
          ...(opts?.imagePaths?.length ? { attachments: opts.imagePaths.map((path) => ({ kind: 'image', path })) } : {}),
        },
      })
      await catchUp()
    } catch (error) {
      finish(1, { error: error instanceof Error ? error.message : String(error), ...(error instanceof SessionDriverMismatchError ? { errorCode: error.code } : isSessionRequestError(error) && error.code ? { errorCode: error.code } : {}) })
    }
    return done
  }
}

/** Native steering (or Flow interrupt) into the running turn of the resident session. */
function createSteerSink(client: SessionHostClient, sessionId: string, turnOpen: () => boolean, delivery: 'steer' | 'interrupt', pendingInterrupts: Set<string>): LiveInputSink {
  return {
    acceptedReceipt: 'received',
    async send(input, onAccepted) {
      if (!turnOpen()) return false
      // Registered before the request: Core may cut the turn before it answers.
      // Never `session.interrupt` first — the delivery itself cuts the turn.
      if (delivery === 'interrupt') pendingInterrupts.add(input.id)
      try {
        await client.request('session.send', {
          sessionId,
          input: { inputId: input.id, text: input.text, delivery, ...(input.imagePaths?.length ? { attachments: input.imagePaths.map((path) => ({ kind: 'image', path })) } : {}) },
        })
      } catch (error) {
        pendingInterrupts.delete(input.id)
        throw error
      }
      // Core journals the input before it reaches the provider: it will never be replayed.
      onAccepted?.()
      return true
    },
  }
}
