import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'child_process'
import { randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import {
  getAdapter,
  isModelAvailableForAdapter,
  reasoningEffortsForModel,
} from './providers'
import { buildProviderEnv, pureOutputToolPolicy } from './providers/runtime'
import type { AdapterEvent, ProviderAdapter, ReasoningEffort } from './providers/types'
import { runAiCliInvocation } from './spawn-lifecycle'
import { spawnAiCli } from './util/cli-prompt'
import { finaliseInvocationResult } from './result-event'
import { recordAgentInvocation, type AgentInvocationStatus } from './desktop-db'
import { ensureBuilderCwd } from './builder-cwd-manager'
import { BUILDER_SYSTEM_PROMPT } from './blueprint-operator-prompt'
import { parseBlueprintDraftBlocks } from './blueprint-draft-parser'
import { generateAutoTitle } from './explore-draft-title'
import {
  addBlueprintMessage,
  getBlueprintConversation,
  updateBlueprintConversation,
  type BlueprintConversation,
} from './blueprint-store'

// ─── BlueprintChatManager (add-project-builder D1) ────────────────────────────
//
// Day-0 Builder chat: an app-level sibling of AgentChatManager that runs with
// NO project (none exists yet), NO MCP wiring (nothing to operate) and NO tier
// ladder. It reuses the shared spawn→stream→settle core (runAiCliInvocation)
// from the app-owned builder cwd, streams over app-global `blueprint.*` WS
// events, persists to desktop.sqlite, and records each settled turn into the
// `agent_invocations` ledger with `project_id NULL` (the Home-turn precedent).

export interface BlueprintTurnOptions {
  model?: string
  /** Reasoning effort per turn (client-driven; the builder conversation is
   *  ephemeral so effort rides the send, not a DB column). Validated against
   *  the adapter's catalog below; ignored by providers without the knob. */
  reasoningEffort?: string
}

export class BlueprintChatManager {
  private readonly _broadcast: (msg: WsMessage) => void
  private readonly _db: DbInstance
  private readonly _active = new Map<string, ChildProcess>()
  private readonly _abortedTurns = new Set<string>()
  private readonly _terminationTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>()
  private _disposed = false
  private _resolveDisposed!: () => void
  private readonly _disposedSignal = new Promise<void>((resolve) => {
    this._resolveDisposed = resolve
  })

  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance) {
    this._broadcast = broadcast
    this._db = db
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
   * the root CLI exits (mirrors AgentChatManager). */
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
        this._terminationTimers.delete(child)
        if (process.platform !== 'win32') {
          try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
        } else {
          try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
        }
      }, 2000)
      timer.unref?.()
      this._terminationTimers.set(child, timer)
    } catch {
      /* already gone */
    }
  }

  isStreaming(conversationId: string): boolean {
    return !this._disposed && this._active.has(conversationId)
  }

  /** Stop the in-flight turn (partial text is kept; never surfaced as error). */
  abort(conversationId: string): void {
    const child = this._active.get(conversationId)
    if (!child) return
    this._abortedTurns.add(conversationId)
    this._active.delete(conversationId)
    this._terminate(child)
  }

  private _emitError(conversationId: string, error: string): void {
    if (this._disposed) return
    this._broadcast({ type: 'blueprint.error', conversationId, error, timestamp: new Date().toISOString() })
  }

  /**
   * Runs one Builder turn: persists the user message, spawns the AI CLI from
   * the builder cwd, streams deltas as `blueprint.stream`, then persists the
   * STRIPPED assistant reply (blueprint-draft fences removed) and broadcasts
   * `blueprint.done` with the last valid blueprint snapshot.
   */
  async sendMessage(conversationId: string, userText: string, options: BlueprintTurnOptions = {}): Promise<void> {
    if (this._disposed) return
    const conversation = getBlueprintConversation(this._db, conversationId)
    if (!conversation) {
      this._emitError(conversationId, 'Unknown conversation')
      return
    }
    if (this._active.has(conversationId)) {
      this._emitError(conversationId, 'A turn is already streaming for this conversation.')
      return
    }
    try {
      await this._runTurn(conversation, userText, options)
    } catch (err) {
      if (this._disposed) return
      console.error(`[blueprint-chat] turn failed (${conversationId}):`, err)
      this._emitError(conversationId, err instanceof Error ? err.message : 'The Builder turn failed.')
    } finally {
      this._abortedTurns.delete(conversationId)
    }
  }

  private async _runTurn(
    conversation: BlueprintConversation,
    userText: string,
    options: BlueprintTurnOptions,
  ): Promise<void> {
    const conversationId = conversation.id
    const adapter = getAdapter(conversation.provider)
    const toolPolicy = pureOutputToolPolicy(adapter)
    if (!toolPolicy) {
      throw new Error(`provider_tool_policy_unsupported:${adapter.id}:pure-output`)
    }
    const requested = options.model || conversation.model
    const model = requested && isModelAvailableForAdapter(adapter, requested)
      ? requested
      : adapter.defaultModel()
    // Reasoning effort: only for providers with the knob, only when the value
    // is in their catalog (else undefined = provider default).
    const efforts = reasoningEffortsForModel(adapter, model)
    const requestedEffort = options.reasoningEffort
    const reasoningEffort: ReasoningEffort | undefined = requestedEffort
      && (efforts as readonly string[]).includes(requestedEffort)
      ? requestedEffort as ReasoningEffort
      : undefined
    const cwd = ensureBuilderCwd()
    const timestamp = (): string => new Date().toISOString()

    addBlueprintMessage(this._db, { conversationId, role: 'user', content: userText })
    // Deterministic title from the first user prompt (no AI spend).
    if (!conversation.title) {
      const title = generateAutoTitle([{ role: 'user', content: userText }])
      if (title) {
        updateBlueprintConversation(this._db, conversationId, { title })
      }
    }

    interface TurnOutcome {
      disposed: boolean
      text: string
      sessionId: string | null
      error: string | null
      code: number | null
      spawnFailed: boolean
      stderrTail: string
      events: AdapterEvent[]
      startedAt: string
    }

    const invoke = async (useResume: boolean): Promise<TurnOutcome> => {
      const action = useResume ? 'chat-resume' : 'chat-turn'
      const startedAt = new Date().toISOString()
      let streamed = ''
      let capturedSessionId: string | null = useResume ? conversation.session_id ?? null : null
      let capturedError: string | null = null
      // `chat-turn` / `chat-resume` intentionally ignore `systemPrompt` for
      // providers whose normal project-chat stance lives in their cwd
      // instructions file. The day-0 Builder has no project instructions, so
      // its schema/operator prompt must ride in the user prompt instead.
      const prompt = adapter.capabilities.systemPromptArg
        ? userText
        : `${BUILDER_SYSTEM_PROMPT}\n\n---\n\n${userText}`

      console.log(
        `[blueprint-chat] turn start conv=${conversationId} provider=${adapter.id} action=${action} model=${model}`,
      )

      const buildOpts = {
        prompt,
        systemPrompt: adapter.capabilities.systemPromptArg ? BUILDER_SYSTEM_PROMPT : undefined,
        model,
        sessionId: useResume ? conversation.session_id ?? undefined : undefined,
        reasoning_effort: reasoningEffort,
        toolPolicy,
      }
      const invocation = this._awaitWhileLive(runAiCliInvocation({
        adapter,
        action,
        cwd,
        env: buildProviderEnv(adapter, buildOpts),
        spawn: this._spawnOwned.bind(this),
        buildOpts,
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
              // Suppress broadcasts once the child left _active (abort keeps
              // flushing buffered stdout) so stragglers can't resurrect
              // client-side streaming state.
              if (this._active.has(conversationId)) {
                this._broadcast({ type: 'blueprint.stream', conversationId, delta: ev.text, timestamp: timestamp() })
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
            default:
              break
          }
        },
      }))

      const invocationResult = await invocation
      if (invocationResult.disposed) {
        this._active.delete(conversationId)
        return { disposed: true, text: '', sessionId: capturedSessionId, error: null, code: null, spawnFailed: false, stderrTail: '', events: [], startedAt }
      }
      const result = invocationResult.value
      this._active.delete(conversationId)
      const text = streamed.trim()
      if (result.stderrTail && (result.spawnFailed || (result.code ?? 0) !== 0 || !text)) {
        console.error(`[blueprint-chat] ${adapter.id} stderr:\n${result.stderrTail}`)
      }
      return { disposed: false, text, sessionId: capturedSessionId, error: capturedError, code: result.code, spawnFailed: result.spawnFailed, stderrTail: result.stderrTail, events: result.events, startedAt }
    }

    const persistSession = (sessionId: string | null): void => {
      if (this._disposed) return
      if (getBlueprintConversation(this._db, conversationId)) {
        updateBlueprintConversation(this._db, conversationId, { session_id: sessionId })
      }
    }

    // One agent_invocations row per settled turn, project_id NULL (day-0 spend).
    const record = (outcome: TurnOutcome, status: AgentInvocationStatus): void => {
      if (this._disposed || outcome.disposed) return
      this._recordTurn(conversation, adapter, model, outcome, status)
    }

    const settleText = (r: TurnOutcome): void => {
      const { stripped, blueprint, rawBlueprint } = parseBlueprintDraftBlocks(r.text)
      const content = stripped.trim()
      if (getBlueprintConversation(this._db, conversationId)) {
        addBlueprintMessage(this._db, { conversationId, role: 'assistant', content: content || r.text })
        persistSession(r.sessionId)
      }
      this._broadcast({
        type: 'blueprint.done',
        conversationId,
        fullText: content || r.text,
        blueprint,
        rawBlueprint,
        timestamp: timestamp(),
      })
    }

    const canResume = !!conversation.session_id && adapter.capabilities.nativeResume
    let r = await invoke(canResume)
    if (this._disposed || r.disposed) return

    if (!getBlueprintConversation(this._db, conversationId)) {
      record(r, 'aborted') // deleted mid-turn; the spawn still billed
      return
    }
    if (this._abortedTurns.delete(conversationId)) {
      if (r.text) settleText(r)
      record(r, 'aborted')
      return
    }

    // Auto-heal a stale session: a resume with no text retries once fresh.
    if (canResume && !r.spawnFailed && !r.error && !r.text) {
      updateBlueprintConversation(this._db, conversationId, { session_id: null })
      r = await invoke(false)
      if (this._disposed || r.disposed) return
      if (!getBlueprintConversation(this._db, conversationId)) {
        record(r, 'aborted')
        return
      }
      if (this._abortedTurns.delete(conversationId)) {
        if (r.text) settleText(r)
        record(r, 'aborted')
        return
      }
    }

    if (r.spawnFailed) {
      this._emitError(conversationId, `Failed to launch ${adapter.binary}. Is it installed and on PATH?`)
      record(r, 'failed')
      return
    }

    if (r.error || r.code !== 0) {
      persistSession(null)
      const reason =
        r.error ||
        (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
        `${adapter.binary} exited with code ${r.code ?? 'unknown'}`
      this._emitError(conversationId, reason)
      record(r, 'failed')
      return
    }

    if (r.text) {
      settleText(r)
      record(r, 'success')
      return
    }

    persistSession(null)
    const reason =
      (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
      'The Builder returned no output.'
    this._emitError(conversationId, reason)
    record(r, 'failed')
  }

  private _recordTurn(
    conversation: BlueprintConversation,
    adapter: ProviderAdapter,
    model: string,
    outcome: { events: AdapterEvent[]; startedAt: string },
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
        project_id: null,
        provider: adapter.id,
        status,
        started_at: outcome.startedAt,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        ...result,
      })
    } catch (err) {
      console.error(`[blueprint-chat] recordAgentInvocation failed (${conversation.id}):`, err)
    }
  }

  /** Kills all live children and permanently gates DB access. */
  shutdown(): void {
    if (this._disposed) return
    this._disposed = true
    this._resolveDisposed()
    for (const child of this._active.values()) this._terminate(child)
    this._active.clear()
  }
}
