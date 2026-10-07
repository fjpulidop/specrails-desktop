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
  metadata?: Record<string, unknown>
  onHandle?: (handle: TurnHandle | null) => void
}

/** InvocationResult plus Core's normalized per-turn usage (already a delta). */
export interface CoreInvocationResult extends InvocationResult {
  usage?: NormalisedResult
  /** The Core session turn that settled this user turn (anchors its sub-agents). */
  coreTurnId?: string
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
    const unsubscribers: Array<() => void> = []
    let resolveDone!: (value: CoreInvocationResult) => void
    const done = new Promise<CoreInvocationResult>((resolve) => { resolveDone = resolve })
    const finish = (code: number | null, extra: { error?: string; usage?: Usage } = {}) => {
      if (settled) return
      settled = true
      context.onHandle?.(null)
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      if (extra.error) emit({ kind: 'error', message: extra.error })
      const usage = toNormalised(extra.usage)
      resolveDone({ code, timedOut: false, spawnFailed: false, events, lastResultEvent: null, sessionId: providerRef ?? opts?.sessionId ?? null, stderrTail: '', child: null, ...(usage ? { usage } : {}), ...(turnId ? { coreTurnId: turnId } : {}) })
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
          if (event.inputId !== inputId) return
          if ((event.state === 'queued' || event.state === 'started') && !initialAccepted) {
            initialAccepted = true
            hooks.onInitialInputAccepted?.()
          }
          if ((event.state === 'rejected' || event.state === 'interrupted') && !turnId) finish(1, { error: `The agent did not start this turn (${event.reason ?? event.state}).` })
          return
        case 'turn.started':
          if (event.inputIds.includes(inputId)) turnId = event.turnId
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
      const config = { model: opts?.model, ...(opts?.reasoning_effort ? { effort: String(opts.reasoning_effort) } : {}), ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}), policy: { ...context.policy, mcp: { servers: context.mcpServers, inheritUserScope: context.policy.mcp?.inheritUserScope ?? false } } }
      let snapshot: { lastSeq?: number }
      try {
        snapshot = (await client.request<{ snapshot: { lastSeq: number } }>('session.open', { resume: { sessionId } })).snapshot
        await client.request('session.update', { sessionId, ...config })
      } catch (error) {
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
      hooks.onInputReady?.(createSteerSink(client, sessionId, () => !settled && turnId !== null))
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
      finish(1, { error: error instanceof Error ? error.message : String(error) })
    }
    return done
  }
}

/** Native steering into the running turn of the resident session. */
function createSteerSink(client: SessionHostClient, sessionId: string, turnOpen: () => boolean): LiveInputSink {
  return {
    acceptedReceipt: 'received',
    async send(input, onAccepted) {
      if (!turnOpen()) return false
      await client.request('session.send', {
        sessionId,
        input: { inputId: input.id, text: input.text, delivery: 'steer', ...(input.imagePaths?.length ? { attachments: input.imagePaths.map((path) => ({ kind: 'image', path })) } : {}) },
      })
      // Core journals the input before it reaches the provider: it will never be replayed.
      onAccepted?.()
      return true
    },
  }
}
