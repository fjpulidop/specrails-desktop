import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import { tmpdir } from 'os'
import path from 'node:path'
import treeKill from 'tree-kill'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import {
  defaultReasoningEffortForModel,
  getAdapter,
  isModelAvailableForAdapter,
  reasoningEffortsForModel,
} from './providers'
import { buildProviderEnv, parseStreamEvents, pureOutputToolPolicy } from './providers/runtime'
import type { ReasoningEffort, AdapterEvent, ProviderAdapter } from './providers/types'
import { runAiCliInvocation } from './spawn-lifecycle'
import { spawnAiCli } from './util/cli-prompt'
import { finaliseInvocationResult } from './result-event'
import { recordAgentInvocation, type AgentInvocationStatus } from './desktop-db'
import { ensureAgentConversationCwd, ensureAgentCwd } from './agent-cwd-manager'
import { OPERATOR_SYSTEM_PROMPT } from './agent-operator-prompt'
import { prepareAgentMcp, removeAgentCapabilityFile } from './agent-mcp-config'
import { resolveExternalEntries } from './external-mcp'
import { normalizeLevel, type AgentTierLevel } from './agent-tier'
import { mintAgentCapability, revokeAgentCapability } from './mcp/agent-capability'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import {
  buildResolvedAgentContextBlock,
  type AgentContextReference,
  type AgentContextRegistry,
} from './agent-context-resolver'
import {
  getAgentConversation,
  addAgentMessage,
  updateAgentConversation,
  listAgentMessages,
  findAgentSystemMessages,
  deleteAgentMessagesByIds,
  updateAgentMessageContent,
} from './agent-store'
import type { PrDecisionCardEnvelope } from './types'
import { generateAutoTitle } from './explore-draft-title'

export type { AgentContextReference } from './agent-context-resolver'

/**
 * Providers report an expired or foreign resume token as a normalized error.
 * Those errors are safe to recover from by clearing the token and retrying the
 * same turn once; every other provider error remains terminal.
 */
function isStaleResumeError(message: string | null): boolean {
  if (!message) return false
  return (
    /no rollout found for thread id/i.test(message) ||
    /unknown (?:session|thread)(?: id)?\b/i.test(message) ||
    /(?:session|thread)(?: id)?\b[^\n]{0,160}\b(?:not found|does not exist)\b/i.test(message)
  )
}

// ─── AgentChatManager (design D1) ─────────────────────────────────────────────
//
// App-level sibling of ChatManager: spawns an AI CLI from the app-owned agent cwd
// with the Specrails MCP bridge as its tool source, streams the turn over the
// app-global `agent_*` WS events (no projectId — fans to all subscribers), and
// persists to the app registry DB. It reuses the shared spawn→stream→settle core
// (runAiCliInvocation) rather than re-implementing ChatManager's loop.

export interface AgentTurnOptions {
  tierLevel?: AgentTierLevel
  model?: string
  attachmentIds?: string[]
  contextRefs?: AgentContextReference[]
  /** Client-generated correlation id echoed on agent_queued / agent_dequeued. */
  queueId?: string | null
}

interface QueuedTurn {
  queueId: string | null
  text: string
  options: AgentTurnOptions
}

