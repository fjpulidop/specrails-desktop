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
import {
  BUILDER_SYSTEM_PROMPT,
  buildSnapshotRepairPrompt,
  type BuilderSnapshotRepairKind,
} from './blueprint-operator-prompt'
import {
  parseBlueprintDraftBlocks,
  type BlueprintParseResult,
  type BlueprintRejectionReason,
} from './blueprint-draft-parser'
import {
  auditRawBlueprintForM1,
  formatQualityIssuesForModel,
  type BuilderSpecQualityIssue,
} from './blueprint-spec-quality'
import { generateAutoTitle } from './explore-draft-title'
import {
  addBlueprintMessage,
  getBlueprintConversation,
  getBlueprintSnapshot,
  saveBlueprintSnapshot,
  saveBlueprintSnapshotIssue,
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

/**
 * What happened to the blueprint snapshot in ONE settled turn — rides
 * `blueprint.done` so the UI can say precisely why the commit CTA is (not)
 * available instead of a stale "generation is not complete yet".
 */
export interface BlueprintSnapshotStatus {
  /** accepted = this turn produced a valid snapshot; rejected = the model
   *  emitted a block the app could not use (even after a repair attempt);
   *  none = no block this turn (the previous snapshot stays current). */
  status: 'accepted' | 'rejected' | 'none'
  reason?: BlueprintRejectionReason
  detail?: string
  /** The accepted snapshot only parsed after a JSON repair pass or an
   *  automatic repair turn. */
  repaired?: boolean
  /** An automatic repair turn ran for this snapshot. */
  repairAttempted?: boolean
  /** The accepted snapshot declares `specsComplete: true`. */
  claimsComplete?: boolean
  /** Deterministic M1 audit failures for an accepted snapshot that claims
   *  completion — present only when the gate disagrees with the model. */
  qualityIssues?: BuilderSpecQualityIssue[]
}

export type BlueprintRepairRefusal = 'unknown_conversation' | 'streaming' | 'nothing_to_repair' | 'no_session'

interface RepairRequest {
  kind: BuilderSnapshotRepairKind
  detail: string
}

interface TurnRequest {
  /** The user's message — absent for a manual repair turn. */
  userText?: string
  options: BlueprintTurnOptions
  /** Manual repair (Settings-less "retry" from the panel): the turn IS the
   *  repair, so no nested automatic repair runs afterwards. */
  repair?: RepairRequest
}

function repairKindForRejection(reason: BlueprintRejectionReason): BuilderSnapshotRepairKind {
  return reason === 'truncated' ? 'truncated' : 'invalid_json'
}

/** Decide whether a settled parse needs ONE repair turn and what to ask. */
export function planSnapshotRepair(parse: Pick<BlueprintParseResult, 'blueprint' | 'rawBlueprint' | 'rejected'>): RepairRequest | null {
  if (!parse.blueprint) {
    const last = parse.rejected[parse.rejected.length - 1]
    if (!last) return null
    const reasonNote = last.reason === 'missing_version' ? 'The payload must be the blueprint object itself with an integer blueprintVersion. ' : ''
    return { kind: repairKindForRejection(last.reason), detail: `${reasonNote}${last.detail}` }
  }
  const audit = auditRawBlueprintForM1(parse.rawBlueprint)
  if (audit.claimsComplete && !audit.valid) {
    return { kind: 'quality', detail: formatQualityIssuesForModel(audit.issues) }
  }
  return null
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
      await this._runTurn(conversation, { userText, options })
    } catch (err) {
      if (this._disposed) return
      console.error(`[blueprint-chat] turn failed (${conversationId}):`, err)
      this._emitError(conversationId, err instanceof Error ? err.message : 'The Builder turn failed.')
    } finally {
      this._abortedTurns.delete(conversationId)
    }
  }

  /**
   * Manual repair (the panel's "retry" after a rejected snapshot, or "ask the
   * Builder to fix" after a failed audit). Decides what to ask from the
   * PERSISTED state, so it works after a restart, and runs ONE repair turn on
   * the same session. Resolves as soon as the turn is scheduled.
   */
  async repairSnapshot(conversationId: string): Promise<{ ok: true; kind: BuilderSnapshotRepairKind } | { ok: false; reason: BlueprintRepairRefusal }> {
    if (this._disposed) return { ok: false, reason: 'unknown_conversation' }
    const conversation = getBlueprintConversation(this._db, conversationId)
    if (!conversation) return { ok: false, reason: 'unknown_conversation' }
    if (this._active.has(conversationId)) return { ok: false, reason: 'streaming' }
    const snapshot = getBlueprintSnapshot(this._db, conversationId)
    let repair: RepairRequest | null = null
    if (snapshot.issue) {
      repair = { kind: repairKindForRejection(snapshot.issue.reason), detail: snapshot.issue.detail }
    } else if (snapshot.rawBlueprint !== null) {
      const audit = auditRawBlueprintForM1(snapshot.rawBlueprint)
      if (audit.claimsComplete && !audit.valid) {
        repair = { kind: 'quality', detail: formatQualityIssuesForModel(audit.issues) }
      }
    }
    if (!repair) return { ok: false, reason: 'nothing_to_repair' }
    const adapter = getAdapter(conversation.provider)
    if (!conversation.session_id || !adapter.capabilities.nativeResume) return { ok: false, reason: 'no_session' }
    const request = repair
    void (async () => {
      try {
        await this._runTurn(conversation, { options: {}, repair: request })
      } catch (err) {
        if (this._disposed) return
        console.error(`[blueprint-chat] repair turn failed (${conversationId}):`, err)
        this._emitError(conversationId, err instanceof Error ? err.message : 'The Builder repair turn failed.')
      } finally {
        this._abortedTurns.delete(conversationId)
      }
    })()
    return { ok: true, kind: repair.kind }
  }

  private async _runTurn(
    conversation: BlueprintConversation,
    turn: TurnRequest,
  ): Promise<void> {
    const conversationId = conversation.id
    const { options } = turn
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
    // The session id the NEXT invocation resumes: the row's id at entry, then
    // whatever the previous invocation captured (a repair turn must continue
    // the session the rejected block came from).
    let currentSessionId: string | null = conversation.session_id ?? null

    if (turn.userText !== undefined) {
      addBlueprintMessage(this._db, { conversationId, role: 'user', content: turn.userText })
      // Deterministic title from the first user prompt (no AI spend).
      if (!conversation.title) {
        const title = generateAutoTitle([{ role: 'user', content: turn.userText }])
        if (title) {
          updateBlueprintConversation(this._db, conversationId, { title })
        }
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

    const invoke = async (useResume: boolean, userText: string): Promise<TurnOutcome> => {
      const action = useResume ? 'chat-resume' : 'chat-turn'
      const startedAt = new Date().toISOString()
      let streamed = ''
      let capturedSessionId: string | null = useResume ? currentSessionId : null
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
        sessionId: useResume ? currentSessionId ?? undefined : undefined,
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
      currentSessionId = sessionId
      if (getBlueprintConversation(this._db, conversationId)) {
        updateBlueprintConversation(this._db, conversationId, { session_id: sessionId })
      }
    }

    // One agent_invocations row per settled invocation, project_id NULL
    // (day-0 spend) — a repair turn is a second spawn and bills too.
    const record = (outcome: TurnOutcome, status: AgentInvocationStatus): void => {
      if (this._disposed || outcome.disposed) return
      this._recordTurn(conversation, adapter, model, outcome, status)
    }

    /** Persist one assistant reply: stripped transcript + unstripped raw when
     *  it carried a block. An empty stripped reply (block only) is still
     *  stored so the raw payload survives; the API hides empty rows. */
    const persistAssistant = (r: TurnOutcome, parse: BlueprintParseResult): string => {
      const content = parse.stripped.trim()
      if (getBlueprintConversation(this._db, conversationId)) {
        addBlueprintMessage(this._db, {
          conversationId,
          role: 'assistant',
          content: parse.hadBlocks ? content : content || r.text,
          rawContent: parse.hadBlocks ? r.text : null,
        })
        persistSession(r.sessionId)
      }
      return parse.hadBlocks ? content : content || r.text
    }

    const finishTurn = (
      fullText: string,
      parse: BlueprintParseResult,
      meta: { repairAttempted: boolean; fromRepairTurn: boolean },
    ): void => {
      let snapshot: BlueprintSnapshotStatus
      if (parse.blueprint) {
        const audit = auditRawBlueprintForM1(parse.rawBlueprint)
        snapshot = {
          status: 'accepted',
          repaired: parse.repaired || meta.fromRepairTurn,
          repairAttempted: meta.repairAttempted,
          claimsComplete: audit.claimsComplete,
          ...(audit.claimsComplete && !audit.valid ? { qualityIssues: audit.issues } : {}),
        }
        if (getBlueprintConversation(this._db, conversationId)) {
          saveBlueprintSnapshot(this._db, conversationId, { blueprint: parse.blueprint, rawBlueprint: parse.rawBlueprint })
        }
      } else if (parse.rejected.length > 0) {
        const last = parse.rejected[parse.rejected.length - 1]
        snapshot = { status: 'rejected', reason: last.reason, detail: last.detail, repairAttempted: meta.repairAttempted }
        if (getBlueprintConversation(this._db, conversationId)) {
          saveBlueprintSnapshotIssue(this._db, conversationId, { reason: last.reason, detail: last.detail, at: timestamp() })
        }
        console.warn(`[blueprint-chat] snapshot rejected conv=${conversationId} reason=${last.reason} repairAttempted=${meta.repairAttempted}: ${last.detail}`)
      } else {
        snapshot = { status: 'none' }
      }
      this._broadcast({
        type: 'blueprint.done',
        conversationId,
        fullText,
        blueprint: parse.blueprint,
        rawBlueprint: parse.rawBlueprint,
        snapshot,
        timestamp: timestamp(),
      })
    }

    /** Shared post-invocation triage. Returns the outcome to continue with, or
     *  null when the turn is over (disposed / deleted / aborted / failed). */
    const settle = async (first: TurnOutcome, allowAutoHeal: boolean): Promise<TurnOutcome | null> => {
      let r = first
      if (this._disposed || r.disposed) return null
      if (!getBlueprintConversation(this._db, conversationId)) {
        record(r, 'aborted') // deleted mid-turn; the spawn still billed
        return null
      }
      if (this._abortedTurns.delete(conversationId)) {
        if (r.text) {
          const parse = parseBlueprintDraftBlocks(r.text)
          finishTurn(persistAssistant(r, parse), parse, { repairAttempted: false, fromRepairTurn: false })
        }
        record(r, 'aborted')
        return null
      }
      // Auto-heal a stale session: a resume with no text retries once fresh.
      if (allowAutoHeal && !r.spawnFailed && !r.error && !r.text) {
        updateBlueprintConversation(this._db, conversationId, { session_id: null })
        currentSessionId = null
        r = await invoke(false, turn.userText ?? '')
        if (this._disposed || r.disposed) return null
        if (!getBlueprintConversation(this._db, conversationId)) {
          record(r, 'aborted')
          return null
        }
        if (this._abortedTurns.delete(conversationId)) {
          if (r.text) {
            const parse = parseBlueprintDraftBlocks(r.text)
            finishTurn(persistAssistant(r, parse), parse, { repairAttempted: false, fromRepairTurn: false })
          }
          record(r, 'aborted')
          return null
        }
      }
      if (r.spawnFailed) {
        this._emitError(conversationId, `Failed to launch ${adapter.binary}. Is it installed and on PATH?`)
        record(r, 'failed')
        return null
      }
      if (r.error || r.code !== 0) {
        persistSession(null)
        const reason =
          r.error ||
          (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
          `${adapter.binary} exited with code ${r.code ?? 'unknown'}`
        this._emitError(conversationId, reason)
        record(r, 'failed')
        return null
      }
      if (!r.text) {
        persistSession(null)
        const reason =
          (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
          'The Builder returned no output.'
        this._emitError(conversationId, reason)
        record(r, 'failed')
        return null
      }
      return r
    }

    /** Repair-turn triage (mirrors `settle` minus the auto-heal and the error
     *  broadcasts — a failed repair never turns a successful user turn into an
     *  error): 'stop' = the turn is over (disposed / deleted / aborted), null =
     *  the repair spawn produced nothing usable (the original outcome stands). */
    const settleRepair = (r: TurnOutcome): TurnOutcome | null | 'stop' => {
      if (this._disposed || r.disposed) return 'stop'
      if (!getBlueprintConversation(this._db, conversationId)) {
        record(r, 'aborted')
        return 'stop'
      }
      if (this._abortedTurns.delete(conversationId)) {
        record(r, 'aborted')
        return 'stop'
      }
      if (r.spawnFailed || r.error || r.code !== 0 || !r.text) {
        console.warn(`[blueprint-chat] repair turn produced no usable reply conv=${conversationId} code=${r.code} error=${r.error ?? ''}`)
        record(r, 'failed')
        return null
      }
      return r
    }

    const canResume = !!currentSessionId && adapter.capabilities.nativeResume

    // ── Manual repair turn: the request IS the repair; never nests another.
    if (turn.repair) {
      this._broadcast({
        type: 'blueprint.repairing',
        conversationId,
        kind: turn.repair.kind,
        attempt: 1,
        manual: true,
        timestamp: timestamp(),
      })
      const r = await settle(await invoke(canResume, buildSnapshotRepairPrompt(turn.repair.kind, turn.repair.detail)), false)
      if (!r) return
      const parse = parseBlueprintDraftBlocks(r.text)
      const fullText = persistAssistant(r, parse)
      record(r, 'success')
      finishTurn(fullText, parse, { repairAttempted: true, fromRepairTurn: true })
      return
    }

    // ── Regular user turn.
    const r = await settle(await invoke(canResume, turn.userText ?? ''), canResume)
    if (!r) return
    const parse = parseBlueprintDraftBlocks(r.text)
    const fullText = persistAssistant(r, parse)
    record(r, 'success')

    // ONE automatic repair turn when the model's block was unusable, or when
    // it claimed completion and the deterministic audit disagrees. Needs a
    // resumable session: without the prior context the model can't re-emit.
    const repair = planSnapshotRepair(parse)
    const canRepair = repair !== null && !!currentSessionId && adapter.capabilities.nativeResume
    if (!repair || !canRepair) {
      finishTurn(fullText, parse, { repairAttempted: false, fromRepairTurn: false })
      return
    }
    console.warn(`[blueprint-chat] snapshot needs repair conv=${conversationId} kind=${repair.kind}: ${repair.detail.slice(0, 200)}`)
    this._broadcast({
      type: 'blueprint.repairing',
      conversationId,
      kind: repair.kind,
      attempt: 1,
      manual: false,
      timestamp: timestamp(),
    })
    const r2 = settleRepair(await invoke(true, buildSnapshotRepairPrompt(repair.kind, repair.detail)))
    if (r2 === 'stop') return
    if (r2 === null) {
      // The repair spawn failed — the original turn still stands.
      finishTurn(fullText, parse, { repairAttempted: true, fromRepairTurn: false })
      return
    }
    const parse2 = parseBlueprintDraftBlocks(r2.text)
    const prose2 = persistAssistant(r2, parse2)
    record(r2, 'success')
    const combinedText = prose2 ? (fullText ? `${fullText}\n\n${prose2}` : prose2) : fullText
    if (parse2.blueprint) {
      finishTurn(combinedText, parse2, { repairAttempted: true, fromRepairTurn: true })
    } else {
      // Still unusable: report the ORIGINAL outcome (plus the newest
      // rejection detail when the repair produced one) so the UI can offer a
      // manual retry with the freshest diagnostic.
      const merged: BlueprintParseResult = parse2.rejected.length > 0
        ? { ...parse, rejected: [...parse.rejected, ...parse2.rejected] }
        : parse
      finishTurn(combinedText, merged, { repairAttempted: true, fromRepairTurn: false })
    }
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
