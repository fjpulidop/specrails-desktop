import type { ChildProcess } from 'child_process'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import { getAdapter } from './providers'
import type { ReasoningEffort } from './providers/types'
import { runAiCliInvocation } from './spawn-lifecycle'
import { ensureAgentCwd } from './agent-cwd-manager'
import { OPERATOR_SYSTEM_PROMPT } from './agent-operator-prompt'
import { prepareAgentMcp } from './agent-mcp-config'
import { normalizeLevel, type AgentTierLevel } from './agent-tier'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import {
  getAgentConversation,
  addAgentMessage,
  updateAgentConversation,
  listAgentMessages,
} from './agent-store'
import { generateAutoTitle } from './explore-draft-title'
import { setActiveProject } from './mcp/tools/types'

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
}

export class AgentChatManager {
  private readonly _broadcast: (msg: WsMessage) => void
  private readonly _db: DbInstance
  private readonly _port: number
  private readonly _active = new Map<string, ChildProcess>()
  /** Conversations with a turn in-flight but not yet spawned. Closes the TOCTOU
   *  window the attachment-extraction await opens between the busy guard and
   *  `_active.set` in onSpawn (mirrors ChatManager's reservation pattern). */
  private readonly _reserved = new Set<string>()

  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance, port: number) {
    this._broadcast = broadcast
    this._db = db
    this._port = port
  }

  /** True while a turn is streaming for this conversation. */
  isStreaming(conversationId: string): boolean {
    return this._active.has(conversationId)
  }

  /**
   * Runs one agent turn: persists the user message, spawns the AI CLI pointed at
   * the Specrails MCP, streams deltas + tool-use as `agent_*` events, then
   * persists the assistant reply and the session id. Settles once.
   */
  async sendMessage(conversationId: string, userText: string, options: AgentTurnOptions = {}): Promise<void> {
    const conversation = getAgentConversation(this._db, conversationId)
    if (!conversation) {
      this._emitError(conversationId, 'Unknown conversation')
      return
    }
    if (this._active.has(conversationId) || this._reserved.has(conversationId)) {
      this._emitError(conversationId, 'The agent is busy. Try again in a moment.')
      return
    }
    this._reserved.add(conversationId)
    try {
      await this._runTurn(conversation, userText, options)
    } finally {
      this._reserved.delete(conversationId)
    }
  }

  private async _runTurn(
    conversation: NonNullable<ReturnType<typeof getAgentConversation>>,
    userText: string,
    options: AgentTurnOptions,
  ): Promise<void> {
    const conversationId = conversation.id
    const tierLevel = normalizeLevel(options.tierLevel ?? conversation.tier_level)
    const adapter = getAdapter(conversation.provider)
    // Resolve a model that is VALID for this provider. A stale model from another
    // provider (e.g. claude's "sonnet" after switching to codex) is rejected by
    // the provider — fall back to the provider's default instead of failing.
    const catalog = new Set(adapter.modelCatalog().map((m) => m.value))
    const requested = options.model || conversation.model
    const model = requested && catalog.has(requested) ? requested : adapter.defaultModel()
    // Reasoning effort: stored per conversation; null = the app default
    // ("medium"). Passed only to providers with a per-spawn knob, and only when
    // the value is in the provider's catalog (a provider switch clears it, but
    // belt-and-braces against stale rows).
    const efforts = (adapter.capabilities.reasoningEfforts ?? []) as readonly string[]
    const storedEffort = conversation.reasoning_effort
    const reasoningEffort = efforts.length
      ? ((storedEffort && efforts.includes(storedEffort) ? storedEffort : 'medium') as ReasoningEffort)
      : undefined

    // Make the pinned project (Cursor-style selector) the MCP active project for
    // this turn, so project-scoped tools resolve without the agent having to call
    // specrails_select_project. Home (null) clears it → app-global mode.
    setActiveProject(conversation.pinned_project_id ?? null)

    // Resolve attachments (conversation-keyed) into extracted text blocks +
    // absolute image paths. Extraction failure degrades to a text-only turn.
    const attachmentIds = options.attachmentIds ?? []
    let userWithAttachments = userText
    let imagePaths: string[] = []
    let hasAttachments = false
    if (attachmentIds.length > 0) {
      try {
        const resolved = await attachmentManager.getClaudeArgsAgent(conversationId, attachmentIds)
        if (resolved.textBlocks.length > 0) {
          userWithAttachments = `${userText}\n\n## Attached Resources\n\n${resolved.textBlocks.join('\n\n')}`
          hasAttachments = true
        }
        imagePaths = resolved.imagePaths
      } catch (err) {
        console.error(`[agent-chat] attachment extraction failed (${conversationId}):`, err)
      }
    }

    // The conversation may have been deleted while attachments were extracting
    // (DELETE aborts the child and drops the row) — inserting would violate the FK.
    if (!getAgentConversation(this._db, conversationId)) return
    addAgentMessage(this._db, { conversationId, role: 'user', content: userText, attachmentIds })
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
    // Only pass native image paths to providers that can vision-load them (codex
    // `--image`); claude/gemini already have the `@path` ref folded into prompt.
    const spawnImagePaths = adapter.capabilities.supportsImageInput ? imagePaths : undefined

    const cwd = ensureAgentCwd()
    let mcpArgs: string[] = []
    let mcpEnv: Record<string, string> = {}
    try {
      const wiring = prepareAgentMcp({
        adapterId: adapter.id,
        conversationId,
        cwd,
        port: this._port,
        tierLevel,
        activeProjectId: conversation.pinned_project_id,
      })
      mcpArgs = wiring.extraArgs
      mcpEnv = wiring.env
    } catch (err) {
      // A bad conversation id or fs failure shouldn't poison the chat — run tool-less.
      console.error('[agent-chat] failed to prepare mcp:', err)
    }

    const timestamp = (): string => new Date().toISOString()

    interface TurnOutcome {
      text: string
      sessionId: string | null
      error: string | null
      code: number | null
      spawnFailed: boolean
      stderrTail: string
    }

    const invoke = async (useResume: boolean): Promise<TurnOutcome> => {
      const action = useResume ? 'chat-resume' : 'chat-turn'
      let streamed = ''
      let capturedSessionId: string | null = useResume ? conversation.session_id ?? null : null
      let capturedError: string | null = null

      console.log(
        `[agent-chat] turn start conv=${conversationId} provider=${adapter.id} binary=${adapter.binary} ` +
          `action=${action} model=${model} cwd=${cwd} mcp=${mcpArgs.length ? 'mcp-config' : Object.keys(mcpEnv).join(',') || 'none'}`,
      )

      const result = await runAiCliInvocation({
        adapter,
        action,
        cwd,
        env: { ...process.env, ...mcpEnv },
        buildOpts: {
          prompt,
          systemPrompt: adapter.capabilities.systemPromptArg ? systemPrompt : undefined,
          model,
          sessionId: useResume ? conversation.session_id ?? undefined : undefined,
          extraArgs: mcpArgs,
          imagePaths: spawnImagePaths,
          reasoning_effort: reasoningEffort,
        },
        onSpawn: (child) => {
          this._active.set(conversationId, child)
        },
        onEvent: (ev) => {
          switch (ev.kind) {
            case 'text-delta':
              streamed += ev.text
              this._broadcast({ type: 'agent_stream', conversationId, delta: ev.text, timestamp: timestamp() })
              break
            case 'tool-use':
              this._broadcast({ type: 'agent_tool', conversationId, tool: ev.name, timestamp: timestamp() })
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
      })

      this._active.delete(conversationId)
      const text = streamed.trim()
      console.log(
        `[agent-chat] turn end conv=${conversationId} provider=${adapter.id} code=${result.code} ` +
          `spawnFailed=${result.spawnFailed} chars=${text.length} err=${capturedError ?? ''}`,
      )
      if (result.stderrTail && (result.spawnFailed || (result.code ?? 0) !== 0 || !text)) {
        console.error(`[agent-chat] ${adapter.id} stderr:\n${result.stderrTail}`)
      }
      return { text, sessionId: capturedSessionId, error: capturedError, code: result.code, spawnFailed: result.spawnFailed, stderrTail: result.stderrTail }
    }

    const canResume = !!conversation.session_id && adapter.capabilities.nativeResume
    let r = await invoke(canResume)

    // Deleted mid-turn (DELETE aborts the child and drops the row): stop here —
    // no auto-heal respawn, no FK-violating assistant INSERT.
    if (!getAgentConversation(this._db, conversationId)) return

    // Auto-heal a stale/foreign session: a resume that produced no text (e.g. a
    // provider switch leaving another provider's session id, or codex
    // "no rollout found for thread id") retries once as a fresh turn.
    if (canResume && !r.spawnFailed && !r.text) {
      console.log(`[agent-chat] resume produced no text — retrying fresh conv=${conversationId}`)
      updateAgentConversation(this._db, conversationId, { session_id: null })
      r = await invoke(false)
      if (!getAgentConversation(this._db, conversationId)) return
    }

    if (r.spawnFailed) {
      this._emitError(conversationId, `Failed to launch ${adapter.binary}. Is it installed and on PATH?`)
      return
    }

    if (r.text) {
      addAgentMessage(this._db, { conversationId, role: 'assistant', content: r.text })
      updateAgentConversation(this._db, conversationId, {
        session_id: r.sessionId,
        provider: conversation.provider,
        model,
        tier_level: tierLevel,
      })
      this._broadcast({ type: 'agent_done', conversationId, fullText: r.text, timestamp: timestamp() })
      return
    }

    // Failure: reset the session so the NEXT turn starts fresh, and surface the
    // real reason instead of silently doing nothing.
    updateAgentConversation(this._db, conversationId, { session_id: null, provider: conversation.provider, model, tier_level: tierLevel })
    const reason =
      r.error ||
      (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
      (r.code !== 0 ? `${adapter.binary} exited with code ${r.code}` : 'The agent returned no output.')
    this._emitError(conversationId, reason)
  }

  /**
   * Auto-title a conversation from its first TWO user prompts (deterministic —
   * no AI spend). Turn 1 sets the title when none exists; turn 2 refines it,
   * but ONLY while the current title is still turn 1's auto title (a manual
   * rename is recomputable-detectable and never clobbered). Broadcasts
   * `agent_title` so the sidebar list updates live.
   */
  private _autoTitle(conversationId: string, currentTitle: string | null): void {
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

  /** Aborts the active turn for a conversation, if any. */
  abort(conversationId: string): boolean {
    const child = this._active.get(conversationId)
    if (!child) return false
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    this._active.delete(conversationId)
    return true
  }

  /** Kills all active turns (graceful shutdown). */
  async shutdown(): Promise<void> {
    for (const [, child] of this._active) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    this._active.clear()
  }

  private _emitError(conversationId: string, error: string): void {
    this._broadcast({ type: 'agent_error', conversationId, error, timestamp: new Date().toISOString() })
  }
}