export class AgentChatManager {
  private readonly _broadcast: (msg: WsMessage) => void
  private readonly _db: DbInstance
  private readonly _port: number
  private readonly _registry: AgentContextRegistry | null
  private readonly _active = new Map<string, ChildProcess>()
  /** Conversations with a turn in-flight but not yet spawned. Closes the TOCTOU
   *  window the attachment-extraction await opens between the busy guard and
   *  `_active.set` in onSpawn (mirrors ChatManager's reservation pattern). */
  private readonly _reserved = new Set<string>()
  /** Messages sent while a turn was in flight — drained FIFO after it settles. */
  private readonly _queue = new Map<string, QueuedTurn[]>()
  /** Conversations whose in-flight turn the user deliberately stopped. Consulted
   *  at settle so an abort is never mistaken for a stale session (auto-heal
   *  would resurrect the aborted prompt) nor surfaced as an error. */
  private readonly _abortedTurns = new Set<string>()
  /** Fire-and-forget auxiliary children (the AI title spawn) tracked so
   *  shutdown() can tree-kill them instead of orphaning them. Self-removed on
   *  'close'/'error'. */
  private readonly _auxProcesses = new Set<ChildProcess>()
  private readonly _auxReaders = new Map<ChildProcess, ReturnType<typeof createInterface>>()
  private readonly _terminationTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>()
  private readonly _turnStartedAt = new Map<string, string>()
  private _turnSnapshotVersion = 0
  /** Permanent lifecycle gate: the app DB may be closed immediately after
   * shutdown, so no delayed turn/title/card callback may touch it afterwards. */
  private _disposed = false
  private _resolveDisposed!: () => void
  private readonly _disposedSignal = new Promise<void>((resolve) => {
    this._resolveDisposed = resolve
  })

  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance, port: number, registry?: AgentContextRegistry | null) {
    this._broadcast = broadcast
    this._db = db
    this._port = port
    this._registry = registry ?? null
  }

  private async _awaitWhileLive<T>(work: Promise<T>): Promise<
    { disposed: true } | { disposed: false; value: T }
  > {
    if (this._disposed) return { disposed: true }
    return Promise.race([
      work.then((value) => ({ disposed: false as const, value })),
      this._disposedSignal.then(() => ({ disposed: true as const })),
    ])
  }

  /** Own a dedicated POSIX process group so descendants remain killable after
   * the root CLI exits. Windows tree termination is provided by taskkill /T /F. */
  private _spawnOwned(binary: string, args: string[], options: NodeSpawnOptions = {}): ChildProcess {
    if (process.platform === 'win32') return spawnAiCli(binary, args, options)
    return spawnAiCli(binary, args, { ...options, detached: true })
  }

  private _terminate(child: ChildProcess): void {
    if (this._terminationTimers.has(child)) return
    try {
      if (!child.pid) {
        child.kill('SIGTERM')
        return
      }
      const pid = child.pid
      treeKill(pid, 'SIGTERM')
      const timer = setTimeout(() => {
        if (this._terminationTimers.get(child) !== timer || child.pid !== pid) return
        this._terminationTimers.delete(child)
        if (process.platform !== 'win32') {
          try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
        } else {
          try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
        }
      }, 2000)
      timer.unref?.()
      this._terminationTimers.set(child, timer)
      child.once('close', () => {
        const pending = this._terminationTimers.get(child)
        if (pending) clearTimeout(pending)
        this._terminationTimers.delete(child)
      })
    } catch {
      /* already gone */
    }
  }

  private _closeChildIo(child: ChildProcess): void {
    try { child.stdin?.destroy() } catch { /* best-effort */ }
    try { child.stdout?.destroy() } catch { /* best-effort */ }
    try { child.stderr?.destroy() } catch { /* best-effort */ }
  }

  /** True while a turn is streaming for this conversation. */
  isStreaming(conversationId: string): boolean {
    return !this._disposed && this._active.has(conversationId)
  }

  /** True while a turn is in flight (spawned or reserved) — a send now queues. */
  isBusy(conversationId: string): boolean {
    return !this._disposed && (this._active.has(conversationId) || this._reserved.has(conversationId))
  }

  activeTurns(): { snapshotVersion: number; capturedAt: string; turns: Array<{ conversationId: string; startedAt: string }> } {
    return {
      snapshotVersion: this._turnSnapshotVersion,
      capturedAt: new Date().toISOString(),
      turns: [...this._turnStartedAt].map(([conversationId, startedAt]) => ({ conversationId, startedAt })),
    }
  }

  private _startLifecycle(conversationId: string): void {
    const startedAt = new Date().toISOString()
    this._turnStartedAt.set(conversationId, startedAt)
    this._turnSnapshotVersion += 1
    console.info('[agent-chat] lifecycle', JSON.stringify({ conversationId, state: 'active', startedAt }))
  }

  private _settleLifecycle(conversationId: string, state: 'terminal' | 'aborted' | 'interrupted'): void {
    if (!this._turnStartedAt.delete(conversationId)) return
    this._turnSnapshotVersion += 1
    console.info('[agent-chat] lifecycle', JSON.stringify({ conversationId, state, settledAt: new Date().toISOString() }))
  }

  /**
   * Runs one agent turn: persists the user message, spawns the AI CLI pointed at
   * the Specrails MCP, streams deltas + tool-use as `agent_*` events, then
   * persists the assistant reply and the session id. Settles once.
   *
   * A send while a turn is in flight is QUEUED (never rejected): the busy check
   * and the enqueue are synchronous (before any await), so the router's isBusy
   * read in the same event-loop frame is consistent with what happens here.
   * Queued turns drain FIFO after the current turn settles; abort discards them.
   */
  async sendMessage(conversationId: string, userText: string, options: AgentTurnOptions = {}): Promise<void> {
    if (this._disposed) return
    const conversation = getAgentConversation(this._db, conversationId)
    if (!conversation) {
      this._emitError(conversationId, 'Unknown conversation')
      return
    }
    if (this.isBusy(conversationId)) {
      const pending = this._queue.get(conversationId) ?? []
      const queueId = options.queueId ?? null
      pending.push({ queueId, text: userText, options })
      this._queue.set(conversationId, pending)
      this._broadcast({
        type: 'agent_queued',
        conversationId,
        queueId,
        text: userText,
        contextRefs: options.contextRefs ?? [],
        position: pending.length,
        timestamp: new Date().toISOString(),
      })
      return
    }
    this._reserved.add(conversationId)
    try {
      await this._runTurnSafely(conversation, userText, options)
      // Drain messages queued while we were running. Each drained turn re-reads
      // the conversation row so a mid-flight tier/provider/model change applies.
      for (;;) {
        if (this._disposed) break
        const pending = this._queue.get(conversationId)
        const next = pending?.shift()
        if (!next) break
        if (pending && pending.length === 0) this._queue.delete(conversationId)
        const conv = getAgentConversation(this._db, conversationId)
        if (!conv) break // deleted mid-drain (abort() already cleared the queue)
        if (this._disposed) break
        this._broadcast({
          type: 'agent_dequeued',
          conversationId,
          queueId: next.queueId,
          text: next.text,
          contextRefs: next.options.contextRefs ?? [],
          timestamp: new Date().toISOString(),
        })
        await this._runTurnSafely(conv, next.text, next.options)
      }
    } finally {
      this._reserved.delete(conversationId)
      this._abortedTurns.delete(conversationId)
    }
  }

  /** One turn that can never break the drain loop (or leave the client hung
   *  streaming): an unexpected throw surfaces as agent_error instead. */
  private async _runTurnSafely(
    conversation: NonNullable<ReturnType<typeof getAgentConversation>>,
    userText: string,
    options: AgentTurnOptions,
  ): Promise<void> {
    this._startLifecycle(conversation.id)
    try {
      await this._runTurn(conversation, userText, options)
    } catch (err) {
      if (this._disposed) return
      console.error(`[agent-chat] turn failed (${conversation.id}):`, err)
      this._emitError(conversation.id, err instanceof Error ? err.message : 'The agent turn failed.')
    } finally {
      this._settleLifecycle(conversation.id, this._abortedTurns.has(conversation.id) ? 'aborted' : 'terminal')
    }
  }

  private async _runTurn(
    conversation: NonNullable<ReturnType<typeof getAgentConversation>>,
    userText: string,
    options: AgentTurnOptions,
  ): Promise<void> {
    if (this._disposed) return
    const conversationId = conversation.id
    const tierLevel = normalizeLevel(options.tierLevel ?? conversation.tier_level)
    const adapter = getAdapter(conversation.provider)
    // Resolve a model that is VALID for this provider. A stale model from another
    // provider (e.g. claude's "sonnet" after switching to codex) is rejected by
    // the provider — fall back to the provider's default instead of failing.
    const requested = options.model || conversation.model
    const model = requested && isModelAvailableForAdapter(adapter, requested)
      ? requested
      : adapter.defaultModel()
    // Reasoning effort is model-scoped. A stale value from a previous model is
    // discarded and the default is selected from the effective model's exact
    // catalog (K3 follows its native high default; other Kimi models expose no
    // per-invocation knob).
    const efforts = reasoningEffortsForModel(adapter, model) as readonly string[]
    const storedEffort = conversation.reasoning_effort
    const reasoningEffort = efforts.length
      ? ((storedEffort && efforts.includes(storedEffort)
          ? storedEffort
          : defaultReasoningEffortForModel(adapter, model)) as ReasoningEffort)
      : undefined

    // Resolve attachments (conversation-keyed) into extracted text blocks +
    // absolute image paths. Extraction failure degrades to a text-only turn.
    const attachmentIds = options.attachmentIds ?? []
    let userWithAttachments = userText
    let imagePaths: string[] = []
    let hasAttachments = false
    if (attachmentIds.length > 0) {
      try {
        const attachmentResult = await this._awaitWhileLive(
          attachmentManager.getClaudeArgsAgent(conversationId, attachmentIds),
        )
        if (attachmentResult.disposed) return
        const resolved = attachmentResult.value
        if (resolved.textBlocks.length > 0) {
          userWithAttachments = `${userText}\n\n## Attached Resources\n\n${resolved.textBlocks.join('\n\n')}`
          hasAttachments = true
        }
        imagePaths = resolved.imagePaths
      } catch (err) {
        if (this._disposed) return
        console.error(`[agent-chat] attachment extraction failed (${conversationId}):`, err)
      }
    }
    if (this._disposed) return
    const contextBlock = buildResolvedAgentContextBlock(options.contextRefs ?? [], {
      desktopDb: this._db,
      registry: this._registry,
      fallbackProjectId: conversation.pinned_project_id ?? null,
    })
    if (contextBlock) {
      userWithAttachments = `${userWithAttachments}\n\n${contextBlock}`
    }

    // The conversation may have been deleted while attachments were extracting
    // (DELETE aborts the child and drops the row) — inserting would violate the FK.
    if (!getAgentConversation(this._db, conversationId)) return
    addAgentMessage(this._db, { conversationId, role: 'user', content: userText, attachmentIds, contextRefs: options.contextRefs })
    this._autoTitle(conversationId, conversation.title)

    // Providers WITHOUT a --system-prompt flag (codex, gemini) drop opts.systemPrompt
    // for chat turns, so the attachment prompt-injection note would never reach them —
    // fold it into the user turn instead (same capability-gated pattern as ChatManager).
    if (hasAttachments && !adapter.capabilities.systemPromptArg) {
      userWithAttachments = `${USER_ATTACHMENT_SYSTEM_NOTE}\n\n${userWithAttachments}`
    }

    // Per-turn dynamic context (pinned project, permission level, provider) rides
    // the USER turn, never the system prompt — byte-stability contract (see
    // agent-operator-prompt.ts).
    const contextPrefix = conversation.pinned_project_id
      ? `[Active project: projectId="${conversation.pinned_project_id}" | Permission level: ${tierLevel} | Provider: ${adapter.id}. Use the project for project-scoped tools unless told otherwise.]`
      : `[No project pinned (Home) | Permission level: ${tierLevel} | Provider: ${adapter.id}]`
    const prompt = `${contextPrefix}\n\n${userWithAttachments}`
    const systemPrompt = hasAttachments
      ? `${OPERATOR_SYSTEM_PROMPT}\n\n${USER_ATTACHMENT_SYSTEM_NOTE}`
      : OPERATOR_SYSTEM_PROMPT
    const effectivePrompt = adapter.capabilities.systemPromptArg
      ? prompt
      : `${systemPrompt}\n\n---\n\n${prompt}`
    // Only pass native image paths to providers that can vision-load them (codex
    // `--image`); claude/gemini already have the `@path` ref folded into prompt.
    const spawnImagePaths = adapter.capabilities.supportsImageInput ? imagePaths : undefined

    const agentCapability = mintAgentCapability({
      conversationId,
      projectId: conversation.pinned_project_id,
      tierLevel,
    })
    try {
      // Gemini discovers MCP registration from project files under cwd. A
      // shared cwd would let two concurrent conversations race on `.mcp.json`
      // / `.gemini/settings.json` and launch with the other's capability.
      // Claude and Codex keep their historical global cwd and explicit MCP
      // registration mechanisms unchanged.
      const projectMcpPath = adapter.projectMcpPath?.('.')
      const needsConversationMcpCwd =
        !!projectMcpPath &&
        path.dirname(projectMcpPath) !== '.'
      const cwd = needsConversationMcpCwd
        ? ensureAgentConversationCwd(conversationId)
        : ensureAgentCwd()
      let mcpArgs: string[] = []
      let mcpEnv: Record<string, string> = {}
      try {
        const wiring = prepareAgentMcp({
          adapterId: adapter.id,
          conversationId,
          cwd,
          port: this._port,
          capability: agentCapability,
          external: resolveExternalEntries(adapter.id, this._db),
        })
        mcpArgs = wiring.extraArgs
        mcpEnv = wiring.env
      } catch (err) {
        // A bad conversation id or fs failure shouldn't poison the chat — run tool-less.
        console.error('[agent-chat] failed to prepare mcp:', err)
      }

      const timestamp = (): string => new Date().toISOString()

      interface TurnOutcome {
        disposed: boolean
        text: string
        sessionId: string | null
        error: string | null
        code: number | null
        spawnFailed: boolean
        stderrTail: string
        /** Parsed adapter events for cost finalisation (HIGH-3). */
        events: AdapterEvent[]
        /** ISO instant this spawn started, for the ai-invocation row. */
        startedAt: string
      }

      const invoke = async (useResume: boolean): Promise<TurnOutcome> => {
        const action = useResume ? 'chat-resume' : 'chat-turn'
        const startedAt = new Date().toISOString()
        let streamed = ''
        let capturedSessionId: string | null = useResume ? conversation.session_id ?? null : null
        let capturedError: string | null = null

        console.log(
          `[agent-chat] turn start conv=${conversationId} provider=${adapter.id} binary=${adapter.binary} ` +
            `action=${action} model=${model} cwd=${cwd} mcp=${mcpArgs.length ? 'mcp-config' : Object.keys(mcpEnv).join(',') || 'none'}`,
        )

        const buildOpts = {
          prompt: effectivePrompt,
          systemPrompt: adapter.capabilities.systemPromptArg ? systemPrompt : undefined,
          model,
          sessionId: useResume ? conversation.session_id ?? undefined : undefined,
          extraArgs: mcpArgs,
          imagePaths: spawnImagePaths,
          reasoning_effort: reasoningEffort,
        }
        const invocation = this._awaitWhileLive(runAiCliInvocation({
          adapter,
          action,
          cwd,
          env: buildProviderEnv(adapter, buildOpts, { ...process.env, ...mcpEnv }),
          spawn: this._spawnOwned.bind(this),
          buildOpts,
          inactivityTimeoutMs: Number.parseInt(process.env.SPECRAILS_AGENT_INACTIVITY_MS ?? '', 10) || 5 * 60_000,
          onInactivityTimeout: () => console.warn('[agent-chat] inactivity timeout', JSON.stringify({ conversationId, provider: adapter.id })),
          onSpawn: (child) => {
            if (this._disposed) {
              this._terminate(child)
              return
            }
            this._active.set(conversationId, child)
          },
          onEvent: (ev) => {
            if (this._disposed) return
            switch (ev.kind) {
              case 'text-delta':
                streamed += ev.text
                // A killed child (abort / conversation DELETE) keeps flushing its
                // buffered stdout — suppress the broadcasts once it left _active
                // so stragglers can't resurrect client-side streaming state.
                if (this._active.has(conversationId)) {
                  this._broadcast({ type: 'agent_stream', conversationId, delta: ev.text, timestamp: timestamp() })
                }
                break
              case 'tool-use':
                if (this._active.has(conversationId)) {
                  this._broadcast({
                    type: 'agent_tool',
                    conversationId,
                    tool: ev.name,
                    ...(ev.inputPreview ? { input: ev.inputPreview } : {}),
                    ...(ev.toolUseId ? { toolId: ev.toolUseId } : {}),
                    timestamp: timestamp(),
                  })
                }
                break
              case 'tool-result':
                // Feeds the activity-log modal's output column. Claude-only
                // today; other adapters never emit this kind.
                if (this._active.has(conversationId)) {
                  this._broadcast({
                    type: 'agent_tool_result',
                    conversationId,
                    ...(ev.toolUseId ? { toolId: ev.toolUseId } : {}),
                    output: ev.outputPreview,
                    ...(ev.isError ? { isError: true } : {}),
                    timestamp: timestamp(),
                  })
                }
                break
              case 'session-started':
                if (ev.sessionId) capturedSessionId = ev.sessionId
                break
              case 'result': {
                const sid = (ev.payload as { session_id?: string }).session_id
                if (sid) capturedSessionId = sid
                break
              }
              case 'error':
                capturedError = ev.message
                break
              case 'other':
                break
            }
          },
        }))

        const invocationResult = await invocation
        if (invocationResult.disposed) {
          this._active.delete(conversationId)
          return {
            disposed: true,
            text: '',
            sessionId: capturedSessionId,
            error: null,
            code: null,
            spawnFailed: false,
            stderrTail: '',
            events: [],
            startedAt,
          }
        }
        const result = invocationResult.value

        this._active.delete(conversationId)
        const text = streamed.trim()
        console.log(
          `[agent-chat] turn end conv=${conversationId} provider=${adapter.id} code=${result.code} ` +
            `spawnFailed=${result.spawnFailed} chars=${text.length} err=${capturedError ?? ''}`,
        )
        if (result.stderrTail && (result.spawnFailed || (result.code ?? 0) !== 0 || !text)) {
          console.error(`[agent-chat] ${adapter.id} stderr:\n${result.stderrTail}`)
        }
        return { disposed: false, text, sessionId: capturedSessionId, error: capturedError, code: result.code, spawnFailed: result.spawnFailed, stderrTail: result.stderrTail, events: result.events, startedAt }
      }

      // Conversation CONFIG (provider/model/tier) is owned by the PATCH route —
      // never write turn-START snapshots back at settle, or a mid-turn provider
      // switch would be silently reverted and a queued turn drained onto the old
      // provider. Only the session id persists, and only while the row's provider
      // is still the one this turn actually ran on (a foreign session id must not
      // pollute the new provider's freshly-reset state).
      const persistSession = (sessionId: string | null): void => {
        if (this._disposed) return
        const fresh = getAgentConversation(this._db, conversationId)
        if (fresh && fresh.provider === conversation.provider) {
          updateAgentConversation(this._db, conversationId, { session_id: sessionId })
        }
      }
      const settleAborted = (r: { text: string; sessionId: string | null }): void => {
        if (this._disposed) return
        // Deliberate user Stop: keep any partial text (it was already streamed to
        // the client), never auto-heal, never surface an error.
        if (r.text && getAgentConversation(this._db, conversationId)) {
          addAgentMessage(this._db, { conversationId, role: 'assistant', content: r.text })
          persistSession(r.sessionId)
          this._broadcast({ type: 'agent_done', conversationId, fullText: r.text, timestamp: timestamp() })
        }
      }

      // Cost accounting (HIGH-3): exactly one row per settled turn, whichever
      // terminal branch we exit through. `pinned_project_id` is captured at turn
      // start (NULL = Home / app-global).
      const record = (outcome: TurnOutcome, status: AgentInvocationStatus): void => {
        if (this._disposed || outcome.disposed) return
        this._recordTurn(conversation, adapter, model, outcome, status)
      }

      const canResume = !!conversation.session_id && adapter.capabilities.nativeResume
      let r = await invoke(canResume)
      if (this._disposed || r.disposed) return

      // Deleted mid-turn (DELETE aborts the child and drops the row): stop here —
      // no auto-heal respawn, no FK-violating assistant INSERT. The spawn still
      // billed, so record it (aborted) before returning.
      if (!getAgentConversation(this._db, conversationId)) {
        record(r, 'aborted')
        return
      }
      if (this._abortedTurns.delete(conversationId)) {
        settleAborted(r)
        record(r, 'aborted')
        return
      }

      // Auto-heal a stale/foreign session: a resume that produced no text (e.g. a
      // provider switch leaving another provider's session id, or codex
      // "no rollout found for thread id") retries once as a fresh turn.
      if (
        canResume &&
        !r.spawnFailed &&
        !r.text &&
        (!r.error || isStaleResumeError(r.error))
      ) {
        console.log(`[agent-chat] resume produced no text — retrying fresh conv=${conversationId}`)
        updateAgentConversation(this._db, conversationId, { session_id: null })
        r = await invoke(false)
        if (this._disposed || r.disposed) return
        if (!getAgentConversation(this._db, conversationId)) {
          record(r, 'aborted')
          return
        }
        if (this._abortedTurns.delete(conversationId)) {
          settleAborted(r)
          record(r, 'aborted')
          return
        }
      }

      if (r.spawnFailed) {
        this._emitError(conversationId, `Failed to launch ${adapter.binary}. Is it installed and on PATH?`)
        record(r, 'failed')
        return
      }

      // A normalized provider error is authoritative even when the CLI exits
      // zero or streamed partial text before failing.
      if (r.error || r.code !== 0) {
        persistSession(null)
        const reason =
          r.error ||
          (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
          `${adapter.binary} exited with code ${r.code ?? 'unknown'}`
        if (r.text) {
          addAgentMessage(this._db, { conversationId, role: 'assistant', content: r.text })
          this._broadcast({ type: 'agent_partial', conversationId, fullText: r.text, error: reason, timestamp: timestamp() })
        }
        this._emitError(conversationId, reason)
        record(r, 'failed')
        return
      }

      if (r.text) {
        addAgentMessage(this._db, { conversationId, role: 'assistant', content: r.text })
        persistSession(r.sessionId)
        this._broadcast({ type: 'agent_done', conversationId, fullText: r.text, timestamp: timestamp() })
        record(r, 'success')
        // AI title after the FIRST completed turn (industry standard — ChatGPT /
        // Claude.ai), on the conversation's own provider. The deterministic title
        // set at send stays the instant fallback; this upgrades it a moment later.
        this._maybeAiTitle(conversation, userText, r.text)
        return
      }

      // Failure: reset the session so the NEXT turn starts fresh, and surface the
      // real reason instead of silently doing nothing.
      persistSession(null)
      const reason =
        (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
        'The agent returned no output.'
      this._emitError(conversationId, reason)
      record(r, 'failed')
    } finally {
      revokeAgentCapability(agentCapability)
      removeAgentCapabilityFile(conversationId)
    }
  }

  /**
   * Finalise one agent-chat turn's billable accounting (COST-ACCOUNTING-AUDIT
   * HIGH-3) and persist an `agent_invocations` row. Cost is the provider's
   * native `total_cost_usd` when reported, else the pricing-table estimate
   * (`total_cost_usd_estimated=1`) — including claude turns killed/aborted
   * before their terminal `result` event. Never throws into the turn path.
   * Broadcasts `spending.invalidated` for the pinned project (app-global Home
   * turns carry no projectId, so no per-project dashboard to invalidate).
   */
  private _recordTurn(
    conversation: NonNullable<ReturnType<typeof getAgentConversation>>,
    adapter: ProviderAdapter,
    model: string,
    outcome: { events: AdapterEvent[]; startedAt: string; sessionId: string | null },
    status: AgentInvocationStatus,
  ): void {
    if (this._disposed) return
    try {
      const finishedAt = new Date().toISOString()
      const { result, estimated } = finaliseInvocationResult(adapter, outcome.events, {
        fallbackModel: model,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(outcome.startedAt)),
      })
      recordAgentInvocation(this._db, {
        id: randomUUID(),
        conversation_id: conversation.id,
        project_id: conversation.pinned_project_id ?? null,
        provider: adapter.id,
        status,
        started_at: outcome.startedAt,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        ...result,
      })
      const projectId = conversation.pinned_project_id
      if (projectId) this._broadcast({ type: 'spending.invalidated', projectId })
    } catch (err) {
      console.error(`[agent-chat] recordAgentInvocation failed (${conversation.id}):`, err)
    }
  }

  /**
   * Auto-title a conversation from its first TWO user prompts (deterministic —
   * no AI spend). Turn 1 sets the title when none exists; turn 2 refines it,
   * but ONLY while the current title is still turn 1's auto title (a manual
   * rename is recomputable-detectable and never clobbered). Broadcasts
   * `agent_title` so the sidebar list updates live.
   */
  private _autoTitle(conversationId: string, currentTitle: string | null): void {
    if (this._disposed) return
    try {
      const userMsgs = listAgentMessages(this._db, conversationId).filter((m) => m.role === 'user')
      if (userMsgs.length === 0 || userMsgs.length > 2) return
      const autoFromFirst = generateAutoTitle([{ role: 'user', content: userMsgs[0].content }])
      const stillAuto = currentTitle === null || (userMsgs.length === 2 && currentTitle === autoFromFirst)
      if (!stillAuto) return
      const source = userMsgs.map((m) => m.content).join(' — ')
      const title = generateAutoTitle([{ role: 'user', content: source }])
      if (!title || title === currentTitle) return
      updateAgentConversation(this._db, conversationId, { title })
      this._broadcast({ type: 'agent_title', conversationId, title, timestamp: new Date().toISOString() })
    } catch (err) {
      console.error(`[agent-chat] auto-title failed (${conversationId}):`, err)
    }
  }

  /**
   * Gate + fire the AI title upgrade. Runs ONLY on the first completed assistant
   * turn and ONLY while the stored title is still the deterministic turn-1
   * auto-title (a manual rename is recomputable-detectable and never clobbered),
   * so the cheap spawn is skipped when it would be pointless.
   */
  private _maybeAiTitle(
    conversation: NonNullable<ReturnType<typeof getAgentConversation>>,
    firstUserMsg: string,
    firstResponse: string,
  ): void {
    if (this._disposed) return
    try {
      const conversationId = conversation.id
      const assistantCount = listAgentMessages(this._db, conversationId).filter((m) => m.role === 'assistant').length
      if (assistantCount !== 1) return
      const deterministic = generateAutoTitle([{ role: 'user', content: firstUserMsg }])
      const fresh = getAgentConversation(this._db, conversationId)
      if (!fresh || fresh.title !== deterministic) return
      this._aiTitle(fresh, firstUserMsg, firstResponse)
    } catch (err) {
      console.error(`[agent-chat] ai-title gate failed (${conversation.id}):`, err)
    }
  }

  /**
   * Fire-and-forget AI title: a cheap one-shot on the conversation's OWN provider
   * (default model) that summarizes the first exchange into a 3-6 word title.
   * Spawned from an empty tmp cwd so no operator CLAUDE.md / `.mcp.json` /
   * user-scope settings are auto-loaded (leanest possible spawn, no tool wiring).
   * On close it records the billable turn (parity with ChatManager's LOW-1 title
   * accounting), then overwrites the title only if it is STILL the deterministic
   * one (never clobbers a rename made during the ~1s generation). Never throws
   * into the turn path — title generation failing must not surface an error.
   */
  private _aiTitle(
    conversation: NonNullable<ReturnType<typeof getAgentConversation>>,
    firstUserMsg: string,
    firstResponse: string,
  ): void {
    if (this._disposed) return
    try {
      const conversationId = conversation.id
      const adapter = getAdapter(conversation.provider)
      const toolPolicy = pureOutputToolPolicy(adapter)
      if (!toolPolicy) return
      const model = adapter.defaultModel()
      const prompt =
        'Generate a concise 3-6 word title for this conversation. ' +
        'Output ONLY the title text — no quotes, no punctuation, no markdown, no preamble.\n\n' +
        `User: ${firstUserMsg.slice(0, 240)}\nAssistant: ${firstResponse.slice(0, 320)}`
      const titleOptions = { prompt, model, toolPolicy }
      const args = adapter.buildArgs('auto-title', titleOptions)
      const child = this._spawnOwned(adapter.binary, args, {
        env: buildProviderEnv(adapter, titleOptions),
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: tmpdir(),
      })
      this._auxProcesses.add(child)

      let raw = ''
      const events: AdapterEvent[] = []
      const startedAt = new Date().toISOString()
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
      this._auxReaders.set(child, reader)
      reader.on('line', (line) => {
        if (this._disposed) return
        for (const ev of parseStreamEvents(adapter, line)) {
          events.push(ev)
          if (ev.kind === 'text-delta') raw += ev.text
        }
      })
      child.on('error', () => {
        this._auxProcesses.delete(child)
        this._auxReaders.delete(child)
        try { reader.close() } catch { /* best-effort */ }
      })
      child.on('close', (code) => {
        this._auxProcesses.delete(child)
        this._auxReaders.delete(child)
        try { reader.close() } catch { /* best-effort */ }
        if (this._disposed) return
        const fresh = getAgentConversation(this._db, conversationId)
        if (!fresh) return // deleted mid-generation — FK-safe: skip record + update
        // Cost accounting parity with ChatManager LOW-1: the title spawn is a
        // real billable invocation — record one agent_invocations row.
        this._recordTurn(fresh, adapter, model, { events, startedAt, sessionId: null }, code === 0 ? 'success' : 'failed')
        if (code !== 0) return
        const title = sanitizeAgentTitle(raw)
        if (!title || title === fresh.title) return
        // Never clobber a manual rename made while the title was generating.
        const deterministic = generateAutoTitle([{ role: 'user', content: firstUserMsg }])
        if (fresh.title !== deterministic) return
        updateAgentConversation(this._db, conversationId, { title })
        this._broadcast({ type: 'agent_title', conversationId, title, timestamp: new Date().toISOString() })
      })
    } catch (err) {
      console.error(`[agent-chat] ai-title spawn failed (${conversation.id}):`, err)
    }
  }

  /**
   * Post the inline PR-decision card into the conversation that launched the
   * rail (safe-pr-review-flow): persist a `system`-role row whose content is
   * the JSON envelope (so the card survives refresh/cold-load), then broadcast
   * `agent_pr_decision` so open panels render it live. No-ops when the
   * conversation was deleted (the ledger's origin link is a soft reference).
   * NEVER throws — it runs inside rail settle paths.
   */
  postPrDecisionCard(conversationId: string, envelope: PrDecisionCardEnvelope): void {
    if (this._disposed) return
    try {
      if (!getAgentConversation(this._db, conversationId)) {
        console.log(`[agent-chat] pr-decision card skipped — conversation gone (${conversationId})`)
        return
      }
      const existing = this._findPrDecisionCards(conversationId, envelope.prDeliveryId)
      if (existing.length > 0) {
        this.updatePrDecisionCard(conversationId, envelope)
        return
      }
      addAgentMessage(this._db, { conversationId, role: 'system', content: JSON.stringify(envelope) })
      this._broadcastPrDecision(conversationId, envelope)
    } catch (err) {
      console.error(`[agent-chat] postPrDecisionCard failed (${conversationId}):`, err)
    }
  }

  /**
   * Update the SAME persisted card in place on a later decision transition
   * (matched by `prDeliveryId`), so a cold-load renders the current/terminal
   * state instead of a stale ask — then re-broadcast. Falls back to posting a
   * fresh card when none exists (resilience: e.g. the original post raced a
   * conversation delete/restore). NEVER throws — it runs inside decision paths.
   */
  updatePrDecisionCard(conversationId: string, envelope: PrDecisionCardEnvelope): void {
    if (this._disposed) return
    try {
      const existing = this._findPrDecisionCards(conversationId, envelope.prDeliveryId)
      if (existing.length === 0) {
        this.postPrDecisionCard(conversationId, envelope)
        return
      }
      const serialized = JSON.stringify(envelope)
      // Keep the newest history anchor: client cold-load dedupe uses the same
      // newest-row rule, so a crash between hydration and this repair cannot
      // make an older blocked envelope authoritative again.
      const canonical = existing[existing.length - 1]
      const duplicateIds = existing.slice(0, -1).map((message) => message.id)
      // Startup recovery may inspect historical deliveries to heal a card that
      // missed its terminal update. Identical projection is not new activity:
      // avoid a redundant DB write and, crucially, do not broadcast an unread
      // event for an old card on every app launch.
      if (canonical.content === serialized && duplicateIds.length === 0) return
      this._db.transaction(() => {
        if (canonical.content !== serialized) updateAgentMessageContent(this._db, canonical.id, serialized)
        deleteAgentMessagesByIds(this._db, duplicateIds)
      })()
      this._broadcastPrDecision(conversationId, envelope)
    } catch (err) {
      console.error(`[agent-chat] updatePrDecisionCard failed (${conversationId}):`, err)
    }
  }

  private _findPrDecisionCards(conversationId: string, prDeliveryId: string) {
    return findAgentSystemMessages(this._db, conversationId, (content) => {
      try {
        const parsed = JSON.parse(content) as { kind?: string; prDeliveryId?: string }
        return parsed.kind === 'pr_decision' && parsed.prDeliveryId === prDeliveryId
      } catch {
        return false
      }
    })
  }

  private _broadcastPrDecision(conversationId: string, envelope: PrDecisionCardEnvelope): void {
    this._broadcast({
      type: 'agent_pr_decision',
      conversationId,
      ...envelope,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Edits a still-queued message in place (composer ↑/↓ queue navigation).
   * Returns false when the message is no longer in the queue — the drain loop
   * `shift()`s an item synchronously before spawning its turn, so a false here
   * means "already dispatched (or cleared)" and the router maps it to 409.
   * Success broadcasts `agent_queue_edited` so every open window updates its chip.
   */
  editQueued(conversationId: string, queueId: string, text: string): boolean {
    if (this._disposed) return false
    const pending = this._queue.get(conversationId)
    const item = pending?.find((q) => q.queueId === queueId)
    if (!item) return false
    item.text = text
    this._broadcast({
      type: 'agent_queue_edited',
      conversationId,
      queueId,
      text,
      contextRefs: item.options.contextRefs ?? [],
      timestamp: new Date().toISOString(),
    })
    return true
  }

  /** Aborts the active turn for a conversation, if any. Stop means stop: any
   *  queued messages are discarded too (broadcast so the client drops chips),
   *  and the settling turn is marked aborted so the stale-session auto-heal
   *  can never resurrect the stopped prompt as a fresh spawn. */
  abort(conversationId: string): boolean {
    if (this._disposed) return false
    this._clearQueue(conversationId)
    if (this.isBusy(conversationId)) this._abortedTurns.add(conversationId)
    const child = this._active.get(conversationId)
    if (!child) return false
    this._terminate(child)
    this._active.delete(conversationId)
    return true
  }

  private _clearQueue(conversationId: string): void {
    const pending = this._queue.get(conversationId)
    if (!pending || pending.length === 0) return
    this._queue.delete(conversationId)
    this._broadcast({ type: 'agent_queue_cleared', conversationId, timestamp: new Date().toISOString() })
  }

  /** Kills all active turns (graceful shutdown). */
  async shutdown(): Promise<void> {
    if (this._disposed) return
    this._disposed = true
    this._resolveDisposed()
    this._queue.clear()
    this._reserved.clear()
    this._abortedTurns.clear()
    for (const [, child] of this._active) {
      this._terminate(child)
      // runAiCliInvocation owns readline listeners and an unbounded event
      // accumulator. Cut the pipes now so an uncooperative child cannot keep
      // feeding that detached invocation during the SIGTERM grace window.
      this._closeChildIo(child)
    }
    this._active.clear()
    for (const child of this._auxProcesses) {
      const reader = this._auxReaders.get(child)
      try { reader?.close() } catch { /* best-effort */ }
      this._terminate(child)
      this._closeChildIo(child)
    }
    this._auxReaders.clear()
    this._auxProcesses.clear()
  }

  private _emitError(conversationId: string, error: string): void {
    if (this._disposed) return
    this._broadcast({ type: 'agent_error', conversationId, error, timestamp: new Date().toISOString() })
  }
}

const MAX_AI_TITLE_LEN = 80

/**
 * Coerce a model's title output into a clean single-line title: first non-empty
 * line, surrounding quotes / markdown emphasis / leading list markers stripped,
 * whitespace collapsed, word-aware length cap. Returns '' when nothing usable
 * remains (the caller then keeps the deterministic title).
 */
export function sanitizeAgentTitle(raw: string): string {
  const firstLine = raw.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  const stripped = firstLine
    .replace(/^[\s>*_#-]+/, '') // leading markdown/list markers
    .replace(/^["'`]+/, '')
    .replace(/["'`*_\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return ''
  if (stripped.length <= MAX_AI_TITLE_LEN) return stripped
  const head = stripped.slice(0, MAX_AI_TITLE_LEN)
  const lastSpace = head.lastIndexOf(' ')
  return (lastSpace > 20 ? head.slice(0, lastSpace) : head).trim() + '…'
}
